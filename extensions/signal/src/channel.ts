// Signal plugin module implements channel behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createReplyToFanout,
  defineChannelMessageAdapter,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { chunkText, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import {
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  resolveSignalAccount,
  resolveSignalReplyToMode,
  type ResolvedSignalAccount,
} from "./accounts.js";
import { listSignalAliasDirectoryEntries, resolveSignalTarget } from "./aliases.js";
import {
  shouldSuppressLocalSignalExecApprovalPrompt,
  signalApprovalCapability,
} from "./approval-native.js";
import { markdownToSignalTextChunks } from "./format.js";
import { signalMessageActions } from "./message-actions.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";
import { resolveSignalOutboundTarget } from "./outbound-session.js";
import { materializeSignalPresentationFallback } from "./presentation-fallback.js";
import { resolveSignalReactionLevel } from "./reaction-level.js";
import { resolveSignalReplyContextWithPersistence } from "./reply-authors.js";
import { signalSetupAdapter } from "./setup-core.js";
import {
  createSignalPluginBase,
  signalConfigAdapter,
  signalSecurityAdapter,
  signalSetupWizard,
} from "./shared.js";

type SignalSendFn = typeof import("./send.runtime.js").sendMessageSignal;
type SignalProbe = import("./probe.js").SignalProbe;

const loadSignalMonitorModule = createLazyRuntimeModule(() => import("./monitor.js"));

const loadSignalProbeModule = createLazyRuntimeModule(() => import("./probe.js"));

const loadSignalSendRuntime = createLazyRuntimeModule(() => import("./send.runtime.js"));

const loadSignalApprovalReactionsModule = createLazyRuntimeModule(
  () => import("./approval-reactions.js"),
);

async function resolveSignalSendContext(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
}) {
  const send =
    resolveOutboundSendDep<SignalSendFn>(params.deps, "signal") ??
    (await loadSignalSendRuntime()).sendMessageSignal;
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
    accountId: params.accountId,
  });
  return { send, maxBytes };
}

function resolveSignalSendTarget(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  to: string;
}) {
  return (
    resolveSignalTarget({
      cfg: params.cfg,
      accountId: params.accountId,
      input: params.to,
    })?.to ?? params.to.trim()
  );
}

async function sendSignalOutbound(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  deps?: { [channelId: string]: unknown };
  replyToId?: string | null;
}) {
  const { send, maxBytes } = await resolveSignalSendContext(params);
  const to = resolveSignalSendTarget(params);
  const replyOptions = await resolveSignalReplyOptions({
    cfg: params.cfg,
    to,
    accountId: params.accountId,
    replyToId: params.replyToId,
  });
  return await send(to, params.text, {
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    ...replyOptions,
  });
}

function resolveSignalReplyOptions(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  accountId?: string | null;
  replyToId?: string | null;
}): Promise<
  { replyToId: string; replyToAuthor?: string; replyToBody?: string } | Record<string, never>
> {
  const replyToId = normalizeOptionalString(params.replyToId);
  if (!replyToId) {
    return Promise.resolve({});
  }
  const accountId = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  }).accountId;
  return resolveSignalReplyContextWithPersistence({
    accountId,
    to: params.to,
    replyToId,
  }).then((persistedContext) => {
    const replyToAuthor =
      persistedContext?.ambiguous === true ? undefined : persistedContext?.author;
    return {
      replyToId,
      ...(replyToAuthor ? { replyToAuthor } : {}),
      ...(persistedContext?.body ? { replyToBody: persistedContext.body } : {}),
    };
  });
}

function inferSignalTargetChatType(rawTo: string) {
  let to = rawTo.trim();
  if (!to) {
    return undefined;
  }
  if (/^signal:/i.test(to)) {
    to = to.replace(/^signal:/i, "").trim();
  }
  if (!to) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(to);
  if (lower.startsWith("group:")) {
    return "group" as const;
  }
  if (lower.startsWith("username:") || lower.startsWith("u:")) {
    return "direct" as const;
  }
  return "direct" as const;
}

type SignalMessageContextExtras = {
  deps?: { [channelId: string]: unknown };
};

function attachSignalVisibleText<T extends object>(result: T, visibleText: string) {
  const meta =
    "meta" in result && result.meta && typeof result.meta === "object"
      ? (result.meta as Record<string, unknown>)
      : {};
  return {
    ...result,
    meta: {
      ...meta,
      signalVisibleText: visibleText,
    },
  };
}

const signalMessageAdapter = defineChannelMessageAdapter({
  id: "signal",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
    },
  },
  send: {
    text: async (ctx) =>
      await sendSignalOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId: ctx.accountId ?? undefined,
        deps: (ctx as typeof ctx & SignalMessageContextExtras).deps,
        replyToId: ctx.replyToId ?? undefined,
      }),
    media: async (ctx) =>
      await sendSignalOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
        accountId: ctx.accountId ?? undefined,
        deps: (ctx as typeof ctx & SignalMessageContextExtras).deps,
        replyToId: ctx.replyToId ?? undefined,
      }),
  },
});

