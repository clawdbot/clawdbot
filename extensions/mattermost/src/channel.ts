// Mattermost plugin module implements channel behavior.
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelThreadingContext,
  ChannelThreadingToolContext,
  ChannelToolSend,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import {
  attachChannelToResult,
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import {
  type MessagePresentation,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationControlValue,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolvePayloadMediaUrls, sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { mattermostApprovalAuth } from "./approval-auth.js";
import {
  chunkTextForOutbound,
  createAccountStatusSink,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
} from "./channel-api.js";
import {
  describeMattermostAccount,
  isMattermostConfigured,
  mattermostConfigAdapter,
  mattermostMeta as meta,
  normalizeMattermostAllowEntry as normalizeAllowEntry,
  resolveMattermostGatewayAuthBypassPaths,
} from "./channel-config-shared.js";
import { MattermostChannelConfigSchema } from "./config-surface.js";
import { mattermostDoctor } from "./doctor.js";
import { resolveMattermostGroupRequireMention } from "./group-mentions.js";
import {
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostReplyToMode,
  type ResolvedMattermostAccount,
} from "./mattermost/accounts.js";
import { looksLikeMattermostTargetId, normalizeMattermostMessagingTarget } from "./normalize.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";
import { mattermostSetupAdapter } from "./setup-core.js";
import { mattermostSetupWizard } from "./setup-surface.js";
import type { MattermostConfig } from "./types.js";

const loadMattermostChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

function buildMattermostPresentationButtons(presentation: MessagePresentation) {
  return presentation.blocks
    .filter((block) => block.type === "buttons")
    .map((block) =>
      block.buttons.flatMap((button) => {
        if (button.action) {
          return [];
        }
        const value = resolveMessagePresentationControlValue(button);
        return value
          ? [
              {
                id: value,
                text: button.label,
                callback_data: value,
                context: {
                  callback_data: value,
                },
                style: button.style,
              },
            ]
          : [];
      }),
    )
    .filter((row) => row.length > 0);
}

const MATTERMOST_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: false,
  context: true,
  divider: false,
  limits: {
    text: {
      markdownDialect: "markdown",
    },
  },
} satisfies ChannelOutboundAdapter["presentationCapabilities"];

function hasMattermostPresentationNavigation(presentation: MessagePresentation): boolean {
  return presentation.blocks.some(
    (block) =>
      block.type === "buttons" &&
      block.buttons.some((button) => {
        const action = resolveMessagePresentationButtonAction(button);
        return action?.type === "url" || (action?.type === "web-app" && Boolean(action.url));
      }),
  );
}

function readMattermostPresentationButtons(payload: {
  channelData?: Record<string, unknown>;
}): Array<unknown> | undefined {
  const buttons = (payload.channelData?.mattermost as { presentationButtons?: unknown } | undefined)
    ?.presentationButtons;
  return Array.isArray(buttons) ? buttons : undefined;
}

type MattermostDirectoryListParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["directory"]>["listGroups"]>
>[0];

const mattermostSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedMattermostAccount>({
  channelKey: "mattermost",
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveGroupPolicy: (account) => account.config.groupPolicy,
  surface: "Mattermost channels",
  openScope: "any member",
  groupPolicyPath: "channels.mattermost.groupPolicy",
  groupAllowFromPath: "channels.mattermost.groupAllowFrom",
  policyPathSuffix: "dmPolicy",
  normalizeDmEntry: (raw) => normalizeAllowEntry(raw),
});

function describeMattermostMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabledAccounts = (
    accountId
      ? [resolveMattermostAccount({ cfg, accountId })]
      : listMattermostAccountIds(cfg).map((listedAccountId) =>
          resolveMattermostAccount({ cfg, accountId: listedAccountId }),
        )
  )
    .filter((account) => account.enabled)
    .filter((account) => Boolean(account.botToken?.trim() && account.baseUrl?.trim()));

  const actions: ChannelMessageActionName[] = [];

  if (enabledAccounts.length > 0) {
    actions.push("send");
  }

  const actionsConfig = cfg.channels?.mattermost?.actions as { reactions?: boolean } | undefined;
  const baseReactions = actionsConfig?.reactions;
  const hasReactionCapableAccount = enabledAccounts.some((account) => {
    const accountActions = account.config.actions as { reactions?: boolean } | undefined;
    return accountActions?.reactions ?? baseReactions ?? true;
  });
  if (hasReactionCapableAccount) {
    actions.push("react");
  }

  return {
    actions,
    capabilities: enabledAccounts.length > 0 ? ["presentation"] : [],
  };
}

