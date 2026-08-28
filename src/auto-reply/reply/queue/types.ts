import type { FastMode } from "@openclaw/normalization-core/string-coerce";
// Shared queue type contracts for admission, drain, and fallback handling.
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { AutoFallbackPrimaryProbe } from "../../../agents/agent-scope.js";
import type { ExecToolDefaults } from "../../../agents/bash-tools.js";
import type { CliSessionBindingFacts } from "../../../agents/cli-runner/types.js";
import type {
  CurrentInboundPromptContext,
  RunEmbeddedAgentParams,
} from "../../../agents/embedded-agent-runner/run/params.js";
import type { ModelFallbackRouteResolution } from "../../../agents/model-fallback.types.js";
import type { ScheduledToolPolicyContext } from "../../../agents/scheduled-tool-policy.js";
import type { TrustedSubagentCompletionHandoff } from "../../../agents/subagents/announce/subagent-announce-handoff.js";
import type { SilentReplyPromptMode } from "../../../agents/system-prompt.types.js";
import type { ChatType } from "../../../channels/chat-type.js";
import type { InboundEventKind } from "../../../channels/inbound-event/kind.js";
import type { ChannelAdmissionEvidence } from "../../../channels/message-access/admission-evidence.js";
import type { SessionEntry, SessionToolOverrides } from "../../../config/sessions.js";
import type { ReplyToMode } from "../../../config/types.base.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
import type { MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { PluginHookChannelContext } from "../../../plugins/hook-types.js";
import type { RuntimePluginToolGrant } from "../../../plugins/runtime/tool-grant.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import type { ExplicitSkillSelection, SkillSnapshot } from "../../../skills/types.js";
import type { SkillWorkshopProposalRevisionConstraint } from "../../../skills/workshop/types.js";
import type {
  QueuedReplyDeliveryCorrelation,
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
  TurnAdoptionLifecycle,
} from "../../get-reply-options.types.js";
import type { ReplyPayload } from "../../reply-payload.js";
import type { OriginatingChannelType } from "../../templating.js";
import type { ThinkingCatalogEntry } from "../../thinking.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../directives.js";
import { releaseRecentQueueMessageId } from "./recent-message-ids.js";

export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
  pluginDebounceMs?: number;
};

export type QueueDedupeMode = "message-id" | "prompt" | "none";

type QueueInsertPosition = "tail" | "front";

export type EnqueueFollowupRunOptions = {
  position?: QueueInsertPosition;
  steerCandidate?: boolean;
  /** Skip the durable write so the caller can persist a larger atomic mutation. */
  deferPersist?: boolean;
  /**
   * When set with `deferPersist`, overflow and reject completions are appended
   * here instead of running immediately so the caller can roll back on persist
   * failure.
   */
  collectDeferredDrops?: FollowupRun[];
};

export type FollowupQueueDisposition = "queue-cap" | "queue-cap-old" | "queue-cap-new";

export type QueuedFollowupReplyBatch = {
  kind: "queued-followup";
  runId: string;
  originatingChannel: string | undefined;
  payloads: ReplyPayload[];
};

type QueuedFollowupReplyDisposition =
  | { kind: "deliver"; deliver: (batch: QueuedFollowupReplyBatch) => Promise<void> | void }
  | { kind: "drop"; reason: "source-unavailable" };

export class FollowupRunDeferredError extends Error {
  constructor(message = "Follow-up run deferred") {
    super(message);
    this.name = "FollowupRunDeferredError";
  }
}

export function isFollowupRunDeferredError(error: unknown): error is FollowupRunDeferredError {
  return error instanceof FollowupRunDeferredError;
}

export class FollowupTerminalDeliveryError extends Error {
  constructor(
    message = "Follow-up terminal delivery failed after execution",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "FollowupTerminalDeliveryError";
  }
}

