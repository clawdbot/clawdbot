import { z } from "zod";
import { normalizeDiagnosticTraceparent } from "../../infra/diagnostic-trace-context-pure.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";

export const CONTINUATION_WORK_CONTROLLER_ID = "core/continuation-work";

const PendingWorkStateSchema = z.object({
  kind: z.literal("continuation_work"),
  sessionKey: z.string().min(1),
  hop: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  electedAt: z.number().int().nonnegative(),
  dueAt: z.number().int().nonnegative(),
  // Retry/recovery eligibility timestamp. `dueAt` remains the semantic maturity
  // time for anchored rows; recoveryDueAt only delays redelivery attempts.
  recoveryDueAt: z.number().int().nonnegative().optional(),
  maxChainLength: z.number().int().positive(),
  chainStartedAt: z.number().int().nonnegative().optional(),
  accumulatedChainTokens: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  parentRunId: z.string().optional(),
  chainId: z.string().optional(),
  traceparent: z.string().optional(),
  traceparentProvenance: z.literal("internal").optional(),
  // Finalization anchor + provenance. Origin identity is audit-only and must
  // stay separate from parentRunId so same-session work never becomes orphan-
  // reap eligible through its electing run.
  anchorPending: z.boolean().optional(),
  anchorFinalizedAt: z.number().int().nonnegative().optional(),
  originRunId: z.string().optional(),
  originTurnId: z.string().optional(),
  releasedAt: z.number().int().nonnegative().optional(),
  deliveredAt: z.number().int().nonnegative().optional(),
  turnGrantedAt: z.number().int().nonnegative().optional(),
  foldedAt: z.number().int().nonnegative().optional(),
  overdueByMs: z.number().int().nonnegative().optional(),
  disposition: z.enum(["granted", "folded-active"]).optional(),
  retryCount: z.number().int().nonnegative().optional(),
  // Consecutive PRE-drive busy-skip (requests-in-flight/draining/queue-busy)
  // count for diagnostics and rate state. DISTINCT from retryCount — a busy-skip
  // is a legit defer, never a failed attempt, so it must not feed the fail-bound.
  busySkipCount: z.number().int().nonnegative().optional(),
  // Event-driven busy retry: when a wake is blocked by an active turn or the
  // main lane, the row parks behind the matching idle event and keeps a slow
  // hedge timer only as loss recovery.
  idleRetry: z
    .object({
      trigger: z.enum(["reply-run-ended", "command-lane-idle"]),
      reasonCategory: z.enum(["follow-up-work", "wait-shaped", "unknown"]),
      armedAt: z.number().int().nonnegative(),
    })
    .optional(),
  // locus-3: durable delivered-mark written AFTER a wake is confirmed
  // delivered but BEFORE the persist-gap that precedes finishFlow. The
  // consume read-guard skips any flow carrying it so a crash in that window
  // never re-delivers (restart-gap dup cure). Two-axis legible: PRESENT=terminal.
  succeeded: z.object({ point: z.literal("optimal"), durability: z.literal("durable") }).optional(),
  // F1: durable obligation to surface a terminal outcome to the agent. Written
  // in the SAME expected-revision CAS that terminalizes the row, so a crash
  // between "the wake permanently failed" and "the agent was told" cannot lose
  // the notice — recovery re-reads this flag from the store. Cleared only after
  // the notice is handed to the durable session-delivery queue, which owns
  // delivery from that point (see work-terminal-notice.ts).
  terminalNoticePending: z.literal("retry-exhausted").optional(),
});

export type PendingWorkState = z.infer<typeof PendingWorkStateSchema>;

export type ContinuationWorkReasonCategory = "follow-up-work" | "wait-shaped" | "unknown";

export type PendingContinuationIdleRetry = {
  trigger: "reply-run-ended" | "command-lane-idle";
  reasonCategory: ContinuationWorkReasonCategory;
  armedAt: number;
};

export type PendingContinuationWork = {
  sessionKey: string;
  hop: number;
  delayMs: number;
  electedAt: number;
  dueAt: number;
  recoveryDueAt?: number;
  maxChainLength: number;
  chainStartedAt?: number;
  accumulatedChainTokens?: number;
  reason?: string;
  parentRunId?: string;
  chainId?: string;
  traceparent?: string;
  anchorPending?: boolean;
  anchorFinalizedAt?: number;
  originRunId?: string;
  originTurnId?: string;
  deliveredAt?: number;
  foldedAt?: number;
  overdueByMs?: number;
  disposition?: "granted" | "folded-active";
  retryCount?: number;
  // Consecutive busy-skip count for diagnostics/rate state. Distinct from
  // retryCount (the transient-error fail-bound). Never penalizes.
  busySkipCount?: number;
  idleRetry?: PendingContinuationIdleRetry;
  // locus-3: durable delivered-mark (see schema). PRESENT once a wake was
  // confirmed delivered; the consume read-guard refuses to re-drive it.
  succeeded?: { point: "optimal"; durability: "durable" };
  // F1: durable pending-notice obligation (see schema). PRESENT means the row
  // terminalized but the agent has not yet been told.
  terminalNoticePending?: "retry-exhausted";
  flowId?: string;
  expectedRevision?: number;
  // Durable flow status carried onto the runtime object by the store reader
  // ({@link workToRuntime}), sourced from the flow's PRE-claim status. The
  // fold-side write-guard needs this to tell a recovered `running`
  // turn (actively executing) from genuine `queued` backlog so a live turn is
  // never finished-as-superseded. Absent on freshly-constructed enqueue inputs;
  // only store reads populate it.
  status?: "queued" | "running";
};

