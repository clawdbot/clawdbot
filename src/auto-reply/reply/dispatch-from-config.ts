/** Main reply dispatch pipeline from finalized config/context to delivery payloads. */
import crypto from "node:crypto";
import { isParentOwnedBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  hasOutboundReplyContent,
  isFastModeAutoProgressPayload,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../../agents/agent-tools.policy.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { selectAgentHarness } from "../../agents/harness/selection.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../../agents/subagent-capabilities.js";
import { isToolAllowedByPolicies } from "../../agents/tool-policy-match.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../agents/tool-policy.js";
import {
  resolveConversationBindingRecord,
  touchConversationBindingRecord,
} from "../../bindings/records.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { shouldSuppressLocalExecApprovalPrompt } from "../../channels/plugins/exec-approval-local.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { normalizeExplicitSessionKey } from "../../config/sessions/explicit-session-key-normalization.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  appendAssistantMessageToSessionTranscript,
  type SessionTranscriptDeliveryMirror,
} from "../../config/sessions/transcript.js";
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
import { isAbortError } from "../../infra/abort-signal.js";
import { isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import {
  logMessageDispatchCompleted,
  logMessageDispatchStarted,
  markDiagnosticSessionProgress,
} from "../../logging/diagnostic.js";
import { createDiagnosticMessageLifecycle } from "../../logging/message-lifecycle.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { matchPluginCommand } from "../../plugins/commands.js";
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
import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveSilentReplyPolicyFromPolicies } from "../../shared/silent-reply-policy.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import {
  normalizeTtsAutoMode,
  resolveConfiguredTtsMode,
  shouldCleanTtsDirectiveText,
  shouldAttemptTtsPayload,
} from "../../tts/tts-config.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import {
  isNativeCommandTurn,
  resolveCommandTurnContext,
  resolveCommandTurnTargetSessionKey,
} from "../command-turn-context.js";
import {
  findCommandByNativeName,
  normalizeCommandBody,
  resolveTextCommand,
} from "../commands-registry.js";
import { registerReplyDispatcherSettledTask } from "../dispatch-dispatcher.js";
import type { BlockReplyContext, GetReplyOptions } from "../get-reply-options.types.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  markReplyPayloadAsTtsSupplement,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import {
  takeCommandSessionMetadataChanges,
  type CommandSessionMetadataChange,
} from "./command-session-metadata.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import {
  createInternalHookEvent,
  loadSessionStore,
  readSessionEntry,
  resolveSessionStoreEntry,
  resolveStorePath,
  triggerInternalHook,
  updateSessionStoreEntry,
} from "./dispatch-from-config.runtime.js";
import type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./dispatch-from-config.types.js";
import { resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import type { ReplySessionBinding } from "./get-reply.types.js";
import { claimInboundDedupe, commitInboundDedupe, releaseInboundDedupe } from "./inbound-dedupe.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import {
  appendReplyDispatcherBeforeDeliverCancelled,
  waitForReplyDispatcherIdle,
} from "./reply-dispatcher.js";
import type {
  DispatcherOutcomeCountsView,
  ReplyDispatchKind,
  ReplyDispatcher,
} from "./reply-dispatcher.types.js";
import { readDispatcherFailedCounts } from "./reply-dispatcher.types.js";
import {
  forceClearReplyRunBySessionId,
  replyRunRegistry,
  type ReplyOperation,
  waitForReplyBarrierSettlement,
} from "./reply-run-registry.js";
import {
  createReplyDeliveryContext,
  resolveReplyDeliveryAccountId,
  resolveReplyToMode,
} from "./reply-threading.js";
import { isReplyProfilerEnabled } from "./reply-timing-tracker.js";
import {
  admitReplyTurn,
  resolveReplyTurnKind,
  runWithReplyOperationLifecycleAdmission,
} from "./reply-turn-admission.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";
import { resolveReplyRoutingDecision } from "./routing-policy.js";
import {
  isExplicitSourceReplyCommand,
  isUnauthorizedTextSlashCommand,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";
import { stageRemoteInboundMediaIfNeeded } from "./stage-remote-inbound-media.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";

type SourceReplyTranscriptMirror = NonNullable<
  NonNullable<ReturnType<typeof getReplyPayloadMetadata>>["sourceReplyTranscriptMirror"]
>;
type TranscriptMirror = SourceReplyTranscriptMirror & {
  expectedSessionId?: string;
  storePath?: string;
  preferText?: boolean;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  transcriptOwner?: boolean;
};
type InternalReplyResolverOptions = {
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
};

function createFinalDispatchPayloadDedupeKey(payload: ReplyPayload): string {
  const metadata = getReplyPayloadMetadata(payload);
  return JSON.stringify({
    payload: {
      text: payload.text,
      mediaUrl: payload.mediaUrl,
      mediaUrls: payload.mediaUrls,
      trustedLocalMedia: payload.trustedLocalMedia,
      sensitiveMedia: payload.sensitiveMedia,
      presentation: payload.presentation,
      delivery: payload.delivery,
      interactive: payload.interactive,
      btw: payload.btw,
      replyToId: payload.replyToId,
      replyToTag: payload.replyToTag,
      replyToCurrent: payload.replyToCurrent,
      audioAsVoice: payload.audioAsVoice,
      spokenText: payload.spokenText,
      ttsSupplement: payload.ttsSupplement,
      isError: payload.isError,
      isReasoning: payload.isReasoning,
      isCommentary: payload.isCommentary,
      isReasoningSnapshot: payload.isReasoningSnapshot,
      isCompactionNotice: payload.isCompactionNotice,
      isFallbackNotice: payload.isFallbackNotice,
      isStatusNotice: payload.isStatusNotice,
      channelData: payload.channelData,
    },
    identity: {
      assistantMessageIndex: metadata?.assistantMessageIndex,
      assistantTranscriptOwned: metadata?.assistantTranscriptOwned,
      replyToIdExplicit: metadata?.replyToIdExplicit,
      replyDelivery: metadata?.replyDelivery,
      replyDeliverySource: metadata?.replyDeliverySource,
      sourceReplyTranscriptMirror: metadata?.sourceReplyTranscriptMirror,
    },
  });
}

class DispatchReplyOperationAbortedError extends Error {
  constructor() {
    super("Dispatch reply operation aborted");
    this.name = "AbortError";
  }
}

function isDispatchReplyOperationAbortedError(
  error: unknown,
): error is DispatchReplyOperationAbortedError {
  return error instanceof DispatchReplyOperationAbortedError;
}

function isRecoverableTerminalSessionStatus(status: SessionEntry["status"] | undefined): boolean {
  return status === "failed" || status === "timeout" || status === "killed";
}

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals: AbortSignal[] = [];
  for (const signal of signals) {
    if (signal && !activeSignals.includes(signal)) {
      activeSignals.push(signal);
    }
  }
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort(signal);
      return controller.signal;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

function routeThreadIdsDiffer(
  left: string | number | undefined,
  right: string | number | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }
  return String(left) !== String(right);
}

function isSlackDirectRoutedThreadTurn(
  ctx: Pick<
    FinalizedMsgContext,
    | "ChatType"
    | "MessageThreadId"
    | "OriginatingChannel"
    | "Provider"
    | "Surface"
    | "TransportThreadId"
  >,
): boolean {
  if (normalizeChatType(ctx.ChatType) !== "direct") {
    return false;
  }
  if (ctx.MessageThreadId == null && ctx.TransportThreadId == null) {
    return false;
  }
  return [ctx.Provider, ctx.Surface, ctx.OriginatingChannel].some(
    (value) => normalizeOptionalString(value)?.toLowerCase() === "slack",
  );
}

function shouldLetSlackRoutedThreadBypassBusyReplyOperation(params: {
  activeOperation?: ReplyOperation;
  ctx: FinalizedMsgContext;
  routeThreadId?: string | number;
}): boolean {
  return (
    isSlackDirectRoutedThreadTurn(params.ctx) &&
    routeThreadIdsDiffer(params.activeOperation?.routeThreadId, params.routeThreadId)
  );
}

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
const getReplyFromConfigRuntimeLoader = createLazyImportLoader(
  () => import("./get-reply-from-config.runtime.js"),
);
const abortRuntimeLoader = createLazyImportLoader(() => import("./abort.runtime.js"));
const ttsRuntimeLoader = createLazyImportLoader(() => import("../../tts/tts.runtime.js"));
const runtimePluginsLoader = createLazyImportLoader(
  () => import("../../plugins/runtime-plugins.runtime.js"),
);
const replyMediaPathsRuntimeLoader = createLazyImportLoader(
  () => import("./reply-media-paths.runtime.js"),
);

function loadRouteReplyRuntime() {
  return routeReplyRuntimeLoader.load();
}

function loadGetReplyFromConfigRuntime() {
  return getReplyFromConfigRuntimeLoader.load();
}

function loadAbortRuntime() {
  return abortRuntimeLoader.load();
}

function loadTtsRuntime() {
  return ttsRuntimeLoader.load();
}

function loadRuntimePlugins() {
  return runtimePluginsLoader.load();
}

function loadReplyMediaPathsRuntime() {
  return replyMediaPathsRuntimeLoader.load();
}

function formatSuppressedReplyPayloadForLog(reply: ReplyPayload): string {
  const metadata = getReplyPayloadMetadata(reply);
  const text = normalizeOptionalString(reply.text);
  const textPreview = text ? truncateUtf16Safe(text.replace(/\s+/g, " "), 160) : undefined;
  const sendableParts = resolveSendableOutboundReplyParts(reply);
  const richParts = [
    reply.presentation ? "presentation" : undefined,
    reply.interactive ? "interactive" : undefined,
    reply.channelData ? "channelData" : undefined,
  ].filter(Boolean);
  return [
    `textChars=${text?.length ?? 0}`,
    `media=${sendableParts.mediaCount}`,
    `rich=${richParts.length ? richParts.join("|") : "none"}`,
    `error=${reply.isError === true}`,
    `beforeAgentRunBlocked=${metadata?.beforeAgentRunBlocked === true}`,
    `deliverDespiteSuppression=${metadata?.deliverDespiteSourceReplySuppression === true}`,
    textPreview ? `textPreview=${JSON.stringify(textPreview)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

async function maybeApplyTtsToReplyPayload(
  params: Parameters<Awaited<ReturnType<typeof loadTtsRuntime>>["maybeApplyTtsToPayload"]>[0],
) {
  if (isReplyPayloadStatusNotice(params.payload)) {
    return params.payload;
  }
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
  const ttsPayload = await maybeApplyTtsToPayload(params);
  return ttsPayload === params.payload
    ? ttsPayload
    : copyReplyPayloadMetadata(params.payload, ttsPayload);
}

const resolveRoutedPolicyConversationType = (
  ctx: FinalizedMsgContext,
): "direct" | "group" | undefined => {
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  if (commandTargetSessionKey && commandTargetSessionKey !== ctx.SessionKey) {
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
  store?: Record<string, SessionEntry>;
} => {
  const targetSessionKey = resolveCommandTurnTargetSessionKey(ctx);
  const sessionKey = normalizeOptionalString(targetSessionKey ?? ctx.SessionKey);
  if (!sessionKey) {
    return {};
  }
  const agentId = resolveSessionAgentId({ sessionKey, config: cfg, fallbackAgentId: ctx.AgentId });
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  try {
    const store = loadSessionStore(storePath);
    return {
      sessionKey,
      storePath,
      store,
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
  initialExplicitLevel?: string;
  fallbackLevel: string;
}) => {
  const resolveCurrentExplicitLevel = () => {
    if (params.sessionKey && params.storePath) {
      try {
        const entry = readSessionEntry(params.storePath, params.sessionKey);
        return normalizeVerboseLevel(entry?.verboseLevel ?? "");
      } catch {
        // Ignore transient store read failures and fall back to the current dispatch snapshot.
      }
    }
    return normalizeVerboseLevel(params.initialExplicitLevel ?? "");
  };
  const resolveLevel = () => {
    const explicitLevel = resolveCurrentExplicitLevel();
    if (explicitLevel) {
      return explicitLevel;
    }
    return normalizeVerboseLevel(params.fallbackLevel) ?? "off";
  };
  return {
    shouldEmit: () => resolveLevel() !== "off",
    shouldEmitFull: () => resolveLevel() === "full",
  };
};

type HarnessSourceVisibleRepliesDefault = "automatic" | "message_tool";

type HarnessDefaultCandidate = {
  provider: string;
  model?: string;
};

function createReplyDispatchEvent(
  params: Omit<PluginHookReplyDispatchEvent, "shouldSendToolSummaries"> & {
    shouldSendToolSummaries: () => boolean;
  },
): PluginHookReplyDispatchEvent {
  const { shouldSendToolSummaries, ...event } = params;
  return Object.defineProperty(event, "shouldSendToolSummaries", {
    enumerable: true,
    get: shouldSendToolSummaries,
  }) as PluginHookReplyDispatchEvent;
}

/** Test-only hooks for overriding selected dispatch dependencies. */
export const testing = {
  createReplyDispatchEvent,
};

function resolveHarnessDefaultChannel(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
}): string | undefined {
  const originatingChannel =
    typeof params.ctx.OriginatingChannel === "string" ? params.ctx.OriginatingChannel : undefined;

  return (
    params.entry?.channel ??
    params.entry?.origin?.provider ??
    originatingChannel ??
    params.ctx.Provider ??
    params.ctx.Surface
  );
}

function resolveHarnessDefaultParentSessionKey(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
}): string | undefined {
  return (
    params.entry?.parentSessionKey ??
    params.ctx.ModelParentSessionKey ??
    params.ctx.ParentSessionKey
  );
}

function resolveTurnModelOverride(
  replyOptions: DispatchFromConfigParams["replyOptions"],
): string | undefined {
  if (replyOptions?.isHeartbeat !== true) {
    return undefined;
  }
  return normalizeOptionalString(replyOptions.heartbeatModelOverride);
}

function resolveChannelModelCandidate(params: {
  aliasIndex: ModelAliasIndex;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  defaultProvider: string;
  entry?: SessionEntry;
  parentSessionKey?: string;
}): HarnessDefaultCandidate | undefined {
  if (!params.cfg.channels?.modelByChannel) {
    return undefined;
  }

  const channel = resolveHarnessDefaultChannel({
    ctx: params.ctx,
    entry: params.entry,
  });
  const channelModelOverride = resolveChannelModelOverride({
    cfg: params.cfg,
    channel,
    groupId: params.entry?.groupId,
    groupChatType: params.entry?.chatType ?? params.ctx.ChatType,
    groupChannel: params.entry?.groupChannel ?? params.ctx.GroupChannel,
    groupSubject: params.entry?.subject ?? params.ctx.GroupSubject,
    parentSessionKey: params.parentSessionKey,
    directUserIds: [
      params.entry?.origin?.nativeDirectUserId,
      params.entry?.origin?.from,
      params.entry?.origin?.to,
      params.ctx.OriginatingTo,
      params.ctx.From,
      params.ctx.SenderId,
    ],
  });
  if (!channelModelOverride) {
    return undefined;
  }

  return resolveModelRefFromString({
    raw: channelModelOverride.model,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  })?.ref;
}

function resolveStoredModelCandidate(params: {
  defaultProvider: string;
  entry?: SessionEntry;
  parentSessionKey?: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
}): HarnessDefaultCandidate | undefined {
  const storedModelRef = resolveStoredModelOverride({
    sessionEntry: params.entry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
    defaultProvider: params.defaultProvider,
  });
  if (!storedModelRef) {
    return undefined;
  }
  return {
    provider: storedModelRef.provider ?? params.defaultProvider,
    model: storedModelRef.model,
  };
}

function resolveModelOverrideCandidate(params: {
  aliasIndex: ModelAliasIndex;
  defaultProvider: string;
  modelOverride?: string;
}): HarnessDefaultCandidate | undefined {
  if (!params.modelOverride) {
    return undefined;
  }
  return resolveModelRefFromString({
    raw: params.modelOverride,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  })?.ref;
}

const resolveHarnessSourceVisibleRepliesDefault = (params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  turnModelOverride?: string;
}): HarnessSourceVisibleRepliesDefault | undefined => {
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return undefined;
  }
  try {
    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: defaultModelRef.provider,
    });
    const parentSessionKey = resolveHarnessDefaultParentSessionKey(params);
    const channelModelCandidate = resolveChannelModelCandidate({
      aliasIndex,
      cfg: params.cfg,
      ctx: params.ctx,
      defaultProvider: defaultModelRef.provider,
      entry: params.entry,
      parentSessionKey,
    });
    const storedModelCandidate = resolveStoredModelCandidate({
      defaultProvider: defaultModelRef.provider,
      entry: params.entry,
      parentSessionKey,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
    });
    const turnModelCandidate = resolveModelOverrideCandidate({
      aliasIndex,
      defaultProvider: defaultModelRef.provider,
      modelOverride: params.turnModelOverride,
    });
    const resolveCandidateDefault = (candidate: { provider: string; model?: string }) => {
      const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
        provider: candidate.provider,
        entry: params.entry,
        cfg: params.cfg,
      });
      const harness = selectAgentHarness({
        provider: candidate.provider,
        modelId: candidate.model,
        config: params.cfg,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
        agentHarnessRuntimeOverride,
      });
      return harness.deliveryDefaults?.sourceVisibleReplies;
    };
    const selectedModelCandidate =
      turnModelCandidate ?? storedModelCandidate ?? channelModelCandidate;
    if (selectedModelCandidate) {
      return resolveCandidateDefault(selectedModelCandidate);
    }
    const sourceProvider = normalizeOptionalString(
      params.entry?.origin?.provider ?? params.ctx.Provider ?? params.ctx.Surface,
    );
    if (sourceProvider) {
      const sourceDefault = resolveCandidateDefault({ provider: sourceProvider });
      if (sourceDefault) {
        return sourceDefault;
      }
    }
    return resolveCandidateDefault(defaultModelRef);
  } catch (error) {
    logVerbose(
      `dispatch-from-config: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
};

function shouldBypassPluginOwnedBindingForCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const commandTurn = resolveCommandTurnContext(ctx);
  if (
    (commandTurn.kind === "native" || commandTurn.kind === "text-slash") &&
    !commandTurn.authorized
  ) {
    return false;
  }
  if (isNativeCommandTurn(commandTurn) && commandTurn.authorized) {
    return true;
  }
  if (!isExplicitSourceReplyCommand(ctx, cfg)) {
    return false;
  }
  const commandBody = normalizeCommandBody(commandTurn.body ?? ctx.CommandBody ?? "", {
    botUsername: ctx.BotUsername,
  });
  if (!commandBody.startsWith("/")) {
    return false;
  }
  if (resolveTextCommand(commandBody)) {
    return true;
  }
  const provider = normalizeOptionalString(ctx.Provider ?? ctx.Surface);
  if (
    commandTurn.commandName &&
    findCommandByNativeName(commandTurn.commandName, provider, {
      includeBundledChannelFallback: true,
    })
  ) {
    return true;
  }
  return Boolean(
    matchPluginCommand(commandBody, {
      channel: normalizeOptionalString(ctx.Surface ?? ctx.Provider),
    }),
  );
}

