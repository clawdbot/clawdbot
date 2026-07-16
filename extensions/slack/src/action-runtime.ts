// Slack plugin module implements action runtime behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedSlackAccount } from "./accounts.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import type { SlackConversationInfo } from "./channel-type.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import { resolveSlackChannelConfig } from "./monitor/channel-config.js";
import { isSlackChannelAllowedByPolicy } from "./monitor/policy.js";
import { hasSlackNativeDataBlock } from "./native-data-blocks.js";
import type { SlackReplyDeliveryMessage } from "./reply-blocks.js";
import {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readPositiveIntegerParam,
  readReactionParams,
  readStringParam,
  type OpenClawConfig,
  withNormalizedTimestamp,
} from "./runtime-api.js";
import { parseSlackTarget, resolveSlackChannelId, slackContextTargetsMatch } from "./targets.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

const messagingActions = new Set([
  "sendMessage",
  "uploadFile",
  "editMessage",
  "deleteMessage",
  "readMessages",
  "downloadFile",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);

type SlackActionsRuntimeModule = typeof import("./actions.runtime.js");

const loadSlackActionsRuntime = createLazyRuntimeModule(() => import("./actions.runtime.js"));

const loadSlackAccountsRuntime = createLazyRuntimeModule(() => import("./accounts.runtime.js"));
const loadSlackChannelTypeRuntime = createLazyRuntimeModule(() => import("./channel-type.js"));

function createLazySlackAction<K extends keyof SlackActionsRuntimeModule>(
  key: K,
): SlackActionsRuntimeModule[K] {
  return (async (...args: unknown[]) => {
    const runtime = await loadSlackActionsRuntime();
    const action = runtime[key] as (...actionArgs: unknown[]) => unknown;
    return action(...args);
  }) as SlackActionsRuntimeModule[K];
}

export const slackActionRuntime = {
  deleteSlackMessage: createLazySlackAction("deleteSlackMessage"),
  downloadSlackFile: createLazySlackAction("downloadSlackFile"),
  editSlackMessage: createLazySlackAction("editSlackMessage"),
  getSlackMemberInfo: createLazySlackAction("getSlackMemberInfo"),
  listSlackEmojis: createLazySlackAction("listSlackEmojis"),
  listSlackPins: createLazySlackAction("listSlackPins"),
  listSlackReactions: createLazySlackAction("listSlackReactions"),
  parseSlackBlocksInput,
  pinSlackMessage: createLazySlackAction("pinSlackMessage"),
  reactSlackMessage: createLazySlackAction("reactSlackMessage"),
  readSlackMessages: createLazySlackAction("readSlackMessages"),
  removeOwnSlackReactions: createLazySlackAction("removeOwnSlackReactions"),
  removeSlackReaction: createLazySlackAction("removeSlackReaction"),
  resolveSlackConversationName: createLazySlackAction("resolveSlackConversationName"),
  resolveSlackConversationInfo: async (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    channelId: string;
    operation?: "read" | "write";
    requireFreshName?: boolean;
  }) => (await loadSlackChannelTypeRuntime()).resolveSlackConversationInfo(params),
  resolveSlackChannelType: async (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    channelId: string;
  }) => (await loadSlackChannelTypeRuntime()).resolveSlackChannelType(params),
  sendSlackMessage: createLazySlackAction("sendSlackMessage"),
  unpinSlackMessage: createLazySlackAction("unpinSlackMessage"),
};

export type SlackActionContext = {
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requesterAccountId?: string;
  requesterSenderId?: string;
  currentChannelProvider?: string;
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Routable target for the current conversation when it differs from the channel ID. */
  currentMessagingTarget?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent for single-use reply modes. */
  hasRepliedRef?: { value: boolean };
  /** True when same-channel root posting would leak a thread-originated reply. */
  sameChannelThreadRequired?: boolean;
  /** Allowed local media directories for file uploads. */
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  /** Slack-private ordered delivery plan prepared after presentation normalization. */
  preparedMessages?: readonly SlackReplyDeliveryMessage[];
};

