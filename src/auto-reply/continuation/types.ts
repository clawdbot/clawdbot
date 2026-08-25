/**
 * Core type definitions for the continuation system.
 *
 * RFC: docs/design/continue-work-signal-v2.md
 *
 * These types are shared across signal parsing, scheduling, delegate dispatch,
 * state persistence, and tool definitions. They represent the contracts that
 * the rest of the continuation surface is built on.
 */

import type { InlineAttachment, InlineAttachmentMount } from "../../shared/inline-attachments.js";
import type {
  ContinuationCrossSessionTargetingPolicy,
  ContinuationDelegateFanoutMode,
} from "./targeting-pure.js";

type ContinuationDelegateAttachment = InlineAttachment;
type ContinuationDelegateAttachAs = InlineAttachmentMount;

// ---------------------------------------------------------------------------
// Continuation signals — parsed from response text or captured from tool calls
// ---------------------------------------------------------------------------

/**
 * A parsed continuation signal from either bracket syntax or a tool call.
 *
 * Tool path: `continue_work()` sets kind="work", `continue_delegate()` sets kind="delegate".
 * Token path: `CONTINUE_WORK` / `CONTINUE_WORK:N` → kind="work",
 *             `[[CONTINUE_DELEGATE: task]]` → kind="delegate".
 *
 * Both paths converge into the same scheduler — the signal shape is identical
 * regardless of origin.
 */
export type ContinuationSignal =
  | {
      kind: "work";
      delayMs?: number;
    }
  | {
      kind: "delegate";
      task: string;
      delayMs?: number;
      silent?: boolean;
      silentWake?: boolean;
      postCompaction?: boolean;
      targetSessionKey?: string;
      targetSessionKeys?: string[];
      fanoutMode?: ContinuationDelegateFanoutMode;
      /**
       * Optional provider/model override for the spawned delegate. Omitted =>
       * the delegate inherits the dispatching session's model (existing
       * behavior). Same contract as `sessions_spawn(model)`.
       */
      model?: string;
    };

// ---------------------------------------------------------------------------
// Pending delegates — enqueued by continue_delegate tool, consumed post-response
// ---------------------------------------------------------------------------

/**
 * A delegate waiting to be dispatched after the current turn completes.
 * Enqueued by the `continue_delegate` tool during execution, consumed by
 * the delegate dispatch module after the response finalizes.
 *
 * `mode` is the single source of truth for silent/silent-wake/post-compaction
 * behaviour. Legacy persisted TaskFlow rows may still carry boolean flags, but
 * runtime objects never do.
 */
export type PendingContinuationDelegate = {
  task: string;
  delayMs?: number;
  mode?: "normal" | "silent" | "silent-wake" | "post-compaction";
  firstArmedAt?: number;
  attachments?: ContinuationDelegateAttachment[];
  attachAs?: ContinuationDelegateAttachAs;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: ContinuationDelegateFanoutMode;
  returnOptions?: {
    artifacts?: "forbidden" | "optional" | "required";
  };
  recipientContext?: {
    purpose: string;
  };
  traceparent?: string;
  /**
   * Optional provider/model override forwarded to the spawned delegate.
   * Omitted => inherit the dispatching session's model.
   */
  model?: string;
  /**
   * Durable chain-cost fold: the settled child's own run-token cost, recorded on
   * the delegate ONLY when the child chain-cost persist to the child session
   * entry failed. Restart recovery adds it to the (stale) child-entry chain cost
   * so the continuation cost cap is enforced against the post-run total even when
   * the child entry never received the run cost.
   */
  chainTokensFold?: number;
  /**
   * Internal recovery marker: the chain state this claimed row already planned
   * to persist before terminalizing. If the process exits after the session-store
   * write but before the TaskFlow row is accepted/failed, restart recovery uses
   * this marker instead of advancing the same delegate a second time.
   */
  persistedChainState?: ChainState;
  persistedChainStateKind?: "advanced" | "terminal";
  /**
   * Durable inherited return policy from a silent/silent-wake parent chain.
   * Used for default-mode delayed delegates that survive process restart before
   * their hedge fires.
   */
  inheritedSilent?: boolean;
  inheritedWake?: boolean;
  /**
   * Original requester context to use when a child-owned delayed bracket
   * delegate eventually spawns. The queue stays child-owned for chain/cost
   * recovery, but the spawned continuation must remain sibling/requester-scoped.
   */
  spawnRequesterSessionKey?: string;
  spawnRequesterChannel?: string;
  spawnRequesterAccountId?: string;
  spawnRequesterTo?: string;
  spawnRequesterThreadId?: string | number;
  /**
   * Internal TaskFlow metadata carried from consume → dispatch so downstream
   * spawn/release failures can flip the row from succeeded → failed without
   * re-querying or guessing revision state.
   */
  flowId?: string;
  expectedRevision?: number;
};

// ---------------------------------------------------------------------------
// Continuation runtime config — resolved from gateway config at use time
// ---------------------------------------------------------------------------