async function clearPendingFinalDeliveryAfterSuccess(params: {
  storePath?: string;
  sessionKey?: string;
}): Promise<void> {
  if (!params.storePath || !params.sessionKey) {
    return;
  }
  await updateSessionStoreEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    skipMaintenance: true,
    takeCacheOwnership: true,
    update: async (entry) => {
      if (!entry.pendingFinalDelivery && !entry.pendingFinalDeliveryText) {
        return null;
      }
      return {
        pendingFinalDelivery: undefined,
        pendingFinalDeliveryText: undefined,
        pendingFinalDeliveryCreatedAt: undefined,
        pendingFinalDeliveryLastAttemptAt: undefined,
        pendingFinalDeliveryAttemptCount: undefined,
        pendingFinalDeliveryLastError: undefined,
        pendingFinalDeliveryContext: undefined,
        pendingFinalDeliveryIntentId: undefined,
        updatedAt: Date.now(),
      };
    },
  });
}

async function mirrorDeliveredReplyToTranscript(params: {
  metadata?: TranscriptMirror;
  cfg: OpenClawConfig;
}): Promise<void> {
  const mirror = params.metadata;
  if (!mirror) {
    return;
  }
  try {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: mirror.sessionKey,
      agentId: mirror.agentId,
      ...(mirror.expectedSessionId ? { expectedSessionId: mirror.expectedSessionId } : {}),
      text: mirror.text,
      mediaUrls: mirror.preferText && mirror.text ? undefined : mirror.mediaUrls,
      idempotencyKey: mirror.idempotencyKey,
      ...(mirror.deliveryMirror ? { deliveryMirror: mirror.deliveryMirror } : {}),
      ...(mirror.storePath ? { storePath: mirror.storePath } : {}),
      updateMode: "inline",
      config: params.cfg,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    if (!result.ok) {
      logVerbose(`dispatch-from-config: transcript mirror skipped: ${result.reason}`);
    }
  } catch (error) {
    logVerbose(
      `dispatch-from-config: transcript mirror failed after delivery: ${formatErrorMessage(error)}`,
    );
  }
}

/** Reads final outcome counters from dispatchers that expose them. */
export function getDispatcherFinalOutcomeCounts(dispatcher: DispatcherOutcomeCountsView): {
  cancelled: number;
  failed: number;
} {
  return {
    cancelled: dispatcher.getCancelledCounts?.().final ?? 0,
    failed: readDispatcherFailedCounts(dispatcher).final,
  };
}

function transcriptMirrorForDeliveredPayload(
  metadata: TranscriptMirror,
  payload: ReplyPayload,
): TranscriptMirror | undefined {
  const sendable = resolveSendableOutboundReplyParts(payload);
  if (!sendable.text && sendable.mediaUrls.length === 0) {
    return undefined;
  }
  return {
    ...metadata,
    text: sendable.text,
    mediaUrls: sendable.mediaUrls.length > 0 ? sendable.mediaUrls : undefined,
  };
}

const STALE_FOREGROUND_SUPPRESSED_FINAL_TEXT =
  "Channel final suppressed before delivery: stale foreground";

function captureSuppressedTranscriptMirror(params: {
  metadata: TranscriptMirror;
  payload: ReplyPayload;
  deliveryId?: string | number;
}): TranscriptMirror | undefined {
  const payloadMetadata = getReplyPayloadMetadata(params.payload);
  if (
    !params.metadata.transcriptOwner ||
    payloadMetadata?.foregroundDeliverySuppression?.reason !== "stale-foreground"
  ) {
    return undefined;
  }
  const sourceMessageId = normalizeOptionalString(params.metadata.deliveryMirror?.sourceMessageId);
  if (!sourceMessageId) {
    return undefined;
  }
  const { transcriptOwner: _transcriptOwner, ...metadata } = params.metadata;
  return {
    ...metadata,
    // The transcript owner already persisted the answer; this row records only delivery state.
    text: STALE_FOREGROUND_SUPPRESSED_FINAL_TEXT,
    mediaUrls: undefined,
    preferText: true,
    idempotencyKey: `channel-final-suppressed:${sourceMessageId}:${params.deliveryId ?? "single"}`,
    deliveryMirror: {
      kind: "channel-final-suppressed",
      reason: "stale-foreground",
      sourceMessageId,
    },
  };
}

function captureDeliveredTranscriptMirror(params: {
  dispatcher: ReplyDispatcher;
  metadata?: TranscriptMirror;
  deliveryId?: string | number;
  captureToken?: object;
}): () => TranscriptMirror | undefined {
  if (!params.metadata || !params.dispatcher.appendBeforeDeliver) {
    return () => (params.metadata?.transcriptOwner ? undefined : params.metadata);
  }
  const metadata = params.metadata;
  let deliveredMetadata: TranscriptMirror | undefined;
  let suppressedMetadata: TranscriptMirror | undefined;
  let observedFinal = false;
  const { idempotencyKey, sessionKey } = metadata;
  params.dispatcher.appendBeforeDeliver((payload, info) => {
    if (info.kind !== "final") {
      return payload;
    }
    if (getReplyPayloadMetadata(payload)?.finalDeliveryCapture !== params.captureToken) {
      return payload;
    }
    observedFinal = true;
    const payloadMetadata = getReplyPayloadMetadata(payload);
    const payloadMirror = payloadMetadata?.sourceReplyTranscriptMirror;
    if (
      payloadMirror &&
      payloadMirror.idempotencyKey === idempotencyKey &&
      payloadMirror.sessionKey === sessionKey
    ) {
      deliveredMetadata = transcriptMirrorForDeliveredPayload(
        {
          ...payloadMirror,
          ...(metadata.expectedSessionId ? { expectedSessionId: metadata.expectedSessionId } : {}),
          storePath: metadata.storePath,
        },
        payload,
      );
    } else if (
      !payloadMirror &&
      !metadata.transcriptOwner &&
      (!idempotencyKey || metadata.deliveryMirror)
    ) {
      deliveredMetadata = transcriptMirrorForDeliveredPayload(metadata, payload);
    }
    return payload;
  });
  appendReplyDispatcherBeforeDeliverCancelled(params.dispatcher, (payload, info) => {
    if (info.kind !== "final") {
      return;
    }
    if (getReplyPayloadMetadata(payload)?.finalDeliveryCapture !== params.captureToken) {
      return;
    }
    observedFinal = true;
    suppressedMetadata = captureSuppressedTranscriptMirror({
      metadata,
      payload,
      deliveryId: params.deliveryId,
    });
  });
  return () =>
    observedFinal
      ? (suppressedMetadata ?? deliveredMetadata)
      : metadata.transcriptOwner
        ? undefined
        : metadata;
}

async function mirrorTranscriptAfterDispatcherSettled(params: {
  dispatcher: ReplyDispatcher;
  before: { cancelled: number; failed: number };
  metadata: () => TranscriptMirror | undefined;
  cfg: OpenClawConfig;
}): Promise<void> {
  const after = getDispatcherFinalOutcomeCounts(params.dispatcher);
  const metadata = params.metadata();
  if (!metadata) {
    return;
  }
  const suppressedFinal = metadata.deliveryMirror?.kind === "channel-final-suppressed";
  if (
    !suppressedFinal &&
    (after.cancelled > params.before.cancelled || after.failed > params.before.failed)
  ) {
    return;
  }
  await mirrorDeliveredReplyToTranscript({
    metadata,
    cfg: params.cfg,
  });
}

function runWithDispatchAbortSignal<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T> | T,
  onWorkStarted?: (work: Promise<unknown>) => void,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new DispatchReplyOperationAbortedError());
  }
  const shouldStopForAbort = () => signal?.aborted === true;
  let settled = false;
  let abortHandler: (() => void) | undefined;
  const work = Promise.resolve()
    .then(run)
    .then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        if (shouldStopForAbort() && isAbortError(error)) {
          throw new DispatchReplyOperationAbortedError();
        }
        throw error;
      },
    );
  onWorkStarted?.(work);
  if (!signal) {
    return work;
  }
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => {
      if (!settled && shouldStopForAbort()) {
        reject(new DispatchReplyOperationAbortedError());
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    settled = true;
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  });
}

function createAbortAwareDispatcher(params: {
  dispatcher: ReplyDispatcher;
  isAborted: () => boolean;
}): ReplyDispatcher {
  const sendIfActive =
    (send: (payload: ReplyPayload) => boolean) =>
    (payload: ReplyPayload): boolean =>
      params.isAborted() ? false : send(payload);
  const dispatcher: ReplyDispatcher = {
    sendToolResult: sendIfActive(params.dispatcher.sendToolResult),
    sendBlockReply: sendIfActive(params.dispatcher.sendBlockReply),
    sendFinalReply: sendIfActive(params.dispatcher.sendFinalReply),
    waitForIdle: () => params.dispatcher.waitForIdle(),
    getQueuedCounts: () => params.dispatcher.getQueuedCounts(),
    getFailedCounts: () => readDispatcherFailedCounts(params.dispatcher),
    markComplete: () => {
      if (!params.isAborted()) {
        params.dispatcher.markComplete();
      }
    },
  };
  if (params.dispatcher.getCancelledCounts) {
    dispatcher.getCancelledCounts = () => params.dispatcher.getCancelledCounts!();
  }
  return dispatcher;
}

type ReplyHotPathTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type ReplyHotPathTimingSummary = {
  totalMs: number;
  spans: ReplyHotPathTimingSpan[];
};

const replyHotPathTimingLog = createSubsystemLogger("auto-reply/reply-timing");
const REPLY_HOT_PATH_TIMING_WARN_TOTAL_MS = 1_000;
const REPLY_HOT_PATH_TIMING_WARN_STAGE_MS = 500;

function createReplyHotPathTimingTracker(options: { profilerEnabled?: boolean } = {}): {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  logIfSlow: (params: {
    channel: string;
    messageId?: number | string;
    sessionKey?: string;
    outcome: "completed" | "skipped" | "error";
    reason?: string;
  }) => void;
} {
  if (!options.profilerEnabled) {
    // This slow-path splitter was added for latency investigation. Keep it
    // inert in normal production dispatches so only explicit profiler runs pay
    // the Date.now/span allocation cost.
    return {
      async measure(_name, run) {
        return await run();
      },
      logIfSlow() {},
    };
  }

  const startedAt = Date.now();
  let didLog = false;
  const spans: ReplyHotPathTimingSpan[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const snapshot = (): ReplyHotPathTimingSummary => ({
    totalMs: toMs(Date.now() - startedAt),
    spans: spans.slice(),
  });
  const shouldLog = (summary: ReplyHotPathTimingSummary) =>
    summary.totalMs >= REPLY_HOT_PATH_TIMING_WARN_TOTAL_MS ||
    summary.spans.some((span) => span.durationMs >= REPLY_HOT_PATH_TIMING_WARN_STAGE_MS);
  const formatSpans = (summary: ReplyHotPathTimingSummary) =>
    summary.spans.length > 0
      ? summary.spans
          .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
          .join(",")
      : "none";
  return {
    async measure(name, run) {
      const spanStartedAt = Date.now();
      try {
        return await run();
      } finally {
        spans.push({
          name,
          durationMs: toMs(Date.now() - spanStartedAt),
          elapsedMs: toMs(Date.now() - startedAt),
        });
      }
    },
    logIfSlow(params) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      didLog = true;
      replyHotPathTimingLog.warn(
        `reply hot path timings channel=${params.channel} messageId=${
          params.messageId ?? "unknown"
        } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} totalMs=${
          summary.totalMs
        } stages=${formatSpans(summary)}${params.reason ? ` reason=${params.reason}` : ""}`,
        {
          channel: params.channel,
          messageId: params.messageId,
          sessionKey: params.sessionKey,
          outcome: params.outcome,
          reason: params.reason,
          totalMs: summary.totalMs,
          spans: summary.spans,
        },
      );
    },
  };
}

export type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./dispatch-from-config.types.js";

