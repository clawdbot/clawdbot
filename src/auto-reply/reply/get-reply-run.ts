/** Prepares and runs auto-reply agent turns, including prompt context and session policy. */
import crypto from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { type FastMode, normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  clearAutoFallbackPrimaryProbeSelection,
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  resolveAgentConfig,
  type AutoFallbackPrimaryProbe,
} from "../../agents/agent-scope.js";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import type { EmbeddedFullAccessBlockedReason } from "../../agents/embedded-agent-runner/types.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../../agents/openai-routing.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../../agents/spawned-context.js";
import type { SilentReplyPromptMode } from "../../agents/system-prompt.types.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { updateAmbientTranscriptWatermark } from "../../config/sessions/ambient-transcript-watermark.js";
import { conversationIdentityFromMsgContext } from "../../config/sessions/conversation-identity.js";
import { resolveGroupSessionKey } from "../../config/sessions/group.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { consumeSessionSkillSuggestion } from "../../config/sessions/skill-suggestions.js";
import {
  formatSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesSession,
} from "../../config/sessions/sqlite-marker.js";
import type { PendingSkillSuggestion, SessionEntry } from "../../config/sessions/types.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { resolveHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import type { ExtractedFileImage } from "../../media-understanding/extracted-file-images.js";
import { isImageMediaFact, resolveMediaFacts, type MediaFact } from "../../media/media-facts.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeMainKey,
} from "../../routing/session-key.js";
import { MEDIA_ONLY_USER_TEXT } from "../../sessions/user-turn-media.js";
import {
  createUserTurnTranscriptRecorder,
  resolvePersistedUserTurnText,
  type UserTurnInput,
} from "../../sessions/user-turn-transcript.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { resolveSkillWorkshopConfig } from "../../skills/workshop/config.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { hasControlCommand } from "../command-detection.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import { resolveEnvelopeFormatOptions } from "../envelope.js";
import type { MsgContext, OriginatingChannelType, TemplateContext } from "../templating.js";
import {
  type ElevatedLevel,
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  type ReasoningLevel,
  resolveSupportedThinkingLevel,
  type ThinkingCatalogEntry,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { applySessionHints } from "./body.js";
import type { buildCommandContext } from "./commands.js";
import { resolveCurrentTurnImages } from "./current-turn-images.js";
import type { InlineDirectives } from "./directive-handling.js";
import { isSystemEventProvider, resolveEffectiveReplyRoute } from "./effective-reply-route.js";
import { shouldUseReplyFastTestRuntime } from "./get-reply-fast-path.js";
import { resolvePreparedReplyQueueState } from "./get-reply-run-queue.js";
import type {
  InternalGetReplyOptions as BaseInternalGetReplyOptions,
  ReplySessionBinding,
} from "./get-reply.types.js";
import {
  buildDirectChatContext,
  buildGroupChatContext,
  buildGroupIntro,
  resolveGroupSilentReplyBehavior,
} from "./groups.js";
import { hasInboundAudio, hasInboundMedia } from "./inbound-media.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
  formatActiveGoalContext,
  resolveInboundUserContextPromptJoiner,
} from "./inbound-meta.js";
import type { createModelSelectionState } from "./model-selection.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { buildReplyPromptEnvelope, buildReplyPromptEnvelopeBase } from "./prompt-prelude.js";
import {
  normalizeToolProgressDetail,
  resolvePersistedPromptProvider,
  resolvePersistedPromptSurface,
} from "./prompt-session-context.js";
import { resolveActiveRunQueueAction } from "./queue-policy.js";
import { resolveQueueSettings } from "./queue/settings-runtime.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  abortReplyRunBySessionId,
  isReplyRunActiveForSessionId,
  isReplyRunStreamingForSessionId,
  resolveActiveReplyRunThreadId,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { resolveReplyToMode } from "./reply-threading.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import {
  isSlackDirectRoutedThreadTurn,
  resolveRoutedDeliveryThreadId,
} from "./routed-delivery-thread.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";
import type { ReplySessionEntryHandle } from "./session-entry-handle.js";
import { resolveBareSessionResetPromptState } from "./session-reset-prompt.js";
import { resolveBareResetBootstrapFileAccess } from "./session-reset-prompt.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { isInternalSourceReplyChannel } from "./source-reply-delivery-mode.js";
import {
  buildChannelSourceTurnId,
  readChannelSourceTurnId,
  setChannelSourceTurnId,
  shouldMintChannelSourceTurnId,
} from "./source-turn-id.js";
import { buildSessionStartupContextPrelude, shouldApplyStartupContext } from "./startup-context.js";
import { resolveTypingMode } from "./typing-mode.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";
import type { TypingController } from "./typing.js";

type InternalGetReplyOptions = BaseInternalGetReplyOptions & {
  /**
   * Dispatch-owned pre-run operation. This is intentionally not part of the
   * public reply API; it lets dispatch prep and hook work share the same
   * diagnostic/abort ownership as the eventual agent run.
   */
  replyOperation?: ReplyOperation;
  /**
   * Source-owned abort signal to persist with queued room-event followups. This
   * can differ from abortSignal when dispatch temporarily borrows an active lane.
   */
  queuedFollowupAbortSignal?: AbortSignal;
  onSessionPrepared?: (binding: ReplySessionBinding) => void;
  extractedFileImages?: ExtractedFileImage[];
};

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type ExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node" | "nodeCwd">;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;
function buildPersistedMediaImageLayout(params: {
  ctx: MsgContext;
  media: readonly MediaFact[];
  ctxMediaCount: number;
  imageOrder?: readonly ("inline" | "offloaded")[];
  imageSourceIndexes?: readonly (number | undefined)[];
}): NonNullable<UserTurnInput["mediaImageLayout"]> | undefined {
  const describedAttachmentIndexes = new Set(
    params.ctx.MediaUnderstanding?.flatMap((output) =>
      output.kind === "image.description" ? [output.attachmentIndex] : [],
    ) ?? [],
  );
  const suppressedFactIndexes: number[] = [];
  const imageFactIndexes: number[] = [];
  for (const [factIndex, fact] of params.media.entries()) {
    if (!isImageMediaFact(fact)) {
      continue;
    }
    imageFactIndexes.push(factIndex);
    if (
      (factIndex < params.ctxMediaCount && describedAttachmentIndexes.has(factIndex)) ||
      fact.hydrationSuppressed === true
    ) {
      suppressedFactIndexes.push(factIndex);
    }
  }
  if (imageFactIndexes.length === 0) {
    return undefined;
  }
  const suppressed = new Set(suppressedFactIndexes);
  const used = new Set<number>();
  const unsuppressedFactCount = imageFactIndexes.filter((index) => !suppressed.has(index)).length;
  const canInferByPosition = unsuppressedFactCount === (params.imageOrder?.length ?? 0);
  const takeNextFactIndex = (): number | undefined =>
    imageFactIndexes.find((index) => !suppressed.has(index) && !used.has(index));
  const slots = (params.imageOrder ?? []).map((kind, index) => {
    const sourceIndex = params.imageSourceIndexes?.[index];
    const sourceFact = sourceIndex === undefined ? undefined : params.media[sourceIndex];
    const factIndex =
      sourceIndex !== undefined
        ? sourceFact &&
          isImageMediaFact(sourceFact) &&
          !suppressed.has(sourceIndex) &&
          !used.has(sourceIndex)
          ? sourceIndex
          : undefined
        : canInferByPosition
          ? takeNextFactIndex()
          : undefined;
    if (factIndex !== undefined) {
      used.add(factIndex);
    }
    return factIndex === undefined ? { kind } : { kind, factIndex };
  });
  for (const factIndex of imageFactIndexes) {
    if (!suppressed.has(factIndex) && !used.has(factIndex)) {
      slots.push({ kind: "offloaded", factIndex });
    }
  }
  if (slots.length === 0 && suppressedFactIndexes.length === 0) {
    return undefined;
  }
  return {
    slots,
    ...(suppressedFactIndexes.length > 0 ? { suppressedFactIndexes } : {}),
  };
}

function hasResolvedThinkingCatalogEntry(params: {
  catalog?: readonly ThinkingCatalogEntry[];
  provider: string;
  model: string;
}): boolean {
  const modelId = normalizeOptionalString(params.model);
  if (!modelId) {
    return false;
  }
  const normalizedProvider = normalizeProviderId(params.provider);
  const entry = params.catalog?.find(
    (candidate) =>
      normalizeProviderId(candidate.provider) === normalizedProvider && candidate.id === modelId,
  );
  return entry?.reasoning !== undefined;
}