/**
 * Resolve threadTs for a Slack message based on context and replyToMode.
 * - "all": always inject threadTs
 * - "first"/"batched": inject only for the first eligible message (updates hasRepliedRef)
 * - "off": never auto-inject
 */
function resolveThreadTsFromContext(
  explicitThreadTs: string | undefined,
  targetChannel: string,
  context: SlackActionContext | undefined,
  opts?: { suppressImplicitThread?: boolean },
): string | undefined {
  // Agent explicitly provided threadTs - use it
  if (explicitThreadTs) {
    return explicitThreadTs;
  }
  if (opts?.suppressImplicitThread) {
    return undefined;
  }
  if (!context?.currentChannelId && !context?.currentMessagingTarget) {
    return undefined;
  }

  // Different channel - don't inject
  if (!slackContextTargetsMatch(targetChannel, context)) {
    return undefined;
  }
  if (!context.currentThreadTs) {
    if (context.sameChannelThreadRequired) {
      throw new Error(
        "Slack thread context is required for same-channel replies from a threaded Slack turn. Set topLevel=true or threadId=null to post at the channel root.",
      );
    }
    return undefined;
  }

  // Check replyToMode
  if (context.replyToMode === "all") {
    return context.currentThreadTs;
  }
  if (
    isSingleUseReplyToMode(context.replyToMode ?? "off") &&
    context.hasRepliedRef &&
    !context.hasRepliedRef.value
  ) {
    context.hasRepliedRef.value = true;
    return context.currentThreadTs;
  }
  return undefined;
}

function readSlackBlocksParam(params: Record<string, unknown>) {
  return slackActionRuntime.parseSlackBlocksInput(params.blocks);
}

function isImageContentType(value: string | undefined): boolean {
  return value?.trim().toLowerCase().startsWith("image/") === true;
}

function hasPotentialSlackNamedPolicy(params: {
  channels: ResolvedSlackAccount["config"]["channels"];
  allowNameMatching?: boolean;
  decision: "allow" | "deny";
}): boolean {
  if (params.allowNameMatching !== true) {
    return false;
  }
  return Object.entries(params.channels ?? {}).some(([key, entry]) => {
    if (entry == null || key === "*") {
      return false;
    }
    const named = !/^(?:channel:)?[CDG][A-Z0-9]+$/i.test(key);
    const entryAllows = entry.enabled !== false;
    return named && (params.decision === "allow" ? entryAllows : !entryAllows);
  });
}

function resolveSlackDmReadAllowed(account: ResolvedSlackAccount): boolean {
  const dmPolicy = account.config.dmPolicy ?? account.config.dm?.policy ?? "pairing";
  return account.config.dm?.enabled !== false && dmPolicy !== "disabled";
}

function normalizeConfiguredSlackDmUserId(value: unknown): string | undefined {
  const target = parseSlackTarget(String(value), { defaultKind: "user" });
  if (target?.kind !== "user") {
    return undefined;
  }
  const userId = target.id.trim().toLowerCase();
  return /^[uw][a-z0-9]+$/i.test(userId) ? userId : undefined;
}

async function isSlackDmTargetConfigured(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  userId?: string;
}): Promise<boolean> {
  const defaultTo = params.account.config.defaultTo?.trim();
  if (
    defaultTo &&
    slackContextTargetsMatch(params.channelId, {
      currentChannelId: defaultTo,
    })
  ) {
    return true;
  }
  const userId = normalizeConfiguredSlackDmUserId(params.userId);
  if (!userId) {
    return false;
  }
  const { resolveSlackAccountAllowFrom } = await loadSlackAccountsRuntime();
  const configuredUsers = [
    ...(resolveSlackAccountAllowFrom({
      cfg: params.cfg,
      accountId: params.account.accountId,
    }) ?? []),
    ...Object.keys(params.account.config.dms ?? {}),
    ...(defaultTo ? [defaultTo] : []),
  ];
  return configuredUsers.some((entry) => normalizeConfiguredSlackDmUserId(entry) === userId);
}