/** Dispatches a reply from config, context, command handling, agent run, and delivery policy. */
export async function dispatchReplyFromConfig(
  params: DispatchFromConfigParams,
): Promise<DispatchFromConfigResult> {
  const { ctx, cfg, dispatcher } = params;
  if (params.replyOptions?.abortSignal?.aborted) {
    return {
      queuedFinal: false,
      counts: dispatcher.getQueuedCounts(),
    };
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfg);
  const channel = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider ?? "unknown");
  const chatId = ctx.To ?? ctx.From;
  const messageId = ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const sessionKey =
    normalizeOptionalString(ctx.SessionKey) ?? normalizeOptionalString(ctx.CommandTargetSessionKey);
  const startTime = diagnosticsEnabled ? Date.now() : 0;
  const canTrackSession = diagnosticsEnabled && Boolean(sessionKey);
  const initialSessionStoreEntry = resolveSessionStoreLookup(ctx, cfg);
  // resolveSessionStoreLookup is command-target-aware (it prefers
  // resolveCommandTurnTargetSessionKey), whereas the lifecycle's sessionKey is
  // source-first (ctx.SessionKey). On a native command turn that targets a
  // different session, the resolved entry can belong to the *target* while the
  // lifecycle reports the *source* key — so only carry the UUID when the entry
  // is for the same session the lifecycle reports, to avoid mis-associating a
  // session id with the wrong session key. When they diverge, emit sessionKey
  // only (prior behavior).
  const lifecycleSessionId =
    initialSessionStoreEntry.sessionKey === sessionKey
      ? initialSessionStoreEntry.entry?.sessionId
      : undefined;
  const messageLifecycle = createDiagnosticMessageLifecycle({
    enabled: diagnosticsEnabled,
    channel,
    chatId,
    messageId,
    sessionKey,
    sessionId: lifecycleSessionId,
    source: "dispatch",
    processingReason: "message_start",
    startedAtMs: startTime,
    trackSessionState: canTrackSession,
  });
  const traceAttributes = {
    surface: channel,
    hasSessionKey: Boolean(sessionKey),
    hasRunId: typeof params.replyOptions?.runId === "string",
  };
  const replyHotPathTiming = createReplyHotPathTimingTracker({
    profilerEnabled: isReplyProfilerEnabled({ config: cfg }),
  });
  const traceReplyPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    replyHotPathTiming.measure(name, () =>
      measureDiagnosticsTimelineSpan(name, run, {
        phase: "agent-turn",
        config: cfg,
        attributes: traceAttributes,
      }),
    );
  let agentDispatchStartedAt = 0;

  const recordProcessed = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (diagnosticsEnabled) {
      replyHotPathTiming.logIfSlow({
        channel,
        messageId,
        sessionKey,
        outcome,
        reason: opts?.reason,
      });
    }
    messageLifecycle.markProcessed(outcome, opts);
  };

  const recordAgentDispatchStarted = () => {
    if (!diagnosticsEnabled || agentDispatchStartedAt > 0) {
      return;
    }
    agentDispatchStartedAt = Date.now();
    logMessageDispatchStarted({
      channel,
      sessionKey: acpDispatchSessionKey,
      source: "replyResolver",
    });
  };

  const recordAgentDispatchCompleted = (
    outcome: "completed" | "skipped" | "error",
    opts?: {
      reason?: string;
      error?: string;
    },
  ) => {
    if (!diagnosticsEnabled || agentDispatchStartedAt <= 0) {
      return;
    }
    logMessageDispatchCompleted({
      channel,
      sessionKey: acpDispatchSessionKey,
      source: "replyResolver",
      durationMs: Date.now() - agentDispatchStartedAt,
      outcome,
      reason: opts?.reason,
      error: opts?.error,
    });
  };

  const markProcessing = () => {
    messageLifecycle.markProcessing();
  };

  const markIdle = (reason: string) => {
    messageLifecycle.markIdle(reason);
  };

  let inboundDedupeReplayUnsafe = false;
  const markInboundDedupeReplayUnsafe = () => {
    inboundDedupeReplayUnsafe = true;
  };

  const boundAcpDispatchSessionKey = resolveBoundAcpDispatchSessionKey({ ctx, cfg });
  const acpDispatchSessionKey =
    boundAcpDispatchSessionKey ?? initialSessionStoreEntry.sessionKey ?? sessionKey;
  // initialSessionStoreEntry is command-target-aware, so native command turns
  // stay target-keyed here. Bound ACP dispatch remains source-key owned while
  // ACP routing uses acpDispatchSessionKey.
  const dispatchOperationSessionKey =
    initialSessionStoreEntry.sessionKey ?? sessionKey ?? acpDispatchSessionKey;
  // Reply-run ownership stays on the inbound/source session. Bound ACP routing
  // may use another agent's store, but must not move source lifecycle admission.
  const operationSessionStoreEntry = initialSessionStoreEntry;
  const initialDispatchReplyOperation = dispatchOperationSessionKey
    ? replyRunRegistry.get(dispatchOperationSessionKey)
    : undefined;
  if (
    params.replyOptions?.isHeartbeat === true &&
    dispatchOperationSessionKey &&
    initialDispatchReplyOperation
  ) {
    return {
      queuedFinal: false,
      counts: dispatcher.getQueuedCounts(),
    };
  }
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
  let preparedSessionBinding: ReplySessionBinding | undefined =
    sessionStoreEntry.sessionKey && sessionStoreEntry.entry?.sessionId
      ? {
          sessionKey: sessionStoreEntry.sessionKey,
          sessionId: sessionStoreEntry.entry.sessionId,
          storePath: sessionStoreEntry.storePath,
        }
      : undefined;
  let preparedOperationSessionBinding: ReplySessionBinding | undefined =
    operationSessionStoreEntry.sessionKey && operationSessionStoreEntry.entry?.sessionId
      ? {
          sessionKey: operationSessionStoreEntry.sessionKey,
          sessionId: operationSessionStoreEntry.entry.sessionId,
          storePath: operationSessionStoreEntry.storePath,
        }
      : undefined;
  const sessionKeysMatch = (left?: string, right?: string) =>
    Boolean(
      left &&
      right &&
      normalizeExplicitSessionKey(left, ctx) === normalizeExplicitSessionKey(right, ctx),
    );
  const notePreparedSession = (binding: ReplySessionBinding) => {
    if (sessionKeysMatch(binding.sessionKey, sessionStoreEntry.sessionKey)) {
      preparedSessionBinding = binding;
    }
    if (sessionKeysMatch(binding.sessionKey, operationSessionStoreEntry.sessionKey)) {
      preparedOperationSessionBinding = binding;
    }
  };
  const resolveOperationExpectedSessionId = () =>
    preparedOperationSessionBinding?.sessionId ?? operationSessionStoreEntry.entry?.sessionId;
  const resolvePreparedTranscriptBinding = (mirrorSessionKey?: string) => {
    if (
      !preparedSessionBinding ||
      !sessionKeysMatch(mirrorSessionKey, preparedSessionBinding.sessionKey)
    ) {
      return undefined;
    }
    return preparedSessionBinding;
  };
  const sessionAgentId = resolveSessionAgentId({
    sessionKey: acpDispatchSessionKey,
    config: cfg,
    fallbackAgentId: ctx.AgentId,
  });
  const sessionAgentCfg = resolveAgentConfig(cfg, sessionAgentId);
  const verboseProgress = createShouldEmitVerboseProgress({
    sessionKey: acpDispatchSessionKey,
    storePath: sessionStoreEntry.storePath,
    initialExplicitLevel: sessionStoreEntry.entry?.verboseLevel,
    fallbackLevel:
      normalizeVerboseLevel(
        sessionStoreEntry.entry?.verboseLevel ??
          sessionAgentCfg?.verboseDefault ??
          cfg.agents?.defaults?.verboseDefault ??
          "",
      ) ?? "off",
  });
  const shouldEmitVerboseProgress = verboseProgress.shouldEmit;
  const shouldEmitFullVerboseProgress = verboseProgress.shouldEmitFull;
  const replyRoute = resolveEffectiveReplyRoute({ ctx, entry: sessionStoreEntry.entry });
  // Restore route thread context only from the active turn or the thread-scoped session key.
  // Do not read thread ids from the normalised session store here: `origin.threadId` can be
  // folded back into lastThreadId/deliveryContext during store normalisation and resurrect a
  // stale route after thread delivery was intentionally cleared.
  const routeThreadId = resolveRoutedDeliveryThreadId({
    ctx,
    sessionKey: acpDispatchSessionKey,
  });
  // Inherited sessions_send routes carry thread ids only when the stored route
  // proves the thread came from an explicit target, not session normalization.
  const routeReplyThreadId = replyRoute.threadId ?? routeThreadId;
  const inboundAudio = hasInboundAudio(ctx);
  const sessionTtsAuto = normalizeTtsAutoMode(sessionStoreEntry.entry?.ttsAuto);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, sessionAgentId);
  let dispatchReplyOperation: ReplyOperation | undefined;
  let dispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchAbortOperation: ReplyOperation | undefined;
  let preDispatchLifecycleAdmission: SessionWorkAdmissionLease | undefined;
  let preDispatchLifecycleAbortController: AbortController | undefined;
  let dispatchLifecycleAbortController: AbortController | undefined;
  let preDispatchLifecycleInterrupted = false;
  const dispatchLifecycleWork = new Set<Promise<void>>();
  const hasInboundAudioForTts = () =>
    inboundAudio || dispatchReplyOperation?.acceptedSteeredInboundAudio === true;
  const trackDispatchLifecycleWork = (work: Promise<unknown>) => {
    if (!dispatchReplyOperation && !preDispatchLifecycleAdmission) {
      return;
    }
    const settled = work.then(
      () => {},
      () => {},
    );
    dispatchLifecycleWork.add(settled);
    void settled.then(() => {
      dispatchLifecycleWork.delete(settled);
    });
  };
  const waitForDispatchLifecycleWorkAndDelivery = async (): Promise<void> => {
    await Promise.allSettled(Array.from(dispatchLifecycleWork));
    await waitForReplyDispatcherIdle(dispatcher);
  };
  const releasePreDispatchLifecycleAdmission = async (
    afterWorkBarrier?: () => PromiseLike<unknown>,
  ): Promise<void> => {
    const admission = preDispatchLifecycleAdmission;
    const preDispatchAbortController = preDispatchLifecycleAbortController;
    const dispatchAbortController = dispatchLifecycleAbortController;
    preDispatchLifecycleAdmission = undefined;
    if (!admission) {
      return;
    }
    const pendingWork = Array.from(dispatchLifecycleWork);
    const clearAbortControllers = () => {
      if (preDispatchLifecycleAbortController === preDispatchAbortController) {
        preDispatchLifecycleAbortController = undefined;
      }
      if (dispatchLifecycleAbortController === dispatchAbortController) {
        dispatchLifecycleAbortController = undefined;
      }
    };
    if (!afterWorkBarrier && pendingWork.length === 0) {
      clearAbortControllers();
      admission.release();
      return;
    }
    try {
      await Promise.allSettled(pendingWork);
      if (afterWorkBarrier) {
        await waitForReplyBarrierSettlement(
          afterWorkBarrier(),
          dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.(),
        );
      }
    } finally {
      clearAbortControllers();
      admission.release();
    }
  };
  const runWithDispatchLifecycleAdmission = async <T>(run: () => Promise<T>): Promise<T> => {
    if (dispatchReplyOperation) {
      return await runWithReplyOperationLifecycleAdmission(dispatchReplyOperation, run);
    }
    return preDispatchLifecycleAdmission
      ? await preDispatchLifecycleAdmission.run(run)
      : await run();
  };
  type DispatchReplyOperationAcquisition =
    | { status: "ready" }
    | { status: "busy" }
    | { status: "aborted" };
  const ensureDispatchReplyOperation = async (
    phase: "pre_dispatch" | "dispatch",
  ): Promise<DispatchReplyOperationAcquisition> => {
    if (phase === "dispatch") {
      // The next full reply operation revalidates the persisted session. Drop
      // the hook-only lease after its queued delivery settles so a waiting
      // lifecycle mutation cannot commit while that delivery is still active.
      await releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(dispatcher));
      if (preDispatchLifecycleInterrupted) {
        return { status: dispatchReplyOperation ? "aborted" : "busy" };
      }
    }
    if (dispatchReplyOperation) {
      return { status: "ready" };
    }
    if (dispatchAbortOperation && !dispatchAbortOperation.result) {
      return dispatchReplyOperation ? { status: "ready" } : { status: "busy" };
    }
    if (
      phase === "dispatch" &&
      preDispatchAbortOperation?.result &&
      preDispatchAbortOperation.result.kind !== "completed" &&
      !dispatchReplyOperation
    ) {
      dispatchAbortOperation = preDispatchAbortOperation;
      return { status: "busy" };
    }
    if (!dispatchOperationSessionKey) {
      return { status: "ready" };
    }
    const operationSessionId =
      dispatchAbortOperation?.sessionId ??
      initialSessionStoreEntry.entry?.sessionId ??
      sessionStoreEntry.entry?.sessionId ??
      crypto.randomUUID();
    const replyTurnKind = resolveReplyTurnKind(params.replyOptions);
    const allowActivePreDispatch = phase === "pre_dispatch" && replyTurnKind === "visible";
    const allowGatewayQueueResolution =
      phase === "dispatch" &&
      replyTurnKind === "visible" &&
      params.replyOptions?.queuedFollowupLifecycle !== undefined &&
      replyRunRegistry.get(dispatchOperationSessionKey) !== undefined;
    if (allowGatewayQueueResolution) {
      // Gateway turns need to reach getReplyFromConfig while the owner is active;
      // that layer applies the session's steer/followup/collect/drop policy.
      return { status: "ready" };
    }
    const allowSlackRoutedThreadBypass =
      phase === "dispatch" &&
      shouldLetSlackRoutedThreadBypassBusyReplyOperation({
        activeOperation: replyRunRegistry.get(dispatchOperationSessionKey),
        ctx,
        routeThreadId,
      });
    const lifecycleOnlyAbortController =
      allowActivePreDispatch || allowSlackRoutedThreadBypass ? new AbortController() : undefined;
    const onLifecycleInterrupt = () => {
      preDispatchLifecycleInterrupted = true;
      lifecycleOnlyAbortController?.abort();
    };
    let admission = await admitReplyTurn({
      sessionKey: dispatchOperationSessionKey,
      sessionId: operationSessionId,
      expectedSessionId: resolveOperationExpectedSessionId(),
      expectedActiveOperation: initialDispatchReplyOperation,
      storePath: operationSessionStoreEntry.storePath,
      kind: replyTurnKind,
      resetTriggered: false,
      routeThreadId,
      upstreamAbortSignal: params.replyOptions?.abortSignal,
      waitForActive: !allowActivePreDispatch && !allowSlackRoutedThreadBypass,
      retainLifecycleAdmissionOnActive: allowActivePreDispatch || allowSlackRoutedThreadBypass,
      onLifecycleInterrupt,
    });
    if (
      admission.status === "skipped" &&
      admission.reason === "active-run" &&
      // Only visible reply turns may force-clear a stale terminal operation.
      // A heartbeat/control turn can also see the terminal snapshot, but it must
      // not abort an in-flight visible recovery a concurrent visible turn just
      // admitted (before that op is marked `terminalRecovery`); let it fall
      // through to normal busy/skip handling instead.
      replyTurnKind === "visible" &&
      isRecoverableTerminalSessionStatus(operationSessionStoreEntry.entry?.status) &&
      // Only clear the leftover op that belongs to the SAME terminal session.
      // A concurrent reset/rotation can admit a fresh op (new sessionId) under
      // this session key while we still hold the stale terminal snapshot;
      // force-clearing by the active op's id would drop that valid in-flight
      // reply and recreate the message loss this fix exists to prevent (#86827).
      admission.activeOperation?.sessionId === operationSessionStoreEntry.entry?.sessionId &&
      // Only clear the proven stale leftover from the failed lifecycle. A
      // freshly-admitted visible recovery op is marked `terminalRecovery` at the
      // admission choke point below; force-failing that op would drop the very
      // recovery turn this path exists to protect (concurrent visible turns can
      // read the same terminal snapshot before it clears).
      !admission.activeOperation?.terminalRecovery
    ) {
      const cleared = forceClearReplyRunBySessionId(
        admission.activeOperation?.sessionId ?? operationSessionId,
        new Error("clearing stale terminal reply operation"),
      );
      if (cleared) {
        admission.lifecycleAdmission?.release();
        logVerbose(
          `dispatch-from-config: cleared stale active reply operation for terminal session ${dispatchOperationSessionKey}`,
        );
        admission = await admitReplyTurn({
          sessionKey: dispatchOperationSessionKey,
          sessionId: operationSessionId,
          expectedSessionId: resolveOperationExpectedSessionId(),
          expectedActiveOperation: initialDispatchReplyOperation,
          storePath: operationSessionStoreEntry.storePath,
          kind: replyTurnKind,
          resetTriggered: false,
          routeThreadId,
          upstreamAbortSignal: params.replyOptions?.abortSignal,
          waitForActive: !allowActivePreDispatch && !allowSlackRoutedThreadBypass,
          retainLifecycleAdmissionOnActive: allowActivePreDispatch || allowSlackRoutedThreadBypass,
          onLifecycleInterrupt,
        });
      }
    }
    if (admission.status === "skipped") {
      if (allowActivePreDispatch && admission.reason === "active-run") {
        preDispatchAbortOperation = admission.activeOperation;
        preDispatchLifecycleAdmission = admission.lifecycleAdmission;
        preDispatchLifecycleAbortController = lifecycleOnlyAbortController;
        return { status: "ready" };
      }
      if (
        admission.reason === "active-run" &&
        shouldLetSlackRoutedThreadBypassBusyReplyOperation({
          activeOperation: admission.activeOperation,
          ctx,
          routeThreadId,
        })
      ) {
        preDispatchLifecycleAdmission = admission.lifecycleAdmission;
        dispatchLifecycleAbortController = lifecycleOnlyAbortController;
        logVerbose(
          `dispatch-from-config: allowing Slack routed thread ${routeThreadId} while ${dispatchOperationSessionKey} has an active reply operation in another Slack thread`,
        );
        return { status: "ready" };
      }
      admission.lifecycleAdmission?.release();
      dispatchAbortOperation = admission.activeOperation;
      logVerbose(
        `dispatch-from-config: skipped reply operation admission for ${dispatchOperationSessionKey}; reason=${admission.reason}`,
      );
      return { status: "busy" };
    }
    // Mark every freshly-admitted visible recovery of a terminal session at this
    // single choke point (both the clean no-stale admission and the
    // re-admission after a sibling force-clear flow through here). The marker
    // protects this op from being force-cleared by a concurrent sibling visible
    // turn that reads the same terminal snapshot (#86827). Genuine stale
    // leftovers from the original failed run never pass through this admission,
    // so they stay unmarked and remain force-clearable.
    if (
      replyTurnKind === "visible" &&
      isRecoverableTerminalSessionStatus(operationSessionStoreEntry.entry?.status) &&
      operationSessionId === operationSessionStoreEntry.entry?.sessionId
    ) {
      admission.operation.markTerminalRecovery();
    }
    dispatchReplyOperation = admission.operation;
    dispatchReplyOperation.retainFailureUntilComplete();
    dispatchAbortOperation = admission.operation;
    return { status: "ready" };
  };
  const getPreDispatchAbortOperation = () => dispatchAbortOperation ?? preDispatchAbortOperation;
  let cachedPreDispatchAbortSignal:
    | {
        operationSignal: AbortSignal | undefined;
        lifecycleSignal: AbortSignal | undefined;
        upstreamSignal: AbortSignal | undefined;
        signal: AbortSignal | undefined;
      }
    | undefined;
  let cachedDispatchAbortSignal:
    | {
        operationSignal: AbortSignal | undefined;
        upstreamSignal: AbortSignal | undefined;
        signal: AbortSignal | undefined;
      }
    | undefined;
  const getPreDispatchAbortSignal = () => {
    const operationSignal = getPreDispatchAbortOperation()?.abortSignal;
    const lifecycleSignal = preDispatchLifecycleAbortController?.signal;
    const upstreamSignal = params.replyOptions?.abortSignal;
    if (
      cachedPreDispatchAbortSignal &&
      cachedPreDispatchAbortSignal.operationSignal === operationSignal &&
      cachedPreDispatchAbortSignal.lifecycleSignal === lifecycleSignal &&
      cachedPreDispatchAbortSignal.upstreamSignal === upstreamSignal
    ) {
      return cachedPreDispatchAbortSignal.signal;
    }
    const signal = composeAbortSignals(operationSignal, lifecycleSignal, upstreamSignal);
    cachedPreDispatchAbortSignal = { operationSignal, lifecycleSignal, upstreamSignal, signal };
    return signal;
  };
  const getDispatchAbortSignal = () => {
    const operationSignal =
      dispatchReplyOperation?.abortSignal ?? dispatchLifecycleAbortController?.signal;
    // The operation mirrors upstream aborts until the backend commits its
    // terminal outcome, then keeps delivery alive after freezeAbort().
    const upstreamSignal = operationSignal ? undefined : params.replyOptions?.abortSignal;
    if (
      cachedDispatchAbortSignal &&
      cachedDispatchAbortSignal.operationSignal === operationSignal &&
      cachedDispatchAbortSignal.upstreamSignal === upstreamSignal
    ) {
      return cachedDispatchAbortSignal.signal;
    }
    const signal = operationSignal ?? upstreamSignal;
    cachedDispatchAbortSignal = { operationSignal, upstreamSignal, signal };
    return signal;
  };
  const getQueuedFollowupAbortSignal = () =>
    dispatchReplyOperation?.abortSignal ?? params.replyOptions?.abortSignal;
  let observedReplyDelivery = false;
  const markObservedReplyDelivery = async () => {
    if (observedReplyDelivery) {
      return;
    }
    observedReplyDelivery = true;
    await params.replyOptions?.onObservedReplyDelivery?.();
  };
  const getReplyOptions = () => {
    const abortSignal = getDispatchAbortSignal();
    if (!abortSignal) {
      return params.replyOptions;
    }
    return {
      ...params.replyOptions,
      abortSignal,
      queuedFollowupAbortSignal: getQueuedFollowupAbortSignal(),
      ...(dispatchReplyOperation ? { replyOperation: dispatchReplyOperation } : {}),
    };
  };
  const completeDispatchReplyOperation = () => {
    const completionBarrier = waitForDispatchLifecycleWorkAndDelivery();
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(dispatcher));
    if (dispatchReplyOperation) {
      dispatchReplyOperation.completeWithAfterClearBarrier(
        completionBarrier,
        dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.(),
      );
    }
  };
  const failDispatchReplyOperation = (error: unknown) => {
    const completionBarrier = waitForDispatchLifecycleWorkAndDelivery();
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(dispatcher));
    if (!dispatchReplyOperation) {
      return;
    }
    dispatchReplyOperation.freezeAbort();
    if (!dispatchReplyOperation.result) {
      dispatchReplyOperation.fail("run_failed", error);
    }
    dispatchReplyOperation.completeWithAfterClearBarrier(
      completionBarrier,
      dispatcher.resolveFollowupAdmissionBarrierTimeoutPolicy?.(),
    );
  };
  const isDispatchOperationAborted = () => getDispatchAbortSignal()?.aborted === true;
  const isPreDispatchOperationAborted = () => getPreDispatchAbortSignal()?.aborted === true;
  const throwIfDispatchOperationAborted = () => {
    if (isDispatchOperationAborted()) {
      throw new DispatchReplyOperationAbortedError();
    }
  };
  const dispatchHookDispatcher = createAbortAwareDispatcher({
    dispatcher,
    isAborted: isPreDispatchOperationAborted,
  });
  const { ensureRuntimePluginsLoaded } = await traceReplyPhase("reply.load_runtime_plugins", () =>
    loadRuntimePlugins(),
  );
  await traceReplyPhase("reply.ensure_runtime_plugins", () => {
    ensureRuntimePluginsLoaded({ config: cfg, workspaceDir });
  });
  const hookRunner = getGlobalHookRunner();
  // Extract message context for hooks (plugin and internal)
  const timestamp =
    typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : undefined;
  const messageIdForHook =
    ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
  const hookCtx = { ...ctx };
  const buildHookState = (sourceCtx: FinalizedMsgContext) => {
    const nextHookContext = deriveInboundMessageHookContext(sourceCtx, {
      messageId: messageIdForHook,
    });
    return {
      hookContext: nextHookContext,
      inboundClaimContext: toPluginInboundClaimContext(nextHookContext),
      inboundClaimEvent: toPluginInboundClaimEvent(nextHookContext, {
        commandAuthorized:
          typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : undefined,
        wasMentioned: typeof ctx.WasMentioned === "boolean" ? ctx.WasMentioned : undefined,
      }),
    };
  };
  let { hookContext, inboundClaimContext, inboundClaimEvent } = buildHookState(hookCtx);
  const { isGroup, groupId } = hookContext;
  let hookMediaPrepared = false;
  let hookMediaMetadataStaged = false;
  const prepareHookMediaMetadata = async () => {
    if (hookMediaPrepared) {
      return;
    }
    hookMediaPrepared = true;
    // Plugin hooks may run in a different Codex cwd from core dispatch, so
    // only actual hook/plugin-claim consumers get remote-cache media paths.
    // Keep ctx unstaged for the normal get-reply single-stage path.
    const staged = await traceReplyPhase("reply.stage_remote_media_for_dispatch", () =>
      stageRemoteInboundMediaIfNeeded({
        ctx: hookCtx,
        cfg,
        sessionKey: acpDispatchSessionKey,
        workspaceDir,
        remoteMediaMode: "cache",
      }),
    );
    if (staged) {
      hookMediaMetadataStaged = true;
      ({ hookContext, inboundClaimContext, inboundClaimEvent } = buildHookState(hookCtx));
    }
  };
  const buildMessageReceivedHookContext = () => {
    const mediaRemoteHost = normalizeOptionalString(ctx.MediaRemoteHost);
    const hasUnstagedRemoteMediaMetadata = Boolean(
      hookContext.mediaPath ||
      hookContext.mediaUrl ||
      hookContext.mediaType ||
      hookContext.mediaPaths?.length ||
      hookContext.mediaUrls?.length ||
      hookContext.mediaTypes?.length,
    );
    if (hookMediaMetadataStaged || !mediaRemoteHost || !hasUnstagedRemoteMediaMetadata) {
      return hookContext;
    }
    const messageReceivedCtx = { ...hookCtx };
    // message_received hooks run before normal get-reply staging, so remote
    // host paths are not safe as live media. Keep originals as debug metadata.
    delete messageReceivedCtx.MediaPath;
    delete messageReceivedCtx.MediaPaths;
    delete messageReceivedCtx.MediaUrl;
    delete messageReceivedCtx.MediaUrls;
    delete messageReceivedCtx.MediaType;
    delete messageReceivedCtx.MediaTypes;
    return {
      ...buildHookState(messageReceivedCtx).hookContext,
      mediaRemoteHost,
      mediaStagingPending: true,
      originalMediaPath: hookContext.mediaPath,
      originalMediaUrl: hookContext.mediaUrl,
      originalMediaType: hookContext.mediaType,
      originalMediaPaths: hookContext.mediaPaths,
      originalMediaUrls: hookContext.mediaUrls,
      originalMediaTypes: hookContext.mediaTypes,
    };
  };

  // Check if we should route replies to originating channel instead of dispatcher.
  // Only route when the originating channel is DIFFERENT from the current surface.
  // This handles cross-provider routing (e.g., message from Telegram being processed
  // by a shared session that's currently on Slack) while preserving normal dispatcher
  // flow when the provider handles its own messages.
  //
  // Debug: `pnpm test src/auto-reply/reply/dispatch-from-config.test.ts`
  const sessionAcpMeta = sessionStoreEntry.sessionKey
    ? readAcpSessionMeta({ sessionKey: sessionStoreEntry.sessionKey })
    : undefined;
  const sessionEntryWithAcp =
    sessionAcpMeta && sessionStoreEntry.entry
      ? { ...sessionStoreEntry.entry, acp: sessionAcpMeta }
      : sessionStoreEntry.entry;
  const suppressAcpChildUserDelivery = isParentOwnedBackgroundAcpSession(sessionEntryWithAcp);
  const normalizedRouteReplyChannel = normalizeMessageChannel(replyRoute.channel);
  const normalizedProviderChannel = normalizeMessageChannel(ctx.Provider);
  const normalizedSurfaceChannel = normalizeMessageChannel(ctx.Surface);
  const normalizedCurrentSurface = normalizedProviderChannel ?? normalizedSurfaceChannel;
  const effectiveExplicitDeliverRoute =
    ctx.ExplicitDeliverRoute === true || replyRoute.inheritedExternalRoute === true;
  const isInternalWebchatTurn =
    normalizedCurrentSurface === INTERNAL_MESSAGE_CHANNEL &&
    (normalizedSurfaceChannel === INTERNAL_MESSAGE_CHANNEL || !normalizedSurfaceChannel) &&
    !effectiveExplicitDeliverRoute;
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
    explicitDeliverRoute: effectiveExplicitDeliverRoute,
    originatingChannel: replyRoute.channel,
    originatingTo: replyRoute.to,
    suppressDirectUserDelivery: suppressAcpChildUserDelivery,
    isRoutableChannel: routeReplyRuntime?.isRoutableChannel ?? (() => false),
  });
  const routeReplyTo = replyRoute.to;
  const deliveryChannel = shouldRouteToOriginating ? routeReplyChannel : currentSurface;
  const shouldPrepareRoutedReplyDelivery = shouldRouteToOriginating && Boolean(routeReplyChannel);
  const replyContextAccountId = routeReplyChannel
    ? resolveReplyDeliveryAccountId(cfg, routeReplyChannel, replyRoute.accountId)
    : undefined;
  const routedReplyAccountId = shouldPrepareRoutedReplyDelivery ? replyContextAccountId : undefined;
  const routedReplyDelivery = shouldPrepareRoutedReplyDelivery
    ? createReplyDeliveryContext(
        resolveReplyToMode(cfg, routeReplyChannel, routedReplyAccountId, replyRoute.chatType),
        replyRoute.chatType,
      )
    : undefined;
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
      accountId: replyContextAccountId,
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
    options?: { abortSignal?: AbortSignal; mirror?: boolean; kind?: ReplyDispatchKind },
  ) => {
    if (!shouldRouteToOriginating || !routeReplyChannel || !routeReplyTo || !routeReplyRuntime) {
      return null;
    }
    markInboundDedupeReplayUnsafe();
    // Outbound session.key must match the session key used by the agent
    // runtime that produced this payload, so agent_end and message delivery
    // hooks expose the same canonical key for native command redirects.
    const agentRuntimeSessionKey =
      ctx.CommandSource === "native"
        ? (resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey)
        : ctx.SessionKey;
    return await routeReplyRuntime.routeReply({
      payload,
      channel: routeReplyChannel,
      to: routeReplyTo,
      sessionKey: agentRuntimeSessionKey,
      policySessionKey: resolveCommandTurnTargetSessionKey(ctx) ?? ctx.SessionKey,
      policyConversationType: resolveRoutedPolicyConversationType(ctx),
      accountId: routedReplyAccountId,
      requesterSenderId: ctx.SenderId,
      requesterSenderName: ctx.SenderName,
      requesterSenderUsername: ctx.SenderUsername,
      requesterSenderE164: ctx.SenderE164,
      threadId: routeReplyThreadId,
      replyDelivery: routedReplyDelivery,
      cfg,
      abortSignal: options?.abortSignal,
      mirror: options?.mirror,
      isGroup,
      groupId,
      replyKind: options?.kind ?? "final",
      runId: params.replyOptions?.runId,
    });
  };

  const isRoutedReplyDelivered = (result: { ok: boolean; suppressed?: boolean }) =>
    result.ok && result.suppressed !== true;

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
    kind: ReplyDispatchKind = "tool",
  ): Promise<void> => {
    // Keep the runtime guard explicit because this helper is called from nested
    // reply callbacks where TypeScript cannot narrow shouldRouteToOriginating.
    if (!routeReplyRuntime || !routeReplyChannel || !routeReplyTo) {
      return;
    }
    const effectiveAbortSignal = abortSignal ?? getDispatchAbortSignal();
    if (effectiveAbortSignal?.aborted) {
      return;
    }
    const result = await routeReplyToOriginating(payload, {
      abortSignal: effectiveAbortSignal,
      mirror,
      kind,
    });
    if (result && !result.ok) {
      logVerbose(`dispatch-from-config: route-reply failed: ${result.error ?? "unknown error"}`);
    }
  };

  const deliverBindingPayload = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
  ): Promise<boolean> => {
    const result = await routeReplyToOriginating(payload, {
      kind: mode === "terminal" ? "final" : "tool",
    });
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
  const sendBindingNotice = async (
    payload: ReplyPayload,
    mode: "additive" | "terminal",
  ): Promise<boolean> => {
    if (suppressAutomaticSourceDelivery) {
      return false;
    }
    return await deliverBindingPayload(payload, mode);
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
  const silentReplyConversationType = resolveRoutedPolicyConversationType(ctx);
  const silentReplySurface = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider);
  const emptyFinalAllowedAsSilent =
    silentReplyConversationType !== undefined &&
    resolveSilentReplyPolicyFromPolicies({
      conversationType: silentReplyConversationType,
      defaultPolicy: cfg.agents?.defaults?.silentReply,
      surfacePolicy: silentReplySurface
        ? cfg.surfaces?.[silentReplySurface]?.silentReply
        : undefined,
    }) === "allow";
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
          sessionStore: sessionStoreEntry.store,
          turnModelOverride: resolveTurnModelOverride(params.replyOptions),
        })
      : undefined;
  const effectiveVisibleReplies = configuredVisibleReplies ?? harnessDefaultVisibleReplies;
  const prefersMessageToolDelivery =
    params.replyOptions?.sourceReplyDeliveryMode === "message_tool_only" ||
    (ctx.InboundEventKind === "room_event" && !isInternalWebchatTurn) ||
    (params.replyOptions?.sourceReplyDeliveryMode === undefined &&
      !isExplicitSourceReplyCommand(ctx, cfg) &&
      (configuredVisibleReplies === "message_tool" ||
        (!isInternalWebchatTurn && effectiveVisibleReplies === "message_tool")));
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
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(cfg, acpDispatchSessionKey, {
    store: subagentStore,
  });
  const messageToolAvailable = isToolAllowedByPolicies("message", [
    profilePolicy,
    providerProfilePolicy,
    globalProviderPolicy,
    agentProviderPolicy,
    globalPolicy,
    agentPolicy,
    groupPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  ]);
  const sourceReplyPolicy = resolveSourceReplyVisibilityPolicy({
    cfg,
    ctx,
    requested: params.replyOptions?.sourceReplyDeliveryMode,
    strictMessageToolOnly: ctx.InboundEventKind === "room_event" && !isInternalWebchatTurn,
    sendPolicy,
    suppressAcpChildUserDelivery,
    explicitSuppressTyping: params.replyOptions?.suppressTyping === true,
    shouldSuppressTyping,
    messageToolAvailable,
    defaultVisibleReplies: harnessDefaultVisibleReplies,
  });
  const {
    sourceReplyDeliveryMode,
    sessionStableSourceReplyDeliveryMode,
    suppressAutomaticSourceDelivery,
    suppressDelivery,
    sendPolicyDenied,
    deliverySuppressionReason,
    suppressHookUserDelivery,
    suppressHookReplyLifecycle,
  } = sourceReplyPolicy;
  const reasoningPayloadsEnabled = params.replyOptions?.reasoningPayloadsEnabled === true;
  const commentaryPayloadsEnabled = params.replyOptions?.commentaryPayloadsEnabled === true;
  const attachSourceReplyDeliveryMode = (
    result: DispatchFromConfigResult,
  ): DispatchFromConfigResult =>
    sourceReplyDeliveryMode === "message_tool_only" || sendPolicyDenied
      ? {
          ...result,
          ...(sourceReplyDeliveryMode === "message_tool_only" ? { sourceReplyDeliveryMode } : {}),
          ...(sendPolicyDenied ? { sendPolicyDenied: true } : {}),
        }
      : result;
  const explicitCommandTurnCtx = isExplicitSourceReplyCommand(ctx, cfg);
  const unauthorizedTextSlashSourceReplyCtx =
    (chatType === "group" || chatType === "channel") && isUnauthorizedTextSlashCommand(ctx);
  const shouldDeliverPluginBindingReply =
    !suppressAutomaticSourceDelivery ||
    explicitCommandTurnCtx ||
    (ctx.InboundEventKind !== "room_event" && !unauthorizedTextSlashSourceReplyCtx);

  const inboundDedupeClaim = claimInboundDedupe(ctx);
  if (inboundDedupeClaim.status === "duplicate" || inboundDedupeClaim.status === "inflight") {
    recordProcessed("skipped", { reason: "duplicate" });
    return attachSourceReplyDeliveryMode({
      queuedFinal: false,
      counts: dispatcher.getQueuedCounts(),
    });
  }
  const commitInboundDedupeIfClaimed = () => {
    if (inboundDedupeClaim.status === "claimed") {
      commitInboundDedupe(inboundDedupeClaim.key);
    }
  };
  const releaseInboundDedupeIfClaimed = () => {
    if (inboundDedupeClaim.status === "claimed") {
      releaseInboundDedupe(inboundDedupeClaim.key);
    }
  };
  const finishReplyOperationBusyDispatch = (opts?: {
    dedupeDisposition?: "commit" | "release";
    recordAgentDispatchCompleted?: boolean;
    sessionMetadataChanges?: DispatchFromConfigResult["sessionMetadataChanges"];
  }): DispatchFromConfigResult => {
    void releasePreDispatchLifecycleAdmission(() => waitForReplyDispatcherIdle(dispatcher));
    if (opts?.recordAgentDispatchCompleted) {
      recordAgentDispatchCompleted("completed", { reason: "reply-operation-active" });
    }
    recordProcessed("skipped", { reason: "reply-operation-active" });
    markIdle("message_completed");
    if (opts?.dedupeDisposition === "release") {
      releaseInboundDedupeIfClaimed();
    } else {
      commitInboundDedupeIfClaimed();
    }
    return attachSourceReplyDeliveryMode({
      queuedFinal: false,
      counts: dispatcher.getQueuedCounts(),
      ...(opts?.sessionMetadataChanges
        ? { sessionMetadataChanges: opts.sessionMetadataChanges }
        : {}),
    });
  };
  const finishReplyOperationAbortedDispatch = (): DispatchFromConfigResult => {
    commitInboundDedupeIfClaimed();
    recordProcessed("completed", { reason: "reply_operation_aborted" });
    markIdle("message_completed");
    completeDispatchReplyOperation();
    return attachSourceReplyDeliveryMode({
      queuedFinal: false,
      counts: dispatcher.getQueuedCounts(),
    });
  };

  let pluginFallbackReason:
    | "plugin-bound-fallback-missing-plugin"
    | "plugin-bound-fallback-no-handler"
    | undefined;
  const emitMessageReceivedHooks = () => {
    if (
      ctx.SuppressMessageReceivedHooks !== true &&
      hookRunner?.hasHooks("message_received") === true
    ) {
      const messageReceivedHookContext = buildMessageReceivedHookContext();
      fireAndForgetHook(
        hookRunner.runMessageReceived(
          toPluginMessageReceivedEvent(messageReceivedHookContext),
          toPluginMessageContext(messageReceivedHookContext),
        ),
        "dispatch-from-config: message_received plugin hook failed",
      );
    }
    if (ctx.SuppressMessageReceivedHooks !== true && sessionKey) {
      const messageReceivedHookContext = buildMessageReceivedHookContext();
      fireAndForgetHook(
        triggerInternalHook(
          createInternalHookEvent("message", "received", sessionKey, {
            ...toInternalMessageReceivedContext(messageReceivedHookContext),
            timestamp,
          }),
        ),
        "dispatch-from-config: message_received internal hook failed",
      );
    }
  };
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
      if (pluginOwnedBinding) {
        touchConversationBindingRecord(pluginOwnedBinding.bindingId);
      }
      emitMessageReceivedHooks();
      let queuedFinal = false;
      let routedFinalCount = 0;
      if (!suppressDelivery) {
        const payload = {
          text: formatAbortReplyTextResolver(fastAbort.stoppedSubagents, fastAbort.rejectionReason),
        } satisfies ReplyPayload;
        const result = await routeReplyToOriginating(payload);
        if (result) {
          queuedFinal = result.ok;
          if (isRoutedReplyDelivered(result)) {
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
      completeDispatchReplyOperation();
      return attachSourceReplyDeliveryMode({ queuedFinal, counts });
    }
    // Own the session before plugin-bound handlers or message hooks can perform
    // work. Fast abort and inbound dedupe intentionally remain ahead of this gate.
    const preDispatchAcquisition = await ensureDispatchReplyOperation("pre_dispatch");
    if (preDispatchAcquisition.status === "aborted") {
      return finishReplyOperationAbortedDispatch();
    }
    if (preDispatchAcquisition.status === "busy") {
      return finishReplyOperationBusyDispatch({ dedupeDisposition: "release" });
    }

    if (pluginOwnedBinding) {
      if (isPreDispatchOperationAborted()) {
        return finishReplyOperationAbortedDispatch();
      }
      touchConversationBindingRecord(pluginOwnedBinding.bindingId);
      if (shouldBypassPluginOwnedBindingForCommand(ctx, cfg)) {
        logVerbose(
          `plugin-bound inbound command escaped plugin binding (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to command processing`,
        );
      } else if (sendPolicyDenied || (suppressDelivery && !suppressAutomaticSourceDelivery)) {
        // Plugin-bound inbound handlers typically emit outbound replies we
        // cannot rewind. When automatic delivery is explicitly denied, skip the
        // plugin claim and fall through to normal suppressed agent processing.
        // message_tool_only is the normal visible-reply mode for group chats and
        // must still let the bound plugin own the turn unless sendPolicy denied it.
        logVerbose(
          `plugin-bound inbound skipped under ${deliverySuppressionReason} (plugin=${pluginOwnedBinding.pluginId} session=${sessionKey ?? "unknown"}); falling through to suppressed agent processing`,
        );
      } else {
        logVerbose(
          `plugin-bound inbound routed to ${pluginOwnedBinding.pluginId} conversation=${pluginOwnedBinding.conversationId}`,
        );
        // Bound native runtimes need the current owner decision, not stale bind-time identity.
        // The resolver folds internal operator.admin authority into this owner decision.
        const bindingAuthorization = resolveCommandAuthorization({
          ctx,
          cfg,
          commandAuthorized: ctx.CommandAuthorized,
        });
        const targetedClaimOutcome = hookRunner?.runInboundClaimForPluginOutcome
          ? await (async () => {
              await prepareHookMediaMetadata();
              if (isPreDispatchOperationAborted()) {
                throw new DispatchReplyOperationAbortedError();
              }
              const authorizedInboundClaimEvent = {
                ...inboundClaimEvent,
                senderIsOwner: bindingAuthorization.senderIsOwner,
              };
              return await runWithDispatchLifecycleAdmission(
                async () =>
                  await hookRunner.runInboundClaimForPluginOutcome(
                    pluginOwnedBinding.pluginId,
                    authorizedInboundClaimEvent,
                    { ...inboundClaimContext, pluginBinding: pluginOwnedBinding },
                  ),
              );
            })()
          : (() => {
              const pluginLoaded =
                getGlobalPluginRegistry()?.plugins.some(
                  (plugin) =>
                    plugin.id === pluginOwnedBinding.pluginId && plugin.status === "loaded",
                ) ?? false;
              return pluginLoaded
                ? ({ status: "no_handler" } as const)
                : ({ status: "missing_plugin" } as const);
            })();

        if (isPreDispatchOperationAborted()) {
          return finishReplyOperationAbortedDispatch();
        }

        switch (targetedClaimOutcome.status) {
          case "handled": {
            if (targetedClaimOutcome.result.reply && shouldDeliverPluginBindingReply) {
              // A bound plugin's reply is the explicit output for this claimed turn,
              // not an automatic agent final; message-tool-only suppression must not
              // turn normal user-request bindings into silent channel responses.
              // Ambient room events keep the same privacy guard as final replies.
              await deliverBindingPayload(targetedClaimOutcome.result.reply, "terminal");
            }
            markIdle("plugin_binding_dispatch");
            recordProcessed("completed", { reason: "plugin-bound-handled" });
            commitInboundDedupeIfClaimed();
            completeDispatchReplyOperation();
            return attachSourceReplyDeliveryMode({
              queuedFinal: false,
              counts: dispatcher.getQueuedCounts(),
            });
          }
          case "missing_plugin":
          case "no_handler": {
            pluginFallbackReason =
              targetedClaimOutcome.status === "missing_plugin"
                ? "plugin-bound-fallback-missing-plugin"
                : "plugin-bound-fallback-no-handler";
            const isUnmentionedGroupFallback =
              (chatType === "group" || chatType === "channel") &&
              ctx.WasMentioned === false &&
              !explicitCommandTurnCtx;
            const shouldSuppressUnmentionedFallback =
              isUnmentionedGroupFallback && ctx.GroupRequireMention !== false;
            if (shouldSuppressUnmentionedFallback) {
              markIdle("plugin_binding_fallback_unmentioned");
              recordProcessed("completed", { reason: pluginFallbackReason });
              commitInboundDedupeIfClaimed();
              completeDispatchReplyOperation();
              return attachSourceReplyDeliveryMode({
                queuedFinal: false,
                counts: dispatcher.getQueuedCounts(),
              });
            }
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
            completeDispatchReplyOperation();
            return attachSourceReplyDeliveryMode({
              queuedFinal: false,
              counts: dispatcher.getQueuedCounts(),
            });
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
            completeDispatchReplyOperation();
            return attachSourceReplyDeliveryMode({
              queuedFinal: false,
              counts: dispatcher.getQueuedCounts(),
            });
          }
        }
      }
    }

    emitMessageReceivedHooks();

    const shouldSuppressDefaultToolProgressMessages = () => !shouldEmitVerboseProgress();
    const shouldSendVerboseProgressMessages = () => !shouldSuppressDefaultToolProgressMessages();
    const shouldSendToolSummaries = () => shouldSendVerboseProgressMessages();
    const shouldSendToolStartStatuses = false;
    const notifiedSessionMetadataChangeKeys = new Set<string>();
    let sessionMetadataChangesForResult: CommandSessionMetadataChange[] | undefined;
    const notifySessionMetadataChanges = (
      changes: CommandSessionMetadataChange[] | undefined,
    ): void => {
      if (!changes?.length) {
        return;
      }
      const freshChanges: CommandSessionMetadataChange[] = [];
      for (const change of changes) {
        const key = JSON.stringify([change.sessionKey, change.agentId ?? null, change.reason]);
        if (notifiedSessionMetadataChangeKeys.has(key)) {
          continue;
        }
        notifiedSessionMetadataChangeKeys.add(key);
        freshChanges.push(change);
      }
      if (freshChanges.length === 0) {
        return;
      }
      sessionMetadataChangesForResult = [
        ...(sessionMetadataChangesForResult ?? []),
        ...freshChanges,
      ];
      params.onSessionMetadataChanges?.(freshChanges);
    };
    const shouldDeliverVerboseProgressDespiteSourceSuppression = () =>
      suppressAutomaticSourceDelivery &&
      sourceReplyDeliveryMode === "message_tool_only" &&
      ctx.InboundEventKind !== "room_event" &&
      !sendPolicyDenied &&
      shouldEmitVerboseProgress() &&
      shouldSendVerboseProgressMessages();
    const shouldDeliverForcedToolProgressDespiteSourceSuppression = () =>
      suppressAutomaticSourceDelivery &&
      sourceReplyDeliveryMode === "message_tool_only" &&
      ctx.InboundEventKind !== "room_event" &&
      !sendPolicyDenied &&
      params.replyOptions?.forceToolResultProgress === true;
    const shouldDeliverFastModeAutoProgressDespiteSourceSuppression = () =>
      suppressAutomaticSourceDelivery &&
      sourceReplyDeliveryMode === "message_tool_only" &&
      ctx.InboundEventKind !== "room_event" &&
      !sendPolicyDenied;
    let finalReplyDeliveryStarted = false;
    const hasExecApprovalPayload = (payload: ReplyPayload) => {
      const execApproval =
        payload.channelData &&
        typeof payload.channelData === "object" &&
        !Array.isArray(payload.channelData)
          ? payload.channelData.execApproval
          : undefined;
      return execApproval && typeof execApproval === "object" && !Array.isArray(execApproval);
    };
    const shouldSuppressLateTextOnlyToolProgress = (payload: ReplyPayload) => {
      if (!finalReplyDeliveryStarted) {
        return false;
      }
      const reply = resolveSendableOutboundReplyParts(payload);
      return !reply.hasMedia && !hasExecApprovalPayload(payload);
    };
    // Durable inter-tool commentary lane: with verbose progress on, preamble
    // items become standalone progress messages like tool summaries. The latest
    // text per item id is buffered (snapshot producers re-emit the same item)
    // and flushed when the producer moves on, always before the final reply.
    let pendingCommentaryProgress: { itemId?: string; text: string } | null = null;
    const deliverCommentaryProgressMessage = async (text: string) => {
      if (!shouldSendToolSummaries() || shouldSuppressProgressDelivery()) {
        return;
      }
      const payload: ReplyPayload = { text: `💬 ${text}` };
      if (shouldSuppressLateTextOnlyToolProgress(payload)) {
        return;
      }
      if (shouldRouteToOriginating) {
        await sendPayloadAsync(payload, undefined, false);
      } else {
        markInboundDedupeReplayUnsafe();
        dispatcher.sendToolResult(payload);
      }
    };
    const flushPendingCommentaryProgress = async () => {
      const pending = pendingCommentaryProgress;
      pendingCommentaryProgress = null;
      const text = pending?.text.trim();
      if (!text) {
        return;
      }
      await deliverCommentaryProgressMessage(text);
    };
    const noteCommentaryProgress = async (payload: { itemId?: string; progressText?: string }) => {
      const itemId = payload.itemId?.trim() || undefined;
      const text = payload.progressText ?? "";
      const updatesBufferedItem =
        pendingCommentaryProgress !== null &&
        pendingCommentaryProgress.itemId !== undefined &&
        pendingCommentaryProgress.itemId === itemId;
      if (!text.trim()) {
        // Empty commentary with an item id means the producer retracted that
        // item; drop it if it has not been sent yet.
        if (updatesBufferedItem) {
          pendingCommentaryProgress = null;
        }
        return;
      }
      if (pendingCommentaryProgress && !updatesBufferedItem) {
        await flushPendingCommentaryProgress();
      }
      pendingCommentaryProgress = { itemId, text };
    };
    const shouldSuppressMessageToolOnlyTextErrorProgress = (payload: ReplyPayload) => {
      if (
        sourceReplyDeliveryMode !== "message_tool_only" ||
        shouldEmitFullVerboseProgress() ||
        payload.isError !== true
      ) {
        return false;
      }
      const reply = resolveSendableOutboundReplyParts(payload);
      return !reply.hasMedia && !hasExecApprovalPayload(payload);
    };
    const sendFinalPayload = async (
      payload: ReplyPayload,
      options: { abortSignal?: AbortSignal; deliveryId?: string } = {},
    ): Promise<{ queuedFinal: boolean; routedFinalCount: number }> => {
      const abortSignal = options.abortSignal ?? getDispatchAbortSignal();
      const throwIfFinalDeliveryAborted = () => {
        if (abortSignal?.aborted) {
          throw new DispatchReplyOperationAbortedError();
        }
      };
      throwIfFinalDeliveryAborted();
      // Trailing commentary must land ahead of the final answer.
      await flushPendingCommentaryProgress();
      throwIfFinalDeliveryAborted();
      const payloadMetadata = getReplyPayloadMetadata(payload);
      const sourceReplySessionBinding = resolvePreparedTranscriptBinding(
        payloadMetadata?.sourceReplyTranscriptMirror?.sessionKey,
      );
      const sourceReplyTranscriptMirror = payloadMetadata?.sourceReplyTranscriptMirror
        ? {
            ...payloadMetadata.sourceReplyTranscriptMirror,
            ...(sourceReplySessionBinding
              ? { expectedSessionId: sourceReplySessionBinding.sessionId }
              : {}),
            storePath: sourceReplySessionBinding?.storePath ?? sessionStoreEntry.storePath,
          }
        : undefined;
      const hasTranscriptOwner =
        payloadMetadata?.assistantMessageIndex !== undefined ||
        payloadMetadata?.assistantTranscriptOwned === true;
      const hasVisibleFinalContent = hasOutboundReplyContent(payload, { trimText: true });
      if (hasVisibleFinalContent) {
        markInboundDedupeReplayUnsafe();
        finalReplyDeliveryStarted = true;
      }
      const ttsPayload =
        payload.isReasoning === true || payload.isCommentary === true
          ? payload
          : await maybeApplyTtsToReplyPayload({
              payload,
              cfg,
              channel: deliveryChannel,
              kind: "final",
              inboundAudio: hasInboundAudioForTts(),
              ttsAuto: sessionTtsAuto,
              agentId: sessionAgentId,
              accountId: replyRoute.accountId,
            });
      throwIfFinalDeliveryAborted();
      const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
      throwIfFinalDeliveryAborted();
      const result = await routeReplyToOriginating(normalizedPayload, {
        abortSignal,
        kind: "final",
        ...(hasTranscriptOwner ? { mirror: false } : {}),
      });
      if (result) {
        if (!result.ok) {
          logVerbose(
            `dispatch-from-config: route-reply (final) failed: ${result.error ?? "unknown error"}`,
          );
        }
        if (isRoutedReplyDelivered(result)) {
          await mirrorDeliveredReplyToTranscript({
            metadata: sourceReplyTranscriptMirror,
            cfg,
          });
        }
        return {
          queuedFinal: result.ok,
          routedFinalCount: isRoutedReplyDelivered(result) ? 1 : 0,
        };
      }
      throwIfFinalDeliveryAborted();
      const transcriptMirrorSessionKey =
        acpDispatchSessionKey ?? sessionStoreEntry.sessionKey ?? sessionKey;
      const transcriptMirrorSourceId =
        normalizeOptionalString(messageIdForHook) ??
        normalizeOptionalString(params.replyOptions?.runId);
      const transcriptMirrorSessionBinding = resolvePreparedTranscriptBinding(
        transcriptMirrorSessionKey,
      );
      const transcriptMirror =
        sourceReplyTranscriptMirror ??
        (normalizedCurrentSurface === "slack" &&
        hasVisibleFinalContent &&
        transcriptMirrorSessionKey
          ? transcriptMirrorForDeliveredPayload(
              {
                sessionKey: transcriptMirrorSessionKey,
                agentId: sessionAgentId,
                ...(transcriptMirrorSessionBinding
                  ? { expectedSessionId: transcriptMirrorSessionBinding.sessionId }
                  : {}),
                storePath: transcriptMirrorSessionBinding?.storePath ?? sessionStoreEntry.storePath,
                preferText: true,
                ...(hasTranscriptOwner ? { transcriptOwner: true } : {}),
                idempotencyKey: transcriptMirrorSourceId
                  ? `channel-final:${transcriptMirrorSourceId}:${options.deliveryId ?? "single"}`
                  : undefined,
                deliveryMirror: {
                  kind: "channel-final",
                  ...(transcriptMirrorSourceId
                    ? { sourceMessageId: transcriptMirrorSourceId }
                    : {}),
                },
              },
              normalizedPayload,
            )
          : undefined);
      markInboundDedupeReplayUnsafe();
      const finalOutcomeBefore = transcriptMirror
        ? getDispatcherFinalOutcomeCounts(dispatcher)
        : undefined;
      const finalDeliveryCapture = transcriptMirror ? {} : undefined;
      const deliveredTranscriptMirror = transcriptMirror
        ? captureDeliveredTranscriptMirror({
            dispatcher,
            metadata: transcriptMirror,
            deliveryId: options.deliveryId,
            captureToken: finalDeliveryCapture,
          })
        : undefined;
      if (finalDeliveryCapture) {
        setReplyPayloadMetadata(normalizedPayload, { finalDeliveryCapture });
      }
      const queuedFinal = dispatcher.sendFinalReply(normalizedPayload);
      if (queuedFinal && deliveredTranscriptMirror && finalOutcomeBefore) {
        // The common settle owner runs this after successful delivery or
        // cancellation. Keeping reconciliation out of the reply operation lets a
        // newer foreground turn settle without creating an operation/idle cycle.
        registerReplyDispatcherSettledTask(dispatcher, () =>
          mirrorTranscriptAfterDispatcherSettled({
            dispatcher,
            before: finalOutcomeBefore,
            metadata: deliveredTranscriptMirror,
            cfg,
          }),
        );
      }
      return {
        queuedFinal,
        routedFinalCount: 0,
      };
    };

    // Run before_dispatch hook — let plugins inspect or handle before model dispatch.
    if (hookRunner?.hasHooks("before_dispatch")) {
      const beforeDispatchResult = await traceReplyPhase("reply.before_dispatch_hooks", () =>
        runWithDispatchLifecycleAdmission(
          async () =>
            await runWithDispatchAbortSignal(
              getPreDispatchAbortSignal(),
              () =>
                hookRunner.runBeforeDispatch(
                  {
                    content: hookContext.content,
                    body: hookContext.bodyForAgent ?? hookContext.body,
                    channel: hookContext.channelId,
                    sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
                    senderId: hookContext.senderId,
                    replyToId: hookContext.replyToId,
                    replyToIdFull: hookContext.replyToIdFull,
                    replyToBody: hookContext.replyToBody,
                    replyToSender: hookContext.replyToSender,
                    replyToIsQuote: hookContext.replyToIsQuote,
                    isGroup: hookContext.isGroup,
                    timestamp: hookContext.timestamp,
                  },
                  {
                    channelId: hookContext.channelId,
                    accountId: hookContext.accountId,
                    conversationId: inboundClaimContext.conversationId,
                    sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
                    senderId: hookContext.senderId,
                    replyToId: hookContext.replyToId,
                    replyToIdFull: hookContext.replyToIdFull,
                    replyToBody: hookContext.replyToBody,
                    replyToSender: hookContext.replyToSender,
                    replyToIsQuote: hookContext.replyToIsQuote,
                  },
                ),
              trackDispatchLifecycleWork,
            ),
        ),
      );
      if (beforeDispatchResult?.handled) {
        const text = beforeDispatchResult.text;
        let queuedFinal = false;
        let routedFinalCount = 0;
        if (text && !suppressDelivery) {
          const handledReply = await sendFinalPayload(
            { text },
            {
              abortSignal: getPreDispatchAbortSignal(),
              deliveryId: "before-dispatch",
            },
          );
          queuedFinal = handledReply.queuedFinal;
          routedFinalCount += handledReply.routedFinalCount;
        }
        const counts = dispatcher.getQueuedCounts();
        counts.final += routedFinalCount;
        recordProcessed("completed", { reason: "before_dispatch_handled" });
        markIdle("message_completed");
        commitInboundDedupeIfClaimed();
        completeDispatchReplyOperation();
        return attachSourceReplyDeliveryMode({ queuedFinal, counts });
      }
    }

    if (hookRunner?.hasHooks("reply_dispatch")) {
      const replyDispatchResult = await traceReplyPhase("reply.reply_dispatch_hooks", () =>
        runWithDispatchLifecycleAdmission(
          async () =>
            await runWithDispatchAbortSignal(
              getPreDispatchAbortSignal(),
              () =>
                hookRunner.runReplyDispatch(
                  createReplyDispatchEvent({
                    ctx,
                    runId: params.replyOptions?.runId,
                    sessionKey: acpDispatchSessionKey,
                    toolsAllow: params.replyOptions?.toolsAllow,
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
                    originatingAccountId: replyContextAccountId,
                    originatingThreadId: routeReplyThreadId,
                    originatingChatType: replyRoute.chatType,
                    shouldSendToolSummaries,
                    sendPolicy,
                  }),
                  {
                    cfg,
                    dispatcher: dispatchHookDispatcher,
                    abortSignal: getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                    onReplyStart: params.replyOptions?.onReplyStart,
                    recordProcessed,
                    markIdle,
                  },
                ),
              trackDispatchLifecycleWork,
            ),
        ),
      );
      if (replyDispatchResult?.handled) {
        commitInboundDedupeIfClaimed();
        completeDispatchReplyOperation();
        return attachSourceReplyDeliveryMode({
          queuedFinal: replyDispatchResult.queuedFinal,
          counts: replyDispatchResult.counts,
        });
      }
    }

    const dispatchAcquisition = await ensureDispatchReplyOperation("dispatch");
    if (dispatchAcquisition.status === "aborted") {
      return finishReplyOperationAbortedDispatch();
    }
    if (dispatchAcquisition.status === "busy") {
      return finishReplyOperationBusyDispatch({ dedupeDisposition: "release" });
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
    let didSendPlanStatusNotice = false;
    const normalizeWorkingLabel = (label: string) => {
      const collapsed = label.replace(/\s+/g, " ").trim();
      if (collapsed.length <= 80) {
        return collapsed;
      }
      return `${truncateUtf16Safe(collapsed, 77).trimEnd()}...`;
    };
    const formatPlanUpdateText = (payload: { explanation?: string; steps?: string[] }) => {
      const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
      const steps = (payload.steps ?? [])
        .map((step) => step.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (steps.length > 0) {
        return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
      }
      return explanation || "Planning next steps.";
    };
    const maybeSendWorkingStatus = async (label: string): Promise<void> => {
      if (shouldSuppressProgressDelivery()) {
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
      if (
        shouldSuppressProgressDelivery() ||
        !shouldSendVerboseProgressMessages() ||
        didSendPlanStatusNotice
      ) {
        return;
      }
      didSendPlanStatusNotice = true;
      const replyPayload: ReplyPayload = {
        text: formatPlanUpdateText(payload),
        isStatusNotice: true,
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
      if (shouldSendToolSummaries()) {
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
      if (isFastModeAutoProgressPayload(payload)) {
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
    const shouldSuppressProgressDelivery = () =>
      sendPolicyDenied ||
      (suppressDelivery && !shouldDeliverVerboseProgressDespiteSourceSuppression());
    const hasVisibleRegularVerboseToolProgress = () =>
      shouldEmitVerboseProgress() &&
      !shouldEmitFullVerboseProgress() &&
      shouldSendVerboseProgressMessages() &&
      ctx.InboundEventKind !== "room_event" &&
      !shouldSuppressProgressDelivery();
    let observedVisibleToolErrorProgress = false;
    const markVisibleToolErrorProgress = () => {
      if (hasVisibleRegularVerboseToolProgress()) {
        observedVisibleToolErrorProgress = true;
      }
    };
    const hasFailedProgressStatus = (payload: {
      phase?: string;
      status?: string;
      exitCode?: number | null;
    }) =>
      payload.phase === "error" ||
      payload.status === "failed" ||
      payload.status === "error" ||
      (typeof payload.exitCode === "number" && payload.exitCode !== 0);
    const shouldSuppressToolErrorWarnings = () => {
      if (params.replyOptions?.suppressToolErrorWarnings !== undefined) {
        return params.replyOptions.suppressToolErrorWarnings;
      }
      if (!shouldEmitVerboseProgress()) {
        return false;
      }
      return observedVisibleToolErrorProgress ? true : undefined;
    };
    const suppressToolErrorWarnings =
      params.replyOptions?.suppressToolErrorWarnings ??
      (observedVisibleToolErrorProgress ? true : undefined);
    const onToolResultFromReplyOptions = params.replyOptions?.onToolResult;
    const onPlanUpdateFromReplyOptions = params.replyOptions?.onPlanUpdate;
    const onApprovalEventFromReplyOptions = params.replyOptions?.onApprovalEvent;
    const onPatchSummaryFromReplyOptions = params.replyOptions?.onPatchSummary;
    const allowSuppressedSourceProgressCallbacks =
      params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed === true;
    const isChannelOwnedToolResultProgressPayload = (payload: ReplyPayload) => {
      const text = normalizeOptionalString(payload.text);
      return Boolean(text?.startsWith("🛠️") || text?.startsWith("🔧"));
    };
    const shouldForwardToolResultProgressCallback = (
      payload: ReplyPayload,
      isFastModeAutoProgress: boolean,
    ) => {
      if (isFastModeAutoProgress) {
        return shouldForwardProgressCallback({ forwardWhenSourceDeliverySuppressed: true });
      }
      if (
        allowSuppressedSourceProgressCallbacks &&
        isChannelOwnedToolResultProgressPayload(payload)
      ) {
        return shouldForwardProgressCallback({ forwardWhenSourceDeliverySuppressed: true });
      }
      return shouldSendToolSummaries() && shouldForwardProgressCallback();
    };
    const shouldAllowQuietChannelOwnedProgressCallbacks = (options?: {
      allowWhenToolSummariesHidden?: boolean;
      requiresToolSummaryVisibility?: boolean;
    }) =>
      options?.requiresToolSummaryVisibility === true &&
      (params.replyOptions?.suppressDefaultToolProgressMessages === true ||
        options.allowWhenToolSummariesHidden === true);
    let hasPendingDirectBlockReplyDelivery = false;
    const waitForPendingDirectBlockReplyDelivery = async (abortSignal?: AbortSignal) => {
      if (!hasPendingDirectBlockReplyDelivery) {
        return;
      }
      // Direct block replies are queued asynchronously so lightweight replies do
      // not wait for dispatcher idle. Flush only before later tool/progress
      // callbacks and final completion where external ordering is visible.
      hasPendingDirectBlockReplyDelivery = false;
      await waitForReplyDispatcherIdle(dispatcher, abortSignal);
    };
    const shouldForwardProgressCallback = (options?: {
      allowWhenToolSummariesHidden?: boolean;
      forwardWhenSourceDeliverySuppressed?: boolean;
      requiresToolSummaryVisibility?: boolean;
    }) => {
      if (
        options?.requiresToolSummaryVisibility === true &&
        !shouldSendToolSummaries() &&
        !shouldAllowQuietChannelOwnedProgressCallbacks(options)
      ) {
        return false;
      }
      return (
        !suppressAutomaticSourceDelivery ||
        (allowSuppressedSourceProgressCallbacks &&
          !sendPolicyDenied &&
          options?.forwardWhenSourceDeliverySuppressed === true)
      );
    };
    const preserveProgressCallbackStartOrder =
      params.replyOptions?.preserveProgressCallbackStartOrder === true;
    let progressCallbackStartTail = Promise.resolve();
    const reserveProgressCallbackStart = () => {
      const previousStart = progressCallbackStartTail;
      let releaseStart: (() => void) | undefined;
      progressCallbackStartTail = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return {
        previousStart,
        releaseStart: () => releaseStart?.(),
      };
    };
    const wrapProgressCallback = <Args extends unknown[], Result extends false | void>(
      callback: ((...args: Args) => Promise<Result> | Result) | undefined,
      options?: {
        allowWhenToolSummariesHidden?: boolean;
        forwardWhenSourceDeliverySuppressed?: boolean;
        requiresToolSummaryVisibility?: boolean;
        onForward?: (...args: Args) => Promise<void> | void;
        onVisible?: (...args: Args) => Promise<void> | void;
        waitForDirectBlockReplyDelivery?: boolean;
      },
    ): ((...args: Args) => Promise<Result | undefined>) | undefined => {
      if (!callback) {
        return undefined;
      }
      const runProgressCallback = async (
        args: Args,
        noteCallbackStarted: () => void,
      ): Promise<Result | undefined> => {
        try {
          if (isDispatchOperationAborted()) {
            return undefined;
          }
          dispatchReplyOperation?.recordActivity();
          markProgress();
          if (options?.waitForDirectBlockReplyDelivery) {
            await waitForPendingDirectBlockReplyDelivery(dispatchAbortOperation?.abortSignal);
            if (isDispatchOperationAborted()) {
              return undefined;
            }
          }
          if (shouldForwardProgressCallback(options)) {
            if (preserveProgressCallbackStartOrder && options?.onForward) {
              await options.onForward(...args);
            } else if (!preserveProgressCallbackStartOrder) {
              // Preserve the historical microtask boundary for unflagged channels.
              await options?.onForward?.(...args);
            }
            const callbackResult = callback(...args);
            noteCallbackStarted();
            const result = await callbackResult;
            if (result === false) {
              return result;
            }
            await options?.onVisible?.(...args);
          }
          return undefined;
        } finally {
          noteCallbackStarted();
        }
      };
      return (...args: Args) => {
        if (!preserveProgressCallbackStartOrder) {
          return runProgressCallback(args, () => undefined);
        }
        // Reserve source order synchronously. Release after callback invocation, not completion,
        // so async presentation work stays concurrent without letting later activity overtake it.
        const start = reserveProgressCallbackStart();
        return (async () => {
          await start.previousStart;
          return await runProgressCallback(args, start.releaseStart);
        })();
      };
    };

    // Snapshot verbose progress visibility for this run: commentary
    // classification in the CLI runners is wired once at run start, so a
    // mid-run verbose toggle cannot move inter-tool commentary between lanes.
    const deliverStandaloneCommentaryProgress = shouldEmitVerboseProgress();
    const itemEventForwardingOptions = {
      forwardWhenSourceDeliverySuppressed: true,
      requiresToolSummaryVisibility: true,
    } as const;
    const canForwardItemEvents =
      Boolean(params.replyOptions?.onItemEvent) &&
      shouldForwardProgressCallback(itemEventForwardingOptions);
    const canForwardSuppressedSourceItemEvents =
      suppressAutomaticSourceDelivery &&
      allowSuppressedSourceProgressCallbacks &&
      canForwardItemEvents;
    const forwardItemEvent = canForwardItemEvents
      ? wrapProgressCallback(params.replyOptions?.onItemEvent, {
          ...itemEventForwardingOptions,
          waitForDirectBlockReplyDelivery: true,
          onForward: (payload) =>
            preserveProgressCallbackStartOrder &&
            deliverStandaloneCommentaryProgress &&
            payload.kind === "preamble"
              ? noteCommentaryProgress(payload)
              : undefined,
          onVisible: (payload) => {
            if (hasFailedProgressStatus(payload)) {
              markVisibleToolErrorProgress();
            }
          },
        })
      : undefined;
    const canConsumeItemEvents = deliverStandaloneCommentaryProgress || canForwardItemEvents;
    // Item-event presence gates CLI commentary classification downstream, so
    // the handler exists exactly when verbose buffers it or a channel consumes it.
    const onItemEvent = canConsumeItemEvents
      ? async (payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0]) => {
          if (isDispatchOperationAborted()) {
            return;
          }
          if (!forwardItemEvent) {
            // The wrapped forwarder marks progress itself when present.
            markProgress();
          }
          if (
            (!forwardItemEvent || !preserveProgressCallbackStartOrder) &&
            deliverStandaloneCommentaryProgress &&
            payload.kind === "preamble"
          ) {
            await noteCommentaryProgress(payload);
          }
          return await forwardItemEvent?.(payload);
        }
      : undefined;
    // Let draft-rendering channels yield their ephemeral commentary lines while
    // the durable verbose commentary lane is delivering the same content.
    params.replyOptions?.onVerboseProgressVisibility?.(
      () =>
        deliverStandaloneCommentaryProgress &&
        shouldSendVerboseProgressMessages() &&
        !shouldSuppressProgressDelivery(),
    );

    const replyResolver =
      params.replyResolver ??
      (await traceReplyPhase("reply.load_reply_resolver", () => loadGetReplyFromConfigRuntime()))
        .getReplyFromConfig;
    const replyConfig = withFullRuntimeReplyConfig(
      params.configOverride ? (applyMergePatch(cfg, params.configOverride) as OpenClawConfig) : cfg,
    );
    recordAgentDispatchStarted();
    const replyResult = await runWithDispatchLifecycleAdmission(
      async () =>
        await runWithDispatchAbortSignal(
          getDispatchAbortSignal(),
          () =>
            traceReplyPhase("reply.run_reply_resolver", () =>
              replyResolver(
                ctx,
                {
                  ...getReplyOptions(),
                  sourceReplyDeliveryMode,
                  sessionPromptSourceReplyDeliveryMode: sessionStableSourceReplyDeliveryMode,
                  ...({
                    onSessionMetadataChanges: notifySessionMetadataChanges,
                    onSessionPrepared: notePreparedSession,
                  } satisfies InternalReplyResolverOptions),
                  onObservedReplyDelivery: markObservedReplyDelivery,
                  suppressToolErrorWarnings,
                  shouldSuppressToolErrorWarnings,
                  typingPolicy: typing.typingPolicy,
                  suppressTyping: typing.suppressTyping,
                  onPartialReply: wrapProgressCallback(params.replyOptions?.onPartialReply),
                  onReasoningStream: wrapProgressCallback(params.replyOptions?.onReasoningStream),
                  streamReasoningInNonStreamModes:
                    params.replyOptions?.streamReasoningInNonStreamModes,
                  onReasoningEnd: wrapProgressCallback(params.replyOptions?.onReasoningEnd),
                  onAssistantMessageStart: wrapProgressCallback(
                    params.replyOptions?.onAssistantMessageStart,
                  ),
                  onBlockReplyQueued: wrapProgressCallback(params.replyOptions?.onBlockReplyQueued),
                  onToolStart: wrapProgressCallback(params.replyOptions?.onToolStart, {
                    allowWhenToolSummariesHidden:
                      params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                    forwardWhenSourceDeliverySuppressed: true,
                    requiresToolSummaryVisibility: true,
                    waitForDirectBlockReplyDelivery: true,
                    onForward: async () => {
                      // Commentary precedes the tool that follows it.
                      await flushPendingCommentaryProgress();
                    },
                  }),
                  onItemEvent,
                  commentaryProgressEnabled:
                    deliverStandaloneCommentaryProgress ||
                    canForwardSuppressedSourceItemEvents ||
                    params.replyOptions?.commentaryProgressEnabled,
                  reasoningPayloadsEnabled,
                  commentaryPayloadsEnabled,
                  onCommandOutput: wrapProgressCallback(params.replyOptions?.onCommandOutput, {
                    forwardWhenSourceDeliverySuppressed: true,
                    requiresToolSummaryVisibility: true,
                    waitForDirectBlockReplyDelivery: true,
                    onVisible: (payload) => {
                      if (hasFailedProgressStatus(payload)) {
                        markVisibleToolErrorProgress();
                      }
                    },
                  }),
                  onCompactionStart: wrapProgressCallback(params.replyOptions?.onCompactionStart, {
                    allowWhenToolSummariesHidden:
                      params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                    forwardWhenSourceDeliverySuppressed: true,
                    requiresToolSummaryVisibility: true,
                    waitForDirectBlockReplyDelivery: true,
                  }),
                  onCompactionEnd: wrapProgressCallback(params.replyOptions?.onCompactionEnd, {
                    allowWhenToolSummariesHidden:
                      params.replyOptions?.allowToolLifecycleWhenProgressHidden === true,
                    forwardWhenSourceDeliverySuppressed: true,
                    requiresToolSummaryVisibility: true,
                    waitForDirectBlockReplyDelivery: true,
                  }),
                  onToolResult: (payload: ReplyPayload) => {
                    dispatchReplyOperation?.recordActivity();
                    markProgress();
                    const run = async () => {
                      if (isDispatchOperationAborted()) {
                        return;
                      }
                      await waitForPendingDirectBlockReplyDelivery(
                        dispatchAbortOperation?.abortSignal,
                      );
                      if (isDispatchOperationAborted()) {
                        return;
                      }
                      markInboundDedupeReplayUnsafe();
                      // Buffered commentary preceded this tool; land it before the summary.
                      await flushPendingCommentaryProgress();
                      // When the operator opts into messages.suppressToolErrors, never
                      // surface tool-error tool-result payloads as channel progress,
                      // regardless of source delivery mode. payloads.ts already drops
                      // the warning text; this drops the visible progress delivery too.
                      if (
                        payload.isError === true &&
                        replyConfig.messages?.suppressToolErrors === true
                      ) {
                        return;
                      }
                      const isFastModeAutoProgress = isFastModeAutoProgressPayload(payload);
                      const isFastModeAutoProgressDelivery =
                        isFastModeAutoProgress &&
                        shouldDeliverFastModeAutoProgressDespiteSourceSuppression();
                      const isForcedToolProgress =
                        shouldDeliverForcedToolProgressDespiteSourceSuppression();
                      const progressCallbackForwarded = shouldForwardToolResultProgressCallback(
                        payload,
                        isFastModeAutoProgress,
                      );
                      if (progressCallbackForwarded) {
                        await onToolResultFromReplyOptions?.(payload);
                      }
                      if (isDispatchOperationAborted()) {
                        return;
                      }
                      if (
                        isFastModeAutoProgress &&
                        progressCallbackForwarded &&
                        onToolResultFromReplyOptions
                      ) {
                        return;
                      }
                      if (sendPolicyDenied) {
                        return;
                      }
                      if (
                        shouldSuppressProgressDelivery() &&
                        !isFastModeAutoProgressDelivery &&
                        !isForcedToolProgress
                      ) {
                        return;
                      }
                      const visibleToolPayload = isForcedToolProgress
                        ? payload
                        : resolveToolDeliveryPayload(payload);
                      if (!visibleToolPayload) {
                        return;
                      }
                      const ttsPayload = await maybeApplyTtsToReplyPayload({
                        payload: visibleToolPayload,
                        cfg,
                        channel: deliveryChannel,
                        kind: "tool",
                        inboundAudio: hasInboundAudioForTts(),
                        ttsAuto: sessionTtsAuto,
                        agentId: sessionAgentId,
                        accountId: replyRoute.accountId,
                      });
                      const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
                      const deliveryPayload = isForcedToolProgress
                        ? normalizedPayload
                        : resolveToolDeliveryPayload(normalizedPayload);
                      if (!deliveryPayload) {
                        return;
                      }
                      if (isDispatchOperationAborted()) {
                        return;
                      }
                      if (
                        shouldSuppressLateTextOnlyToolProgress(deliveryPayload) &&
                        !isFastModeAutoProgressPayload(deliveryPayload) &&
                        !isForcedToolProgress
                      ) {
                        return;
                      }
                      if (shouldSuppressMessageToolOnlyTextErrorProgress(deliveryPayload)) {
                        return;
                      }
                      if (
                        shouldSuppressDefaultToolProgressMessages() &&
                        !isFastModeAutoProgressPayload(deliveryPayload) &&
                        !isForcedToolProgress
                      ) {
                        const hasMedia =
                          resolveSendableOutboundReplyParts(deliveryPayload).hasMedia;
                        if (!hasMedia && !hasExecApprovalPayload(deliveryPayload)) {
                          return;
                        }
                      }
                      if (deliveryPayload.isError === true) {
                        markVisibleToolErrorProgress();
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
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markProgress();
                    await waitForPendingDirectBlockReplyDelivery(
                      dispatchAbortOperation?.abortSignal,
                    );
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markInboundDedupeReplayUnsafe();
                    if (
                      shouldForwardProgressCallback({
                        forwardWhenSourceDeliverySuppressed: true,
                        requiresToolSummaryVisibility: true,
                      })
                    ) {
                      await onPlanUpdateFromReplyOptions?.(payload);
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (payload.phase !== "update" || shouldSuppressDefaultToolProgressMessages()) {
                      return;
                    }
                    await sendPlanUpdate({
                      explanation: payload.explanation,
                      steps: payload.steps,
                    });
                  },
                  onApprovalEvent: async (payload) => {
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markProgress();
                    await waitForPendingDirectBlockReplyDelivery(
                      dispatchAbortOperation?.abortSignal,
                    );
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markInboundDedupeReplayUnsafe();
                    if (
                      shouldForwardProgressCallback({
                        forwardWhenSourceDeliverySuppressed: true,
                        requiresToolSummaryVisibility: true,
                      })
                    ) {
                      await onApprovalEventFromReplyOptions?.(payload);
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (
                      payload.phase !== "requested" ||
                      shouldSuppressDefaultToolProgressMessages()
                    ) {
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
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markProgress();
                    await waitForPendingDirectBlockReplyDelivery(
                      dispatchAbortOperation?.abortSignal,
                    );
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    markInboundDedupeReplayUnsafe();
                    if (
                      shouldForwardProgressCallback({
                        forwardWhenSourceDeliverySuppressed: true,
                        requiresToolSummaryVisibility: true,
                      })
                    ) {
                      await onPatchSummaryFromReplyOptions?.(payload);
                    }
                    if (isDispatchOperationAborted()) {
                      return;
                    }
                    if (payload.phase !== "end" || shouldSuppressDefaultToolProgressMessages()) {
                      return;
                    }
                    const label = summarizePatchLabel({
                      summary: payload.summary,
                      title: payload.title,
                    });
                    if (!label) {
                      return;
                    }
                    await maybeSendWorkingStatus(label);
                  },
                  onBlockReply: (payload: ReplyPayload, context?: BlockReplyContext) => {
                    markProgress();
                    const run = async () => {
                      if (isDispatchOperationAborted()) {
                        return;
                      }
                      if (
                        payload.isReasoning !== true &&
                        payload.isCommentary !== true &&
                        hasOutboundReplyContent(payload, { trimText: true })
                      ) {
                        markInboundDedupeReplayUnsafe();
                      }
                      // Buffered commentary preceded this block; deliver it first.
                      await flushPendingCommentaryProgress();
                      if (suppressDelivery) {
                        return;
                      }
                      // Durable reasoning is a channel-owned lane; generic channels
                      // keep the historical suppression unless they explicitly opt in.
                      if (payload.isReasoning === true && !reasoningPayloadsEnabled) {
                        return;
                      }
                      // Durable commentary is a channel-owned lane; generic channels keep the
                      // historical suppression unless they explicitly opt in.
                      if (payload.isCommentary === true && !commentaryPayloadsEnabled) {
                        return;
                      }
                      // Accumulate block text for TTS generation after streaming.
                      // Exclude status notices — they are informational UI signals
                      // and must not be synthesised into the spoken reply. Display
                      // lanes stay out too: they are presentation, never final text.
                      const isStatusNotice = isReplyPayloadStatusNotice(payload);
                      if (
                        payload.text &&
                        !isStatusNotice &&
                        payload.isReasoning !== true &&
                        payload.isCommentary !== true
                      ) {
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
                        payload.text &&
                        cleanBlockTtsDirectiveText &&
                        !isStatusNotice &&
                        payload.isReasoning !== true &&
                        payload.isCommentary !== true
                          ? (() => {
                              const text = cleanBlockTtsDirectiveText.push(payload.text);
                              return copyReplyPayloadMetadata(payload, {
                                ...payload,
                                text: text.trim() ? text : undefined,
                              });
                            })()
                          : payload;
                      if (!hasOutboundReplyContent(visiblePayload, { trimText: true })) {
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
                        await params.replyOptions?.onBlockReplyQueued?.(
                          visiblePayload,
                          queuedContext,
                        );
                      }
                      if (isDispatchOperationAborted()) {
                        return;
                      }
                      const ttsPayload =
                        payload.isReasoning === true || payload.isCommentary === true
                          ? visiblePayload
                          : await maybeApplyTtsToReplyPayload({
                              payload: visiblePayload,
                              cfg,
                              channel: deliveryChannel,
                              kind: "block",
                              inboundAudio: hasInboundAudioForTts(),
                              ttsAuto: sessionTtsAuto,
                              agentId: sessionAgentId,
                              accountId: replyRoute.accountId,
                            });
                      const normalizedPayload = await normalizeReplyMediaPayload(ttsPayload);
                      if (isDispatchOperationAborted()) {
                        return;
                      }
                      if (shouldRouteToOriginating) {
                        await sendPayloadAsync(
                          normalizedPayload,
                          context?.abortSignal,
                          false,
                          "block",
                        );
                      } else {
                        markInboundDedupeReplayUnsafe();
                        const delivered = dispatcher.sendBlockReply(normalizedPayload);
                        if (delivered) {
                          hasPendingDirectBlockReplyDelivery = true;
                        }
                      }
                    };
                    return run();
                  },
                },
                replyConfig,
              ),
            ),
          trackDispatchLifecycleWork,
        ),
    );
    const sessionMetadataChanges = takeCommandSessionMetadataChanges(ctx);
    notifySessionMetadataChanges(sessionMetadataChanges);
    const finalDispatchAcquisition = await ensureDispatchReplyOperation("dispatch");
    if (finalDispatchAcquisition.status === "aborted") {
      return finishReplyOperationAbortedDispatch();
    }
    if (finalDispatchAcquisition.status === "busy") {
      return finishReplyOperationBusyDispatch({
        recordAgentDispatchCompleted: true,
        ...(sessionMetadataChangesForResult
          ? { sessionMetadataChanges: sessionMetadataChangesForResult }
          : {}),
      });
    }

    if (ctx.AcpDispatchTailAfterReset === true) {
      // Command handling prepared a trailing prompt after ACP in-place reset.
      // Route that tail through ACP now (same turn) instead of embedded dispatch.
      ctx.AcpDispatchTailAfterReset = false;
      if (hookRunner?.hasHooks("reply_dispatch")) {
        const tailDispatchResult = await runWithDispatchLifecycleAdmission(
          async () =>
            await runWithDispatchAbortSignal(
              getDispatchAbortSignal(),
              () =>
                hookRunner.runReplyDispatch(
                  createReplyDispatchEvent({
                    ctx,
                    runId: params.replyOptions?.runId,
                    sessionKey: acpDispatchSessionKey,
                    toolsAllow: params.replyOptions?.toolsAllow,
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
                    originatingAccountId: replyContextAccountId,
                    originatingThreadId: routeReplyThreadId,
                    originatingChatType: replyRoute.chatType,
                    shouldSendToolSummaries,
                    sendPolicy,
                    isTailDispatch: true,
                  }),
                  {
                    cfg,
                    dispatcher: dispatchHookDispatcher,
                    abortSignal: getPreDispatchAbortSignal() ?? params.replyOptions?.abortSignal,
                    onReplyStart: params.replyOptions?.onReplyStart,
                    recordProcessed,
                    markIdle,
                  },
                ),
              trackDispatchLifecycleWork,
            ),
        );
        if (tailDispatchResult?.handled) {
          recordAgentDispatchCompleted("completed");
          completeDispatchReplyOperation();
          return attachSourceReplyDeliveryMode({
            queuedFinal: tailDispatchResult.queuedFinal,
            counts: tailDispatchResult.counts,
            ...(sessionMetadataChangesForResult
              ? { sessionMetadataChanges: sessionMetadataChangesForResult }
              : {}),
          });
        }
      }
    }

    const replies = replyResult ? (Array.isArray(replyResult) ? replyResult : [replyResult]) : [];
    // Final delivery is outside the progress wrappers. Wait until every source-ordered callback
    // has at least started so a delayed tool/reasoning transition cannot appear after the final.
    if (preserveProgressCallbackStartOrder) {
      await progressCallbackStartTail;
    }
    // Backstop: silent/streaming-delivered turns end without a visible final
    // reply; trailing commentary must still land.
    await flushPendingCommentaryProgress();
    const beforeAgentRunBlocked = replies.some(
      (reply) => getReplyPayloadMetadata(reply)?.beforeAgentRunBlocked === true,
    );

    let queuedFinal = false;
    let routedFinalCount = 0;
    let attemptedFinalDelivery = false;
    let finalDeliveryFailed = false;
    // Explicit command turns (native or authorized text-slash like /compact) are
    // user-initiated, so a marked terminal reply for the command bypasses
    // room_event suppression. Ambient marked notices (no CommandTurn) stay
    // suppressed in room_event. sendPolicy: deny still suppresses everything.
    // Uses the same helper as the source-reply visibility policy so the bypass
    // and the policy stay aligned.
    const shouldDeliverDespiteSourceReplySuppression = (reply: ReplyPayload) =>
      suppressAutomaticSourceDelivery &&
      !sendPolicyDenied &&
      getReplyPayloadMetadata(reply)?.deliverDespiteSourceReplySuppression === true &&
      (ctx.InboundEventKind !== "room_event" || explicitCommandTurnCtx);
    const sentFinalPayloadDedupeKeys = new Set<string>();
    for (const [replyIndex, reply] of replies.entries()) {
      throwIfDispatchOperationAborted();
      // Durable reasoning is a channel-owned lane; generic channels keep the
      // historical suppression unless they explicitly opt in.
      if (reply.isReasoning === true && !reasoningPayloadsEnabled) {
        continue;
      }
      if (reply.isCommentary === true && !commentaryPayloadsEnabled) {
        continue;
      }
      if (suppressDelivery && !shouldDeliverDespiteSourceReplySuppression(reply)) {
        if (hasOutboundReplyContent(reply, { trimText: true })) {
          logVerbose(
            [
              `dispatch-from-config: final reply suppressed by ${deliverySuppressionReason || "source delivery policy"}`,
              `(session=${acpDispatchSessionKey ?? sessionKey ?? "unknown"}`,
              `provider=${ctx.Provider ?? "unknown"}`,
              `surface=${ctx.Surface ?? "unknown"}`,
              `chatType=${chatType ?? "unknown"}`,
              `inboundEventKind=${ctx.InboundEventKind ?? "unknown"}`,
              `message=${ctx.MessageSidFull ?? ctx.MessageSid ?? "unknown"}`,
              `${formatSuppressedReplyPayloadForLog(reply)})`,
            ].join(" "),
          );
        }
        continue;
      }
      const finalPayloadDedupeKey = createFinalDispatchPayloadDedupeKey(reply);
      if (sentFinalPayloadDedupeKeys.has(finalPayloadDedupeKey)) {
        continue;
      }
      sentFinalPayloadDedupeKeys.add(finalPayloadDedupeKey);
      attemptedFinalDelivery = true;
      const finalReply = await sendFinalPayload(reply, { deliveryId: String(replyIndex) });
      queuedFinal = finalReply.queuedFinal || queuedFinal;
      routedFinalCount += finalReply.routedFinalCount;
      if (!finalReply.queuedFinal && finalReply.routedFinalCount === 0) {
        finalDeliveryFailed = true;
      }
    }

    if (attemptedFinalDelivery && !finalDeliveryFailed) {
      // The final reply already shipped, so clear the durable pending-final
      // bookkeeping before honoring a late abort. A stuck-session recovery abort
      // racing this window (#89115) otherwise strands pendingFinalDelivery=true,
      // and the get-reply redelivery short-circuit then silently blocks all inbound.
      await clearPendingFinalDeliveryAfterSuccess({
        storePath: sessionStoreEntry.storePath,
        sessionKey: sessionStoreEntry.sessionKey ?? sessionKey,
      });
      throwIfDispatchOperationAborted();
    }

    if (!suppressDelivery) {
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
          await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
          throwIfDispatchOperationAborted();
          const ttsSyntheticReply = await maybeApplyTtsToReplyPayload({
            payload: { text: accumulatedBlockTtsText },
            cfg,
            channel: deliveryChannel,
            kind: "final",
            inboundAudio: hasInboundAudioForTts(),
            ttsAuto: sessionTtsAuto,
            agentId: sessionAgentId,
            accountId: replyRoute.accountId,
          });
          throwIfDispatchOperationAborted();
          // Only send if TTS was actually applied (mediaUrl exists)
          if (ttsSyntheticReply.mediaUrl) {
            // Send TTS-only payload (no text, just audio) so it doesn't duplicate the block content.
            // Keep the spoken text only for hooks/archive consumers.
            const ttsOnlyPayload = markReplyPayloadAsTtsSupplement(
              {
                mediaUrl: ttsSyntheticReply.mediaUrl,
                audioAsVoice: ttsSyntheticReply.audioAsVoice,
                spokenText: accumulatedBlockTtsText,
                trustedLocalMedia: true,
              },
              accumulatedBlockTtsText,
              { visibleTextAlreadyDelivered: true },
            );
            const normalizedTtsOnlyPayload = await normalizeReplyMediaPayload(ttsOnlyPayload);
            throwIfDispatchOperationAborted();
            const result = await routeReplyToOriginating(normalizedTtsOnlyPayload, {
              abortSignal: getDispatchAbortSignal(),
              kind: "final",
            });
            if (result) {
              queuedFinal = result.ok || queuedFinal;
              if (isRoutedReplyDelivered(result)) {
                routedFinalCount += 1;
              }
              if (!result.ok) {
                logVerbose(
                  `dispatch-from-config: route-reply (tts-only) failed: ${result.error ?? "unknown error"}`,
                );
              }
            } else {
              throwIfDispatchOperationAborted();
              markInboundDedupeReplayUnsafe();
              const didQueue = dispatcher.sendFinalReply(normalizedTtsOnlyPayload);
              queuedFinal = didQueue || queuedFinal;
            }
          }
        } catch (err) {
          if (isDispatchReplyOperationAbortedError(err)) {
            throw err;
          }
          logVerbose(
            `dispatch-from-config: accumulated block TTS failed: ${formatErrorMessage(err)}`,
          );
        }
      }
    }

    await waitForPendingDirectBlockReplyDelivery(getDispatchAbortSignal());
    const counts = dispatcher.getQueuedCounts();
    counts.final += routedFinalCount;
    commitInboundDedupeIfClaimed();
    recordAgentDispatchCompleted("completed");
    recordProcessed(
      "completed",
      pluginFallbackReason ? { reason: pluginFallbackReason } : undefined,
    );
    markIdle("message_completed");
    completeDispatchReplyOperation();
    return attachSourceReplyDeliveryMode({
      queuedFinal,
      counts,
      ...(sessionMetadataChangesForResult
        ? { sessionMetadataChanges: sessionMetadataChangesForResult }
        : {}),
      ...(observedReplyDelivery ? { observedReplyDelivery } : {}),
      ...(!queuedFinal && !observedReplyDelivery && !emptyFinalAllowedAsSilent
        ? { noVisibleReplyFallbackEligible: true }
        : {}),
      ...(beforeAgentRunBlocked ? { beforeAgentRunBlocked } : {}),
    });
  } catch (err) {
    if (isDispatchReplyOperationAbortedError(err)) {
      return finishReplyOperationAbortedDispatch();
    }
    if (inboundDedupeClaim.status === "claimed") {
      if (inboundDedupeReplayUnsafe) {
        commitInboundDedupe(inboundDedupeClaim.key);
      } else {
        releaseInboundDedupe(inboundDedupeClaim.key);
      }
    }
    recordAgentDispatchCompleted("error", { error: String(err) });
    recordProcessed("error", { error: String(err) });
    markIdle("message_error");
    failDispatchReplyOperation(err);
    throw err;
  }
}
