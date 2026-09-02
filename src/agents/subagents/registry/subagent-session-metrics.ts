/**
 * Subagent session metric helpers.
 *
 * Derives display/runtime status from partial live, archived, or recovered registry records.
 */
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentExecutionMetrics = Pick<
  SubagentRunRecord["execution"],
  "status" | "startedAt" | "endedAt" | "outcome"
>;
type SubagentSessionStartRecord = Pick<SubagentRunRecord, "sessionStartedAt"> & {
  execution: Pick<SubagentExecutionMetrics, "startedAt">;
};
type SubagentSessionRuntimeRecord = Pick<SubagentRunRecord, "accumulatedRuntimeMs"> & {
  execution: Pick<SubagentExecutionMetrics, "startedAt" | "endedAt">;
};
type SubagentSessionStatusRecord = Pick<SubagentRunRecord, "endedReason"> & {
  execution: Pick<SubagentExecutionMetrics, "status" | "endedAt" | "outcome">;
};

/** Returns a recorded execution start, never the earlier admission time. */
export function getSubagentSessionStartedAt(
  entry: SubagentSessionStartRecord | null | undefined,
): number | undefined {
  if (!entry) {
    return undefined;
  }
  if (typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)) {
    return entry.sessionStartedAt;
  }
  if (typeof entry.execution.startedAt === "number" && Number.isFinite(entry.execution.startedAt)) {
    return entry.execution.startedAt;
  }
  return undefined;
}

/** Computes accumulated runtime including the current live run when still active. */
export function getSubagentSessionRuntimeMs(
  entry: SubagentSessionRuntimeRecord | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!entry) {
    return undefined;
  }

  const accumulatedRuntimeMs =
    typeof entry.accumulatedRuntimeMs === "number" && Number.isFinite(entry.accumulatedRuntimeMs)
      ? Math.max(0, entry.accumulatedRuntimeMs)
      : 0;

  const startedAt = entry.execution.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) {
    // Archived/recovered rows may only have an accumulated duration.
    return accumulatedRuntimeMs > 0 ? accumulatedRuntimeMs : undefined;
  }

  const endedAt = entry.execution.endedAt;
  const currentRunEndedAt = typeof endedAt === "number" && Number.isFinite(endedAt) ? endedAt : now;
  return Math.max(0, accumulatedRuntimeMs + Math.max(0, currentRunEndedAt - startedAt));
}

/**
 * True when this row's `timeout` outcome recorded only that a wait deadline
 * elapsed, with nothing ever observed to stop the child.
 *
 * The single derivation of that predicate for the whole codebase: the registry's
 * `shouldDeferTerminalCleanupForUnconfirmedChild` delegates here, and so do the
 * read-side status projections below. It lives in this leaf module because the
 * display and liveness paths must be able to ask the question without importing
 * the cleanup layer.
 */
export function isSubagentChildStopUnconfirmed(
  entry: Pick<SubagentSessionStatusRecord, "execution"> | null | undefined,
): boolean {
  const outcome = entry?.execution.outcome;
  return outcome?.status === "timeout" && outcome.timeoutDisposition === "child-unconfirmed";
}

/** Maps persisted run outcome fields to the compact session status shown in tools/UI. */
export function resolveSubagentSessionStatus(
  entry: SubagentSessionStatusRecord | null | undefined,
): "queued" | "running" | "killed" | "failed" | "timeout" | "done" | undefined {
  if (!entry) {
    return undefined;
  }
  if (!entry.execution.endedAt) {
    return entry.execution.status === "queued" ? "queued" : "running";
  }
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  if (isSubagentChildStopUnconfirmed(entry)) {
    // `endedAt` on this row is the end of the PARENT'S WAIT, not of the child's
    // run. Reporting `timeout` here would file a possibly-live child under a
    // terminal death in every reader of this function — including the session
    // rows a parent consults before deciding whether to replace it — while its
    // detached task is still `running`. Report the only thing that is known: the
    // child has not been observed to stop.
    return "running";
  }
  const status = entry.execution.outcome?.status;
  if (status === "error") {
    return "failed";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "done";
}

/** Formats the authoritative run status while preserving unfinished descendants. */
export function resolveSubagentDisplayStatus(
  entry: SubagentSessionStatusRecord,
  pendingDescendants = 0,
): string {
  // A bare `running` would hide that this row's wait already ended, so the
  // display form says both halves out loud. It is deliberately not the word
  // `timeout`: the tool output a parent reads must never contradict the
  // completion warning that told it the child may still be working.
  const status = isSubagentChildStopUnconfirmed(entry)
    ? "running (wait expired; child stop unconfirmed)"
    : (resolveSubagentSessionStatus(entry) ?? "done");
  const pending = Math.max(0, pendingDescendants);
  if (pending > 0) {
    const childLabel = pending === 1 ? "child" : "children";
    const waiting = `waiting on ${pending} ${childLabel}`;
    // Pending descendants keep the row active without hiding a terminal failure,
    // and must not collapse an unconfirmed stop into a plain `active` either.
    return status === "running" || status === "done"
      ? `active (${waiting})`
      : `${status} (${waiting})`;
  }
  return status;
}
