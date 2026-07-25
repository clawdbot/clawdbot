/**
 * Handles embedded-agent compaction lifecycle events. The handlers pause
 * liveness, emit agent events, run hooks, reconcile persisted counts, and
 * clear stale usage after compaction rewrites history.
 */
import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { recordSessionCompacted } from "../sessions/session-state-events.js";
import { stripStaleAssistantUsageBeforeLatestCompaction } from "./compaction-usage.js";
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

type CompactionEndEvent =
  | SessionCompactionEndEvent
  | {
      type: "compaction_end";
      reason?: unknown;
      willRetry?: unknown;
      result?: unknown;
      aborted?: unknown;
    };

// Unknown reasons come from external runtimes or older sessions. Treat them as
// threshold compaction so logs and event payloads stay on the closed reason set.
function normalizeCompactionReason(reason: unknown): CompactionReason {
  return reason === "manual" || reason === "threshold" || reason === "overflow"
    ? reason
    : "threshold";
}

function compactionLogKind(reason: CompactionReason): string {
  return reason === "manual" ? "manual compaction" : "auto-compaction";
}

/** Handles compaction start events from an embedded agent session. */
export function handleCompactionStart(
  ctx: EmbeddedAgentSubscribeContext,
  evt: CompactionStartEvent,
) {
  const reason = normalizeCompactionReason(evt.reason);
  const kind = compactionLogKind(reason);
  ctx.state.compactionInFlight = true;
  ctx.state.livenessState = "paused";
  ctx.ensureCompactionPromise();
  ctx.log.info(`embedded run ${kind} start`, {
    event: "embedded_run_compaction_start",
    runId: ctx.params.runId,
    reason,
    consoleMessage: `embedded run ${kind} start: runId=${ctx.params.runId} reason=${reason}`,
  });
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "start" },
  });
  runBestEffortCallback({
    label: "compaction agent event",
    log: ctx.log,
    callback: () =>
      ctx.params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "start" },
      }),
  });

  // Hooks are fire-and-forget so compaction state updates and liveness pauses
  // cannot be delayed by plugin work.
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("before_compaction")) {
    void hookRunner
      .runBeforeCompaction(
        {
          messageCount: ctx.params.session.messages?.length ?? 0,
          messages: ctx.params.session.messages,
          sessionFile: ctx.params.session.sessionFile,
        },
        {
          sessionKey: ctx.params.sessionKey,
        },
      )
      .catch((err: unknown) => {
        ctx.log.warn(`before_compaction hook failed: ${String(err)}`);
      });
  }
}

/** Handles compaction completion, retry, and incomplete events. */
export function handleCompactionEnd(ctx: EmbeddedAgentSubscribeContext, evt: CompactionEndEvent) {
  const reason = normalizeCompactionReason(evt.reason);
  const kind = compactionLogKind(reason);
  ctx.state.compactionInFlight = false;
  const willRetry = Boolean(evt.willRetry);
  // Increment counter whenever compaction actually produced a result, regardless
  // of willRetry. Overflow-triggered compaction retries the LLM request after
  // trimming context, and the persisted count must reflect that successful trim.
  const hasResult = evt.result != null;
  const wasAborted = Boolean(evt.aborted);
  if (hasResult && !wasAborted) {
    ctx.incrementCompactionCount();
    const tokensAfter =
      typeof evt.result === "object" && evt.result
        ? (evt.result as { tokensAfter?: unknown }).tokensAfter
        : undefined;
    ctx.noteCompactionTokensAfter(tokensAfter);
    const observedCompactionCount = ctx.getCompactionCount();
    recordSessionCompacted({
      sessionKey: ctx.params.sessionKey,
      operationId: `${ctx.params.runId}:${observedCompactionCount}`,
      agentId: ctx.params.agentId,
      runId: ctx.params.runId,
    });
    ctx.log.info(`embedded run ${kind} complete`, {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      completed: true,
      willRetry,
      compactionCount: observedCompactionCount,
      consoleMessage: `embedded run ${kind} complete: runId=${ctx.params.runId} reason=${reason} compactionCount=${observedCompactionCount} willRetry=${willRetry}`,
    });
    void reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey: ctx.params.sessionKey,
      agentId: ctx.params.agentId,
      configStore: ctx.params.config?.session?.store,
      observedCompactionCount,
    }).catch((err: unknown) => {
      ctx.log.warn(`late compaction count reconcile failed: ${String(err)}`);
    });
  }
  if (willRetry) {
    ctx.noteCompactionRetry();
    ctx.resetForCompactionRetry();
    ctx.log.debug(`embedded run compaction retry: runId=${ctx.params.runId}`);
  } else {
    if (!wasAborted) {
      ctx.state.livenessState = "working";
    }
    ctx.maybeResolveCompactionWait();
    clearStaleAssistantUsageOnSessionMessages(ctx);
  }
  if (!hasResult || wasAborted) {
    ctx.log.info(`embedded run ${kind} incomplete`, {
      event: "embedded_run_compaction_end",
      runId: ctx.params.runId,
      reason,
      completed: false,
      willRetry,
      aborted: wasAborted,
      consoleMessage: `embedded run ${kind} incomplete: runId=${ctx.params.runId} reason=${reason} aborted=${wasAborted} willRetry=${willRetry}`,
    });
  }
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "compaction",
    data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
  });
  runBestEffortCallback({
    label: "compaction agent event",
    log: ctx.log,
    callback: () =>
      ctx.params.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry, completed: hasResult && !wasAborted },
      }),
  });

  // after_compaction runs only once the run will not retry, matching the visible
  // post-compaction session state plugin authors observe.
  if (!willRetry) {
    const hookRunnerEnd = getGlobalHookRunner();
    if (hookRunnerEnd?.hasHooks("after_compaction")) {
      void hookRunnerEnd
        .runAfterCompaction(
          {
            messageCount: ctx.params.session.messages?.length ?? 0,
            compactedCount: ctx.getCompactionCount(),
            sessionFile: ctx.params.session.sessionFile,
          },
          { sessionKey: ctx.params.sessionKey },
        )
        .catch((err: unknown) => {
          ctx.log.warn(`after_compaction hook failed: ${String(err)}`);
        });
    }
  }
}

/** Lazily reconciles persisted compaction count after a successful compaction. */
async function reconcileSessionStoreCompactionCountAfterSuccess(params: {
  sessionKey?: string;
  agentId?: string;
  configStore?: string;
  observedCompactionCount: number;
  now?: number;
}): Promise<number | undefined> {
  const { default: reconcile } =
    await import("./embedded-agent-subscribe.handlers.compaction.runtime.js");
  return reconcile(params);
}

function clearStaleAssistantUsageOnSessionMessages(ctx: EmbeddedAgentSubscribeContext): void {
  const messages = ctx.params.session.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  // Marker-free final compaction has no fresh boundary to compare against.
  // Clear all assistant usage or stale pre-compaction totals keep driving the
  // context counter after cleanup.
  stripStaleAssistantUsageBeforeLatestCompaction(messages, {
    mutate: true,
    whenMissingCompactionSummary: "zeroAssistantUsage",
  });
}