function isCurrentSlackReadTarget(params: {
  account: ResolvedSlackAccount;
  channelId: string;
  context?: SlackActionContext;
}): boolean {
  const requesterAccountId = params.context?.requesterAccountId?.trim();
  return Boolean(
    normalizeOptionalLowercaseString(params.context?.currentChannelProvider) === "slack" &&
    requesterAccountId &&
    normalizeAccountId(requesterAccountId) === normalizeAccountId(params.account.accountId) &&
    params.context &&
    slackContextTargetsMatch(params.channelId, params.context),
  );
}

function assertSlackMemberInfoAllowed(params: {
  account: ResolvedSlackAccount;
  context?: SlackActionContext;
  userId: string;
}) {
  if (params.context?.conversationReadOrigin === "direct-operator") {
    return;
  }
  const requesterAccountId = params.context?.requesterAccountId?.trim();
  const requesterSenderId = normalizeOptionalLowercaseString(params.context?.requesterSenderId);
  if (
    normalizeOptionalLowercaseString(params.context?.currentChannelProvider) !== "slack" ||
    !requesterAccountId ||
    normalizeAccountId(requesterAccountId) !== normalizeAccountId(params.account.accountId) ||
    !requesterSenderId ||
    requesterSenderId !== normalizeOptionalLowercaseString(params.userId)
  ) {
    throw new Error("Delegated Slack member info is limited to the current requester.");
  }
}

function resolveSlackChannelReadPolicy(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  channelName?: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  metadataResolved?: boolean;
  currentConversation?: boolean;
}) {
  const channels = params.account.config.channels;
  const channelKeys = Object.keys(channels ?? {});
  const channelConfig = resolveSlackChannelConfig({
    channelId: params.channelId,
    channelName: params.channelName,
    channels,
    channelKeys,
    allowNameMatching: params.account.config.dangerouslyAllowNameMatching,
    defaultRequireMention: params.account.config.requireMention,
  });
  const channelAllowed = channelConfig?.allowed !== false;
  const channelExplicitlyDisabled = !channelAllowed && channelConfig?.matchSource === "direct";
  const channelWildcardDisabled = !channelAllowed && channelConfig?.matchSource === "wildcard";
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.slack !== undefined,
    groupPolicy: params.account.config.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const policyAllowed = isSlackChannelAllowedByPolicy({
    groupPolicy,
    channelAllowlistConfigured: channelKeys.length > 0,
    channelAllowed,
  });
  const delegatedChannelAllowed =
    policyAllowed && !(!channelAllowed && (groupPolicy !== "open" || channelConfig?.matchSource));
  const directChannelAllowed =
    groupPolicy !== "disabled" && !channelExplicitlyDisabled && !channelWildcardDisabled;
  const baseChannelAllowed =
    params.conversationReadOrigin === "direct-operator" || params.currentConversation
      ? directChannelAllowed
      : delegatedChannelAllowed;
  const allowNameMatching = params.account.config.dangerouslyAllowNameMatching;
  const shouldResolveName =
    !params.metadataResolved &&
    !params.channelName &&
    ((baseChannelAllowed &&
      channelConfig?.matchSource !== "direct" &&
      hasPotentialSlackNamedPolicy({
        channels,
        allowNameMatching,
        decision: "deny",
      })) ||
      (!baseChannelAllowed &&
        groupPolicy !== "disabled" &&
        !channelExplicitlyDisabled &&
        hasPotentialSlackNamedPolicy({
          channels,
          allowNameMatching,
          decision: "allow",
        })));
  return {
    channelAllowed: baseChannelAllowed,
    channelExplicitlyDisabled,
    groupDmAllowed:
      params.account.config.dm?.enabled !== false &&
      params.account.config.dm?.groupEnabled === true &&
      (params.currentConversation ||
        isSlackGroupDmTargetConfigured(params.account, params.channelId)),
    shouldResolveName,
  };
}

