import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Shared queue type contracts for admission, drain, and fallback handling.
import type { AutoFallbackPrimaryProbe } from "../../../agents/agent-scope.js";
import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { CliSessionBindingFacts } from "../../../agents/cli-runner/types.js";
import type { CurrentInboundPromptContext } from "../../../agents/embedded-agent-runner/run/params.js";
import type { SilentReplyPromptMode } from "../../../agents/system-prompt.types.js";
import type { ChatType } from "../../../channels/chat-type.js";
import type { InboundEventKind } from "../../../channels/inbound-event/kind.js";
import type { SessionEntry } from "../../../config/sessions.js";
import type { ReplyToMode } from "../../../config/types.base.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { PluginHookChannelContext } from "../../../plugins/hook-types.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import type { SkillSnapshot } from "../../../skills/types.js";
import type {
  QueuedReplyDeliveryCorrelation,
  QueuedReplyLifecycle,
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../../get-reply-options.types.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../directives.js";

export type QueueMode = "steer" | "followup" | "collect" | "interrupt";

export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type QueueDedupeMode = "message-id" | "prompt" | "none";

export type QueueInsertPosition = "tail" | "front";

export type EnqueueFollowupRunOptions = {
  position?: QueueInsertPosition;
};

export class FollowupRunDeferredError extends Error {
  constructor(message = "Follow-up run deferred") {
    super(message);
    this.name = "FollowupRunDeferredError";
  }
}

export function isFollowupRunDeferredError(error: unknown): error is FollowupRunDeferredError {
  return error instanceof FollowupRunDeferredError;
}

export type FollowupRun = {
  prompt: string;
  /** Latest session to claim without rewriting the queued run before store refresh. */
  admissionSessionId?: string;
  /** User-visible prompt body persisted to transcript; excludes runtime-only prompt context. */
  transcriptPrompt?: string;
  /** Shared lifecycle owner for the current user-turn transcript append. */
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder;
  currentInboundEventKind?: InboundEventKind;
  /** Native inbound event timestamp in epoch milliseconds, when the transport provides one. */
  currentInboundEventTimestampMs?: number;
  /** Whether the current inbound message contained audio for inbound-only TTS policy. */
  currentInboundAudio?: boolean;
  /** Explicit current-turn context that should be visible for this run but not persisted as user text. */
  currentInboundContext?: CurrentInboundPromptContext;
  /** Abort signal for turns that are canceled by their source-channel admission fence. */
  abortSignal?: AbortSignal;
  /** Queue-owned cancellation fence used when lifecycle cleanup invalidates pending work. */
  queueAbortSignal?: AbortSignal;
  deliveryCorrelations?: QueuedReplyDeliveryCorrelation[];
  queuedLifecycle?: QueuedReplyLifecycle;
  /** Dispatch-scoped freshness owner for a queued delivery-barrier wait. */
  onFollowupAdmissionWaitChange?: (waiting: boolean) => void;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  /** Force individual drain; never merge this run into a collect batch. */
  disableCollectBatching?: boolean;
  /** Internal marker for the one-shot stranded final recovery retry. */
  strandedReplyRetry?: boolean;
  /** Preserve priority runs when old-item queue overflow eviction runs before drain. */
  protectFromQueueOverflow?: boolean;
  enqueuedAt: number;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder?: PromptImageOrderEntry[];
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using the session's lastChannel.
   */
  originatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  originatingTo?: string;
  /** Transport-native chat/conversation ID for hook identity context. */
  originatingChatId?: string;
  /** Provider account id (multi-account). */
  originatingAccountId?: string;
  /** Thread id for reply routing (Telegram topic id or Matrix thread event id). */
  originatingThreadId?: string | number;
  /** Provider reply target for transports that model threads as message replies. */
  originatingReplyToId?: string;
  /** Effective reply policy for deciding whether the reply target affects queued delivery. */
  originatingReplyToMode?: ReplyToMode;
  /** Chat type for context-aware threading (e.g., DM vs channel). */
  originatingChatType?: string;
  run: {
    agentId: string;
    agentDir: string;
    sessionId: string;
    sessionKey?: string;
    runtimePolicySessionKey?: string;
    messageProvider?: string;
    clientCaps?: string[];
    chatType?: ChatType;
    agentAccountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    /** Parent session provenance used to validate inherited group policy. */
    spawnedBy?: string;
    senderId?: string;
    channelContext?: PluginHookChannelContext;
    senderName?: string;
    senderUsername?: string;
    senderE164?: string;
    senderIsOwner?: boolean;
    traceAuthorized?: boolean;
    approvalReviewerDeviceId?: string;
    sessionFile: string;
    workspaceDir: string;
    /** Task working directory for runtime execution. Defaults to workspaceDir. */
    cwd?: string;
    config: OpenClawConfig;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    /** Prevents the queued run from selecting configured fallback models. */
    modelSelectionLocked?: boolean;
    hasSessionModelOverride?: boolean;
    modelOverrideSource?: "auto" | "user";
    hasAutoFallbackProvenance?: boolean;
    autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    thinkLevel?: ThinkLevel;
    fastMode?: FastMode;
    fastModeAutoOnSeconds?: number;
    fastModeOverride?: boolean;
    fastModeAutoOnSecondsOverride?: boolean;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    elevatedLevel?: ElevatedLevel;
    execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node" | "nodeCwd">;
    bashElevated?: {
      enabled: boolean;
      allowed: boolean;
      defaultLevel: ElevatedLevel;
    };
    timeoutMs: number;
    runTimeoutOverrideMs?: number;
    blockReplyBreak: "text_end" | "message_end";
    ownerNumbers?: string[];
    inputProvenance?: InputProvenance;
    extraSystemPrompt?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
    silentReplyPromptMode?: SilentReplyPromptMode;
    extraSystemPromptStatic?: string;
    cliSessionBindingFacts?: CliSessionBindingFacts;
    enforceFinalTag?: boolean;
    skipProviderRuntimeHints?: boolean;
    silentExpected?: boolean;
    allowEmptyAssistantReplyAsSilent?: boolean;
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    drainsContinuationDelegateQueue?: boolean;
    traceparent?: string;
  };
};

export function isFollowupRunAborted(
  run: Pick<FollowupRun, "abortSignal" | "queueAbortSignal">,
): boolean {
  return run.abortSignal?.aborted === true || run.queueAbortSignal?.aborted === true;
}

const enqueuedFollowupLifecycles = new WeakSet<QueuedReplyLifecycle>();
const admittedFollowupLifecycles = new WeakSet<QueuedReplyLifecycle>();
const admittingFollowupLifecycles = new WeakMap<QueuedReplyLifecycle, Promise<void>>();
const retiredFollowupCancellationLifecycles = new WeakSet<QueuedReplyLifecycle>();
const completedFollowupLifecycles = new WeakSet<QueuedReplyLifecycle>();
const completedFollowupLifecycleCallbacks = new WeakSet<QueuedReplyLifecycle>();

export function markFollowupRunEnqueued(run: Pick<FollowupRun, "queuedLifecycle">): boolean {
  const lifecycle = run.queuedLifecycle;
  if (!lifecycle || enqueuedFollowupLifecycles.has(lifecycle)) {
    return true;
  }
  if (lifecycle.onEnqueued?.() === false) {
    return false;
  }
  enqueuedFollowupLifecycles.add(lifecycle);
  return true;
}

export function retireFollowupRunCancellation(run: Pick<FollowupRun, "queuedLifecycle">): void {
  const lifecycle = run.queuedLifecycle;
  if (!lifecycle || retiredFollowupCancellationLifecycles.has(lifecycle)) {
    return;
  }
  retiredFollowupCancellationLifecycles.add(lifecycle);
  lifecycle.onCancellationRetired?.();
}

export async function admitFollowupRunLifecycle(
  run: Pick<FollowupRun, "queuedLifecycle">,
): Promise<void> {
  const lifecycle = run.queuedLifecycle;
  if (!lifecycle || admittedFollowupLifecycles.has(lifecycle)) {
    return;
  }
  const existing = admittingFollowupLifecycles.get(lifecycle);
  if (existing) {
    await existing;
    return;
  }
  if (completedFollowupLifecycles.has(lifecycle)) {
    throw new Error("followup run lifecycle completed before admission");
  }
  const admission = Promise.resolve()
    .then(async () => await lifecycle.onAdmitted?.())
    .then(() => {
      admittedFollowupLifecycles.add(lifecycle);
    });
  admittingFollowupLifecycles.set(lifecycle, admission);
  try {
    await admission;
  } finally {
    admittingFollowupLifecycles.delete(lifecycle);
  }
}

export function completeFollowupRunLifecycle(run: Pick<FollowupRun, "queuedLifecycle">): void {
  const lifecycle = run.queuedLifecycle;
  if (!lifecycle || completedFollowupLifecycles.has(lifecycle)) {
    return;
  }
  completedFollowupLifecycles.add(lifecycle);
  const finish = () => {
    if (completedFollowupLifecycleCallbacks.has(lifecycle)) {
      return;
    }
    completedFollowupLifecycleCallbacks.add(lifecycle);
    lifecycle.onComplete?.();
  };
  const admission = admittingFollowupLifecycles.get(lifecycle);
  if (!admission) {
    finish();
    return;
  }
  // Completion closes future admission immediately, but the callback waits for
  // the in-flight admission attempt so adoption and abandonment cannot race.
  void admission.then(finish, finish).catch(() => {});
}

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
  pluginDebounceMs?: number;
};
