/**
 * Handles embedded-agent compaction lifecycle events. The handlers pause
 * liveness, emit agent events, run hooks, reconcile persisted counts, and
 * clear stale usage after compaction rewrites history.
 */
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { recordSessionCompacted } from "../sessions/session-state-events.js";
import { normalizeCompactionTrigger } from "./compaction-attribution.js";
import { stripStaleAssistantUsageBeforeLatestCompaction } from "./compaction-usage.js";
import {
  classifyCompactionReason,
  formatUnknownCompactionReasonDetail,
} from "./embedded-agent-runner/compact-reasons.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentSessionEvent } from "./sessions/index.js";

type SessionCompactionStartEvent = Extract<AgentSessionEvent, { type: "compaction_start" }>;
type SessionCompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;
type CompactionReason = SessionCompactionStartEvent["reason"];

type CompactionStartEvent =
  | SessionCompactionStartEvent
  | {
      type: "compaction_start";
      reason?: unknown;
    };

// Compaction-retry fence facts ride alongside the session event: a delivery
// callback from the discarded attempt must not double-count the retry, and the
// replacement attempt needs the invalidated generation token to reset cleanly.
type CompactionEndEvent = SessionCompactionEndEvent & {
  invalidatedDeliveryGeneration?: number;
  retryAlreadyNoted?: boolean;
};

// Unknown reasons come from external runtimes or older sessions. Treat them as
// threshold compaction so logs and event payloads stay on the closed reason set.
function normalizeCompactionReason(reason: unknown): CompactionReason {
  return reason === "manual" || reason === "threshold" || reason === "overflow"
    ? reason
    : "threshold";
}

function emitCompactionAgentEvent(
  ctx: EmbeddedAgentSubscribeContext,
  data:
    | { phase: "start"; trigger: string; sessionKey?: string }
    | {
        phase: "end";
        completed: boolean;
        willRetry: boolean;
        outcome: SessionCompactionEndEvent["outcome"]["status"];
        reason?: string;
        trigger: string;
        sessionKey?: string;
        compactionCountBefore: number;
        compactionCountAfter: number;
        compactionCountDelta: number;
      },
): void {
  const event = { stream: "compaction" as const, data };
  emitAgentEvent({ runId: ctx.params.runId, ...event });
  runBestEffortCallback({
    label: "compaction agent event",
    log: ctx.log,
    callback: () => ctx.params.onAgentEvent?.(event),
  });
}

function runBestEffortCompactionHook(
  ctx: EmbeddedAgentSubscribeContext,
  phase: "before" | "after",
): void {
  const hookRunner = getGlobalHookRunner();
  const hookName = phase === "before" ? "before_compaction" : "after_compaction";
  if (!hookRunner?.hasHooks(hookName)) {
    return;
  }
  const metrics = {
    messageCount: ctx.params.session.messages?.length ?? 0,
    sessionFile: ctx.params.session.sessionFile,
  };
  const context = { sessionKey: ctx.params.sessionKey };
  const hook =
    phase === "before"
      ? hookRunner.runBeforeCompaction(
          { ...metrics, messages: ctx.params.session.messages },
          context,
        )
      : hookRunner.runAfterCompaction(
          { ...metrics, compactedCount: ctx.getCompactionCount() },
          context,
        );
  void hook.catch((err: unknown) => {
    ctx.log.warn(`${hookName} hook failed: ${String(err)}`);
  });
}

/** Handles compaction start events from an embedded agent session. */
export function handleCompactionStart(
  ctx: EmbeddedAgentSubscribeContext,
  evt: CompactionStartEvent,
) {
  // Both axes: `trigger` feeds attribution / counter reconciliation (feature),
  // `reason` feeds structured logging (upstream). They consume the same field.
  const trigger = normalizeCompactionTrigger(evt.reason);
  const reason = normalizeCompactionReason(evt.reason);
  const kind = reason === "manual" ? "manual compaction" : "auto-compaction";
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  ctx.log.info(`embedded run ${kind} start`, {
    event: "embedded_run_compaction_start",
    runId: ctx.params.runId,
    reason,
    consoleMessage: `embedded run ${kind} start: runId=${ctx.params.runId} reason=${reason}`,
  });
  ctx.log.debug(`embedded run compaction start: runId=${ctx.params.runId} trigger=${trigger}`);
  emitCompactionAgentEvent(ctx, {
    phase: "start",
    trigger,
    sessionKey: ctx.params.sessionKey,
  });

  // Hooks are fire-and-forget so compaction state updates and liveness pauses
  // cannot be delayed by plugin work.
  runBestEffortCompactionHook(ctx, "before");
}

