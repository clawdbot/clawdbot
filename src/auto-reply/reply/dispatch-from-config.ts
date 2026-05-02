import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { isParentOwnedBackgroundAcpSession } from "../../acp/session-interaction-mode.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { selectAgentHarness } from "../../agents/harness/selection.js";
import {
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicyForSession,
} from "../../agents/pi-tools.policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../agents/subagent-capabilities.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import {
  resolveConversationBindingRecord,
  touchConversationBindingRecord,
} from "../../bindings/records.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { shouldSuppressLocalExecApprovalPrompt } from "../../channels/plugins/exec-approval-local.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import {
  deriveInboundMessageHookContext,
  toPluginInboundClaimContext,
  toPluginInboundClaimEvent,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "../../hooks/message-hook-mappers.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import {
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
  markDiagnosticSessionProgress,
} from "../../logging/diagnostic.js";
import {
  buildPluginBindingDeclinedText,
  buildPluginBindingErrorText,
  buildPluginBindingUnavailableText,
  hasShownPluginBindingFallbackNotice,
  isPluginOwnedSessionBindingRecord,
  markPluginBindingFallbackNoticeShown,
  toPluginConversationBinding,
} from "../../plugins/conversation-binding.js";
import { getGlobalHookRunner, getGlobalPluginRegistry } from "../../plugins/hook-runner-global.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import {
  normalizeTtsAutoMode,
  resolveConfiguredTtsMode,
  shouldCleanTtsDirectiveText,
  shouldAttemptTtsPayload,
} from "../../tts/tts-config.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { BlockReplyContext } from "../get-reply-options.types.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import {
  createInternalHookEvent,
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  triggerInternalHook,
} from "./dispatch-from-config.runtime.js";
import type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./dispatch-from-config.types.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { claimInboundDedupe, commitInboundDedupe, releaseInboundDedupe } from "./inbound-dedupe.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveReplyRoutingDecision } from "./routing-policy.js";
import { resolveSourceReplyVisibilityPolicy } from "./source-reply-delivery-mode.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

let routeReplyRuntimePromise: Promise<typeof import("./route-reply.runtime.js")> | null = null;
let getReplyFromConfigRuntimePromise: Promise<
  typeof import("./get-reply-from-config.runtime.js")
> | null = null;
let abortRuntimePromise: Promise<typeof import("./abort.runtime.js")> | null = null;
let ttsRuntimePromise: Promise<typeof import("../../tts/tts.runtime.js")> | null = null;
let runtimePluginsPromise: Promise<typeof import("./runtime-plugins.runtime.js")> | null = null;
let replyMediaPathsRuntimePromise: Promise<typeof import("./reply-media-paths.runtime.js")> | null =
  null;

function loadRouteReplyRuntime() {
  routeReplyRuntimePromise ??= import("./route-reply.runtime.js");
  return routeReplyRuntimePromise;
}

function loadGetReplyFromConfigRuntime() {
  getReplyFromConfigRuntimePromise ??= import("./get-reply-from-config.runtime.js");
  return getReplyFromConfigRuntimePromise;
}

function loadAbortRuntime() {
  abortRuntimePromise ??= import("./abort.runtime.js");
  return abortRuntimePromise;
}

function loadTtsRuntime() {
  ttsRuntimePromise ??= import("../../tts/tts.runtime.js");
  return ttsRuntimePromise;
}

function loadRuntimePlugins() {
  runtimePluginsPromise ??= import("./runtime-plugins.runtime.js");
  return runtimePluginsPromise;
}

function loadReplyMediaPathsRuntime() {
  replyMediaPathsRuntimePromise ??= import("./reply-media-paths.runtime.js");
  return replyMediaPathsRuntimePromise;
}

async function maybeApplyTtsToReplyPayload(
  params: Parameters<Awaited<ReturnType<typeof loadTtsRuntime>>["maybeApplyTtsToPayload"]>[0],
) {
  if (
    !shouldAttemptTtsPayload({
      cfg: params.cfg,
      ttsAuto: params.ttsAuto,
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId,
    })
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await loadTtsRuntime();
  return maybeApplyTtsToPayload(params);
}

const AUDIO_PLACEHOLDER_RE = /^<media:audio>(\s*\([^)]*\))?$/i;
const AUDIO_HEADER_RE = /^\[Audio\b/i;
const normalizeMediaType = (value: string): string =>
  normalizeOptionalLowercaseString(value.split(";")[0]) ?? "";

const isInboundAudioContext = (ctx: FinalizedMsgContext): boolean => {
  const rawTypes = [
    typeof ctx.MediaType === "string" ? ctx.MediaType : undefined,
    ...(Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : []),
  ].filter(Boolean) as string[];
  const types = rawTypes.map((type) => normalizeMediaType(type));
  if (types.some((type) => type === "audio" || type.startsWith("audio/"))) {
    return true;
  }

  const body =
    typeof ctx.BodyForCommands === "string"
      ? ctx.BodyForCommands
      : typeof ctx.CommandBody === "string"
        ? ctx.CommandBody
        : typeof ctx.RawBody === "string"
          ? ctx.RawBody
          : typeof ctx.Body === "string"
            ? ctx.Body
            : "";
  const trimmed = body.trim();
  if (!trimmed) {
    return false;
  }
  if (AUDIO_PLACEHOLDER_RE.test(trimmed)) {
    return true;
  }
  return AUDIO_HEADER_RE.test(trimmed);
};

const resolveRoutedPolicyConversationType = (
  ctx: FinalizedMsgContext,
): "direct" | "group" | undefined => {
  if (
    ctx.CommandSource === "native" &&
    ctx.CommandTargetSessionKey &&
    ctx.CommandTargetSessionKey !== ctx.SessionKey
  ) {
    return undefined;
  }
  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType === "direct") {
    return "direct";
  }
  if (chatType === "group" || chatType === "channel") {
    return "group";
  }
  return undefined;
};

const resolveSessionStoreLookup = (
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): {
  sessionKey?: string;
  storePath?: string;
  entry?: SessionEntry;
} => {
  const targetSessionKey =
    ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined;
  const sessionKey = normalizeOptionalString(targetSessionKey ?? ctx.SessionKey);
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      sessionKey,
      storePath,
      entry: resolveSessionStoreEntry({ store, sessionKey }).existing,
    };
  } catch {
    return {
      sessionKey,
      storePath,
    };
  }
};