function hasConfiguredMattermostDirectoryAccount({
  cfg,
  accountId,
}: Pick<MattermostDirectoryListParams, "cfg" | "accountId">): boolean {
  const accounts = accountId
    ? [resolveMattermostAccount({ cfg, accountId })]
    : listMattermostAccountIds(cfg).map((listedAccountId) =>
        resolveMattermostAccount({ cfg, accountId: listedAccountId }),
      );
  return accounts.some((account) =>
    Boolean(account.enabled && account.botToken?.trim() && account.baseUrl?.trim()),
  );
}

function extractMattermostToolSend(args: Record<string, unknown>): ChannelToolSend | null {
  if (normalizeOptionalString(args.action) !== "send") {
    return null;
  }
  const to = normalizeOptionalString(args.to) ?? normalizeOptionalString(args.target);
  if (!to) {
    return null;
  }
  const threadId =
    normalizeOptionalString(args.threadId) ??
    normalizeOptionalString(args.replyToId) ??
    normalizeOptionalString(args.replyTo);
  const threadSuppressed = args.topLevel === true || args.threadId === null;
  return {
    to,
    accountId: normalizeOptionalString(args.accountId),
    ...(threadId ? { threadId } : {}),
    ...(!threadId && !threadSuppressed ? { threadImplicit: true } : {}),
    ...(threadSuppressed ? { threadSuppressed: true } : {}),
  };
}

function extractMattermostToolSendResult(
  result: unknown,
  send: ChannelToolSend,
): ChannelToolSend | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const toolSend = (details as { toolSend?: unknown }).toolSend;
  if (!toolSend || typeof toolSend !== "object") {
    return null;
  }
  const record = toolSend as Record<string, unknown>;
  const to = normalizeOptionalString(record.to);
  if (!to) {
    return null;
  }
  const threadId = normalizeOptionalString(record.threadId);
  const originalTarget = normalizeOptionalString(send.to);
  const preserveOriginalTarget =
    originalTarget?.startsWith("user:") === true || originalTarget?.startsWith("@") === true;
  return {
    to: preserveOriginalTarget ? originalTarget : to,
    ...(threadId ? { threadId } : {}),
  };
}

function resolveMattermostAutoThreadId(params: {
  to: string;
  replyToId?: string | null;
  toolContext?: {
    currentChannelId?: string;
    currentThreadTs?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
  };
}): string | undefined {
  const replyToId = normalizeOptionalString(params.replyToId);
  const context = params.toolContext;
  const currentThreadId = normalizeOptionalString(context?.currentThreadTs);
  const currentMessageId =
    typeof context?.currentMessageId === "number"
      ? String(context.currentMessageId)
      : normalizeOptionalString(context?.currentMessageId);
  const currentTarget = normalizeMattermostThreadTarget(context?.currentChannelId);
  if (currentThreadId && currentTarget === normalizeMattermostThreadTarget(params.to)) {
    if (replyToId === currentMessageId) {
      return currentThreadId;
    }
    if (!replyToId) {
      const replyToMode = context?.replyToMode;
      const canInheritThread =
        replyToMode === "all" ||
        (replyToMode === "first" && context?.hasRepliedRef?.value !== true);
      return canInheritThread ? currentThreadId : undefined;
    }
  }
  return replyToId;
}

function normalizeMattermostThreadTarget(raw: string | undefined): string | undefined {
  const normalized = raw ? normalizeMattermostMessagingTarget(raw) : undefined;
  if (normalized) {
    return normalized;
  }
  const trimmed = normalizeOptionalString(raw);
  return trimmed && /^[a-z0-9]{26}$/i.test(trimmed) ? `channel:${trimmed}` : undefined;
}