async function assertSlackReadTargetAllowed(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  channelId: string;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  context?: SlackActionContext;
}) {
  const deny = () => {
    throw new Error("Slack read target channel is not allowed.");
  };
  const currentConversation = isCurrentSlackReadTarget({
    account: params.account,
    channelId: params.channelId,
    context: params.context,
  });
  const directOperator = params.conversationReadOrigin === "direct-operator";
  if (/^D/i.test(params.channelId)) {
    if (!resolveSlackDmReadAllowed(params.account)) {
      deny();
    }
    if (directOperator || currentConversation) {
      return;
    }
    const info = await slackActionRuntime.resolveSlackConversationInfo({
      cfg: params.cfg,
      accountId: params.account.accountId,
      channelId: params.channelId,
      operation: "read",
    });
    if (
      info.type !== "dm" ||
      !(await isSlackDmTargetConfigured({
        ...params,
        userId: info.user,
      }))
    ) {
      deny();
    }
    return;
  }

  const preliminary = resolveSlackChannelReadPolicy({
    ...params,
    currentConversation,
  });
  if (preliminary.channelExplicitlyDisabled) {
    deny();
  }
  const needsMetadata =
    preliminary.shouldResolveName || preliminary.channelAllowed !== preliminary.groupDmAllowed;
  if (!needsMetadata) {
    if (!preliminary.channelAllowed) {
      deny();
    }
    return;
  }

  const info: SlackConversationInfo = await slackActionRuntime.resolveSlackConversationInfo({
    cfg: params.cfg,
    accountId: params.account.accountId,
    channelId: params.channelId,
    operation: "read",
    ...(preliminary.shouldResolveName ? { requireFreshName: true } : {}),
  });
  if (
    preliminary.shouldResolveName &&
    (info.type === "channel" || info.type === "unknown") &&
    !info.name
  ) {
    deny();
  }
  const resolved = resolveSlackChannelReadPolicy({
    ...params,
    channelName: info.name,
    metadataResolved: true,
    currentConversation,
  });
  if (resolved.channelExplicitlyDisabled) {
    deny();
  }
  if (info.type === "dm") {
    if (
      !resolveSlackDmReadAllowed(params.account) ||
      (!directOperator &&
        !currentConversation &&
        !(await isSlackDmTargetConfigured({
          ...params,
          userId: info.user,
        })))
    ) {
      deny();
    }
    return;
  }
  const allowed =
    info.type === "channel"
      ? resolved.channelAllowed
      : info.type === "group"
        ? resolved.groupDmAllowed
        : resolved.channelAllowed && resolved.groupDmAllowed;
  if (!allowed) {
    deny();
  }
}

