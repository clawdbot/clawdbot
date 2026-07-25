import type { SubagentEndReason } from "../context-engine/types.js";
/** Persisted execution, completion, delivery, and attachment state for child runs. */
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import type { SubagentLaunchAuthorization } from "./subagent-launch-authorization.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export type SubagentCompletionRequest = {
  runId: string;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
  startedAt?: number;
  suppressSessionEffects?: boolean;
  recoverInterrupted?: true;
  completionSnapshot?: { resultText: string | null; capturedAt: number };
};

export type ContextEngineSubagentEndedParams = {
  childSessionKey: string;
  reason: SubagentEndReason;
  agentDir?: string;
  workspaceDir?: string;
};

export type SubagentProgressOrigin = {
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  channelId?: string | number;
  messageId?: string | number;
};

export type PendingFinalDeliveryPayload = {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  childSessionKey: string;
  childRunId: string;
  task: string;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  expectsCompletionMessage?: boolean;
  spawnMode?: SpawnSubagentMode;
  frozenResultText?: string | null;
  fallbackFrozenResultText?: string | null;
  wakeOnDescendantSettle?: boolean;
};

export type SubagentExecutionState = {
  status: "queued" | "running" | "interrupted" | "terminal";
  acceptedAt?: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  interruptedAt?: number;
  interruptionReason?: "gateway-restart" | "lost-execution-context";
  transcriptTarget?: AgentRunSessionTarget;
};

export type SubagentCompletionState = {
  required: boolean;
  resultText?: string | null;
  capturedAt?: number;
  fallbackResultText?: string | null;
  fallbackCapturedAt?: number;
};

export type SwarmCollectorStatus = "done" | "failed" | "killed" | "timeout";