function matchesMattermostToolContextTarget(params: {
  target: string;
  toolContext: ChannelThreadingToolContext;
}): boolean {
  const target = normalizeMattermostThreadTarget(params.target);
  if (!target) {
    return false;
  }
  return [params.toolContext.currentChannelId, params.toolContext.currentMessagingTarget].some(
    (currentTarget) => normalizeMattermostThreadTarget(currentTarget) === target,
  );
}

function normalizeMattermostThreadId(value: string | number | undefined): string | undefined {
  return typeof value === "number" ? String(value) : normalizeOptionalString(value);
}

function buildMattermostThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: { value: boolean };
}): ChannelThreadingToolContext {
  const account = resolveMattermostAccount({
    cfg: params.cfg,
    accountId: params.accountId ?? resolveDefaultMattermostAccountId(params.cfg),
  });
  const chatType =
    params.context.ChatType === "direct" ||
    params.context.ChatType === "group" ||
    params.context.ChatType === "channel"
      ? params.context.ChatType
      : "channel";
  const configuredReplyToMode = resolveMattermostReplyToMode(account, chatType);
  const currentThreadTs =
    normalizeMattermostThreadId(params.context.MessageThreadId) ??
    normalizeMattermostThreadId(params.context.TransportThreadId) ??
    normalizeOptionalString(params.context.ReplyToId);
  const currentMessageId = normalizeMattermostThreadId(params.context.CurrentMessageId);
  const hasExistingThread =
    Boolean(currentThreadTs) && (!currentMessageId || currentThreadTs !== currentMessageId);
  const currentChannelId = params.context.To
    ? normalizeMattermostMessagingTarget(params.context.To)
    : undefined;
  return {
    currentChannelId,
    currentThreadTs,
    currentMessageId: params.context.CurrentMessageId,
    replyToMode: hasExistingThread ? "all" : configuredReplyToMode,
    hasRepliedRef: params.hasRepliedRef,
    sameChannelThreadRequired: Boolean(currentThreadTs),
  };
}

async function listMattermostDirectoryGroups(params: MattermostDirectoryListParams) {
  if (!hasConfiguredMattermostDirectoryAccount(params)) {
    return [];
  }
  return (await loadMattermostChannelRuntime()).listMattermostDirectoryGroups(params);
}

async function listMattermostDirectoryPeers(params: MattermostDirectoryListParams) {
  if (!hasConfiguredMattermostDirectoryAccount(params)) {
    return [];
  }
  return (await loadMattermostChannelRuntime()).listMattermostDirectoryPeers(params);
}

const mattermostMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: describeMattermostMessageTool,
  extractToolSend: ({ args }) => extractMattermostToolSend(args),
  extractToolSendResult: ({ result, send }) => extractMattermostToolSendResult(result, send),
  supportsAction: ({ action }) => {
    return action === "send" || action === "react";
  },
  handleAction: async ({
    action,
    params,
    cfg,
    accountId,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
    conversationReadOrigin,
  }) => {
    if (action === "react") {
      const resolvedAccountId = accountId ?? resolveDefaultMattermostAccountId(cfg);
      const mattermostConfig = cfg.channels?.mattermost as MattermostConfig | undefined;
      const account = resolveMattermostAccount({ cfg, accountId: resolvedAccountId });
      if (!account.enabled) {
        throw new Error(`Mattermost account "${resolvedAccountId}" is disabled`);
      }
      const reactionsEnabled =
        account.config.actions?.reactions ?? mattermostConfig?.actions?.reactions ?? true;
      if (!reactionsEnabled) {
        throw new Error("Mattermost reactions are disabled in config");
      }

      const { postId, emojiName, remove } = parseMattermostReactActionParams(params);
      // The runner preserves the caller's spelling in `target` and puts the
      // directory-resolved provider destination in `to` before dispatch.
      const authorizedTarget = normalizeOptionalString(params.to);
      if (remove) {
        const result = await (
          await loadMattermostChannelRuntime()
        ).removeMattermostReaction({
          cfg,
          postId,
          emojiName,
          accountId: resolvedAccountId,
          authorizedTarget,
          conversationReadOrigin,
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        return {
          content: [
            { type: "text" as const, text: `Removed reaction :${emojiName}: from ${postId}` },
          ],
          details: {},
        };
      }

      const result = await (
        await loadMattermostChannelRuntime()
      ).addMattermostReaction({
        cfg,
        postId,
        emojiName,
        accountId: resolvedAccountId,
        authorizedTarget,
        conversationReadOrigin,
      });
      if (!result.ok) {
        throw new Error(result.error);
      }

      return {
        content: [{ type: "text" as const, text: `Reacted with :${emojiName}: on ${postId}` }],
        details: {},
      };
    }

    if (action !== "send") {
      throw new Error(`Unsupported Mattermost action: ${action}`);
    }

    // Send action with optional interactive buttons
    const to =
      typeof params.to === "string"
        ? params.to.trim()
        : typeof params.target === "string"
          ? params.target.trim()
          : "";
    if (!to) {
      throw new Error("Mattermost send requires a target (to).");
    }

    const presentation = normalizeMessagePresentation(params.presentation);
    const message = presentation
      ? renderMessagePresentationFallbackText({
          text: typeof params.message === "string" ? params.message : "",
          presentation,
        })
      : typeof params.message === "string"
        ? params.message
        : "";
    // Mattermost post root_id is the thread root. A generic replyTo can name
    // the current child post, so prefer threadId unless the caller supplied the
    // Mattermost-specific replyToId root directly.
    const replyToId =
      normalizeOptionalString(params.replyToId) ??
      normalizeOptionalString(params.threadId) ??
      normalizeOptionalString(params.replyTo);
    const resolvedAccountId = accountId || undefined;

    const attachmentMedia = collectMattermostAttachmentMedia(params);
    if (attachmentMedia.hasUnsupportedAttachmentPayload) {
      throw new Error(
        "Mattermost send attachments require media, mediaUrl, path, filePath, fileUrl, mediaUrls, or attachments[] with one of those fields; buffer/base64 payloads are not supported.",
      );
    }
    if (attachmentMedia.mediaUrls.length > 1) {
      throw new Error(
        "Mattermost send supports one attachment per message; split multiple mediaUrls or attachments[] entries into separate sends.",
      );
    }
    const buttons = presentation ? buildMattermostPresentationButtons(presentation) : [];

    const result = await (
      await loadMattermostChannelRuntime()
    ).sendMessageMattermost(to, message, {
      cfg,
      accountId: resolvedAccountId,
      replyToId,
      buttons: buttons.length > 0 ? buttons : undefined,
      attachmentText: typeof params.attachmentText === "string" ? params.attachmentText : undefined,
      mediaUrl: attachmentMedia.mediaUrls[0],
      mediaLocalRoots: mediaLocalRoots ?? mediaAccess?.localRoots,
      mediaReadFile: mediaReadFile ?? mediaAccess?.readFile,
      ...(mediaAccess?.workspaceDir ? { workspaceDir: mediaAccess.workspaceDir } : {}),
      requireMediaUpload: requiresMattermostMediaUpload(attachmentMedia.mediaUrls[0])
        ? true
        : undefined,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            channel: "mattermost",
            messageId: result.messageId,
            channelId: result.channelId,
          }),
        },
      ],
      details: {
        toolSend: {
          to: `channel:${result.channelId}`,
          ...(replyToId ? { threadId: replyToId } : {}),
        },
      },
    };
  },
};

function parseMattermostReactActionParams(params: Record<string, unknown>): {
  postId: string;
  emojiName: string;
  remove: boolean;
} {
  const postId =
    normalizeOptionalString(params.messageId) ?? normalizeOptionalString(params.postId);
  if (!postId) {
    throw new Error("Mattermost react requires messageId (post id)");
  }

  const emojiName = normalizeOptionalString(params.emoji)?.replace(/^:+|:+$/g, "");
  if (!emojiName) {
    throw new Error("Mattermost react requires emoji");
  }

  return {
    postId,
    emojiName,
    remove: params.remove === true,
  };
}

function collectNonBlankStrings(values: Array<string | undefined>): string[] {
  const collected: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      collected.push(trimmed);
    }
  }
  return collected;
}