/**
 * Resolved continuation configuration. Read from `agents.defaults.continuation`
 * at each enforcement point (hot-reloadable).
 *
 * Note: no `generationGuardTolerance` field. The generation guard mechanism
 * was removed (2026-04-15): unrelated channel noise must not cancel
 * dispatched continuation work.
 */
export type ContinuationRuntimeConfig = {
  enabled: boolean;
  defaultDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxChainLength: number;
  costCapTokens: number;
  maxDelegatesPerTurn: number;
  /**
   * Max concurrent undelivered continue_work flows per session.
   * Enforced at enqueue; orthogonal to maxChainLength (lineage depth) — this
   * bounds store pressure / the multi-continue_work flood foot-gun.
   */
  maxPendingWork: number;
  crossSessionTargeting: ContinuationCrossSessionTargetingPolicy;
  contextPressureThreshold?: number;
  earlyWarningBand?: number;
  /**
   * busy-skip exp-backoff bounds (rate-cap, NOT a safety invariant).
   * `baseMs` = first re-arm delay, multiplied by `factor` per consecutive
   * busy-skip up to `ceilingMs` (the give-up rate-cap — the flow keeps deferring
   * at this rate forever, never dropped). Always populated by
   * resolveContinuationRuntimeConfig; optional on the type (like earlyWarningBand)
   * so hand-built fixtures may omit it.
   */
  busySkipBackoff?: { baseMs: number; ceilingMs: number; factor: number };
  /**
   * orphan-reap confidence-gate floor (ms). An unended subagent run is
   * treated as confident-terminal (reap-eligible) only after it ages past this
   * cutoff; `undefined` uses the subagent-registry default. The per-run timeout
   * is always respected (a run is never reaped before its own timeout + grace).
   * The safety invariants (uncertain→quiesce, never-wrongful-reap) are NOT
   * tunable — only this confidence-window floor is.
   */
  orphanReapStaleCutoffMs?: number;
};

// ---------------------------------------------------------------------------
// Post-compaction delegate staging
// ---------------------------------------------------------------------------

/**
 * A delegate staged for release after compaction completes.
 * Serialized into the TaskFlow state payload by `buildDelegateState`
 * (see `delegate-store.ts`) — no longer lives on `SessionEntry`.
 * Released in the after-compaction lifecycle path with
 * `silentAnnounce: true` and `wakeOnReturn: true`.
 */
export type StagedPostCompactionDelegate = {
  task: string;
  stagedAt: number;
  firstArmedAt?: number;
  attachments?: ContinuationDelegateAttachment[];
  attachAs?: ContinuationDelegateAttachAs;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: ContinuationDelegateFanoutMode;
  returnOptions?: {
    artifacts?: "forbidden" | "optional" | "required";
  };
  recipientContext?: {
    purpose: string;
  };
  traceparent?: string;
  /** Optional provider/model override; omitted => inherit parent. */
  model?: string;
};

// ---------------------------------------------------------------------------
// continue_work tool-call request shape
// ---------------------------------------------------------------------------

/**
 * Captured by `continue_work()` during tool execution; consumed by the runner
 * in the same turn's post-response. Same-turn ephemeral — never persisted
 * across turn boundaries or gateway restarts.
 *
 * Single canonical definition used by signal extraction, the continue-work
 * tool, and delegate handling.
 */
export type ContinueWorkRequest = {
  reason: string;
  delaySeconds: number;
  /** Runtime-captured diagnostic context. Never populated from model/tool arguments. */
  traceparent?: string;
};

// ---------------------------------------------------------------------------
// Chain state — passed into scheduler / dispatch / persistence entry points
// ---------------------------------------------------------------------------

/**
 * Per-session continuation chain state — depth, start time, accumulated tokens.
 * Construct from a `SessionEntry` via `loadContinuationChainState(entry, turnTokens)`
 * in `./state.ts` rather than hand-rolling `?? 0` / `?? Date.now()` at each site.
 */
export type ChainState = {
  currentChainCount: number;
  chainStartedAt: number;
  accumulatedChainTokens: number;
  chainId?: string;
};

export type ContinuationWorkScheduleResult =
  | { scheduled: false; capped: boolean; chainState: ChainState }
  | { scheduled: true; capped: false; chainState: ChainState };

export type ContinuationWorkBatchResult = {
  scheduledCount: number;
  cappedCount: number;
  capped: boolean;
  chainState: ChainState;
};

export type ContinuationWorkScheduleParams = {
  sessionKey: string;
  chainState: ChainState;
  request: ContinueWorkRequest;
  config: ContinuationRuntimeConfig;
  parentRunId?: string;
  originRunId?: string;
  originTurnId?: string;
  onFlowEnqueued?: (flowId: string) => void;
  log?: (message: string) => void;
};

export type ContinuationWorkBatchParams = Omit<
  ContinuationWorkScheduleParams,
  "request" | "onFlowEnqueued"
> & {
  requests: readonly ContinueWorkRequest[];
  coalescePriorParkedWork?: boolean;
  onFlowEnqueued?: (flowId: string) => void;
};