function buildSignalBaseSessionKey(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "signal" });
}

function resolveSignalOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
  resolvedTarget?: { to: string };
}) {
  const target = params.resolvedTarget?.to ?? params.target;
  const resolved = resolveSignalOutboundTarget(target);
  if (!resolved) {
    return null;
  }
  const normalizedTarget = target.replace(/^signal:/i, "").trim();
  const recipientSessionExact: true | "direct-alias" =
    resolved.chatType === "group" || /^\+?\d{3,15}$/.test(normalizedTarget) ? true : "direct-alias";
  const baseSessionKey = buildSignalBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer: resolved.peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    recipientSessionExact,
    ...resolved,
  };
}

async function sendFormattedSignalText(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string | null;
  deps?: { [channelId: string]: unknown };
  replyToId?: string | null;
  replyToIdSource?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendFormattedText"]>
  >[0]["replyToIdSource"];
  replyToMode?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendFormattedText"]>
  >[0]["replyToMode"];
  abortSignal?: AbortSignal;
  onDeliveryResult?: Parameters<
    NonNullable<ChannelOutboundAdapter["sendFormattedText"]>
  >[0]["onDeliveryResult"];
}) {
  const { send, maxBytes } = await resolveSignalSendContext({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    deps: ctx.deps,
  });
  const limit = resolveTextChunkLimit(ctx.cfg, "signal", ctx.accountId ?? undefined, {
    fallbackLimit: 4000,
  });
  const to = resolveSignalSendTarget({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    to: ctx.to,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "signal",
    accountId: ctx.accountId ?? undefined,
  });
  let chunks =
    limit === undefined
      ? markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, { tableMode })
      : markdownToSignalTextChunks(ctx.text, limit, { tableMode });
  if (chunks.length === 0 && ctx.text) {
    chunks = [{ text: ctx.text, styles: [] }];
  }
  const nextReplyToId = createReplyToFanout({
    replyToId: ctx.replyToId,
    replyToIdSource: ctx.replyToIdSource,
    replyToMode:
      ctx.replyToMode ??
      resolveSignalReplyToMode({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        chatType: inferSignalTargetChatType(to),
      }),
  });
  const results = [];
  for (const chunk of chunks) {
    ctx.abortSignal?.throwIfAborted();
    const replyToId = nextReplyToId();
    const replyOptions = await resolveSignalReplyOptions({
      cfg: ctx.cfg,
      to,
      accountId: ctx.accountId,
      replyToId,
    });
    const result = await send(to, chunk.text, {
      cfg: ctx.cfg,
      maxBytes,
      accountId: ctx.accountId ?? undefined,
      textMode: "plain",
      textStyles: chunk.styles,
      ...replyOptions,
    });
    const deliveryResult = attachChannelToResult(
      "signal",
      attachSignalVisibleText(result, chunk.text),
    );
    results.push(deliveryResult);
    await ctx.onDeliveryResult?.(deliveryResult);
  }
  return results;
}

async function sendFormattedSignalMedia(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string | null;
  deps?: { [channelId: string]: unknown };
  replyToId?: string | null;
  abortSignal?: AbortSignal;
}) {
  ctx.abortSignal?.throwIfAborted();
  const { send, maxBytes } = await resolveSignalSendContext({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    deps: ctx.deps,
  });
  const to = resolveSignalSendTarget({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    to: ctx.to,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "signal",
    accountId: ctx.accountId ?? undefined,
  });
  const formatted = markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, {
    tableMode,
  })[0] ?? {
    text: ctx.text,
    styles: [],
  };
  const replyOptions = await resolveSignalReplyOptions({
    cfg: ctx.cfg,
    to,
    accountId: ctx.accountId,
    replyToId: ctx.replyToId,
  });
  const result = await send(to, formatted.text, {
    cfg: ctx.cfg,
    mediaUrl: ctx.mediaUrl,
    mediaLocalRoots: ctx.mediaLocalRoots,
    ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
    maxBytes,
    accountId: ctx.accountId ?? undefined,
    textMode: "plain",
    textStyles: formatted.styles,
    ...replyOptions,
  });
  return attachChannelToResult("signal", attachSignalVisibleText(result, formatted.text));
}