const resolveBoundAcpDispatchSessionKey = (params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}): string | undefined => {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg: params.cfg,
    ctx: params.ctx,
  });
  if (!bindingContext) {
    return undefined;
  }

  const binding = getSessionBindingService().resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  const targetSessionKey = normalizeOptionalString(binding?.targetSessionKey);
  if (!binding || !targetSessionKey || !isAcpSessionKey(targetSessionKey)) {
    return undefined;
  }
  if (isPluginOwnedSessionBindingRecord(binding)) {
    return undefined;
  }
  getSessionBindingService().touch(binding.bindingId);
  return targetSessionKey;
};

const createShouldEmitVerboseProgress = (params: {
  sessionKey?: string;
  storePath?: string;
  fallbackLevel: string;
}) => {
  return () => {
    if (params.sessionKey && params.storePath) {
      try {
        const store = loadSessionStore(params.storePath);
        const entry = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey }).existing;
        const currentLevel = normalizeVerboseLevel(entry?.verboseLevel ?? "");
        if (currentLevel) {
          return currentLevel !== "off";
        }
      } catch {
        // Ignore transient store read failures and fall back to the current dispatch snapshot.
      }
    }
    return params.fallbackLevel !== "off";
  };
};

const resolveHarnessSourceVisibleRepliesDefault = (params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
}): "automatic" | "message_tool" | undefined => {
  if (params.ctx.CommandSource === "native") {
    return undefined;
  }
  try {
    const provider =
      normalizeOptionalString(params.entry?.modelProvider) ??
      normalizeOptionalString(params.ctx.Provider) ??
      normalizeOptionalString(params.ctx.Surface) ??
      "";
    const harness = selectAgentHarness({
      provider,
      modelId: normalizeOptionalString(params.entry?.model),
      config: params.cfg,
      agentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
      agentHarnessId:
        normalizeOptionalString(params.entry?.agentHarnessId) ??
        normalizeOptionalString(params.entry?.agentRuntimeOverride),
    });
    return harness.deliveryDefaults?.sourceVisibleReplies;
  } catch (error) {
    logVerbose(
      `dispatch-from-config: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
};

export type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./dispatch-from-config.types.js";

export async function dispatchReplyFromConfig(
  params: DispatchFromConfigParams,
): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider ?? "unknown");
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey =
    normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.CommandTargetSessionKey);
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled) {
      return;
    }
    logMessageProcessed({
      channel,
      chatId,
      messageId,
      sessionKey,
      durationMs: Date.now() - startTime,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logMessageQueued({ sessionKey, channel, source: "dispatch" });
    logSessionStateChange({
      sessionKey,
      state: "processing",
      reason: "message_start",
    });
  };

  const markIdle = (reason: string) => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    logSessionStateChange({
      sessionKey,
      state: "idle",
      reason,
    });
  };

  const inboundDedupeClaim = claimInboundDedupe(ctx);
  if (inboundDedupeClaim.status === "duplicate" || inboundDedupeClaim.status === "inflight") {
    recordProcessed("skipped", { reason: "duplicate" });
    return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
  }
  let inboundDedupeReplayUnsafe = false;
  const markInboundDedupeReplayUnsafe = () => {
    inboundDedupeReplayUnsafe = true;
  };
  const commitInboundDedupeIfClaimed = () => {
    if (inboundDedupeClaim.status === "claimed") {
      commitInboundDedupe(inboundDedupeClaim.key);
    }
  };

  const initialSessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
  const boundAcpDispatchSessionKey = resolveBoundAcpDispatchSessionKey({ ctx, cfg });
  const acpDispatchSessionKey =
    boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
  const markProgress = () => {
    if (!canTrackSession || !sessionKey) {
      return;
    }
    markDiagnosticSessionProgress({ sessionKey });
    if (acpDispatchSessionKey && acpDispatchSessionKey !== sessionKey) {
      markDiagnosticSessionProgress({ sessionKey: acpDispatchSessionKey });
    }
  };
  const sessionStoreEntry = boundAcpDispatchSessionKey
    ? resolveSessionStoreLookup({ ...ctx, SessionKey: boundAcpDispatchSessionKey }, cfg)
    : initialSessionStoreEntry;
  const sessionAgentId = resolveSessionAgentId({ sessionKey: acpDispatchSessionKey, config: cfg });
  const sessionAgentCfg = resolveAgentConfig(cfg, sessionAgentId);
  const shouldEmitVerboseProgress = createShouldEmitVerboseProgress({
    sessionKey: acpDispatchSessionKey,
    storePath: sessionStoreEntry.storePath,
    fallbackLevel:
      normalizeVerboseLevel(
        sessionStoreEntry.entry?.verboseLevel ??
          sessionAgentCfg?.verboseDefault ??
          cfg.agents?.defaults?.verboseDefault ??
          "",
      ) ?? "off",
  });
  const replyRoute = resolveEffectiveReplyRoute({ ctx, entry: sessionStoreEntry.entry });
  // Restore route thread context only from the active turn or the thread-scoped session key.
  // Do not read thread ids from the normalised session store here: `origin.threadId` can be
  // folded back into lastThreadId/deliveryContext during store normalisation and resurrect a
  // stale route after thread delivery was intentionally cleared.
  const routeThreadId =
    ctx.MessageThreadId ?? parseSessionThreadInfoFast(acpDispatchSessionKey).threadId;
  const inboundAudio = isInboundAudioContext(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const { ensureRuntimePluginsLoaded } = await loadRuntimePlugins();
  ensureRuntimePluginsLoaded({ config: cfg, workspaceDir });
  const hookRunner = getGlobalHookRunner();

  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const hookContext = deriveInboundMessageHookContext(ctx, { messageId: messageIdForHook });
  const { isGroup, groupId } = hookContext;
  const inboundClaimContext = toPluginInboundClaimContext(hookContext);
  const inboundClaimEvent = toPluginInboundClaimEvent(hookContext, {
    commandAuthorized:
      typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : undefined,
    wasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : undefined,
  });

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const suppressAcpChildUserDelivery = isParentOwnedBackgroundAcpSession(sessionStoreEntry.entry);
  const normalizedRouteReplyChannel = normalizeMessageChannel(replyRoute.channel);
  const normalizedProviderChannel = normalizeMessageChannel(ctx.Provider);
  const normalizedSurfaceChannel = normalizeMessageChannel(ctx.Surface);
  const normalizedCurrentSurface = normalizedProviderChannel ?? normalizedSurfaceChannel;
  const isInternalWebchatTurn =
    normalizedCurrentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (normalizedSurfaceChannel === INTERNAL_MESSAGE_CHANNEL || !normalizedSurfaceChannel) &&
    ctx.ExplicitDeliverRoute !== true;
  const hasRouteReplyCandidate = Boolean(
    !suppressAcpChildUserDelivery &&
    !isInternalWebchatTurn &&
    normalizedRouteReplyChannel &&
    replyRoute.to &&
    normalizedRouteReplyChannel !== normalizedCurrentSurface,
  );
  const routeReplyRuntime = hasRouteReplyCandidate ? await loadRouteReplyRuntime() : undefined;
  const {
    originatingChannel: routeReplyChannel,
    currentSurface,
    shouldRouteToOriginating,
    shouldSuppressTyping,
  } = resolveReplyRoutingDecision({
    provider: ctx.Provider,
    surface: ctx.Surface,
    explicitDeliverRoute: ctx.ExplicitDeliverRoute,
    originatingChannel: replyRoute.channel,
    originatingTo: replyRoute.to,
    suppressDirectUserDelivery: suppressAcpChildUserDelivery,
    isRoutableChannel: routeReplyRuntime?.isRoutableChannel ?? (() => false),
  });
  const routeReplyTo = replyRoute.to;
  const deliveryChannel = shouldRouteToOriginating ? routeReplyChannel : currentSurface;
  let normalizeReplyMediaPaths:
    | ReturnType<
        (typeof import("./reply-media-paths.runtime.js"))["createReplyMediaPathNormalizer"]
      >
    | undefined;
  const getNormalizeReplyMediaPaths = async () => {
    if (normalizeReplyMediaPaths) {
      return normalizeReplyMediaPaths;
    }
    const { createReplyMediaPathNormalizer } = await loadReplyMediaPathsRuntime();
    normalizeReplyMediaPaths = createReplyMediaPathNormalizer({
      cfg,
      sessionKey: acpDispatchSessionKey,
      workspaceDir,
      messageProvider: deliveryChannel,
      accountId: replyRoute.accountId,
      groupId,
      groupChannel: ctx.GroupChannel,
      groupSpace: ctx.GroupSpace,
      requesterSenderId: ctx.SenderId,
      requesterSenderName: ctx.SenderName,
      requesterSenderUsername: ctx.SenderUsername,
      requesterSenderE164: ctx.SenderE164,
    });
    return normalizeReplyMediaPaths;
  };
  const normalizeReplyMediaPayload = async (payload: ReplyPayload): Promise<ReplyPayload> => {
    if (!resolveSendableOutboundReplyParts(payload).hasMedia) {
      return payload;
    }
    const normalizeReplyMediaPayloadPaths = await getNormalizeReplyMediaPaths();
    return await normalizeReplyMediaPayloadPaths(payload);
  };

  const routeReplyToOriginating = async (
    payload: ReplyPayload,
    options?: { abortSignal?: AbortSignal; mirror?: boolean },
  ) => {
    if (!shouldRouteToOriginating || !routeReplyChannel || !routeReplyTo || !routeReplyRuntime) {
      return null;
    }
    markInboundDedupeReplayUnsafe();
    return await routeReplyRuntime.routeReply({
      payload,
      channel: routeReplyChannel,
      to: routeReplyTo,
      sessionKey: ctx.SessionKey,
      policySessionKey:
        ctx.CommandSource === "native"
          ? (ctx.CommandTargetSessionKey ?? ctx.SessionKey)
          : ctx.SessionKey,
      policyConversationType: resolveRoutedPolicyConversationType(ctx),
      accountId: replyRoute.accountId,
      requesterSenderId: ctx.SenderId,
      requesterSenderName: ctx.SenderName,
      requesterSenderUsername: ctx.SenderUsername,
      requesterSenderE164: ctx.SenderE164,
      threadId: routeThreadId,
      cfg,
      abortSignal: options?.abortSignal,
      mirror: options?.mirror,
      isGroup,
      groupId,
    });
  };

  /**
   * Helper to send a payload via route-reply (async).
   * Only used when actually routing to a different provider.
   * Note: Only called when shouldRouteToOriginating is true, so
   * routeReplyChannel and routeReplyTo are guaranteed to be defined.
   */
  const sendPayloadAsync = async (
    payload: ReplyPayload,
    abortSignal?: AbortSignal,
    mirror?: boolean,
  ): Promise<void> => {
    // Keep the runtime guard explicit because this helper is called from nested
    // reply callbacks where TypeScript cannot narrow shouldRouteToOriginating.
    if (!routeReplyRuntime || !routeReplyChannel || !routeReplyTo) {
      return;
    }
    if (abortSignal?.aborted) {
      return;
    }
    const result = await routeReplyToOriginating(payload, {
      abortSignal,
      mirror,
    });
    if (result && !result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
  ): Promise<boolean> => {
    const result = await routeReplyToOriginating(payload);
    if (result) {
      if (!result.ok) {
        logVerbose(
          `dispatch-from-config: route-reply (plugin binding notice) failed: ${result.error ?? "unknown error"}`,
        );
      }
      return result.ok;
    }
    markInboundDedupeReplayUnsafe();
    return mode === "additive"
      ? dispatcher.sendToolResult(payload)
      : dispatcher.sendFinalReply(payload);
  };

  const pluginOwnedBindingRecord =
    inboundClaimContext.conversationId && inboundClaimContext.channelId
      ? resolveConversationBindingRecord({
          channel: inboundClaimContext.channelId,
          accountId:
            inboundClaimContext.accountId ??
            ((
              cfg.channels as Record<string, { defaultAccount?: unknown } | undefined> | undefined
            )?.[inboundClaimContext.channelId]?.defaultAccount as string | undefined) ??
            "default",
          conversationId: inboundClaimContext.conversationId,
          parentConversationId: inboundClaimContext.parentConversationId,
        })
      : null;
  const pluginOwnedBinding = isPluginOwnedSessionBindingRecord(pluginOwnedBindingRecord)
    ? toPluginConversationBinding(pluginOwnedBindingRecord)
    : null;

  // Resolve automatic source-delivery suppression early so every outbound path
  // below (plugin-binding notices, fast-abort, normal dispatch) honors it. The
  // agent still processes inbound, but automatic replies/notices/indicators are
  // blocked; explicit message tool sends remain available.
  const sendPolicy = resolveSendPolicy({
    cfg,
    entry: sessionStoreEntry.entry,
    sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
    channel:
      (shouldRouteToOriginating ? routeReplyChannel : undefined) ??
      sessionStoreEntry.entry?.channel ??
      replyRoute.channel ??
      ctx.Surface ??
      ctx.Provider ??
      undefined,
    chatType: sessionStoreEntry.entry?.chatType,
  });
  const {
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: cfg,
    sessionKey: acpDispatchSessionKey,
    agentId: sessionAgentId,
  });
  const chatType = normalizeChatType(ctx.ChatType);
  const configuredVisibleReplies =
    chatType === "group" || chatType === "channel"
      ? (cfg.messages?.groupChat?.visibleReplies ?? cfg.messages?.visibleReplies)
      : cfg.messages?.visibleReplies;
  const harnessDefaultVisibleReplies =
    configuredVisibleReplies === undefined && chatType !== "group" && chatType !== "channel"
      ? resolveHarnessSourceVisibleRepliesDefault({
          cfg,
          ctx,
          entry: sessionStoreEntry.entry,
          sessionAgentId,
          sessionKey: acpDispatchSessionKey,
        })
      : undefined;
  const effectiveVisibleReplies = configuredVisibleReplies ?? harnessDefaultVisibleReplies;
  const prefersMessageToolDelivery =
    params.replyOptions?.sourceReplyDeliveryMode === "message_tool_only" ||
    (params.replyOptions?.sourceReplyDeliveryMode === undefined &&
      ctx.CommandSource !== "native" &&
      (chatType === "group" || chatType === "channel"
        ? effectiveVisibleReplies !== "automatic"
        : effectiveVisibleReplies === "message_tool"));
  const runtimeProfileAlsoAllow = prefersMessageToolDelivery ? ["message"] : [];
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), [
    ...(profileAlsoAllow ?? []),
    ...runtimeProfileAlsoAllow,
  ]);
  const providerProfilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(providerProfile), [
    ...(providerProfileAlsoAllow ?? []),
    ...runtimeProfileAlsoAllow,
  ]);
  const groupResolution = resolveGroupSessionKey(ctx);
  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: ctx.OriginatingChannel,
    provider: ctx.Provider ?? ctx.Surface,
  });
  const groupPolicy = resolveGroupToolPolicy({
    config: cfg,
    sessionKey: acpDispatchSessionKey,
    messageProvider,
    groupId: groupResolution?.id,
    groupChannel:
      normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject),
    groupSpace: normalizeOptionalString(ctx.GroupSpace),
    accountId: ctx.AccountId,
    senderId: normalizeOptionalString(ctx.SenderId),
    senderName: normalizeOptionalString(ctx.SenderName),
    senderUsername: normalizeOptionalString(ctx.SenderUsername),
    senderE164: normalizeOptionalString(ctx.SenderE164),
  });
  const subagentStore = resolveSubagentCapabilityStore(acpDispatchSessionKey, { cfg });
  const subagentPolicy =
    acpDispatchSessionKey &&
    isSubagentEnvelopeSession(acpDispatchSessionKey, {
      cfg,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(cfg, acpDispatchSessionKey, {
          store: subagentStore,
        })
      : undefined;
  const messageToolAvailable = isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    globalProviderPolicy,
    agentProviderPolicy,
    globalPolicy,
    agentPolicy,
    groupPolicy,
    subagentPolicy,
  ]);
  const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
    cfg,
    ctx,
    requested: params.replyOptions?.sourceReplyDeliveryMode,
    sendPolicy,
    suppressAcpChildUserDelivery,
    explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
    shouldSuppressTyping,
    messageToolAvailable,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
  });
  const {
    sourceReplyDeliveryMode,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    deliverySuppressionReason,
    suppressHookUserDelivery,
    suppressHookReplyLifecycle,
  } = sourceReplyPolicy;

  let pluginFallbackReason:
    | "plugin-bound-fallback-missing-plugin"
    | "plugin-bound-fallback-no-handler"
    | undefined;

  if (pluginOwnedBinding) {
    touchConversationBindingRecord(pluginOwnedBinding.bindingId);
    if (suppressDelivery) {
      // Plugin-bound inbound handlers typically emit outbound replies we
      // cannot rewind. When automatic delivery is suppressed, skip the plugin
      // claim and fall through to normal suppressed agent processing.
      logVerbose(
        `plugin-bound inbound skipped under ${deliverySuppressionReason} (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to suppressed agent processing`,
      );
    } else {
      logVerbose(
        `plugin-bound inbound routed to ${pluginOwnedBinding.pluginId} conversation=${pluginOwnedBinding.conversationId}`,
      );
      const targetedClaimOutcome = hookRunner?.runInboundClaimForPluginOutcome
        ? await hookRunner.runInboundClaimForPluginOutcome(
            pluginOwnedBinding.pluginId,
            inboundClaimEvent,
            { ...inboundClaimContext, pluginBinding: pluginOwnedBinding },
          )
        : (() => {
            const pluginLoaded =
              getGlobalPluginRegistry()?.plugins.some(
                (plugin) => plugin.id === pluginOwnedBinding.pluginId && plugin.status === "loaded",
              ) ?? false;
            return pluginLoaded
              ? ({ status: "no_handler" } as const)
              : ({ status: "missing_plugin" } as const);
          })();

      switch (targetedClaimOutcome.status) {
        case "handled": {
          if (targetedClaimOutcome.result.reply) {
            await sendBindingNotice(targetedClaimOutcome.result.reply, "terminal");
          }
          markIdle("plugin_binding_dispatch");
          recordProcessed("completed", { reason: "plugin-bound-handled" });
          commitInboundDedupeIfClaimed();
          return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
        }
        case "missing_plugin":
        case "no_handler": {
          pluginFallbackReason =
            targetedClaimOutcome.status === "missing_plugin"
              ? "plugin-bound-fallback-missing-plugin"
              : "plugin-bound-fallback-no-handler";
          if (!hasShownPluginBindingFallbackNotice(pluginOwnedBinding.bindingId)) {
            const didSendNotice = await sendBindingNotice(
              { text: buildPluginBindingUnavailableText(pluginOwnedBinding) },
              "additive",
            );
            if (didSendNotice) {
              markPluginBindingFallbackNoticeShown(pluginOwnedBinding.bindingId);
            }
          }
          break;
        }
        case "declined": {
          await sendBindingNotice(
            { text: buildPluginBindingDeclinedText(pluginOwnedBinding) },
            "terminal",
          );
          markIdle("plugin_binding_declined");
          recordProcessed("completed", { reason: "plugin-bound-declined" });
          commitInboundDedupeIfClaimed();
          return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
        }
        case "error": {
          logVerbose(
            `plugin-bound inbound claim failed for ${pluginOwnedBinding.pluginId}: ${targetedClaimOutcome.error}`,
          );
          await sendBindingNotice(
            { text: buildPluginBindingErrorText(pluginOwnedBinding) },
            "terminal",
          );
          markIdle("plugin_binding_error");
          recordProcessed("completed", { reason: "plugin-bound-error" });
          commitInboundDedupeIfClaimed();
          return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
        }
      }
    }
  }

  // Trigger plugin hooks (fire-and-forget)
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetHook(
      hookRunner.runMessageReceived(
        toPluginMessageReceivedEvent(hookContext),
        toPluginMessageContext(hookContext),
      ),
      "dispatch-from-config: message_received plugin hook failed",
    );
  }

  // Bridge to internal hooks (HOOK.md discovery system) - refs #8807
  if (sessionKey) {
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent("message", "received", sessionKey, {
          ...toInternalMessageReceivedContext(hookContext),
          timestamp,
        }),
      ),
      "dispatch-from-config: message_received internal hook failed",
    );
  }

  markProcessing();

  try {
    const abortRuntime = params.fastAbortResolver ? null : await loadAbortRuntime();
    const fastAbortResolver = params.fastAbortResolver ?? abortRuntime?.tryFastAbortFromMessage;
    const formatAbortReplyTextResolver =
      params.formatAbortReplyTextResolver ?? abortRuntime?.formatAbortReplyText;
    if (!fastAbortResolver || !formatAbortReplyTextResolver) {
      throw new Error("abort runtime unavailable");
    }
    const fastAbort = await fastAbortResolver({ ctx, cfg });
    if (fastAbort.handled) {
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (!suppressDelivery) {
        const payload = {
          text: formatAbortReplyTextResolver(fastAbort.stoppedSubagents),
        } satisfies ReplyPayload;
        const result = await routeReplyToOriginating(payload);
        if (result) {
          queuedFinal = result.ok;
          if (result.ok) {
            routedFinalCount += 1;
          }
          if (!result.ok) {
            logVerbose(
              `dispatch-from-config: route-reply (abort) failed: ${result.error ?? "unknown error"}`,
            );
          }
        } else {
          markInboundDedupeReplayUnsafe();
          queuedFinal = dispatcher.sendFinalReply(payload);
        }
      } else {
        logVerbose(
          `dispatch-from-config: fast_abort reply suppressed by ${deliverySuppressionReason} (session=${sessionKey ?? "unknown"})`,
        );
      }
      const counts = dispatcher.getQueuedCounts();
      counts.final += routedFinalCount;
      recordProcessed("completed", { reason: "fast_abort" });
      markIdle("message_completed");
      commitInboundDedupeIfClaimed();
      return { queuedFinal, counts };
    }

    const isSlackNonDirectSurface =
      (ctx.Surface === "slack" || ctx.Provider === "slack") && ctx.ChatType !== "direct";
    const shouldSendVerboseProgressMessages =
      !isSlackNonDirectSurface && (ctx.ChatType !== "group" || ctx.IsForum === true);
    const shouldSendToolSummaries = shouldSendVerboseProgressMessages;
    const shouldSendToolStartStatuses = shouldSendVerboseProgressMessages;
    const sendFinalPayload = async (
      payload: ReplyPayload,
    ): Promise<{ queuedFinal: boolean; routedFinalCount: number }> => {
      if (resolveSendableOutboundReplyParts(payload).hasContent) {
        markInboundDedupeReplayUnsafe();
      }
      const ttsPayload = await maybeApplyTtsToReplyPayload({
        payload,
        cfg,
        channel: deliveryChannel,
        kind: "final",
        inboundAudio,
        ttsAuto: sessionTtsAuto,
        agentId: sessionAgentId,
        accountId: replyRoute.accountId,
      });
      const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
      const result = await routeReplyToOriginating(normalizedPayload);
      if (result) {
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        return {
          queuedFinal: result.ok,
          routedFinalCount: result.ok ? 1 : 0,
        };
      }
      markInboundDedupeReplayUnsafe();
      return {
        queuedFinal: dispatcher.sendFinalReply(normalizedPayload),
        routedFinalCount: 0,
      };
    };

    // Run before_dispatch hook — let plugins inspect or handle before model dispatch.
    if (hookRunner?.hasHooks("before_dispatch")) {
      const beforeDispatchResult = await hookRunner.runBeforeDispatch(
        {
          content: hookContext.content,
          body: hookContext.bodyForAgent ?? hookContext.body,
          channel: hookContext.channelId,
          sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
          senderId: hookContext.senderId,
          isGroup: hookContext.isGroup,
          timestamp: hookContext.timestamp,
        },
        {
          channelId: hookContext.channelId,
          accountId: hookContext.accountId,
          conversationId: inboundClaimContext.conversationId,
          sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
          senderId: hookContext.senderId,
        },
      );
      if (beforeDispatchResult?.handled) {
        const text = beforeDispatchResult.text;
        let queuedFinal = false;
        let routedFinalCount = 0;
        if (text && !suppressDelivery) {
          const handledReply = await sendFinalPayload({ text });
          queuedFinal = handledReply.queuedFinal;
          routedFinalCount += handledReply.routedFinalCount;
        }
        const counts = dispatcher.getQueuedCounts();
        counts.final += routedFinalCount;
        recordProcessed("completed", { reason: "before_dispatch_handled" });
        markIdle("message_completed");
        commitInboundDedupeIfClaimed();
        return { queuedFinal, counts };
      }
    }

    if (hookRunner?.hasHooks("reply_dispatch")) {
      const replyDispatchResult = await hookRunner.runReplyDispatch(
        {
          ctx,
          runId: params.replyOptions?.runId,
          sessionKey: acpDispatchSessionKey,
          images: params.replyOptions?.images,
          inboundAudio,
          sessionTtsAuto,
          ttsChannel: deliveryChannel,
          suppressUserDelivery: suppressHookUserDelivery,
          suppressReplyLifecycle: suppressHookReplyLifecycle,
          sourceReplyDeliveryMode,
          shouldRouteToOriginating,
          originatingChannel: routeReplyChannel,
          originatingTo: routeReplyTo,
          shouldSendToolSummaries,
          sendPolicy,
        },
        {
          cfg,
          dispatcher,
          abortSignal: params.replyOptions?.abortSignal,
          onReplyStart: params.replyOptions?.onReplyStart,
          recordProcessed,
          markIdle,
        },
      );
      if (replyDispatchResult?.handled) {
        commitInboundDedupeIfClaimed();
        return {
          queuedFinal: replyDispatchResult.queuedFinal,
          counts: replyDispatchResult.counts,
        };
      }
    }

    // When automatic source delivery is suppressed, still let the agent process
    // the inbound message (context, memory, tool calls) but suppress automatic
    // outbound source delivery.
    if (suppressDelivery) {
      logVerbose(
        `Delivery suppressed by ${deliverySuppressionReason} for session ${sessionStoreEntry.sessionKey ?? sessionKey ?? "unknown"} — agent will still process the message`,
      );
    }

    const toolStartStatusesSent = new Set<string>();
    let toolStartStatusCount = 0;
    const normalizeWorkingLabel = (label: string) => {
      const collapsed = label.replace(/\s+/g, " ").trim();
      if (collapsed.length <= 80) {
        return collapsed;
      }
      return `${collapsed.slice(0, 77).trimEnd()}...`;
    };
    const formatPlanUpdateText = (payload: { explanation?: string; steps?: string[] }) => {
      const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
      const steps = (payload.steps ?? [])
        .map((step) => step.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const parts: string[] = [];
      if (explanation) {
        parts.push(explanation);
      }
      if (steps.length > 0) {
        parts.push(steps.map((step, index) => `${index + 1}. ${step}`).join("\n"));
      }
      return parts.join("\n\n").trim() || "Planning next steps.";
    };
    const maybeSendWorkingStatus = async (label: string): Promise<void> => {
      if (suppressDelivery) {
        return;
      }
      const normalizedLabel = normalizeWorkingLabel(label);
      if (
        !shouldEmitVerboseProgress() ||
        !shouldSendToolStartStatuses ||
        !normalizedLabel ||
        toolStartStatusCount >= 2 ||
        toolStartStatusesSent.has(normalizedLabel)
      ) {
        return;
      }
      toolStartStatusesSent.add(normalizedLabel);
      toolStartStatusCount += 1;
      const payload: ReplyPayload = {
        text: `Working: ${normalizedLabel}`,
      };
      if (shouldRouteToOriginating) {
        await sendPayloadAsync(payload, undefined, false);
        return;
      }
      markInboundDedupeReplayUnsafe();
      dispatcher.sendToolResult(payload);
    };
    const sendPlanUpdate = async (payload: {
      explanation?: string;
      steps?: string[];
    }): Promise<void> => {
      if (suppressDelivery || !shouldEmitVerboseProgress() || !shouldSendVerboseProgressMessages) {
        return;
      }
      const replyPayload: ReplyPayload = {
        text: formatPlanUpdateText(payload),
      };
      if (shouldRouteToOriginating) {
        await sendPayloadAsync(replyPayload, undefined, false);
        return;
      }
      markInboundDedupeReplayUnsafe();
      dispatcher.sendToolResult(replyPayload);
    };
    const summarizeApprovalLabel = (payload: {
      status?: string;
      command?: string;
      message?: string;
    }) => {
      if (payload.status === "pending") {
        const command = normalizeOptionalString(payload.command);
        if (command) {
          return normalizeWorkingLabel(`awaiting approval: ${command}`);
        }
        return "awaiting approval";
      }
      if (payload.status === "unavailable") {
        const message = normalizeOptionalString(payload.message);
        if (message) {
          return normalizeWorkingLabel(message);
        }
        return "approval unavailable";
      }
      return "";
    };
    const summarizePatchLabel = (payload: { summary?: string; title?: string }) => {
      const summary = normalizeOptionalString(payload.summary);
      if (summary) {
        return normalizeWorkingLabel(summary);
      }
      const title = normalizeOptionalString(payload.title);
      if (title) {
        return normalizeWorkingLabel(title);
      }
      return "";
    };
    // Track accumulated block text for TTS generation after streaming completes.
    // When block streaming succeeds, there's no final reply, so we need to generate
    // TTS audio separately from the accumulated block content.
    let accumulatedBlockText = "";
    let accumulatedBlockTtsText = "";
    let blockCount = 0;
    const cleanBlockTtsDirectiveText = shouldCleanTtsDirectiveText({
      cfg,
      ttsAuto: sessionTtsAuto,
      agentId: sessionAgentId,
      channelId: deliveryChannel,
      accountId: replyRoute.accountId,
    })
      ? createTtsDirectiveTextStreamCleaner()
      : undefined;

    const resolveToolDeliveryPayload = (payload: ReplyPayload): ReplyPayload | null => {
      if (
        shouldSuppressLocalExecApprovalPrompt({
          channel: normalizeMessageChannel(ctx.Surface ?? ctx.Provider),
          cfg,
          accountId: ctx.AccountId,
          payload,
        })
      ) {
        return null;
      }
      if (shouldSendToolSummaries) {
        return payload;
      }
      const execApproval =
        payload.channelData &&
        typeof payload.channelData === "object" &&
        !Array.isArray(payload.channelData)
          ? payload.channelData.execApproval
          : undefined;
      if (execApproval && typeof execApproval === "object" && !Array.isArray(execApproval)) {
        return payload;
      }
      // Group/native flows intentionally suppress tool summary text, but media-only
      // tool results (for example TTS audio) must still be delivered.
      const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
      if (!hasMedia) {
        return null;
      }
      return { ...payload, text: undefined };
    };
    const typing = resolveRunTypingPolicy({
      requestedPolicy: params.replyOptions?.typingPolicy,
      suppressTyping: sourceReplyPolicy.suppressTyping,
      originatingChannel: routeReplyChannel,
      systemEvent: shouldRouteToOriginating,
    });
    const suppressDefaultToolProgressMessages =
      params.replyOptions?.suppressDefaultToolProgressMessages === true;
    const onToolResultFromReplyOptions = params.replyOptions?.onToolResult;
    const onPlanUpdateFromReplyOptions = params.replyOptions?.onPlanUpdate;
    const onApprovalEventFromReplyOptions = params.replyOptions?.onApprovalEvent;
    const onPatchSummaryFromReplyOptions = params.replyOptions?.onPatchSummary;
    const wrapProgressCallback = <Args extends unknown[]>(
      callback: ((...args: Args) => Promise<void> | void) | undefined,
    ): ((...args: Args) => Promise<void>) | undefined => {
      if (!callback && (!suppressAutomaticSourceDelivery || !canTrackSession)) {
        return undefined;
      }
      return async (...args: Args) => {
        markProgress();
        if (!suppressAutomaticSourceDelivery) {
          await callback?.(...args);
        }
      };
    };

    const replyResolver =
      params.replyResolver ?? (await loadGetReplyFromConfigRuntime()).getReplyFromConfig;
    const replyConfig = withFullRuntimeReplyConfig(
      params.configOverride ? (applyMergePatch(cfg, params.configOverride) as OpenClawConfig) : cfg,
    );
    const replyResult = await replyResolver(
      ctx,
      {
        ...params.replyOptions,
        sourceReplyDeliveryMode,
        typingPolicy: typing.typingPolicy,
        suppressTyping: typing.suppressTyping,
        onPartialReply: wrapProgressCallback(params.replyOptions?.onPartialReply),
        onReasoningStream: wrapProgressCallback(params.replyOptions?.onReasoningStream),
        onReasoningEnd: wrapProgressCallback(params.replyOptions?.onReasoningEnd),
        onAssistantMessageStart: wrapProgressCallback(params.replyOptions?.onAssistantMessageStart),
        onBlockReplyQueued: wrapProgressCallback(params.replyOptions?.onBlockReplyQueued),
        onToolStart: wrapProgressCallback(params.replyOptions?.onToolStart),
        onItemEvent: wrapProgressCallback(params.replyOptions?.onItemEvent),
        onCommandOutput: wrapProgressCallback(params.replyOptions?.onCommandOutput),
        onCompactionStart: wrapProgressCallback(params.replyOptions?.onCompactionStart),
        onCompactionEnd: wrapProgressCallback(params.replyOptions?.onCompactionEnd),
        onToolResult: (payload: ReplyPayload) => {
          markProgress();
          const run = async () => {
            markInboundDedupeReplayUnsafe();
            if (!suppressAutomaticSourceDelivery) {
              await onToolResultFromReplyOptions?.(payload);
            }
            if (suppressDelivery) {
              return;
            }
            const ttsPayload = await maybeApplyTtsToReplyPayload({
              payload,
              cfg,
              channel: deliveryChannel,
              kind: "tool",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
              agentId: sessionAgentId,
              accountId: replyRoute.accountId,
            });
            const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
            const deliveryPayload = resolveToolDeliveryPayload(normalizedPayload);
            if (!deliveryPayload) {
              return;
            }
            if (suppressDefaultToolProgressMessages) {
              const hasMedia = resolveSendableOutboundReplyParts(deliveryPayload).hasMedia;
              const execApproval =
                deliveryPayload.channelData &&
                typeof deliveryPayload.channelData === "object" &&
                !Array.isArray(deliveryPayload.channelData)
                  ? deliveryPayload.channelData.execApproval
                  : undefined;
              const hasExecApproval =
                execApproval && typeof execApproval === "object" && !Array.isArray(execApproval);
              if (!hasMedia && !hasExecApproval && deliveryPayload.isError !== true) {
                return;
              }
            }
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(deliveryPayload, undefined, false);
            } else {
              markInboundDedupeReplayUnsafe();
              dispatcher.sendToolResult(deliveryPayload);
            }
          };
          return run();
        },
        onPlanUpdate: async (payload) => {
          markProgress();
          markInboundDedupeReplayUnsafe();
          if (!suppressAutomaticSourceDelivery) {
            await onPlanUpdateFromReplyOptions?.(payload);
          }
          if (payload.phase !== "update" || suppressDefaultToolProgressMessages) {
            return;
          }
          await sendPlanUpdate({ explanation: payload.explanation, steps: payload.steps });
        },
        onApprovalEvent: async (payload) => {
          markProgress();
          markInboundDedupeReplayUnsafe();
          if (!suppressAutomaticSourceDelivery) {
            await onApprovalEventFromReplyOptions?.(payload);
          }
          if (payload.phase !== "requested" || suppressDefaultToolProgressMessages) {
            return;
          }
          const label = summarizeApprovalLabel({
            status: payload.status,
            command: payload.command,
            message: payload.message,
          });
          if (!label) {
            return;
          }
          await maybeSendWorkingStatus(label);
        },
        onPatchSummary: async (payload) => {
          markProgress();
          markInboundDedupeReplayUnsafe();
          if (!suppressAutomaticSourceDelivery) {
            await onPatchSummaryFromReplyOptions?.(payload);
          }
          if (payload.phase !== "end" || suppressDefaultToolProgressMessages) {
            return;
          }
          const label = summarizePatchLabel({ summary: payload.summary, title: payload.title });
          if (!label) {
            return;
          }
          await maybeSendWorkingStatus(label);
        },
        onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => {
          markProgress();
          const run = async () => {
            if (
              payload.isReasoning !== true &&
              resolveSendableOutboundReplyParts(payload).hasContent
            ) {
              markInboundDedupeReplayUnsafe();
            }
            if (suppressDelivery) {
              return;
            }
            // Suppress reasoning payloads — channels using this generic dispatch
            // path (WhatsApp, web, etc.) do not have a dedicated reasoning lane.
            // Telegram has its own dispatch path that handles reasoning splitting.
            if (payload.isReasoning === true) {
              return;
            }
            // Accumulate block text for TTS generation after streaming.
            // Exclude compaction status notices — they are informational UI
            // signals and must not be synthesised into the spoken reply.
            if (payload.text && !payload.isCompactionNotice) {
              const joinsBufferedTtsDirective =
                cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
              if (accumulatedBlockText.length > 0) {
                accumulatedBlockText += "\n";
              }
              accumulatedBlockText += payload.text;
              if (accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) {
                accumulatedBlockTtsText += "\n";
              }
              accumulatedBlockTtsText += payload.text;
              blockCount++;
            }
            const visiblePayload =
              payload.text && cleanBlockTtsDirectiveText && !payload.isCompactionNotice
                ? (() => {
                    const text = cleanBlockTtsDirectiveText.push(payload.text);
                    return { ...payload, text: text.trim() ? text : undefined };
                  })()
                : payload;
            if (!resolveSendableOutboundReplyParts(visiblePayload).hasContent) {
              return;
            }
            // Channels that keep a live draft preview may need to rotate their
            // preview state at the logical block boundary before queued block
            // delivery drains asynchronously through the dispatcher.
            const payloadMetadata = getReplyPayloadMetadata(payload);
            const queuedContext =
              payloadMetadata?.assistantMessageIndex !== undefined
                ? {
                    ...context,
                    assistantMessageIndex: payloadMetadata.assistantMessageIndex,
                  }
                : context;
            if (!suppressAutomaticSourceDelivery) {
              await params.replyOptions?.onBlockReplyQueued?.(visiblePayload, queuedContext);
            }
            const ttsPayload = await maybeApplyTtsToReplyPayload({
              payload: visiblePayload,
              cfg,
              channel: deliveryChannel,
              kind: "block",
              inboundAudio,
              ttsAuto: sessionTtsAuto,
              agentId: sessionAgentId,
              accountId: replyRoute.accountId,
            });
            const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
            if (shouldRouteToOriginating) {
              await sendPayloadAsync(normalizedPayload, context?.abortSignal, false);
            } else {
              markInboundDedupeReplayUnsafe();
              dispatcher.sendBlockReply(normalizedPayload);
            }
          };
          return run();
        },
      },
      replyConfig,
    );

    if (ctx.AcpDispatchTailAfterReset === true) {
      // Command handling prepared a trailing prompt after ACP in-place reset.
      // Route that tail through ACP now (same turn) instead of embedded dispatch.
      ctx.AcpDispatchTailAfterReset = false;
      if (hookRunner?.hasHooks("reply_dispatch")) {
        const tailDispatchResult = await hookRunner.runReplyDispatch(
          {
            ctx,
            runId: params.replyOptions?.runId,
            sessionKey: acpDispatchSessionKey,
            images: params.replyOptions?.images,
            inboundAudio,
            sessionTtsAuto,
            ttsChannel: deliveryChannel,
            suppressUserDelivery: suppressHookUserDelivery,
            suppressReplyLifecycle: suppressHookReplyLifecycle,
            sourceReplyDeliveryMode,
            shouldRouteToOriginating,
            originatingChannel: routeReplyChannel,
            originatingTo: routeReplyTo,
            shouldSendToolSummaries,
            sendPolicy,
            isTailDispatch: true,
          },
          {
            cfg,
            dispatcher,
            abortSignal: params.replyOptions?.abortSignal,
            onReplyStart: params.replyOptions?.onReplyStart,
            recordProcessed,
            markIdle,
          },
        );
        if (tailDispatchResult?.handled) {
          return {
            queuedFinal: tailDispatchResult.queuedFinal,
            counts: tailDispatchResult.counts,
          };
        }
      }
    }

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];

    let queuedFinal = false;
    let routedFinalCount = 0;
    if (!suppressDelivery) {
      for (const reply of replies) {
        // Suppress reasoning payloads from channel delivery — channels using this
        // generic dispatch path do not have a dedicated reasoning lane.
        if (reply.isReasoning === true) {
          continue;
        }
        const finalReply = await sendFinalPayload(reply);
        queuedFinal = finalReply.queuedFinal || queuedFinal;
        routedFinalCount += finalReply.routedFinalCount;
      }

      const ttsMode = resolveConfiguredTtsMode(cfg, {
        agentId: sessionAgentId,
        channelId: deliveryChannel,
        accountId: replyRoute.accountId,
      });
      // Generate TTS-only reply after block streaming completes (when there's no final reply).
      // This handles the case where block streaming succeeds and drops final payloads,
      // but we still want TTS audio to be generated from the accumulated block content.
      if (
        ttsMode === "final" &&
        replies.length === 0 &&
        blockCount > 0 &&
        accumulatedBlockTtsText.trim()
      ) {
        try {
          const ttsSyntheticReply = await maybeApplyTtsToReplyPayload({
            payload: { text: accumulatedBlockTtsText },
            cfg,
            channel: deliveryChannel,
            kind: "final",
            inboundAudio,
            ttsAuto: sessionTtsAuto,
            agentId: sessionAgentId,
            accountId: replyRoute.accountId,
          });
          // Only send if TTS was actually applied (mediaUrl exists)
          if (ttsSyntheticReply.mediaUrl) {
            // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content.
            // Keep the spoken text only for hooks/archive consumers.
            const ttsOnlyPayload: ReplyPayload = {
              mediaUrl: ttsSyntheticReply.mediaUrl,
              audioAsVoice: ttsSyntheticReply.audioAsVoice,
              spokenText: accumulatedBlockTtsText,
            };
            const normalizedTtsOnlyPayload = await normalizeReplyMediaPayload(ttsOnlyPayload);
            const result = await routeReplyToOriginating(normalizedTtsOnlyPayload);
            if (result) {
              queuedFinal = result.ok || queuedFinal;
              if (result.ok) {
                routedFinalCount += 1;
              }
              if (!result.ok) {
                logVerbose(
                  `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
                );
              }
            } else {
              markInboundDedupeReplayUnsafe();
              const didQueue = dispatcher.sendFinalReply(normalizedTtsOnlyPayload);
              queuedFinal = didQueue || queuedFinal;
            }
          }
        } catch (err) {
          logVerbose(
            `dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(err)}`,
          );
        }
      }
    }

    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    commitInboundDedupeIfClaimed();
    recordProcessed(
      "completed",
      pluginFallbackReason ? { reason: pluginFallbackReason } : undefined,
    );
    markIdle("message_completed");
    return { queuedFinal, counts };
  } catch (err) {
    if (inboundDedupeClaim.status === "claimed") {
      if (inboundDedupeReplayUnsafe) {
        commitInboundDedupe(inboundDedupeClaim.key);
      } else {
        releaseInboundDedupe(inboundDedupeClaim.key);
      }
    }
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    throw err;
  }
}