export function isContinuationWorkFlow(flow: TaskFlowRecord): boolean {
  return flow.syncMode === "managed" && flow.controllerId === CONTINUATION_WORK_CONTROLLER_ID;
}

export function isRecoverableWorkFlow(flow: TaskFlowRecord): boolean {
  return isContinuationWorkFlow(flow) && (flow.status === "queued" || flow.status === "running");
}

export function decodeWorkState(flow: TaskFlowRecord): PendingWorkState | undefined {
  const parsed = PendingWorkStateSchema.safeParse(flow.stateJson);
  return parsed.success ? parsed.data : undefined;
}

export function encodeWorkState(work: PendingContinuationWork): PendingWorkState {
  const traceparent = normalizeDiagnosticTraceparent(work.traceparent);
  return {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    ...(work.recoveryDueAt !== undefined ? { recoveryDueAt: work.recoveryDueAt } : {}),
    maxChainLength: work.maxChainLength,
    ...(work.chainStartedAt !== undefined ? { chainStartedAt: work.chainStartedAt } : {}),
    ...(work.accumulatedChainTokens !== undefined
      ? { accumulatedChainTokens: work.accumulatedChainTokens }
      : {}),
    ...(work.reason ? { reason: work.reason } : {}),
    ...(work.parentRunId ? { parentRunId: work.parentRunId } : {}),
    ...(work.chainId ? { chainId: work.chainId } : {}),
    ...(traceparent ? { traceparent, traceparentProvenance: "internal" as const } : {}),
    ...(work.originRunId ? { originRunId: work.originRunId } : {}),
    ...(work.originTurnId ? { originTurnId: work.originTurnId } : {}),
    // a continue_work captured during an active turn parks on the
    // end-of-turn lifecycle event from the moment it is enqueued, so the marker
    // must survive the durable write (not just live on the runtime object).
    // Anchors persist too so delayed work remains tied to the electing turn's
    // finalization across gateway restart.
    ...(work.anchorPending !== undefined ? { anchorPending: work.anchorPending } : {}),
    ...(work.anchorFinalizedAt !== undefined ? { anchorFinalizedAt: work.anchorFinalizedAt } : {}),
    ...(work.busySkipCount !== undefined ? { busySkipCount: work.busySkipCount } : {}),
    ...(work.idleRetry ? { idleRetry: work.idleRetry } : {}),
  };
}

export function buildFallbackWorkState(work: PendingContinuationWork): PendingWorkState {
  return {
    kind: "continuation_work",
    sessionKey: work.sessionKey,
    hop: work.hop,
    delayMs: work.delayMs,
    electedAt: work.electedAt,
    dueAt: work.dueAt,
    ...(work.recoveryDueAt !== undefined ? { recoveryDueAt: work.recoveryDueAt } : {}),
    maxChainLength: work.maxChainLength,
    ...(work.anchorPending !== undefined ? { anchorPending: work.anchorPending } : {}),
    ...(work.anchorFinalizedAt !== undefined ? { anchorFinalizedAt: work.anchorFinalizedAt } : {}),
    ...(work.originRunId ? { originRunId: work.originRunId } : {}),
    ...(work.originTurnId ? { originTurnId: work.originTurnId } : {}),
  };
}

export function workGoal(work: PendingContinuationWork): string {
  const reason = work.reason?.trim();
  return reason ? `Continuation work: ${reason.slice(0, 80)}` : "Continuation work";
}

export function workToRuntime(
  flow: TaskFlowRecord,
  state: PendingWorkState,
  status: "queued" | "running",
): PendingContinuationWork {
  return {
    sessionKey: state.sessionKey,
    hop: state.hop,
    delayMs: state.delayMs,
    electedAt: state.electedAt,
    dueAt: state.dueAt,
    ...(state.recoveryDueAt !== undefined ? { recoveryDueAt: state.recoveryDueAt } : {}),
    maxChainLength: state.maxChainLength,
    ...(state.chainStartedAt !== undefined ? { chainStartedAt: state.chainStartedAt } : {}),
    ...(state.accumulatedChainTokens !== undefined
      ? { accumulatedChainTokens: state.accumulatedChainTokens }
      : {}),
    ...(state.reason ? { reason: state.reason } : {}),
    ...(state.parentRunId ? { parentRunId: state.parentRunId } : {}),
    ...(state.chainId ? { chainId: state.chainId } : {}),
    ...(state.traceparent && state.traceparentProvenance === "internal"
      ? { traceparent: state.traceparent }
      : {}),
    ...(state.anchorPending !== undefined ? { anchorPending: state.anchorPending } : {}),
    ...(state.anchorFinalizedAt !== undefined
      ? { anchorFinalizedAt: state.anchorFinalizedAt }
      : {}),
    ...(state.originRunId ? { originRunId: state.originRunId } : {}),
    ...(state.originTurnId ? { originTurnId: state.originTurnId } : {}),
    ...(state.deliveredAt !== undefined ? { deliveredAt: state.deliveredAt } : {}),
    ...(state.foldedAt !== undefined ? { foldedAt: state.foldedAt } : {}),
    ...(state.overdueByMs !== undefined ? { overdueByMs: state.overdueByMs } : {}),
    ...(state.disposition !== undefined ? { disposition: state.disposition } : {}),
    ...(state.retryCount !== undefined ? { retryCount: state.retryCount } : {}),
    ...(state.busySkipCount !== undefined ? { busySkipCount: state.busySkipCount } : {}),
    ...(state.idleRetry ? { idleRetry: state.idleRetry } : {}),
    ...(state.succeeded ? { succeeded: state.succeeded } : {}),
    ...(state.terminalNoticePending ? { terminalNoticePending: state.terminalNoticePending } : {}),
    status,
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  };
}