function isSlackGroupDmTargetConfigured(account: ResolvedSlackAccount, channelId: string): boolean {
  const entries = account.config.dm?.groupChannels ?? [];
  if (entries.length === 0) {
    return true;
  }
  const target = channelId.trim().toLowerCase();
  return entries.some((entry) => {
    const candidate = String(entry).trim().toLowerCase();
    return (
      candidate === "*" ||
      candidate === target ||
      candidate === `slack:${target}` ||
      candidate === `channel:${target}` ||
      candidate === `group:${target}` ||
      candidate === `mpim:${target}`
    );
  });
}

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  context?: SlackActionContext,
): Promise<AgentToolResult<unknown>> {
  const resolveChannelId = () =>
    resolveSlackChannelId(
      readStringParam(params, "channelId", {
        required: true,
      }),
    );
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const { resolveSlackAccount } = await loadSlackAccountsRuntime();
  const account = resolveSlackAccount({ cfg, accountId });
  if (account.config.enterpriseOrgInstall === true) {
    throw new Error("Slack action tools are unavailable for Enterprise Grid org installs.");
  }
  const actionConfig = account.actions ?? cfg.channels?.slack?.actions;
  const isActionEnabled = createActionGate(actionConfig);
  const userToken = account.userToken;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;

  // Choose the most appropriate token for Slack read/write operations.
  const getTokenForOperation = (operation: "read" | "write") => {
    if (operation === "read") {
      return userToken ?? botToken;
    }
    if (!allowUserWrites) {
      return botToken;
    }
    return botToken ?? userToken;
  };

  const buildActionOpts = (operation: "read" | "write") => {
    const token = getTokenForOperation(operation);
    const tokenOverride = token && token !== botToken ? token : undefined;
    return {
      cfg,
      ...(accountId ? { accountId } : {}),
      ...(tokenOverride ? { token: tokenOverride } : {}),
    };
  };

  const readOpts = buildActionOpts("read");
  const writeOpts = buildActionOpts("write");
  const assertReadTargetAllowed = async (channelId: string) =>
    await assertSlackReadTargetAllowed({
      account,
      cfg,
      channelId,
      conversationReadOrigin: context?.conversationReadOrigin,
      context,
    });

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const channelId = resolveChannelId();
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Slack reaction.",
      });
      await assertReadTargetAllowed(channelId);
      if (remove) {
        if (writeOpts) {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji, writeOpts);
        } else {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji);
        }
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = writeOpts
          ? await slackActionRuntime.removeOwnSlackReactions(channelId, messageId, writeOpts)
          : await slackActionRuntime.removeOwnSlackReactions(channelId, messageId);
        return jsonResult({ ok: true, removed });
      }
      if (writeOpts) {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji, writeOpts);
      } else {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji);
      }
      return jsonResult({ ok: true, added: emoji });
    }
    await assertReadTargetAllowed(channelId);
    const reactions = readOpts
      ? await slackActionRuntime.listSlackReactions(channelId, messageId, readOpts)
      : await slackActionRuntime.listSlackReactions(channelId, messageId);
    return jsonResult({ ok: true, reactions });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const blocks = readSlackBlocksParam(params);
        const replyBroadcast = readBooleanParam(params, "replyBroadcast");
        const textIsSlackMrkdwn = readBooleanParam(params, "textIsSlackMrkdwn");
        const textIsSlackPlainText = readBooleanParam(params, "textIsSlackPlainText");
        const preparedMessages = context?.preparedMessages;
        const authoredTextPlacement = readStringParam(params, "authoredTextPlacement") as
          | "none"
          | "blocks"
          | "outside-blocks"
          | undefined;
        if (
          authoredTextPlacement &&
          authoredTextPlacement !== "none" &&
          authoredTextPlacement !== "blocks" &&
          authoredTextPlacement !== "outside-blocks"
        ) {
          throw new Error("Slack authoredTextPlacement is invalid.");
        }
        const nativeDataFallbackBaseText = readStringParam(params, "nativeDataFallbackBaseText", {
          allowEmpty: true,
        });
        if (!content && !mediaUrl && !blocks && !preparedMessages?.length) {
          throw new Error("Slack sendMessage requires content, blocks, or mediaUrl.");
        }
        if (replyBroadcast && mediaUrl) {
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
        }
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
          {
            suppressImplicitThread: params.topLevel === true || params.threadTs === null,
          },
        );
        const baseSendOpts = {
          ...writeOpts,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
        };
        const sendOpts = {
          ...baseSendOpts,
          ...(replyBroadcast ? { replyBroadcast } : {}),
          ...(textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
          ...(textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
          ...(authoredTextPlacement ? { authoredTextPlacement } : {}),
          ...(nativeDataFallbackBaseText !== undefined ? { nativeDataFallbackBaseText } : {}),
        };
        const sendContentAndBlocks = async () => {
          const shouldSplitLongContent =
            content && content.length > SLACK_TEXT_LIMIT && !hasSlackNativeDataBlock(blocks);
          if (content && shouldSplitLongContent) {
            // Reuse the resolved thread for both sends. Invoking the action twice
            // could consume replyToMode=first and move the full text off-thread.
            const { replyBroadcast: _replyBroadcast, ...blockSendOpts } = sendOpts;
            await slackActionRuntime.sendSlackMessage(to, "", {
              ...blockSendOpts,
              blocks,
            });
            return await slackActionRuntime.sendSlackMessage(to, content, sendOpts);
          }
          return await slackActionRuntime.sendSlackMessage(to, content ?? "", {
            ...sendOpts,
            blocks,
          });
        };
        const result = preparedMessages?.length
          ? await (async () => {
              let lastResult:
                | Awaited<ReturnType<typeof slackActionRuntime.sendSlackMessage>>
                | undefined;
              if (mediaUrl) {
                lastResult = await slackActionRuntime.sendSlackMessage(to, "", {
                  ...baseSendOpts,
                  mediaUrl,
                });
              }
              for (const [index, message] of preparedMessages.entries()) {
                lastResult = await slackActionRuntime.sendSlackMessage(to, message.text, {
                  ...baseSendOpts,
                  ...(index === 0 && replyBroadcast ? { replyBroadcast: true } : {}),
                  ...(message.blocks ? { blocks: message.blocks } : {}),
                  ...(message.authoredTextPlacement
                    ? { authoredTextPlacement: message.authoredTextPlacement }
                    : {}),
                  ...(Object.hasOwn(message, "nativeDataFallbackBaseText")
                    ? { nativeDataFallbackBaseText: message.nativeDataFallbackBaseText }
                    : {}),
                  ...(message.textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
                });
              }
              if (!lastResult) {
                throw new Error("Slack prepared message plan produced no delivery.");
              }
              return lastResult;
            })()
          : blocks
            ? await (async () => {
                if (mediaUrl) {
                  await slackActionRuntime.sendSlackMessage(to, "", {
                    ...sendOpts,
                    mediaUrl,
                  });
                }
                return await sendContentAndBlocks();
              })()
            : await slackActionRuntime.sendSlackMessage(to, content ?? "", {
                ...sendOpts,
                mediaUrl: mediaUrl ?? undefined,
                blocks,
              });

        // Keep "first" mode consistent even when the agent explicitly provided
        // threadTs: once we send a message to the current channel, consider the
        // first reply "used" so later tool calls don't auto-thread again.
        if (context?.hasRepliedRef && slackContextTargetsMatch(to, context)) {
          context.hasRepliedRef.value = true;
        }

        return jsonResult({ ok: true, result });
      }
      case "uploadFile": {
        const to = readStringParam(params, "to", { required: true });
        const filePath = readStringParam(params, "filePath", {
          required: true,
          trim: false,
        });
        const initialComment = readStringParam(params, "initialComment", {
          allowEmpty: true,
        });
        const filename = readStringParam(params, "filename");
        const title = readStringParam(params, "title");
        const replyBroadcast = readBooleanParam(params, "replyBroadcast");
        if (replyBroadcast) {
          throw new Error(
            "Slack replyBroadcast is only supported for text or block thread replies.",
          );
        }
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
          {
            suppressImplicitThread: params.topLevel === true || params.threadTs === null,
          },
        );
        const result = await slackActionRuntime.sendSlackMessage(to, initialComment ?? "", {
          ...writeOpts,
          mediaUrl: filePath,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
          ...(filename ? { uploadFileName: filename } : {}),
          ...(title ? { uploadTitle: title } : {}),
        });

        if (context?.hasRepliedRef && slackContextTargetsMatch(to, context)) {
          context.hasRepliedRef.value = true;
        }

        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const blocks = readSlackBlocksParam(params);
        if (!content && !blocks) {
          throw new Error("Slack editMessage requires content or blocks.");
        }
        await assertReadTargetAllowed(channelId);
        if (writeOpts) {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            ...writeOpts,
            blocks,
          });
        } else {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            blocks,
          });
        }
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        await assertReadTargetAllowed(channelId);
        if (writeOpts) {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId, writeOpts);
        } else {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId);
        }
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const channelId = resolveChannelId();
        await assertReadTargetAllowed(channelId);
        const limit = readPositiveIntegerParam(params, "limit", {
          message: "limit must be a positive integer.",
        });
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const threadId = readStringParam(params, "threadId");
        const messageId = readStringParam(params, "messageId");
        const result = await slackActionRuntime.readSlackMessages(channelId, {
          ...readOpts,
          limit,
          before: before ?? undefined,
          after: after ?? undefined,
          threadId: threadId ?? undefined,
          messageId: messageId ?? undefined,
        });
        const messages = result.messages.map((message) =>
          withNormalizedTimestamp(
            message as Record<string, unknown>,
            (message as { ts?: unknown }).ts,
          ),
        );
        return jsonResult({
          ok: true,
          channelId,
          ...(threadId ? { threadId } : {}),
          messages,
          hasMore: result.hasMore,
        });
      }
      case "downloadFile": {
        const fileId = readStringParam(params, "fileId", { required: true });
        const channelTarget =
          readStringParam(params, "channelId") ??
          readStringParam(params, "to") ??
          context?.currentChannelId;
        if (!channelTarget) {
          throw new Error(
            "Slack file download requires channelId or to so the read target can be authorized.",
          );
        }
        const channelId = resolveSlackChannelId(channelTarget);
        await assertReadTargetAllowed(channelId);
        const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
        const maxBytes = account.config?.mediaMaxMb
          ? account.config.mediaMaxMb * 1024 * 1024
          : 20 * 1024 * 1024;
        const readToken = getTokenForOperation("read");
        const downloaded = await slackActionRuntime.downloadSlackFile(fileId, {
          ...readOpts,
          ...(readToken && !readOpts?.token ? { token: readToken } : {}),
          maxBytes,
          channelId,
          threadId: threadId ?? undefined,
        });
        if (!downloaded) {
          return jsonResult({
            ok: false,
            error: "File could not be downloaded (not found, too large, or inaccessible).",
          });
        }
        if (!isImageContentType(downloaded.contentType)) {
          return jsonResult({
            ok: true,
            fileId,
            path: downloaded.path,
            contentType: downloaded.contentType,
            placeholder: downloaded.placeholder,
            media: {
              mediaUrl: downloaded.path,
              outbound: false,
              ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            },
          });
        }
        return await imageResultFromFile({
          label: "slack-file",
          path: downloaded.path,
          extraText: downloaded.placeholder,
          details: {
            fileId,
            path: downloaded.path,
            ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            media: { outbound: false },
          },
        });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const channelId = resolveChannelId();
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await assertReadTargetAllowed(channelId);
      if (writeOpts) {
        await slackActionRuntime.pinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.pinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      await assertReadTargetAllowed(channelId);
      if (writeOpts) {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    await assertReadTargetAllowed(channelId);
    const pins = writeOpts
      ? await slackActionRuntime.listSlackPins(channelId, readOpts)
      : await slackActionRuntime.listSlackPins(channelId);
    const normalizedPins = pins.map((pin) => {
      const message = pin.message
        ? withNormalizedTimestamp(
            pin.message as Record<string, unknown>,
            (pin.message as { ts?: unknown }).ts,
          )
        : pin.message;
      return message ? Object.assign({}, pin, { message }) : pin;
    });
    return jsonResult({ ok: true, pins: normalizedPins });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    assertSlackMemberInfoAllowed({ account, context, userId });
    const info = readOpts
      ? await slackActionRuntime.getSlackMemberInfo(userId, readOpts)
      : await slackActionRuntime.getSlackMemberInfo(userId);
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const limit = readPositiveIntegerParam(params, "limit", {
      message: "limit must be a positive integer.",
    });
    const result = readOpts
      ? await slackActionRuntime.listSlackEmojis(readOpts)
      : await slackActionRuntime.listSlackEmojis();
    if (limit != null && limit > 0 && result.emoji != null) {
      const entries = Object.entries(result.emoji).toSorted(([a], [b]) => a.localeCompare(b));
      if (entries.length > limit) {
        return jsonResult({
          ok: true,
          emojis: {
            ...result,
            emoji: Object.fromEntries(entries.slice(0, limit)),
          },
        });
      }
    }
    return jsonResult({ ok: true, emojis: result });
  }

  throw new Error(`Unknown action: ${action}`);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