function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function readMattermostParam(params: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(params, key)) {
    return params[key];
  }
  const snakeKey = toSnakeCaseKey(key);
  return snakeKey === key || !Object.hasOwn(params, snakeKey) ? undefined : params[snakeKey];
}

function readMattermostStringParam(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = readMattermostParam(params, key);
  return typeof raw === "string" ? normalizeOptionalString(raw) : undefined;
}

function readMattermostStringArrayParam(params: Record<string, unknown>, key: string): string[] {
  const raw = readMattermostParam(params, key);
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => {
        const normalized = normalizeOptionalString(entry);
        return normalized ? [normalized] : [];
      });
  }
  if (typeof raw === "string") {
    const normalized = normalizeOptionalString(raw);
    return normalized ? [normalized] : [];
  }
  return [];
}

function requiresMattermostMediaUpload(mediaUrl: string | undefined): boolean {
  const normalized = normalizeOptionalString(mediaUrl);
  return Boolean(normalized && !/^https?:\/\//i.test(normalized));
}

function collectMattermostAttachmentMedia(params: Record<string, unknown>): {
  mediaUrls: string[];
  hasUnsupportedAttachmentPayload: boolean;
} {
  const mediaUrlCandidates: Array<string | undefined> = [
    readMattermostStringParam(params, "media"),
    readMattermostStringParam(params, "mediaUrl"),
    readMattermostStringParam(params, "path"),
    readMattermostStringParam(params, "filePath"),
    readMattermostStringParam(params, "fileUrl"),
  ];
  mediaUrlCandidates.push(...readMattermostStringArrayParam(params, "mediaUrls"));

  let hasUnsupportedAttachmentPayload = Boolean(
    readMattermostStringParam(params, "buffer") ?? readMattermostStringParam(params, "base64"),
  );
  if (Array.isArray(params.attachments)) {
    for (const attachment of params.attachments) {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        continue;
      }
      const record = attachment as Record<string, unknown>;
      mediaUrlCandidates.push(
        readMattermostStringParam(record, "media"),
        readMattermostStringParam(record, "mediaUrl"),
        readMattermostStringParam(record, "path"),
        readMattermostStringParam(record, "filePath"),
        readMattermostStringParam(record, "fileUrl"),
        readMattermostStringParam(record, "url"),
      );
      hasUnsupportedAttachmentPayload ||= Boolean(
        readMattermostStringParam(record, "buffer") ?? readMattermostStringParam(record, "base64"),
      );
    }
  }

  return {
    mediaUrls: collectNonBlankStrings(mediaUrlCandidates),
    hasUnsupportedAttachmentPayload,
  };
}

const mattermostOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      payload: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  presentationCapabilities: MATTERMOST_PRESENTATION_CAPABILITIES,
  renderPresentation: ({ payload, presentation }) => {
    if (payload.mediaUrls && payload.mediaUrls.length > 1) {
      return null;
    }
    const buttons = buildMattermostPresentationButtons(presentation);
    const hasButtons = buttons.some((row) => row.length > 0);
    if (!hasButtons && !hasMattermostPresentationNavigation(presentation)) {
      return null;
    }
    return {
      ...payload,
      text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
      ...(hasButtons
        ? {
            channelData: {
              ...payload.channelData,
              mattermost: {
                ...(payload.channelData?.mattermost as Record<string, unknown> | undefined),
                presentationButtons: buttons,
              },
            },
          }
        : {}),
    };
  },
  sendPayload: async (ctx) => {
    const buttons = readMattermostPresentationButtons(ctx.payload);
    if (buttons?.length) {
      const mediaUrl = resolvePayloadMediaUrls({
        ...ctx.payload,
        mediaUrl: ctx.payload.mediaUrl ?? ctx.mediaUrl,
      })
        .map((url) => url.trim())
        .find(Boolean);
      const result = await (
        await loadMattermostChannelRuntime()
      ).sendMessageMattermost(ctx.to, ctx.payload.text ?? ctx.text, {
        cfg: ctx.cfg,
        accountId: ctx.accountId ?? undefined,
        mediaUrl,
        mediaLocalRoots: ctx.mediaLocalRoots ?? ctx.mediaAccess?.localRoots,
        mediaReadFile: ctx.mediaReadFile ?? ctx.mediaAccess?.readFile,
        ...(ctx.mediaAccess?.workspaceDir ? { workspaceDir: ctx.mediaAccess.workspaceDir } : {}),
        requireMediaUpload: requiresMattermostMediaUpload(mediaUrl) ? true : undefined,
        replyToId: ctx.replyToId ?? (ctx.threadId != null ? String(ctx.threadId) : undefined),
        buttons,
      });
      return attachChannelToResult("mattermost", result);
    }
    return await sendTextMediaPayload({ channel: "mattermost", ctx, adapter: mattermostOutbound });
  },
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Mattermost requires --to <channelId|@username|user:ID|channel:ID>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  ...createAttachedChannelResultAdapter({
    channel: "mattermost",
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) =>
      await (
        await loadMattermostChannelRuntime()
      ).sendMessageMattermost(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
      }),
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      replyToId,
      threadId,
    }) =>
      await (
        await loadMattermostChannelRuntime()
      ).sendMessageMattermost(to, text, {
        cfg,
        accountId: accountId ?? undefined,
        mediaUrl,
        mediaLocalRoots: mediaLocalRoots ?? mediaAccess?.localRoots,
        mediaReadFile: mediaReadFile ?? mediaAccess?.readFile,
        ...(mediaAccess?.workspaceDir ? { workspaceDir: mediaAccess.workspaceDir } : {}),
        requireMediaUpload: requiresMattermostMediaUpload(mediaUrl) ? true : undefined,
        replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
      }),
  }),
};

const mattermostMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "mattermost",
  outbound: mattermostOutbound,
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        discardPending: true,
      },
    },
  },
});