export function isFollowupTerminalDeliveryError(
  error: unknown,
): error is FollowupTerminalDeliveryError {
  return error instanceof FollowupTerminalDeliveryError;
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
  /** Whether the current inbound message contained audio for inbound-only TTS policy. */
  currentInboundAudio?: boolean;
  /** Host-minted participant evidence; raw channel identities never live on this object. */
  channelAdmissionEvidence?: ChannelAdmissionEvidence;
  /** Explicit current-turn context that should be visible for this run but not persisted as user text. */
  currentInboundContext?: CurrentInboundPromptContext;
  /** Explicit skills resolved from the authenticated inbound message. */
  explicitSkillSelections?: ExplicitSkillSelection[];
  /** Abort signal for turns that are canceled by their source-channel admission fence. */
  abortSignal?: AbortSignal;
  /** Queue-owned cancellation fence used when lifecycle cleanup invalidates pending work. */
  queueAbortSignal?: AbortSignal;
  /**
   * Durable fail-closed tombstone for in-process cancellation. Abort signals are
   * not serialized; restore skips these rows instead of replaying canceled work.
   */
  canceled?: true;
  /**
   * Durable completion tombstone written after channel delivery succeeds and
   * before the row is omitted. Restore fail-closes these items so a crash
   * between send and acknowledgement cannot replay the follow-up.
   */
  delivered?: true;
  /**
   * Durable fail-closed tombstone written after execution when terminal
   * delivery failed. Restore skip these rows instead of replaying side effects.
   */
  discarded?: true;
  deliveryCorrelations?: QueuedReplyDeliveryCorrelation[];
  /** Canonical ownership lifecycle for durable ingress / reply-lane transfer. */
  turnAdoptionLifecycle?: TurnAdoptionLifecycle;
  /** Records terminal queue-cap outcomes at the queue owner before lifecycle cleanup. */
  onQueueDisposition?: (disposition: FollowupQueueDisposition) => void;
  /** Keep delivery bound to the source that owned admission, not later runner defaults. */
  queuedFollowupReplyDisposition?: QueuedFollowupReplyDisposition;
  /** Provider message ID, when available (for deduplication). */
  messageId?: string;
  summaryLine?: string;
  /** Turn-owned tool authority captured before queue ownership transfers. */
  toolsAllow?: string[];
  disableTools?: boolean;
  /** Force individual drain; never merge this run into a collect batch. */
  disableCollectBatching?: boolean;
  /** The current-turn hook already ran before this steer became a fallback. */
  /** Pending same-turn acceptance while this item remains parked in FIFO order. */
  steerPending?: {
    predecessor: Promise<boolean>;
    settle: (accepted: boolean) => void;
  };
  /** Preserves this candidate's position ahead of overflow summaries. */
  steerAnchor?: true;
  /** Internal marker for the one-shot stranded final recovery retry. */
  strandedReplyRetry?: boolean;
  /** Preserve priority runs when old-item queue overflow eviction runs before drain. */
  protectFromQueueOverflow?: boolean;
  enqueuedAt: number;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  imageOrder?: PromptImageOrderEntry[];
  /** Ordered facts represented by attachment text in this prompt. */
  media?: MediaFact[];
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
    toolBindings?: Readonly<Record<string, unknown>>;
    chatType?: ChatType;
    agentAccountId?: string;
    conversationToolPolicy?: GroupToolPolicyConfig;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    memberRoleIds?: string[];
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
    permissionMode?: SessionEntry["permissionMode"];
    sessionRoot?: string;
    config: OpenClawConfig;
    toolOverrides?: SessionToolOverrides;
    skillsSnapshot?: SkillSnapshot;
    provider: string;
    model: string;
    requestedRouteResolution?: ModelFallbackRouteResolution;
    /** Prevents the queued run from selecting configured fallback models. */
    modelSelectionLocked?: boolean;
    hasSessionModelOverride?: boolean;
    modelOverrideSource?: "auto" | "user";
    hasAutoFallbackProvenance?: boolean;
    autoFallbackPrimaryProbe?: AutoFallbackPrimaryProbe;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
    /** Prepared model metadata reused when fallbacks revalidate the immutable thinking request. */
    thinkingCatalog?: ThinkingCatalogEntry[];
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
    /** Trusted authority facts that must survive queueing and steering admission. */
    trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
    scheduledToolPolicy?: ScheduledToolPolicyContext;
    runtimePluginToolGrant?: RuntimePluginToolGrant;
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
    terminalReplyExpectation?: RunEmbeddedAgentParams["terminalReplyExpectation"];
    suppressNextUserMessagePersistence?: boolean;
    suppressTranscriptOnlyAssistantPersistence?: boolean;
    /** Gateway-private optimistic-concurrency constraint for an operator-requested proposal revision. */
    skillWorkshopProposalRevision?: SkillWorkshopProposalRevisionConstraint;
  };
};

/**
 * Canonical runtime shape for active, pending, and restored follow-up queues.
 * Runtime-only fields (abortController, inFlight, activeSummarySources) are
 * reconstructed fresh when persistence restores queue state from disk.
 */