/** Handles compaction completion, retry, and incomplete events. */
export function handleCompactionEnd(ctx: EmbeddedAgentSubscribeContext, evt: CompactionEndEvent) {
  const reason = evt.reason;
  const kind = reason === "manual" ? "manual compaction" : "auto-compaction";
  const outcome = evt.outcome;
  ctx.state.compactionInFlight = false;
  const trigger = normalizeCompactionTrigger(evt.reason);
  // Count the compaction whenever it actually rewrote history, regardless of
  // willRetry. Overflow-triggered compaction retries the LLM request after
  // trimming context, and the persisted count must reflect that successful trim.
  const completed = outcome.status === "completed";
  const willRetry = completed && outcome.willRetry;
  const compactionCountBefore = ctx.getCompactionCount();
  let compactionCountAfter = compactionCountBefore;
  if (completed) {
    ctx.incrementCompactionCount();
    ctx.noteCompactionTokensAfter(outcome.tokensAfter);
    compactionCountAfter = ctx.getCompactionCount();
    recordSessionCompacted({
      sessionKey: ctx.params.sessionKey,
      operationId: `${ctx.params.runId}:${compactionCountAfter}`,
      agentId: ctx.params.agentId,
      runId: ctx.params.runId,
    });
    ctx.log.info(`embedded run ${kind} complete`, {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      completed: true,
      willRetry,
      compactionCount: compactionCountAfter,
      consoleMessage: `embedded run ${kind} complete: runId=${ctx.params.runId} reason=${reason} compactionCount=${compactionCountAfter} willRetry=${willRetry}`,
    });
    void import("./embedded-agent-subscribe.handlers.compaction.runtime.js")
      .then(({ default: reconcile }) =>
        reconcile({
          sessionKey: ctx.params.sessionKey,
          agentId: ctx.params.agentId,
          configStore: ctx.params.config?.session?.store,
          observedCompactionCount: compactionCountAfter,
          attribution: {
            runId: ctx.params.runId,
            trigger,
            outcome: "compacted",
          },
        }),
      )
      .catch((err: unknown) => {
        ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
      });
  }
  const attributionOutcome =
    outcome.status === "completed"
      ? "compacted"
      : outcome.status === "aborted"
        ? "aborted"
        : "skipped";
  const compactionCountDelta = compactionCountAfter - compactionCountBefore;
  ctx.log.debug(
    `[compaction-attribution] end runId=${ctx.params.runId} sessionKey=${ctx.params.sessionKey ?? ctx.params.sessionId} ` +
      `trigger=${trigger} outcome=${attributionOutcome} willRetry=${willRetry} ` +
      `compactionCount.before=${compactionCountBefore} compactionCount.after=${compactionCountAfter} ` +
      `compactionCount.delta=${compactionCountDelta}`,
  );
  if (willRetry) {
    if (evt.retryAlreadyNoted !== true) {
      ctx.noteCompactionRetry();
    }
    ctx.resetForCompactionRetry(evt.invalidatedDeliveryGeneration);
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    if (outcome.status !== "aborted") {
      ctx.state.livenessState = "working";
    }
    ctx.maybeResolveCompactionWait();
    const messages = ctx.params.session.messages;
    // Only a compaction that actually rewrote history invalidates prior usage.
    // A failed/aborted/skipped end must keep live assistant usage intact —
    // zeroing it disables the persistent-error compaction trigger exactly in
    // the degraded sessions that need it.
    if (completed && Array.isArray(messages)) {
      // Marker-free final compaction has no fresh boundary, so stale totals
      // must be cleared before later context counters inspect assistant usage.
      stripStaleAssistantUsageBeforeLatestCompaction(messages, {
        mutate: true,
        whenMissingCompactionSummary: "zeroAssistantUsage",
      });
    }
  }
  const outcomeReason =
    outcome.status === "skipped" || outcome.status === "failed" ? outcome.reason : undefined;
  if (!completed) {
    const reasonClass = outcomeReason ? classifyCompactionReason(outcomeReason) : "aborted";
    const reasonDetail =
      reasonClass === "unknown" ? formatUnknownCompactionReasonDetail(outcomeReason) : undefined;
    const metadata = {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      outcome: outcome.status,
      completed: false,
      willRetry: false,
      reasonClass,
      ...(outcomeReason ? { outcomeReason } : {}),
      ...(reasonDetail ? { reasonDetail } : {}),
      consoleMessage: `embedded run ${kind} ${outcome.status}: runId=${ctx.params.runId} reason=${reasonClass}${reasonDetail ? ` detail=${reasonDetail}` : ""}`,
    };
    const benign =
      outcome.status === "aborted" ||
      (outcome.status === "skipped" &&
        (reasonClass === "no_compactable_entries" ||
          reasonClass === "below_threshold" ||
          reasonClass === "already_compacted"));
    if (benign) {
      ctx.log.info(`embedded run ${kind} ${outcome.status}`, metadata);
    } else {
      ctx.log.warn(`embedded run ${kind} ${outcome.status}`, metadata);
    }
  }
  emitCompactionAgentEvent(ctx, {
    phase: "end",
    completed,
    willRetry,
    outcome: outcome.status,
    ...(outcomeReason ? { reason: outcomeReason } : {}),
    trigger,
    sessionKey: ctx.params.sessionKey,
    compactionCountBefore,
    compactionCountAfter,
    compactionCountDelta,
  });

  // after_compaction runs only once the run will not retry, matching the visible
  // post-compaction session state plugin authors observe.
  if (!willRetry) {
    runBestEffortCompactionHook(ctx, "after");
  }
}
