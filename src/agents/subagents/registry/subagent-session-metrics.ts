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
  const status = resolveSubagentSessionStatus(entry) ?? "done";
  const pending = Math.max(0, pendingDescendants);
  if (pending > 0) {
    const childLabel = pending === 1 ? "child" : "children";
    const waiting = `waiting on ${pending} ${childLabel}`;
    // Pending descendants keep the row active without hiding a terminal failure.
    return status === "running" || status === "done"
      ? `active (${waiting})`
      : `${status} (${waiting})`;
  }
  return status;
}