export type FollowupQueueState = {
  abortController: AbortController;
  items: FollowupRun[];
  draining: boolean;
  /** Identities retained in `items` while delivery awaits; pending cap and depth must exclude them. */
  inFlight: Set<FollowupRun>;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  summarySources: FollowupRun[];
  /** Serializes parked steer acceptance so later parked candidates wait their turn. */
  steerAcceptanceTail: Promise<boolean>;
  /** Sources currently used by an async summary delivery cannot be evicted mid-run. */
  activeSummarySources: WeakSet<FollowupRun>;
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    /** Compact sources stay strong so cancellation follows summarized content until delivery. */
    sources: FollowupRun[];
    /** Summary lines stay index-aligned with sources across context isolation and eviction. */
    summaryLines: string[];
    /** Weak source mapping keeps concurrent summary consumption identity-safe. */
    sourceRefs: WeakMap<FollowupRun, FollowupRun>;
  }>;
  evictedSummaryCount: number;
  lastRun?: FollowupRun["run"];
};

export function isFollowupRunAborted(
  run: Pick<FollowupRun, "abortSignal" | "queueAbortSignal">,
): boolean {
  return run.abortSignal?.aborted === true || run.queueAbortSignal?.aborted === true;
}

export function resolveFollowupAbortSignal(
  run: Pick<FollowupRun, "abortSignal" | "queueAbortSignal">,
): AbortSignal | undefined {
  const signals = [run.abortSignal, run.queueAbortSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

const enqueuedTurnAdoptionLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const admittedTurnAdoptionLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const admittingTurnAdoptionLifecycles = new WeakMap<TurnAdoptionLifecycle, Promise<void>>();
const retiredTurnAdoptionCancellationLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const completedTurnAdoptionLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const completedTurnAdoptionLifecycleCallbacks = new WeakSet<TurnAdoptionLifecycle>();

type FollowupLifecycleRun = Pick<FollowupRun, "steerPending" | "turnAdoptionLifecycle">;

export function markFollowupRunEnqueued(run: FollowupLifecycleRun): boolean {
  const lifecycle = run.turnAdoptionLifecycle;
  if (lifecycle && !enqueuedTurnAdoptionLifecycles.has(lifecycle)) {
    if (lifecycle.onDeferred?.() === false) {
      return false;
    }
    enqueuedTurnAdoptionLifecycles.add(lifecycle);
  }
  return true;
}

export function retireFollowupRunCancellation(run: FollowupLifecycleRun): void {
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle || retiredTurnAdoptionCancellationLifecycles.has(lifecycle)) {
    return;
  }
  retiredTurnAdoptionCancellationLifecycles.add(lifecycle);
  lifecycle.onCancellationRetired?.();
}

export async function admitFollowupRunLifecycle(run: FollowupLifecycleRun): Promise<void> {
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle || admittedTurnAdoptionLifecycles.has(lifecycle)) {
    return;
  }
  const existing = admittingTurnAdoptionLifecycles.get(lifecycle);
  if (existing) {
    await existing;
    return;
  }
  if (completedTurnAdoptionLifecycles.has(lifecycle)) {
    throw new Error("followup run lifecycle completed before admission");
  }

  const admission = Promise.resolve().then(async () => {
    if (!admittedTurnAdoptionLifecycles.has(lifecycle)) {
      await lifecycle.onAdopted();
      admittedTurnAdoptionLifecycles.add(lifecycle);
    }
  });

  admittingTurnAdoptionLifecycles.set(lifecycle, admission);
  try {
    await admission;
  } finally {
    admittingTurnAdoptionLifecycles.delete(lifecycle);
  }
}

export function completeFollowupRunLifecycle(run: FollowupLifecycleRun): void {
  run.steerPending?.settle(false);
  const lifecycle = run.turnAdoptionLifecycle;

  const finish = () => {
    if (!lifecycle || completedTurnAdoptionLifecycleCallbacks.has(lifecycle)) {
      return;
    }
    completedTurnAdoptionLifecycleCallbacks.add(lifecycle);
    // Async onAbandoned work must contain its own rejections; core guarantees a
    // non-rejecting promise. onSettled must still run after a synchronous throw.
    try {
      if (!admittedTurnAdoptionLifecycles.has(lifecycle)) {
        // The queue is relinquishing an un-admitted message: free its dedupe
        // identity so the abandonment-triggered ingress retry can re-enqueue
        // instead of being rejected as a recent duplicate and falsely completed.
        releaseRecentQueueMessageId(run);
        lifecycle.onAbandoned?.();
      }
    } finally {
      lifecycle.onSettled?.();
    }
  };

  if (lifecycle && !completedTurnAdoptionLifecycles.has(lifecycle)) {
    completedTurnAdoptionLifecycles.add(lifecycle);
  }

  const admission = lifecycle ? admittingTurnAdoptionLifecycles.get(lifecycle) : undefined;
  if (!admission) {
    finish();
    return;
  }
  // Completion closes future admission immediately, but the callback waits for
  // the in-flight admission attempt so adoption and abandonment cannot race.
  void admission.then(finish, finish).catch(() => {});
}