export const mattermostPlugin: ChannelPlugin<ResolvedMattermostAccount> = createChatChannelPlugin({
  base: {
    id: "mattermost",
    meta: {
      ...meta,
    },
    setup: mattermostSetupAdapter,
    setupWizard: mattermostSetupWizard,
    capabilities: {
      chatTypes: ["direct", "channel", "group", "thread"],
      reactions: true,
      threads: true,
      media: true,
      nativeCommands: true,
    },
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
    },
    reload: { configPrefixes: ["channels.mattermost"] },
    configSchema: MattermostChannelConfigSchema,
    config: {
      ...mattermostConfigAdapter,
      isConfigured: isMattermostConfigured,
      describeAccount: describeMattermostAccount,
    },
    approvalCapability: mattermostApprovalAuth,
    doctor: mattermostDoctor,
    groups: {
      resolveRequireMention: resolveMattermostGroupRequireMention,
    },
    actions: mattermostMessageActions,
    message: mattermostMessageAdapter,
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    directory: createChannelDirectoryAdapter({
      listGroups: listMattermostDirectoryGroups,
      listGroupsLive: listMattermostDirectoryGroups,
      listPeers: listMattermostDirectoryPeers,
      listPeersLive: listMattermostDirectoryPeers,
    }),
    messaging: {
      targetPrefixes: ["mattermost"],
      directTargetStyle: "user-prefixed",
      targetIdComparison: "case-sensitive",
      defaultMarkdownTableMode: "off",
      normalizeTarget: normalizeMattermostMessagingTarget,
      resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
        const parent = parentConversationId?.trim();
        const child = conversationId.trim();
        return parent && parent !== child
          ? { to: `channel:${parent}`, threadId: child }
          : { to: normalizeMattermostMessagingTarget(`channel:${child}`) };
      },
      resolveOutboundSessionRoute: (params) => resolveMattermostOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: looksLikeMattermostTargetId,
        hint: "<channelId|user:ID|channel:ID>",
        resolveTarget: async ({ cfg, accountId, input }) => {
          const resolved = await (
            await loadMattermostChannelRuntime()
          ).resolveMattermostOpaqueTarget({
            input,
            cfg,
            accountId,
          });
          if (!resolved) {
            return null;
          }
          return {
            to: resolved.to,
            kind: resolved.kind,
            source: "directory",
          };
        },
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedMattermostAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
        connected: false,
        lastConnectedAt: null,
        lastDisconnect: null,
      }),
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveProbedChannelStatusSummary(snapshot, {
          botTokenSource: snapshot.botTokenSource ?? "none",
          connected: snapshot.connected ?? false,
          baseUrl: snapshot.baseUrl ?? null,
        }),
      probeAccount: async ({ account, timeoutMs }) => {
        const token = account.botToken?.trim();
        const baseUrl = account.baseUrl?.trim();
        if (!token || !baseUrl) {
          return { ok: false, error: "bot token or baseUrl missing" };
        }
        return await (
          await loadMattermostChannelRuntime()
        ).probeMattermost(baseUrl, token, timeoutMs, isPrivateNetworkOptInEnabled(account.config));
      },
      resolveAccountSnapshot: ({ account, runtime }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.botToken && account.baseUrl),
        extra: {
          botTokenSource: account.botTokenSource,
          baseUrl: account.baseUrl,
          dmPolicy: account.config.dmPolicy ?? "pairing",
          connected: runtime?.connected ?? false,
          lastConnectedAt: runtime?.lastConnectedAt ?? null,
          lastDisconnect: runtime?.lastDisconnect ?? null,
        },
      }),
    }),
    gateway: {
      // Same function as the public gateway-auth artifact so the pre-plugin
      // fast path and the loaded plugin cannot drift (pinned by contract test).
      resolveGatewayAuthBypassPaths: resolveMattermostGatewayAuthBypassPaths,
      startAccount: async (ctx) => {
        const account = ctx.account;
        const statusSink = createAccountStatusSink({
          accountId: ctx.accountId,
          setStatus: ctx.setStatus,
        });
        statusSink({
          baseUrl: account.baseUrl,
          botTokenSource: account.botTokenSource,
        });
        ctx.log?.info(`[${account.accountId}] starting channel`);
        return (await loadMattermostChannelRuntime()).monitorMattermostProvider({
          botToken: account.botToken ?? undefined,
          baseUrl: account.baseUrl ?? undefined,
          accountId: account.accountId,
          config: ctx.cfg,
          runtime: ctx.runtime,
          abortSignal: ctx.abortSignal,
          statusSink,
        });
      },
    },
  },
  pairing: {
    text: {
      idLabel: "mattermostUserId",
      message: "OpenClaw: your access has been approved.",
      normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
      notify: createLoggedPairingApprovalNotifier(
        ({ id }) => `[mattermost] User ${id} approved for pairing`,
      ),
    },
  },
  threading: {
    buildToolContext: (params) => buildMattermostThreadingToolContext(params),
    scopedAccountReplyToMode: {
      resolveAccount: (cfg, accountId) =>
        resolveMattermostAccount({
          cfg,
          accountId: accountId ?? resolveDefaultMattermostAccountId(cfg),
        }),
      resolveReplyToMode: (account, chatType) =>
        resolveMattermostReplyToMode(
          account,
          chatType === "direct" || chatType === "group" || chatType === "channel"
            ? chatType
            : "channel",
        ),
    },
    resolveAutoThreadId: ({ to, replyToId, toolContext }) =>
      resolveMattermostAutoThreadId({ to, replyToId, toolContext }),
    matchesToolContextTarget: ({ target, toolContext }) =>
      matchesMattermostToolContextTarget({ target, toolContext }),
    resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit, replyDelivery }) => {
      const ambientThreadId = threadId != null ? String(threadId) : undefined;
      // Direct chats stay flat when their effective mode is off. Opted-in DMs
      // preserve the thread root for routed replies and message-tool follow-ups.
      const isFlatDirect =
        replyDelivery?.chatType === "direct" && replyDelivery.replyToMode === "off";
      const resolvedThreadId = isFlatDirect
        ? undefined
        : replyDelivery
          ? replyToIsExplicit
            ? (replyToId ?? ambientThreadId)
            : (ambientThreadId ?? replyToId ?? undefined)
          : (ambientThreadId ?? replyToId);
      return {
        replyToId: isFlatDirect ? null : resolvedThreadId,
        threadId: resolvedThreadId ?? null,
      };
    },
  },
  security: mattermostSecurityAdapter,
  outbound: mattermostOutbound,
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