function routeThreadIdsMatch(
  activeThreadId: string | number | undefined,
  currentThreadId: string | number | undefined,
): boolean {
  if (activeThreadId === undefined || currentThreadId === undefined) {
    return true;
  }
  return String(activeThreadId) === String(currentThreadId);
}

function normalizeMessageTimestampMs(value: unknown): number | undefined {
  const timestamp = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (timestamp === undefined || timestamp <= 0) {
    return undefined;
  }
  const timestampMs =
    timestamp < EPOCH_MILLISECONDS_THRESHOLD ? Math.trunc(timestamp * 1000) : timestamp;
  return asDateTimestampMs(timestampMs);
}

function projectSkillSuggestionForTurn(
  entry: SessionEntry | undefined,
  suggestion: PendingSkillSuggestion | undefined,
): SessionEntry | undefined {
  if (!entry) {
    return undefined;
  }
  if (suggestion) {
    return { ...entry, pendingSkillSuggestion: suggestion };
  }
  if (!entry.pendingSkillSuggestion) {
    return entry;
  }
  const projected = { ...entry };
  delete projected.pendingSkillSuggestion;
  return projected;
}

async function updateRoomEventAmbientTranscriptWatermark(params: {
  expectedSessionId: string;
  sessionCtx: TemplateContext;
  storePath?: string;
  sessionKey?: string;
}): Promise<void> {
  const key = normalizeOptionalString(params.sessionCtx.AmbientTranscriptWatermarkKey);
  const messageId = normalizeOptionalString(params.sessionCtx.AmbientTranscriptMessageId);
  if (!params.storePath || !params.sessionKey || !key || !messageId) {
    return;
  }
  // Advance only after the transcript row exists; Telegram windows exclude
  // everything at or before this durable boundary on later turns.
  await updateAmbientTranscriptWatermark({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    key,
    messageId,
    timestampMs: params.sessionCtx.AmbientTranscriptTimestampMs,
    expectedSessionId: params.expectedSessionId,
  });
}

function resolvePromptSilentReplyConversationType(params: {
  ctx: Pick<
    MsgContext,
    "ChatType" | "CommandSource" | "CommandTargetSessionKey" | "CommandTurn" | "SessionKey"
  >;
  inboundSessionKey?: string;
}): SilentReplyConversationType | undefined {
  const sourceSessionKey = params.inboundSessionKey ?? params.ctx.SessionKey;
  const commandTargetSessionKey = resolveCommandTurnTargetSessionKey(params.ctx);
  if (commandTargetSessionKey && commandTargetSessionKey !== sourceSessionKey) {
    return undefined;
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  if (chatType === "direct") {
    return "direct";
  }
  if (chatType === "group" || chatType === "channel") {
    return "group";
  }
  return undefined;
}

function resolvePromptSessionContextForSystemEvent(params: {
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  ctx?: Pick<MsgContext, "Provider">;
  isHeartbeat?: boolean;
}): TemplateContext {
  const { sessionCtx, sessionEntry } = params;
  const isSystemEvent =
    params.isHeartbeat === true ||
    isSystemEventProvider(params.ctx?.Provider) ||
    isSystemEventProvider(sessionCtx.Provider);
  if (!isSystemEvent || !sessionEntry) {
    return sessionCtx;
  }

  const origin = sessionDeliveryOrigin(sessionEntry);
  const deliveryContext = deliveryContextFromSession(sessionEntry);
  const persistedChatType =
    normalizeChatType(sessionEntry.chatType) ?? normalizeChatType(origin?.chatType);
  const liveChatType = normalizeChatType(sessionCtx.ChatType);
  const effectiveChatType = liveChatType ?? persistedChatType;
  const persistedProvider = resolvePersistedPromptProvider(sessionEntry);
  const persistedSurface = resolvePersistedPromptSurface(sessionEntry);
  const liveProvider = normalizeOptionalString(sessionCtx.Provider);
  const liveSurface = normalizeOptionalString(sessionCtx.Surface);
  const nextProvider =
    liveProvider && !isSystemEventProvider(liveProvider)
      ? liveProvider
      : (persistedProvider ?? liveProvider);
  const nextSurface =
    liveSurface && !isSystemEventProvider(liveSurface)
      ? liveSurface
      : (persistedSurface ?? liveSurface);

  const next: TemplateContext = { ...sessionCtx };
  let changed = false;
  const setIfMissing = <K extends keyof TemplateContext>(key: K, value: TemplateContext[K]) => {
    if (next[key] != null && next[key] !== "") {
      return;
    }
    if (value == null || value === "") {
      return;
    }
    next[key] = value;
    changed = true;
  };
  const setIfChanged = <K extends keyof TemplateContext>(key: K, value: TemplateContext[K]) => {
    if (value == null || value === "" || next[key] === value) {
      return;
    }
    next[key] = value;
    changed = true;
  };

  setIfChanged("Provider", nextProvider);
  setIfChanged("Surface", nextSurface);
  setIfMissing("ChatType", persistedChatType);
  if (effectiveChatType === "group" || effectiveChatType === "channel") {
    setIfMissing("GroupSubject", normalizeOptionalString(sessionEntry.subject));
    setIfMissing("GroupChannel", normalizeOptionalString(sessionEntry.groupChannel));
    setIfMissing("GroupSpace", normalizeOptionalString(sessionEntry.space));
  }
  setIfMissing("OriginatingChannel", persistedProvider);
  setIfMissing("OriginatingTo", normalizeOptionalString(deliveryContext?.to ?? origin?.to));
  setIfMissing(
    "AccountId",
    normalizeOptionalString(deliveryContext?.accountId ?? origin?.accountId),
  );
  setIfMissing("MessageThreadId", deliveryContext?.threadId ?? origin?.threadId);

  return changed ? next : sessionCtx;
}

function buildExecOverridePromptHint(params: {
  execOverrides?: ExecOverrides;
  elevatedLevel: ElevatedLevel;
  fullAccessAvailable?: boolean;
  fullAccessBlockedReason?: EmbeddedFullAccessBlockedReason;
}): string | undefined {
  const exec = params.execOverrides;
  if (!exec && params.elevatedLevel === "off") {
    return undefined;
  }
  const parts = [
    exec?.host ? `host=${exec.host}` : undefined,
    exec?.security ? `security=${exec.security}` : undefined,
    exec?.ask ? `ask=${exec.ask}` : undefined,
    exec?.node ? `node=${exec.node}` : undefined,
  ].filter(Boolean);
  const execLine =
    parts.length > 0
      ? `Current session exec defaults: ${parts.join(" ")}.`
      : "Current session exec defaults: inherited from configured agent/global defaults.";
  const elevatedLine = `Current elevated level: ${params.elevatedLevel}.`;
  const fullAccessLine =
    params.fullAccessAvailable === false
      ? `Auto-approved /elevated full is unavailable here (${params.fullAccessBlockedReason ?? "runtime"}). Do not ask the user to switch to /elevated full.`
      : undefined;
  return [
    "## Current Exec Session State",
    execLine,
    elevatedLine,
    fullAccessLine,
    "If the user asks to run a command, use the current exec state above. Do not assume a prior denial still applies after `/exec` or `/elevated` changed.",
  ]
    .filter(Boolean)
    .join("\n");
}

const embeddedAgentRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/embedded-agent.runtime.js"),
);
const agentRunnerRuntimeLoader = createLazyImportLoader(() => import("./agent-runner.runtime.js"));
const sessionUpdatesRuntimeLoader = createLazyImportLoader(
  () => import("./session-updates.runtime.js"),
);

function loadEmbeddedAgentRuntime() {
  return embeddedAgentRuntimeLoader.load();
}

function loadAgentRunnerRuntime() {
  return agentRunnerRuntimeLoader.load();
}

function loadSessionUpdatesRuntime() {
  return sessionUpdatesRuntimeLoader.load();
}

function stripPromptThinkingDirectives(body: string): string {
  return body
    .split("\n")
    .map((line) =>
      line
        .replace(/(^|\s)\/(?:thinking|think|t)(?=$|\s|:)(?:\s*:\s*|\s+)?[A-Za-z-]*/gi, "$1")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd(),
    )
    .join("\n");
}

function hasInboundHistoryBody(ctx: TemplateContext): boolean {
  return (
    Array.isArray(ctx.InboundHistory) &&
    ctx.InboundHistory.some((entry) => entry.body.replaceAll("\u0000", "").trim().length > 0)
  );
}