type SwarmCollectorCompletion = {
  status: SwarmCollectorStatus;
  structured?: unknown;
  schemaError?: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export type SwarmStructuredOutputState = {
  structured?: unknown;
  schemaError?: string;
  invalidAttempts: number;
};

export type SwarmQueuedLaunch = {
  request: Record<string, unknown>;
  /** Exact trusted launch capability, persisted so restart replay cannot lose it. */
  authorization?: SubagentLaunchAuthorization;
  timeoutMs: number;
  schedulerGroupKey: string;
  maxConcurrent: number;
};

export type SubagentCompletionDeliveryState = {
  status:
    | "not_required"
    | "pending"
    | "in_progress"
    | "delivered"
    | "failed"
    | "suspended"
    | "discarded";
  payload?: PendingFinalDeliveryPayload;
  createdAt?: number;
  enqueuedAt?: number;
  deliveredAt?: number;
  announcedAt?: number;
  lastAttemptAt?: number;
  attemptCount?: number;
  lastError?: string | null;
  steeringLeaseId?: string;
  steeringLeasedAt?: number;
  steeringInjectedAt?: number;
  suspendedAt?: number;
  suspendedReason?: "retry-limit" | "expiry";
  discardedAt?: number;
  discardReason?: "expired" | "pressure-pruned";
  discardedPayloadSummary?: {
    requesterSessionKey?: string;
    childSessionKey?: string;
    childRunId?: string;
    endedAt?: number;
    status?: string;
    lastError?: string | null;
  };
  lastDropReason?:
    | "queue_cap"
    | "parent_run_ended"
    | "sink_unavailable"
    | "dedupe"
    | "waiting_for_requester_turn";
};

/** Durable outbox state for the top-level requester settle wake. */
export type RequesterSettleWakeState = {
  status: "pending" | "dispatching";
  /** Number of delivery attempts already admitted. */
  attemptCount: number;
  /** Ambiguous transport replays made with the current idempotency key. */
  replayCount?: number;
  /** Persisted retry deadline; restore waits until this instant. */
  nextAttemptAt?: number;
  /** Frozen wave membership after delivery admission or requester-yield re-admission. */
  batchRunIds?: string[];
  /** Batch frozen while its spawning requester turn was yielding. */
  requesterYieldBatch?: true;
  /** Present only when an idle requester needs a new turn after yielding. */
  afterRequesterYield?: true;
  /** Monotonic process generation protecting a newer yield from stale completion. */
  rearmGeneration?: number;
  lastError?: string | null;
  /** Cleanup wanted to retire this row; defer deletion until the outbox resolves. */
  retireAfterSettle?: boolean;
};

type SubagentKillReconciliationState = {
  /** Actual cancellation time; a yielded run may have an older execution end. */
  killedAt: number;
  /** Requester aborts must not re-inject a delayed completion after queues are cleared. */
  suppressTaskDelivery?: boolean;
  /** Durable ownership boundary even after the newer registry row is released. */
  supersededAt?: number;
};

export type SubagentRunRecord = {
  runId: string;
  /** Detached task owner; steer/restart changes runId but continues the same task. */
  taskRunId?: string;
  /** Requester attempt that must settle before this completion row can retire. */
  requesterTurnRunId?: string;
  /** Durable proof that this requester attempt invoked sessions_yield. */
  requesterTurnYielded?: true;
  /** Cleanup retirement deferred until requesterTurnRunId settles. */
  retireAfterRequesterTurn?: boolean;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  /** Durable source locator for transport-neutral progress presentation. */
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  /** Effective requester agent, including cron/hook overrides not encoded in the session key. */
  requesterAgentId?: string;
  task: string;
  taskName?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  spawnMode?: SpawnSubagentMode;
  /** Monotonic ownership generation within one child session. */
  generation?: number;
  createdAt: number;
  startedAt?: number;
  sessionStartedAt?: number;
  accumulatedRuntimeMs?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  suppressAnnounceReason?: "steer-restart" | "killed";
  /** Sticky owner while restart recovery replays this exact terminal run. */
  terminalOwner?: "interrupted-recovery";
  /** Present only while a current-version killed run awaits bounded reconciliation. */
  killReconciliation?: SubagentKillReconciliationState;
  /** Durable requester-stop policy until silent completion cleanup finishes. */
  suppressCompletionDelivery?: boolean;
  expectsCompletionMessage?: boolean;
  endedReason?: SubagentLifecycleEndedReason;
  pauseReason?: "sessions_yield";
  wakeOnDescendantSettle?: boolean;
  execution?: SubagentExecutionState;
  completion?: SubagentCompletionState;
  /** Set after the subagent_ended hook has been emitted successfully once. */
  endedHookEmittedAt?: number;
  /** Set after cleanupBrowserSessionsForLifecycleEnd has been dispatched once. */
  browserCleanupDispatchedAt?: number;
  /** Set immediately before irreversible sessions.delete cleanup is dispatched. */
  deleteCleanupDispatchedAt?: number;
  /** Durable outbox marker for parent/external completion delivery. */
  delivery?: SubagentCompletionDeliveryState;
  /** Durable top-level requester wake obligation, replayed after restart. */
  requesterSettleWake?: RequesterSettleWakeState;
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  /** Collector-mode runs remain waitable and never announce to the requester. */
  collect?: boolean;
  /** Stable spawning-session owner for caps, scheduling, and wait authorization. */
  swarmRequesterSessionKey?: string;
  /** Spawner plus ancestor sessions authorized to wait, frozen when the collector is registered. */
  swarmWaitOwnerSessionKeys?: string[];
  /** Stable public collector id; gateway execution ids can change across dispatch/recovery. */
  swarmRunId?: string;
  /** Stable scheduler slot identity across gateway-assigned run id replacements. */
  schedulerSlotId?: string;
  /** Exact host-reserved Gateway request identity for the current collector turn. */
  swarmLaunchIdempotencyKey?: string;
  /** Replay-safe host bridge identity used to recover a collector after restart. */
  swarmLaunchReplayKey?: string;
  /** Canonical collector request hash paired with a host-reserved launch identity. */
  swarmLaunchRequestFingerprint?: string;
  /** True only between host reservation and accepted Gateway dispatch. */
  swarmLaunchPending?: boolean;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  structuredOutput?: SwarmStructuredOutputState;
  queuedLaunch?: SwarmQueuedLaunch;
  /** Durable retry obligation for a prepared collector session whose launch failed. */
  collectorLaunchCleanupPending?: boolean;
  /** Set after failed-launch context-engine cleanup succeeds, preventing duplicate end hooks. */
  contextEngineCleanupCompletedAt?: number;
  collectorCompletion?: SwarmCollectorCompletion;
};