async function registerDeliveredSignalApprovalPayloadForReactions(
  params: Parameters<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>[0],
) {
  const account = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.target.accountId ?? undefined,
  });
  const targetAuthor = normalizeOptionalString(account.config.account);
  const targetAuthorUuid = normalizeOptionalString(account.config.accountUuid);
  if (!targetAuthor && !targetAuthorUuid) {
    return;
  }
  const { registerSignalQuestionReactionTargetForDeliveredPayload } =
    await import("./question-reactions.js");
  registerSignalQuestionReactionTargetForDeliveredPayload({
    cfg: params.cfg,
    target: { ...params.target, accountId: account.accountId },
    payload: params.payload,
    results: params.results,
    targetAuthor,
    targetAuthorUuid,
  });
  const { registerSignalApprovalReactionTargetForDeliveredPayload } =
    await loadSignalApprovalReactionsModule();
  registerSignalApprovalReactionTargetForDeliveredPayload({
    cfg: params.cfg,
    target: { ...params.target, accountId: account.accountId },
    payload: params.payload,
    results: params.results,
    targetAuthor,
    targetAuthorUuid,
  });
}

async function renderSignalApprovalPayloadForReactions(
  params: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0],
) {
  const account = resolveSignalAccount({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId ?? undefined,
  });
  const targetAuthor = normalizeOptionalString(account.config.account);
  const targetAuthorUuid = normalizeOptionalString(account.config.accountUuid);
  if (!targetAuthor && !targetAuthorUuid) {
    return null;
  }
  const { addSignalApprovalReactionHintToStructuredPayload } =
    await loadSignalApprovalReactionsModule();
  const payload = materializeSignalPresentationFallback(params.payload, params.presentation);
  const questionPayload = questionGatewayRuntime.prepareReactionPayloadForDelivery({
    payload: params.payload,
    presentation: params.presentation,
  });
  if (questionPayload) {
    return questionPayload;
  }
  return addSignalApprovalReactionHintToStructuredPayload({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId ?? undefined,
    to: params.ctx.to,
    payload,
    targetAuthor,
    targetAuthorUuid,
  });
}

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount, SignalProbe> =
  createChatChannelPlugin({
    base: {
      ...createSignalPluginBase({
        setupWizard: signalSetupWizard,
        setup: signalSetupAdapter,
      }),
      actions: signalMessageActions,
      approvalCapability: signalApprovalCapability,
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "signal",
        resolveAccount: resolveSignalAccount,
        normalize: ({ cfg, accountId, values }) =>
          signalConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
        resolveDmAllowFrom: (account) => account.config.allowFrom,
        resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
        resolveDmPolicy: (account) => account.config.dmPolicy,
        resolveGroupPolicy: (account) => account.config.groupPolicy,
      }),
      agentPrompt: {
        reactionGuidance: ({ cfg, accountId }) => {
          const level = resolveSignalReactionLevel({
            cfg,
            accountId: accountId ?? undefined,
          }).agentReactionGuidance;
          return level ? { level, channelLabel: "Signal" } : undefined;
        },
      },
      messaging: {
        targetPrefixes: ["signal"],
        normalizeTarget: normalizeSignalMessagingTarget,
        inferTargetChatType: ({ to }) => inferSignalTargetChatType(to),
        resolveOutboundSessionRoute: (params) => resolveSignalOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeSignalTargetId,
          hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>",
          resolveTarget: async ({ cfg, accountId, input }) => {
            let target: ReturnType<typeof resolveSignalTarget>;
            try {
              target = resolveSignalTarget({ cfg, accountId, input });
            } catch {
              return null;
            }
            if (!target) {
              return null;
            }
            return {
              to: target.to,
              kind: target.kind,
              display: target.source === "alias" ? target.alias : undefined,
              source: target.source === "alias" ? "directory" : "normalized",
            };
          },
        },
      },
      directory: {
        listPeers: async ({ cfg, accountId, query, limit }) =>
          listSignalAliasDirectoryEntries({
            cfg,
            accountId,
            query,
            limit,
            kind: "user",
          }),
        listGroups: async ({ cfg, accountId, query, limit }) =>
          listSignalAliasDirectoryEntries({
            cfg,
            accountId,
            query,
            limit,
            kind: "group",
          }),
      },
      heartbeat: {
        sendTyping: async ({ cfg, to, accountId }) => {
          await (
            await loadSignalSendRuntime()
          ).sendTypingSignal(to, {
            cfg,
            ...(accountId ? { accountId } : {}),
          });
        },
        clearTyping: async ({ cfg, to, accountId }) => {
          await (
            await loadSignalSendRuntime()
          ).sendTypingSignal(to, {
            cfg,
            ...(accountId ? { accountId } : {}),
            stop: true,
          });
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedSignalAccount, SignalProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildBaseChannelStatusSummary(snapshot, {
            baseUrl: snapshot.baseUrl ?? null,
            probe: snapshot.probe,
            lastProbeAt: snapshot.lastProbeAt ?? null,
          }),
        probeAccount: async ({ account, timeoutMs }) => {
          const baseUrl = account.baseUrl;
          const { probeSignal } = await loadSignalProbeModule();
          return await probeSignal(baseUrl, timeoutMs, {
            apiMode: account.config?.apiMode ?? "auto",
          });
        },
        formatCapabilitiesProbe: ({ probe }) =>
          probe?.version ? [{ text: `Signal daemon: ${probe.version}` }] : [],
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            baseUrl: account.baseUrl,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          ctx.setStatus({
            accountId: account.accountId,
            baseUrl: account.baseUrl,
          });
          ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
          const { monitorSignalProvider } = await loadSignalMonitorModule();
          return await monitorSignalProvider({
            accountId: account.accountId,
            config: ctx.cfg,
            runtime: ctx.runtime,
            channelRuntime: ctx.channelRuntime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
          });
        },
      },
      message: signalMessageAdapter,
    },
    pairing: {
      text: {
        idLabel: "signalNumber",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^signal:/i),
        notify: async ({ cfg, id, message }) => {
          await (
            await loadSignalSendRuntime()
          ).sendMessageSignal(id, message, {
            cfg,
          });
        },
      },
    },
    security: signalSecurityAdapter,
    threading: {
      resolveReplyToMode: (params) => resolveSignalReplyToMode(params),
      matchesToolContextTarget: ({ target, toolContext }) => {
        const normalizedTarget = normalizeSignalMessagingTarget(target);
        if (!normalizedTarget) {
          return false;
        }
        return [toolContext.currentMessagingTarget, toolContext.currentChannelId].some(
          (currentTarget) =>
            currentTarget != null &&
            normalizeSignalMessagingTarget(currentTarget) === normalizedTarget,
        );
      },
      buildToolContext: ({ cfg, accountId, context, hasRepliedRef }) => {
        const currentMessagingTarget = normalizeOptionalString(context.To);
        const currentChatType =
          context.ChatType === "direct" || context.ChatType === "group"
            ? context.ChatType
            : undefined;
        return {
          currentChannelId:
            normalizeOptionalString(context.NativeChannelId) ?? currentMessagingTarget,
          currentChatType,
          currentMessagingTarget,
          currentMessageId: context.ReplyToId ?? context.CurrentMessageId,
          replyToMode: resolveSignalReplyToMode({
            cfg,
            accountId,
            chatType: currentChatType,
          }),
          hasRepliedRef,
        };
      },
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        resolveTarget: ({ cfg, to, accountId }) => {
          const raw = to?.trim();
          if (!raw) {
            return { ok: false, error: new Error("Signal target is required") };
          }
          let target: ReturnType<typeof resolveSignalTarget>;
          try {
            target = resolveSignalTarget({
              cfg: cfg ?? {},
              accountId,
              input: raw,
            });
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
          if (!target) {
            return {
              ok: false,
              error: new Error(
                `Unknown Signal alias or target "${raw}". Configure channels.signal.aliases.${raw.replace(/^signal:/i, "")} or use E.164, uuid:<id>, username:<name>, or group:<id>.`,
              ),
            };
          }
          return { ok: true, to: target.to };
        },
        chunker: chunkText,
        chunkerMode: "text",
        textChunkLimit: 4000,
        sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
        shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
          shouldSuppressLocalSignalExecApprovalPrompt({
            cfg,
            accountId,
            payload,
            hint,
          }),
        afterDeliverPayload: async (params) =>
          await registerDeliveredSignalApprovalPayloadForReactions(params),
        renderPresentation: async (params) => await renderSignalApprovalPayloadForReactions(params),
        sendFormattedText: async ({
          cfg,
          to,
          text,
          accountId,
          deps,
          replyToId,
          replyToIdSource,
          replyToMode,
          abortSignal,
          onDeliveryResult,
        }) =>
          await sendFormattedSignalText({
            cfg,
            to,
            text,
            accountId,
            deps,
            replyToId,
            replyToIdSource,
            replyToMode,
            abortSignal,
            onDeliveryResult,
          }),
        sendFormattedMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          deps,
          replyToId,
          abortSignal,
        }) =>
          await sendFormattedSignalMedia({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            mediaReadFile,
            accountId,
            deps,
            replyToId,
            abortSignal,
          }),
      },
      attachedResults: {
        channel: "signal",
        sendText: async ({ cfg, to, text, accountId, deps, replyToId }) =>
          await sendSignalOutbound({
            cfg,
            to,
            text,
            accountId: accountId ?? undefined,
            deps,
            replyToId,
          }),
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          deps,
          replyToId,
        }) =>
          await sendSignalOutbound({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            mediaReadFile,
            accountId: accountId ?? undefined,
            deps,
            replyToId,
          }),
      },
    },
  });
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