function hasReplyTargetContext(ctx: MsgContext | TemplateContext): boolean {
  if (normalizeOptionalString(ctx.ReplyToBody)) {
    return true;
  }
  const replyChain = (ctx as { ReplyChain?: unknown }).ReplyChain;
  return Array.isArray(replyChain) && replyChain.length > 0;
}

type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: OpenClawConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource?: string;
  allowTextCommands: boolean;
  directives: InlineDirectives;
  defaultActivation: Parameters<typeof buildGroupIntro>[0]["defaultActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedFastMode?: FastMode;
  resolvedFastModeAutoOnSeconds?: number;
  resolvedFastModeOverride?: boolean;
  resolvedFastModeAutoOnSecondsOverride?: boolean;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecOverrides;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  provider: string;
  model: string;
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
  typing: TypingController;
  opts?: InternalGetReplyOptions;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
  autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
};

/** Runs a prepared reply turn after session, prompt, queue, and policy state are resolved. */
export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    allowTextCommands,
    directives,
    defaultActivation,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir: configuredWorkspaceDir,
    sessionEntryHandle,
    sessionStore,
  } = params;
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    cfg,
    ctx,
    sessionKey,
  });
  const {
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    abortedLastRun,
  } = params;
  let { sessionEntry, resolvedThinkLevel } = params;
  const isHeartbeat = opts?.isHeartbeat === true;
  const heartbeatRunScope = resolveHeartbeatRunScope(opts);
  const explicitThinkingLevelOverride = normalizeThinkLevel(opts?.thinkingLevelOverride);
  const effectiveQueueMode = opts?.queueModeOverride ?? perMessageQueueMode;
  const traceAttributes = {
    provider,
    hasSessionKey: Boolean(sessionKey),
    isHeartbeat,
    queueMode: effectiveQueueMode ?? "configured",
  };
  const traceRunPhase = <T>(name: string, run: () => Promise<T> | T): Promise<T> =>
    measureDiagnosticsTimelineSpan(name, run, {
      phase: "agent-turn",
      config: cfg,
      attributes: traceAttributes,
    });
  const promptSessionCtx = resolvePromptSessionContextForSystemEvent({
    sessionCtx,
    sessionEntry,
    ctx,
    isHeartbeat,
  });
  const inboundEventKind = promptSessionCtx.InboundEventKind;
  const isInternalPromptChannel = isInternalSourceReplyChannel(promptSessionCtx);
  const sourceReplyDeliveryMode =
    inboundEventKind === "room_event" && !isInternalPromptChannel
      ? "message_tool_only"
      : isInternalPromptChannel && opts?.sourceReplyDeliveryMode === undefined
        ? "automatic"
        : opts?.sourceReplyDeliveryMode;
  const sessionPromptSourceReplyDeliveryMode =
    opts?.sessionPromptSourceReplyDeliveryMode ?? sourceReplyDeliveryMode;
  const silentReplyConversationType = resolvePromptSilentReplyConversationType({
    ctx: promptSessionCtx,
    inboundSessionKey: ctx.SessionKey,
  });
  const silentReplySettings = resolveSilentReplySettings({
    cfg,
    sessionKey: runtimePolicySessionKey,
    surface: promptSessionCtx.Surface ?? promptSessionCtx.Provider,
    conversationType: silentReplyConversationType,
  });
  const useFastReplyRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv: isFastTestRuntimeEnv(),
  });
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider,
    modelId: model,
    agentId,
    sessionKey: runtimePolicySessionKey,
    sessionEntry,
  });
  const fullAccessState = resolveEmbeddedFullAccessState({
    execElevated: {
      enabled: elevatedEnabled,
      allowed: elevatedAllowed,
      defaultLevel: resolvedElevatedLevel ?? "off",
    },
  });
  const currentSystemSent = systemSent;

  const isFirstTurnInSession = isNewSession || !currentSystemSent;
  const isGroupChat =
    promptSessionCtx.ChatType === "group" || promptSessionCtx.ChatType === "channel";
  const isDirectChat = promptSessionCtx.ChatType === "direct" || promptSessionCtx.ChatType === "dm";
  const wasMentioned = ctx.WasMentioned === true;
  const { typingPolicy, suppressTyping } = resolveRunTypingPolicy({
    requestedPolicy: opts?.typingPolicy,
    suppressTyping: opts?.suppressTyping === true,
    isHeartbeat,
    originatingChannel: ctx.OriginatingChannel,
  });
  const typingMode = resolveTypingMode({
    configured: resolveAgentConfig(cfg, agentId)?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned,
    isHeartbeat,
    typingPolicy,
    suppressTyping,
    sourceReplyDeliveryMode,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  const directChatContext = isDirectChat
    ? buildDirectChatContext({
        sessionCtx: promptSessionCtx,
        sourceReplyDeliveryMode: sessionPromptSourceReplyDeliveryMode,
      })
    : "";
  // Always include persistent group chat context (provider + reply guidance).
  const groupChatContext = isGroupChat
    ? buildGroupChatContext({
        sessionCtx: promptSessionCtx,
        sourceReplyDeliveryMode: sessionPromptSourceReplyDeliveryMode,
        silentReplyPolicy: silentReplySettings.policy,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  // Claude CLI fixes the system prompt at session creation; group intro must stay session-stable.
  const groupIntro = isGroupChat
    ? buildGroupIntro({
        sessionEntry,
        defaultActivation,
      })
    : "";
  const allowEmptyAssistantReplyAsSilent =
    (isDirectChat &&
      silentReplyConversationType === "direct" &&
      silentReplySettings.policy === "allow") ||
    (isGroupChat &&
      resolveGroupSilentReplyBehavior({
        sessionEntry,
        defaultActivation,
        silentReplyPolicy: silentReplySettings.policy,
      }).allowEmptyAssistantReplyAsSilent);
  const groupSystemPrompt = normalizeOptionalString(promptSessionCtx.GroupSystemPrompt) ?? "";
  const inboundMetaPrompt = buildInboundMetaSystemPrompt(
    isNewSession ? sessionCtx : { ...sessionCtx, ThreadStarterBody: undefined },
    cfg,
    // promptSessionCtx restores the persisted channel/account for system-event
    // turns, so reply formatting hints resolve against the delivery channel.
    { includeFormattingHints: !useFastReplyRuntime, formattingHintsCtx: promptSessionCtx },
  );
  const execOverridePromptHint = buildExecOverridePromptHint({
    execOverrides,
    elevatedLevel: resolvedElevatedLevel,
    fullAccessAvailable: fullAccessState.available,
    fullAccessBlockedReason: fullAccessState.blockedReason,
  });
  const extraSystemPromptParts = [
    inboundMetaPrompt,
    directChatContext,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    execOverridePromptHint,
  ].filter(Boolean);
  const extraSystemPromptStatic = [
    directChatContext,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
    execOverridePromptHint,
  ]
    .filter(Boolean)
    .join("\n\n");
  const cliSessionBindingFacts = {
    extraSystemPromptStatic,
    ...(sessionPromptSourceReplyDeliveryMode
      ? { sourceReplyDeliveryMode: sessionPromptSourceReplyDeliveryMode }
      : {}),
  };
  const silentReplyPromptMode: SilentReplyPromptMode =
    directChatContext || groupChatContext || sourceReplyDeliveryMode === "message_tool_only"
      ? "none"
      : "generic";
  const baseBody = sessionCtx.agentText ?? "";
  const rawBodyTrimmed = (ctx.commandText ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  const normalizedCommandBody = command.commandBodyNormalized.trim();
  const softResetTriggered = command.softResetTriggered === true;
  const softResetTail = command.softResetTail?.trim() ?? "";
  const effectiveResetTriggered = resetTriggered || softResetTriggered;
  const hasCurrentReplyTargetContext =
    hasReplyTargetContext(ctx) || hasReplyTargetContext(sessionCtx);
  const isWholeMessageCommand =
    normalizedCommandBody === rawBodyTrimmed ||
    normalizedCommandBody === rawBodyTrimmed.toLowerCase();
  const isResetOrNewCommand = /^\/(new|reset)(?:\s|$)/i.test(normalizedCommandBody);
  if (
    allowTextCommands &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    isWholeMessageCommand &&
    (hasControlCommand(rawBodyTrimmed, cfg) || isResetOrNewCommand)
  ) {
    typing.cleanup();
    return undefined;
  }
  const isBareNewOrReset = /^\/(new|reset)$/i.test(normalizedCommandBody);
  const isBareSessionReset =
    softResetTriggered ||
    (isNewSession &&
      (isBareNewOrReset ||
        (!hasCurrentReplyTargetContext &&
          baseBodyTrimmedRaw.length === 0 &&
          rawBodyTrimmed.length > 0)));
  const startupAction =
    softResetTriggered || /^\/reset(?:\s|$)/i.test(normalizedCommandBody) ? "reset" : "new";
  const sessionWorkspaceOverride = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: sessionEntry?.spawnedBy,
    workspaceDir: sessionEntry?.spawnedWorkspaceDir,
    cwd: sessionEntry?.spawnedCwd,
  });
  const workspaceDir = sessionWorkspaceOverride ?? configuredWorkspaceDir;
  const bareResetPromptState =
    isBareSessionReset && workspaceDir
      ? await resolveBareSessionResetPromptState({
          cfg,
          workspaceDir,
          isPrimaryRun: !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey),
          isCanonicalWorkspace: !sessionWorkspaceOverride,
          hasBootstrapFileAccess: () =>
            resolveBareResetBootstrapFileAccess({
              cfg,
              agentId,
              sessionKey,
              workspaceDir,
              modelProvider: provider,
              modelId: model,
            }),
        })
      : null;
  const startupContextPrelude =
    isBareSessionReset &&
    bareResetPromptState?.shouldPrependStartupContext !== false &&
    shouldApplyStartupContext({ cfg, action: startupAction })
      ? await buildSessionStartupContextPrelude({
          workspaceDir,
          cfg,
        })
      : null;
  const baseBodyFinal = isBareSessionReset
    ? (bareResetPromptState?.prompt ?? "")
    : stripPromptThinkingDirectives(baseBody);
  const hasUserBody =
    baseBodyFinal.trim().length > 0 ||
    softResetTail.length > 0 ||
    hasInboundHistoryBody(sessionCtx) ||
    hasCurrentReplyTargetContext;
  const hasMediaAttachment = hasInboundMedia(sessionCtx) || (opts?.images?.length ?? 0) > 0;
  if (!hasUserBody && !hasMediaAttachment) {
    // Skip onReplyStart when typing is suppressed (e.g. sendPolicy deny) —
    // otherwise channels that wire onReplyStart to typing indicators leak
    // visible signals even though outbound delivery is suppressed.
    if (!suppressTyping) {
      await typing.onReplyStart();
    }
    logVerbose("Inbound body empty after normalization; skipping agent run");
    typing.cleanup();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const skillSuggestionEnabled = !resolveSkillWorkshopConfig(cfg).autonomous.enabled;
  const inboundUserContextSessionCtx = isNewSession
    ? {
        ...sessionCtx,
        ...(normalizeOptionalString(sessionCtx.ThreadHistoryBody)
          ? { InboundHistory: undefined, ThreadStarterBody: undefined }
          : {}),
      }
    : { ...sessionCtx, ThreadStarterBody: undefined };
  let consumedSkillSuggestion: PendingSkillSuggestion | undefined;
  const resolveContextSessionEntry = async (
    entry: SessionEntry | undefined,
  ): Promise<SessionEntry | undefined> => {
    if (isHeartbeat) {
      return undefined;
    }
    let currentEntry = entry;
    if (!consumedSkillSuggestion && currentEntry?.pendingSkillSuggestion) {
      try {
        const consumed = await consumeSessionSkillSuggestion({
          agentId,
          sessionKey,
          storePath,
        });
        if (consumed) {
          currentEntry = consumed.entry;
          consumedSkillSuggestion = skillSuggestionEnabled ? consumed.suggestion : undefined;
          sessionEntry = consumed.entry;
          sessionEntryHandle?.replaceCurrent(consumed.entry);
          if (sessionStore) {
            sessionStore[sessionKey] = consumed.entry;
          }
        }
      } catch (error) {
        logVerbose(`Skill suggestion consume failed: ${String(error)}`);
      }
    }
    return projectSkillSuggestionForTurn(currentEntry, consumedSkillSuggestion);
  };
  let inboundContextSessionEntry = await resolveContextSessionEntry(
    sessionStore?.[sessionKey] ?? sessionEntryHandle?.getCurrent() ?? sessionEntry,
  );
  let activeGoalContext = formatActiveGoalContext(inboundContextSessionEntry);
  let inboundUserContext = buildInboundUserContextPrefix(
    inboundUserContextSessionCtx,
    envelopeOptions,
    inboundContextSessionEntry,
  );
  const refreshInboundContextAfterAdmissionWait = async () => {
    if (isHeartbeat) {
      return;
    }
    const latestSessionEntry =
      storePath && sessionKey
        ? loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })
        : (sessionEntryHandle?.getCurrent() ?? sessionStore?.[sessionKey] ?? sessionEntry);
    inboundContextSessionEntry = await resolveContextSessionEntry(latestSessionEntry);
    activeGoalContext = formatActiveGoalContext(inboundContextSessionEntry);
    inboundUserContext = buildInboundUserContextPrefix(
      inboundUserContextSessionCtx,
      envelopeOptions,
      inboundContextSessionEntry,
    );
  };
  const inboundUserContextPromptJoiner = resolveInboundUserContextPromptJoiner(sessionCtx);
  const promptEnvelopeBase = buildReplyPromptEnvelopeBase({
    ctx,
    sessionCtx,
    baseBody: baseBodyFinal,
    hasUserBody,
    inboundUserContext,
    activeGoalContext,
    inboundUserContextPromptJoiner,
    isBareSessionReset,
    startupAction,
    startupContextPrelude,
    softResetTail,
    isHeartbeat,
    inboundEventKind,
    sourceReplyDeliveryMode,
  });
  const effectiveBaseBody = promptEnvelopeBase.effectiveBaseBody;
  // A commitment-only wake must not consume the one-shot aborted-run hint;
  // that recovery context belongs to the next normal conversation turn.
  let prefixedBodyBase =
    heartbeatRunScope === "commitment-only"
      ? effectiveBaseBody
      : await applySessionHints({
          baseBody: effectiveBaseBody,
          abortedLastRun,
          sessionEntry,
          sessionEntryHandle,
          sessionStore,
          sessionKey,
          storePath,
          abortKey: command.abortKey,
        });
  sessionEntry = sessionEntryHandle?.getCurrent() ?? sessionEntry;
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);
  // Extract first-token think hint from the user body BEFORE prepending system events.
  // If done after, the System: prefix becomes parts[0] and silently shadows any
  // low|medium|high shorthand the user typed.
  if (!resolvedThinkLevel && prefixedBodyBase) {
    const parts = prefixedBodyBase.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    const thinkingCatalog = maybeLevel
      ? await traceRunPhase("reply.resolve_thinking_catalog_for_hint", () =>
          modelState.resolveThinkingCatalog(),
        )
      : undefined;
    if (
      maybeLevel &&
      isThinkingLevelSupported({
        provider,
        model,
        level: maybeLevel,
        catalog: thinkingCatalog,
        agentRuntime: thinkingRuntime,
      })
    ) {
      resolvedThinkLevel = maybeLevel;
      prefixedBodyBase = parts.slice(1).join(" ").trim();
    }
  }
  const prefixedBodyCore = prefixedBodyBase;
  const threadStarterBody = normalizeOptionalString(ctx.ThreadStarterBody);
  const threadHistoryBody = normalizeOptionalString(ctx.ThreadHistoryBody);
  const threadContextNote = threadHistoryBody
    ? `[Thread history - for context]\n${threadHistoryBody}`
    : !isNewSession && threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const drainedSystemEventBlocks: string[] = [];
  const rebuildPromptBodies = async (): Promise<{
    prefixedCommandBody: string;
    queuedBody: string;
    transcriptBody: string;
    transcriptCommandBody: string;
    media?: MediaFact[];
    currentInboundContext?: typeof promptEnvelopeBase.currentInboundContext;
  }> => {
    if (!useFastReplyRuntime && heartbeatRunScope !== "commitment-only") {
      const eventsBlock = await drainFormattedSystemEvents({
        cfg,
        sessionKey,
        isMainSession,
        isNewSession,
        suppressHeartbeatOwnedEvents: isHeartbeat,
      });
      if (eventsBlock) {
        drainedSystemEventBlocks.push(eventsBlock);
      }
    }
    return buildReplyPromptEnvelope({
      ctx,
      sessionCtx,
      baseBody: baseBodyFinal,
      prefixedBody: prefixedBodyCore,
      hasUserBody,
      inboundUserContext,
      activeGoalContext,
      inboundUserContextPromptJoiner,
      isBareSessionReset,
      startupAction,
      startupContextPrelude,
      softResetTail,
      isHeartbeat,
      inboundEventKind,
      sourceReplyDeliveryMode,
      threadContextNote,
      systemEventBlocks: drainedSystemEventBlocks,
      media: opts?.media,
    });
  };
  const skillResult = isFastTestRuntimeEnv()
    ? {
        sessionEntry,
        skillsSnapshot: sessionEntry?.skillsSnapshot,
        systemSent: currentSystemSent,
      }
    : await traceRunPhase("reply.ensure_skill_snapshot", async () => {
        const { ensureSkillSnapshot } = await loadSessionUpdatesRuntime();
        return await ensureSkillSnapshot({
          sessionEntry,
          sessionEntryHandle,
          sessionStore,
          sessionKey,
          storePath,
          sessionId,
          isFirstTurnInSession,
          workspaceDir,
          cfg,
          execOverrides,
          skillFilter: opts?.skillFilter,
        });
      });
  sessionEntry = skillResult.sessionEntry;
  if (sessionEntry) {
    sessionEntryHandle?.replaceCurrent(sessionEntry);
  }
  const skillsSnapshot = skillResult.skillsSnapshot;
  let {
    prefixedCommandBody,
    queuedBody,
    transcriptBody,
    transcriptCommandBody,
    media: promptMedia,
    currentInboundContext,
  } = await traceRunPhase("reply.build_prompt_bodies", () => rebuildPromptBodies());
  const isRoomEvent = inboundEventKind === "room_event";
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await traceRunPhase("reply.resolve_default_thinking", () =>
      modelState.resolveDefaultThinkingLevel(),
    );
  }
  const allowedThinkingCatalog = modelState.allowedModelCatalog ?? [];
  let thinkingCatalog = allowedThinkingCatalog.length > 0 ? allowedThinkingCatalog : undefined;
  let thinkingLevelSupported = isThinkingLevelSupported({
    provider,
    model,
    level: resolvedThinkLevel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  });
  const shouldHydrateThinkingCatalog =
    !thinkingLevelSupported ||
    (resolvedThinkLevel !== "off" &&
      !hasResolvedThinkingCatalogEntry({ catalog: thinkingCatalog, provider, model }));
  if (shouldHydrateThinkingCatalog) {
    // Hydrate the runtime model catalog only when the lightweight catalog cannot
    // prove support or lacks reasoning metadata for the selected model. The full
    // catalog load was a 14s+ reply-blocking cost for known Codex models that
    // already publish authoritative thinking metadata.
    thinkingCatalog = await traceRunPhase("reply.resolve_thinking_catalog", () =>
      modelState.resolveThinkingCatalog(),
    );
    thinkingLevelSupported = isThinkingLevelSupported({
      provider,
      model,
      level: resolvedThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
  }
  if (!thinkingLevelSupported) {
    const explicitThink =
      (directives.hasThinkDirective && directives.thinkLevel !== undefined) ||
      explicitThinkingLevelOverride !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        text: `Thinking level "${resolvedThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
      };
    }
    const fallbackThinkLevel = resolveSupportedThinkingLevel({
      provider,
      model,
      level: resolvedThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    });
    if (fallbackThinkLevel !== resolvedThinkLevel) {
      // Execution fallbacks are turn-local; directive/model persistence owns
      // durable thinking remaps so explicit session overrides survive replies.
      resolvedThinkLevel = fallbackThinkLevel;
    }
  }
  const providedReplyOperation = opts?.replyOperation;
  // Native command turns reserve their operation under the slash SOURCE key so
  // commands never contend with the target's active run (#104144). When such a
  // turn continues into a full agent turn (/steer fallback, /goal, /learn,
  // unhandled body), it mutates the TARGET session: it must adopt the target's
  // run slot before running or concurrent target inbounds double-admit and
  // split the session (#104844).
  const commandTurnContinuationTargetKey =
    providedReplyOperation !== undefined &&
    providedReplyOperation.result === null &&
    providedReplyOperation.phase === "queued" &&
    sessionKey !== undefined &&
    providedReplyOperation.key !== sessionKey &&
    resolveCommandTurnTargetSessionKey(ctx) !== undefined
      ? sessionKey
      : undefined;
  if (
    commandTurnContinuationTargetKey === undefined &&
    providedReplyOperation !== undefined &&
    providedReplyOperation.result === null &&
    providedReplyOperation.phase === "queued" &&
    sessionId !== undefined &&
    sessionId !== providedReplyOperation.sessionId
  ) {
    // Dispatch reserves a queued operation before session init. If stale init
    // rotates the session, move the reservation so later steer/abort paths
    // target the session that will actually run. Command-turn continuations
    // rebind after slot adoption below: rebinding first would collide with a
    // still-active target operation that owns the same session ID.
    providedReplyOperation.updateSessionId(sessionId);
  }
  const isOwnPreDispatchOperationSession = (candidateSessionId: string | undefined): boolean =>
    providedReplyOperation !== undefined &&
    providedReplyOperation.result === null &&
    providedReplyOperation.phase === "queued" &&
    candidateSessionId === providedReplyOperation.sessionId;
  const sessionIdFinal = sessionId ?? providedReplyOperation?.sessionId ?? crypto.randomUUID();
  const sessionFilePathOptions = resolveSessionFilePathOptions({ agentId, storePath });
  const resolvePreparedSessionState = (): {
    sessionEntry: SessionEntry | undefined;
    sessionId: string;
    sessionFile: string;
  } => {
    // Working-set exact key first; disk alias resolve only when storePath known.
    // No whole-map scan — that encodes the store layout the accessor hides.
    const latestSessionEntry =
      sessionStore && sessionKey
        ? (sessionStore[sessionKey] ??
          (storePath
            ? loadSessionEntry({
                storePath,
                sessionKey,
                readConsistency: "latest",
              })
            : undefined) ??
          sessionEntry)
        : sessionEntry;
    const latestSessionId = latestSessionEntry?.sessionId ?? sessionIdFinal;
    opts?.onSessionPrepared?.({
      sessionKey,
      sessionId: latestSessionId,
      storePath,
    });
    const existingSessionFile = latestSessionEntry?.sessionFile;
    const sessionFile =
      existingSessionFile &&
      sqliteSessionFileMarkerMatchesSession(existingSessionFile, latestSessionId)
        ? existingSessionFile
        : storePath
          ? formatSqliteSessionFileMarker({
              agentId,
              sessionId: latestSessionId,
              storePath,
            })
          : resolveSessionFilePath(latestSessionId, latestSessionEntry, sessionFilePathOptions);
    return {
      sessionEntry: latestSessionEntry,
      sessionId: latestSessionId,
      sessionFile,
    };
  };
  let preparedSessionState = resolvePreparedSessionState();
  const resolvedQueue = useFastReplyRuntime
    ? {
        mode: "collect" as const,
        debounceMs: 0,
        cap: 1,
        dropPolicy: "summarize" as const,
      }
    : resolveQueueSettings({
        cfg,
        channel: sessionCtx.Provider,
        sessionEntry,
        inlineMode: effectiveQueueMode,
        inlineOptions: perMessageQueueOptions,
      });
  const embeddedAgentRuntime = useFastReplyRuntime
    ? null
    : await traceRunPhase("reply.load_embedded_agent_runtime", () => loadEmbeddedAgentRuntime());
  const resolveActiveEmbeddedSessionId = (sessionFile = preparedSessionState.sessionFile) =>
    embeddedAgentRuntime?.resolveActiveEmbeddedRunSessionId(sessionKey) ??
    embeddedAgentRuntime?.resolveActiveEmbeddedRunSessionIdBySessionFile?.(sessionFile);
  const sessionLaneKey = embeddedAgentRuntime
    ? embeddedAgentRuntime.resolveEmbeddedSessionLane(sessionKey ?? sessionIdFinal)
    : undefined;
  const laneSize = sessionLaneKey ? getQueueSize(sessionLaneKey) : 0;
  const activeRunQueueMode = effectiveResetTriggered ? "interrupt" : resolvedQueue.mode;
  const rawActiveSessionIdForInterrupt = resolveActiveEmbeddedSessionId();
  const activeSessionIdForInterrupt = isOwnPreDispatchOperationSession(
    rawActiveSessionIdForInterrupt,
  )
    ? undefined
    : rawActiveSessionIdForInterrupt;
  if (
    activeRunQueueMode === "interrupt" &&
    !isRoomEvent &&
    sessionLaneKey &&
    (laneSize > 0 || activeSessionIdForInterrupt)
  ) {
    const cleared = clearCommandLane(sessionLaneKey);
    const aborted = embeddedAgentRuntime?.abortEmbeddedAgentRun(
      activeSessionIdForInterrupt ?? preparedSessionState.sessionId,
    );
    logVerbose(`Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`);
  }
  const agentHarnessPolicy = useFastReplyRuntime
    ? undefined
    : resolveAgentHarnessPolicy({
        provider,
        modelId: model,
        config: cfg,
        agentId,
        sessionKey: runtimePolicySessionKey,
      });
  const resolveAcceptedAuthProfileProviders = () =>
    agentHarnessPolicy
      ? listOpenAIAuthProfileProvidersForAgentRuntime({
          provider,
          harnessRuntime: agentHarnessPolicy.runtime,
          config: cfg,
        })
      : [provider];
  const resolveRuntimeAuthProfile = async (): Promise<{
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
  }> => {
    if (useFastReplyRuntime) {
      return {
        authProfileId: preparedSessionState.sessionEntry?.authProfileOverride,
        authProfileIdSource: preparedSessionState.sessionEntry?.authProfileOverrideSource,
      };
    }
    const shouldUseEphemeralSession = params.autoFallbackPrimaryProbe !== undefined;
    const authSessionKey = shouldUseEphemeralSession ? (sessionKey ?? sessionIdFinal) : sessionKey;
    const authSessionEntry =
      shouldUseEphemeralSession && preparedSessionState.sessionEntry
        ? { ...preparedSessionState.sessionEntry }
        : preparedSessionState.sessionEntry;
    if (params.autoFallbackPrimaryProbe && authSessionEntry) {
      clearAutoFallbackPrimaryProbeSelection(authSessionEntry);
    }
    const authSessionStore =
      shouldUseEphemeralSession && authSessionEntry
        ? { [authSessionKey]: authSessionEntry }
        : sessionStore;
    const resolvedAuthProfileId = await resolveSessionAuthProfileOverride({
      cfg,
      provider,
      acceptedProviderIds: resolveAcceptedAuthProfileProviders(),
      agentDir,
      sessionEntry: authSessionEntry,
      sessionStore: authSessionStore,
      sessionKey: authSessionKey,
      storePath: shouldUseEphemeralSession ? undefined : storePath,
      isNewSession,
    });
    return {
      authProfileId: resolvedAuthProfileId,
      authProfileIdSource:
        resolvedAuthProfileId && authSessionEntry?.authProfileOverride === resolvedAuthProfileId
          ? authSessionEntry.authProfileOverrideSource
          : undefined,
    };
  };
  let authProfileId: string | undefined;
  let authProfileIdSource: "auto" | "user" | undefined;
  ({ authProfileId, authProfileIdSource } = await traceRunPhase("reply.resolve_auth_profile", () =>
    resolveRuntimeAuthProfile(),
  ));
  const { runReplyAgent } = await traceRunPhase("reply.load_agent_runner_runtime", () =>
    loadAgentRunnerRuntime(),
  );
  const queueKey = sessionKey ?? sessionIdFinal;
  preparedSessionState = resolvePreparedSessionState();
  const currentRouteThreadId = resolveRoutedDeliveryThreadId({
    ctx,
    sessionKey,
  });
  const applySlackRouteThreadSteeringGuard = isSlackDirectRoutedThreadTurn(ctx);
  const resolveActiveRunAcceptsCurrentThread = (busy: { isActive: boolean }) => {
    if (!busy.isActive || !sessionKey || !applySlackRouteThreadSteeringGuard) {
      return true;
    }
    return routeThreadIdsMatch(resolveActiveReplyRunThreadId(sessionKey), currentRouteThreadId);
  };
  const resolveActiveReplyOperationSessionId = () =>
    sessionKey ? resolveActiveReplyRunSessionId(sessionKey) : undefined;
  const resolveActiveQueueSessionId = () =>
    resolveActiveEmbeddedSessionId() ??
    resolveActiveReplyOperationSessionId() ??
    preparedSessionState.sessionId;
  const resolveQueueBusyState = () => {
    const embeddedActiveSessionId = resolveActiveEmbeddedSessionId();
    const replyOperationActiveSessionId = resolveActiveReplyOperationSessionId();
    const activeSessionId =
      embeddedActiveSessionId ?? replyOperationActiveSessionId ?? preparedSessionState.sessionId;
    if (!activeSessionId || (!embeddedAgentRuntime && !replyOperationActiveSessionId)) {
      return { activeSessionId: undefined, isActive: false, isStreaming: false };
    }
    if (isOwnPreDispatchOperationSession(activeSessionId)) {
      return { activeSessionId, isActive: false, isStreaming: false };
    }
    const replyOperationActive =
      replyOperationActiveSessionId != null &&
      isReplyRunActiveForSessionId(replyOperationActiveSessionId);
    return {
      activeSessionId,
      isActive:
        (embeddedActiveSessionId != null &&
          (embeddedAgentRuntime?.isEmbeddedAgentRunActive(embeddedActiveSessionId) ?? false)) ||
        replyOperationActive,
      isStreaming:
        (embeddedActiveSessionId != null &&
          (embeddedAgentRuntime?.isEmbeddedAgentRunStreaming(embeddedActiveSessionId) ?? false)) ||
        (replyOperationActiveSessionId != null &&
          isReplyRunStreamingForSessionId(replyOperationActiveSessionId)),
    };
  };
  if (commandTurnContinuationTargetKey && providedReplyOperation) {
    const adoption = await admitReplyTurn({
      sessionKey: commandTurnContinuationTargetKey,
      sessionId: providedReplyOperation.sessionId,
      expectedSessionId: preparedSessionState.sessionEntry?.sessionId,
      storePath,
      kind: "visible",
      resetTriggered: effectiveResetTriggered,
      routeThreadId: currentRouteThreadId,
      upstreamAbortSignal: opts?.abortSignal,
      // Never wait on the target's active turn: a blocked continuation would
      // re-create the #104142 command-lane wedge. When the slot is owned, the
      // queue policy below sees the target-keyed owner and steers/queues this
      // turn instead of running it concurrently.
      waitForActive: false,
      adoptOperation: providedReplyOperation,
    });
    if (adoption.status === "skipped" && adoption.reason === "aborted") {
      typing.cleanup();
      return undefined;
    }
    if (
      adoption.status === "owned" &&
      sessionId !== undefined &&
      sessionId !== providedReplyOperation.sessionId
    ) {
      providedReplyOperation.updateSessionId(sessionId);
    }
  }
  const { activeSessionId, isActive, isStreaming } = resolveQueueBusyState();
  const activeRunAcceptsCurrentThread = resolveActiveRunAcceptsCurrentThread({ isActive });
  const isHeartbeatRun = opts?.isHeartbeat === true;
  const shouldSteer =
    !isRoomEvent &&
    activeRunAcceptsCurrentThread &&
    !isHeartbeatRun &&
    !effectiveResetTriggered &&
    resolvedQueue.mode === "steer";
  const shouldFollowup =
    !effectiveResetTriggered &&
    ((isRoomEvent && isActive) ||
      resolvedQueue.mode === "steer" ||
      resolvedQueue.mode === "followup" ||
      resolvedQueue.mode === "collect");
  const activeRunQueueAction = resolveActiveRunQueueAction({
    isActive,
    isHeartbeat: isHeartbeatRun,
    shouldFollowup,
    queueMode: activeRunQueueMode,
    resetTriggered: effectiveResetTriggered,
  });
  if (isActive && activeRunQueueAction === "run-now") {
    const queueState = await resolvePreparedReplyQueueState({
      activeRunQueueAction,
      activeSessionId: activeSessionId ?? resolveActiveQueueSessionId(),
      queueMode: activeRunQueueMode,
      sessionKey,
      sessionId: sessionIdFinal,
      abortActiveRun: (activeRunSessionId) => {
        const embeddedAborted =
          embeddedAgentRuntime?.abortEmbeddedAgentRun(activeRunSessionId) ?? false;
        const replyOperationAborted = abortReplyRunBySessionId(activeRunSessionId);
        return embeddedAborted || replyOperationAborted;
      },
      waitForActiveRunEnd: (activeRunSessionId) =>
        isReplyRunActiveForSessionId(activeRunSessionId)
          ? waitForReplyRunEndBySessionId(activeRunSessionId, REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS)
          : (embeddedAgentRuntime?.waitForEmbeddedAgentRunEnd(activeRunSessionId) ??
            Promise.resolve(undefined)),
      refreshPreparedState: async () => {
        preparedSessionState = resolvePreparedSessionState();
        ({ authProfileId, authProfileIdSource } = await resolveRuntimeAuthProfile());
        preparedSessionState = resolvePreparedSessionState();
        // The interrupted run may have changed goal or suggestion state while admission waited.
        await refreshInboundContextAfterAdmissionWait();
        ({
          prefixedCommandBody,
          queuedBody,
          transcriptBody,
          transcriptCommandBody,
          media: promptMedia,
          currentInboundContext,
        } = await traceRunPhase("reply.build_prompt_bodies", () => rebuildPromptBodies()));
      },
      resolveBusyState: resolveQueueBusyState,
    });
    if (queueState.kind === "reply") {
      typing.cleanup();
      return queueState.reply;
    }
    resolveActiveRunAcceptsCurrentThread({ isActive });
  }
  const runHasStoredSessionModelOverride = Boolean(
    normalizeOptionalString(preparedSessionState.sessionEntry?.modelOverride) ||
    normalizeOptionalString(preparedSessionState.sessionEntry?.providerOverride),
  );
  const runHasLegacyAutoFallbackWithoutOrigin =
    runHasStoredSessionModelOverride &&
    hasLegacyAutoFallbackWithoutOrigin(preparedSessionState.sessionEntry);
  const runHasSessionModelOverride =
    runHasStoredSessionModelOverride && !runHasLegacyAutoFallbackWithoutOrigin;
  const runModelOverrideSource = runHasSessionModelOverride
    ? preparedSessionState.sessionEntry?.modelOverrideSource
    : undefined;
  const runHasAutoFallbackProvenance =
    runHasSessionModelOverride &&
    hasSessionAutoModelFallbackProvenance(preparedSessionState.sessionEntry);
  const originatingThreadId = resolveRoutedDeliveryThreadId({
    ctx,
    sessionKey,
  });
  const currentTurnImages = await traceRunPhase("reply.resolve_current_turn_images", () =>
    resolveCurrentTurnImages({
      ctx,
      cfg,
      images: opts?.images,
      imageOrder: opts?.imageOrder,
      extractedFileImages: opts?.extractedFileImages,
    }),
  );
  // Abort-signal attachment for queued followups:
  // - room_event: always inherit (source admission fence / ambient cancel).
  // - Gateway-owned lifecycle (chat.send / turnAdoptionLifecycle): always inherit
  //   so Esc can cancel a turn after chat.send terminalizes while still queued.
  // - plain user_request without lifecycle: deliberately detach from the
  //   source/active-lane signal so a superseded parent abort does not cancel a
  //   still-valid queued user turn.
  const hasQueuedOwnershipLifecycle = Boolean(opts?.turnAdoptionLifecycle);
  const queuedFollowupAbortSignal =
    hasQueuedOwnershipLifecycle || inboundEventKind === "room_event"
      ? (opts?.queuedFollowupAbortSignal ??
        opts?.turnAdoptionLifecycle?.abortSignal ??
        opts?.abortSignal)
      : undefined;
  const replyRoute = resolveEffectiveReplyRoute({
    ctx: {
      Provider: ctx.Provider ?? sessionCtx.Provider,
      Surface: ctx.Surface ?? sessionCtx.Surface,
      OriginatingChannel: ctx.OriginatingChannel ?? sessionCtx.OriginatingChannel,
      OriginatingTo: ctx.OriginatingTo ?? sessionCtx.OriginatingTo,
      AccountId: ctx.AccountId ?? sessionCtx.AccountId,
      InputProvenance: ctx.InputProvenance ?? sessionCtx.InputProvenance,
      ChatType: ctx.ChatType ?? sessionCtx.ChatType,
    },
    entry: preparedSessionState.sessionEntry,
  });
  const messageProvider = resolveOriginMessageProvider({
    originatingChannel: replyRoute.channel,
    // Prefer Provider over Surface for fallback channel identity.
    // Surface can carry relayed metadata while Provider owns reply routing.
    provider: ctx.Provider ?? ctx.Surface ?? promptSessionCtx.Provider,
  });
  const sourceMessageId =
    normalizeOptionalString(sessionCtx.MessageSidFull) ??
    normalizeOptionalString(sessionCtx.MessageSid);
  const sourceTurnId =
    readChannelSourceTurnId(sessionCtx) ??
    (shouldMintChannelSourceTurnId(ctx.Provider ?? ctx.Surface ?? promptSessionCtx.Provider)
      ? buildChannelSourceTurnId({
          provider: messageProvider,
          accountId: replyRoute.accountId,
          conversationId: replyRoute.to,
          messageId: sourceMessageId,
        })
      : undefined);
  setChannelSourceTurnId(sessionCtx, sourceTurnId);
  const persistGroupSender = replyRoute.chatType === "group" || replyRoute.chatType === "channel";
  const ctxMediaForPersistence = resolveMediaFacts(ctx);
  const userTurnMediaForPersistence = [...ctxMediaForPersistence, ...(opts?.media ?? [])];
  const mediaImageLayout = buildPersistedMediaImageLayout({
    ctx,
    media: userTurnMediaForPersistence,
    ctxMediaCount: ctxMediaForPersistence.length,
    imageOrder: currentTurnImages.imageOrder,
    imageSourceIndexes: currentTurnImages.imageSourceIndexes,
  });
  const inputProvenance = ctx.InputProvenance ?? sessionCtx.InputProvenance;
  const userTurnTimestamp = normalizeMessageTimestampMs(ctx.Timestamp);
  // prompt-prelude substitutes MEDIA_ONLY_USER_TEXT as transcriptBody for
  // bodyless turns; storage stays bare (the LLM boundary re-injects it), while
  // room-event lines that merely contain the marker keep their real text.
  const userTurnTranscriptText =
    !hasUserBody && transcriptBody === MEDIA_ONLY_USER_TEXT
      ? ""
      : resolvePersistedUserTurnText(transcriptBody);
  const conversationIdentity = conversationIdentityFromMsgContext({ ctx: sessionCtx });
  const conversationRef = conversationIdentity?.conversationRef;
  const transportMessageId =
    normalizeOptionalString(sessionCtx.MessageSidFull) ??
    normalizeOptionalString(sessionCtx.MessageSid);
  const transportReplyToId =
    normalizeOptionalString(sessionCtx.ReplyToIdFull) ??
    normalizeOptionalString(sessionCtx.ReplyToId);
  const transportThreadId =
    sessionCtx.MessageThreadId === undefined
      ? undefined
      : normalizeOptionalString(String(sessionCtx.MessageThreadId));
  const transportChannel =
    normalizeOptionalString(conversationIdentity?.channel) ??
    normalizeOptionalString(sessionCtx.OriginatingChannel) ??
    normalizeOptionalString(sessionCtx.Provider);
  const transport =
    conversationRef ||
    transportMessageId ||
    transportReplyToId ||
    transportThreadId ||
    transportChannel
      ? {
          ...(transportChannel ? { channel: transportChannel } : {}),
          ...(conversationRef ? { conversationRef } : {}),
          ...(transportMessageId ? { messageId: transportMessageId } : {}),
          ...(transportReplyToId ? { replyToId: transportReplyToId } : {}),
          ...(transportThreadId ? { threadId: transportThreadId } : {}),
        }
      : undefined;
  const userTurnInput =
    userTurnTranscriptText !== undefined || userTurnMediaForPersistence.length > 0
      ? {
          text: userTurnTranscriptText,
          senderIsOwner: command.senderIsOwner,
          ...(sourceTurnId ? { idempotencyKey: sourceTurnId } : {}),
          ...(inputProvenance && !isHeartbeat ? { provenance: inputProvenance } : {}),
          ...(isHeartbeat
            ? { provenance: { kind: "internal_system" as const, sourceTool: "heartbeat" } }
            : {}),
          ...(transport ? { transport } : {}),
          ...(userTurnMediaForPersistence.length > 0 ? { media: userTurnMediaForPersistence } : {}),
          ...(mediaImageLayout ? { mediaImageLayout } : {}),
          // Persist the message's own arrival timestamp so the single
          // LLM-boundary stamping site (normalizeMessagesForLlmBoundary) can
          // derive a stable per-message `[DOW YYYY-MM-DD HH:MM TZ]` prefix that
          // is identical whether this turn is sent as the current turn or
          // replayed as history. See: https://github.com/openclaw/openclaw/issues/3658
          ...(userTurnTimestamp ? { timestamp: userTurnTimestamp } : {}),
          // Direct transcripts keep their existing identity-storage boundary.
          sender: persistGroupSender
            ? {
                id: normalizeOptionalString(sessionCtx.SenderId),
                name: normalizeOptionalString(sessionCtx.SenderName),
                username: normalizeOptionalString(sessionCtx.SenderUsername),
              }
            : undefined,
        }
      : undefined;
  const userTurnTranscriptRecorder =
    opts?.userTurnTranscriptRecorder ??
    (userTurnInput
      ? createUserTurnTranscriptRecorder({
          input: userTurnInput,
          target: () => ({
            sessionId: preparedSessionState.sessionId,
            sessionKey: sessionKey ?? preparedSessionState.sessionId,
            sessionEntry: preparedSessionState.sessionEntry,
            ...(sessionStore ? { sessionStore } : {}),
            ...(storePath ? { storePath } : {}),
            agentId,
            cwd: workspaceDir,
            config: cfg,
          }),
          errorContext: "reply user turn transcript",
          beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
          onMessagePersisted: isRoomEvent
            ? async () =>
                await updateRoomEventAmbientTranscriptWatermark({
                  expectedSessionId: preparedSessionState.sessionId,
                  sessionCtx,
                  storePath,
                  sessionKey: sessionKey ?? preparedSessionState.sessionId,
                })
            : undefined,
        })
      : undefined);
  const replyPolicyChannel =
    (replyRoute.channel as OriginatingChannelType | undefined) ??
    (messageProvider as OriginatingChannelType | undefined);
  const followupRun = {
    prompt: queuedBody,
    transcriptPrompt: transcriptCommandBody,
    ...(userTurnTranscriptRecorder ? { userTurnTranscriptRecorder } : {}),
    currentInboundEventKind: inboundEventKind,
    currentInboundAudio: hasInboundAudio(sessionCtx),
    currentInboundContext,
    ...(queuedFollowupAbortSignal ? { abortSignal: queuedFollowupAbortSignal } : {}),
    deliveryCorrelations: opts?.queuedDeliveryCorrelations,
    turnAdoptionLifecycle: opts?.turnAdoptionLifecycle,
    onReplyAdmissionWaitChange: opts?.onReplyAdmissionWaitChange,
    messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    summaryLine: baseBodyTrimmedRaw,
    enqueuedAt: Date.now(),
    images: currentTurnImages.images,
    imageOrder: currentTurnImages.imageOrder,
    media: promptMedia,
    // Originating channel for reply routing.
    originatingChannel: replyRoute.channel,
    originatingTo: replyRoute.to,
    originatingAccountId: replyRoute.accountId,
    originatingThreadId: replyRoute.threadId ?? originatingThreadId,
    originatingReplyToId: promptSessionCtx.ReplyToId,
    originatingReplyToMode:
      promptSessionCtx.ReplyToMode ??
      resolveReplyToMode(cfg, replyPolicyChannel, replyRoute.accountId, replyRoute.chatType),
    originatingChatId:
      normalizeOptionalString(sessionCtx.NativeChannelId) ??
      normalizeOptionalString(sessionCtx.ChatId),
    originatingChatType: replyRoute.chatType,
    run: {
      agentId,
      agentDir,
      sessionId: preparedSessionState.sessionId,
      sessionKey,
      runtimePolicySessionKey,
      messageProvider,
      clientCaps: ctx.GatewayClientCaps,
      toolBindings: ctx.GatewayRunToolBindings,
      chatType: replyRoute.chatType,
      agentAccountId: replyRoute.accountId,
      groupId: resolveGroupSessionKey(sessionCtx)?.id ?? undefined,
      groupChannel:
        normalizeOptionalString(sessionCtx.GroupChannel) ??
        normalizeOptionalString(sessionCtx.GroupSubject),
      groupSpace: normalizeOptionalString(sessionCtx.GroupSpace),
      // Parent lineage authenticates inherited group policy for queued CLI/MCP runs.
      spawnedBy: normalizeOptionalString(preparedSessionState.sessionEntry?.spawnedBy),
      senderId: normalizeOptionalString(sessionCtx.SenderId),
      channelContext: ctx.ChannelContext ?? sessionCtx.ChannelContext,
      senderName: normalizeOptionalString(sessionCtx.SenderName),
      senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
      senderE164: normalizeOptionalString(sessionCtx.SenderE164),
      // Queued system events are prompt content in the same trusted session;
      // they do not rewrite the sender identity used by command/action auth.
      senderIsOwner: command.senderIsOwner,
      traceAuthorized:
        command.senderIsOwner || (ctx.GatewayClientScopes ?? []).includes("operator.admin"),
      approvalReviewerDeviceId: normalizeOptionalString(ctx.ApprovalReviewerDeviceId),
      sessionFile: preparedSessionState.sessionFile,
      workspaceDir,
      cwd: normalizeOptionalString(sessionEntry?.spawnedCwd),
      config: cfg,
      skillsSnapshot,
      provider,
      model,
      modelSelectionLocked: preparedSessionState.sessionEntry?.modelSelectionLocked === true,
      hasSessionModelOverride: runHasSessionModelOverride,
      modelOverrideSource: runModelOverrideSource,
      hasAutoFallbackProvenance: runHasAutoFallbackProvenance || undefined,
      autoFallbackPrimaryProbe: params.autoFallbackPrimaryProbe,
      authProfileId,
      authProfileIdSource,
      thinkLevel: resolvedThinkLevel,
      ...(() => {
        if (useFastReplyRuntime) {
          return {
            fastMode: false,
            fastModeAutoOnSeconds: undefined,
            fastModeOverride: true,
          };
        }
        const fastModeState = resolveFastModeState({
          cfg,
          provider,
          model,
          agentId,
          sessionEntry: preparedSessionState.sessionEntry,
        });
        return {
          fastMode: params.resolvedFastMode ?? fastModeState.mode,
          fastModeAutoOnSeconds:
            params.resolvedFastModeAutoOnSeconds ?? fastModeState.fastAutoOnSeconds,
          ...(params.resolvedFastModeOverride ? { fastModeOverride: true } : {}),
          ...(params.resolvedFastModeAutoOnSecondsOverride
            ? { fastModeAutoOnSecondsOverride: true }
            : {}),
        };
      })(),
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      execOverrides,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
        fullAccessAvailable: fullAccessState.available,
        ...(fullAccessState.blockedReason
          ? { fullAccessBlockedReason: fullAccessState.blockedReason }
          : {}),
      },
      timeoutMs,
      runTimeoutOverrideMs: opts?.timeoutOverrideSeconds !== undefined ? timeoutMs : undefined,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers: command.ownerList.length > 0 ? command.ownerList : undefined,
      inputProvenance,
      ...(opts?.suppressNextUserMessagePersistence
        ? { suppressNextUserMessagePersistence: true }
        : {}),
      extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
      sourceReplyDeliveryMode,
      taskSuggestionDeliveryMode: opts?.taskSuggestionDeliveryMode,
      silentReplyPromptMode,
      extraSystemPromptStatic,
      cliSessionBindingFacts,
      skipProviderRuntimeHints: useFastReplyRuntime,
      allowEmptyAssistantReplyAsSilent,
      suppressTranscriptOnlyAssistantPersistence: isRoomEvent,
      ...(!useFastReplyRuntime &&
      isReasoningTagProvider(provider, {
        config: cfg,
        workspaceDir,
        modelId: model,
      })
        ? { enforceFinalTag: true }
        : {}),
    },
  };

  const replyThreadingOverride =
    isBareSessionReset && sessionCtx.ReplyThreading?.implicitCurrentMessage !== "deny"
      ? {
          ...sessionCtx.ReplyThreading,
          implicitCurrentMessage: "deny" as const,
        }
      : undefined;

  return runReplyAgent({
    commandBody: prefixedCommandBody,
    transcriptCommandBody,
    followupRun,
    queueKey,
    resolvedQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isRunActive: () => {
      const latestSessionState = resolvePreparedSessionState();
      const latestActiveSessionId =
        resolveActiveEmbeddedSessionId(latestSessionState.sessionFile) ??
        latestSessionState.sessionId;
      return embeddedAgentRuntime?.isEmbeddedAgentRunActive(latestActiveSessionId) ?? false;
    },
    isStreaming,
    opts,
    typing,
    sessionEntry: preparedSessionState.sessionEntry,
    sessionStore,
    sessionKey,
    runtimePolicySessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens: agentCfg?.contextTokens,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
    toolProgressDetail:
      normalizeToolProgressDetail(agentCfg?.toolProgressDetail) ??
      normalizeToolProgressDetail(cfg.agents?.defaults?.toolProgressDetail),
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
    resetTriggered: effectiveResetTriggered,
    replyThreadingOverride,
    replyOperation: providedReplyOperation,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
