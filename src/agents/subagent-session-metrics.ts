/**
 * Subagent session metric helpers.
 *
 * Derives display/runtime status from partial live, archived, or recovered registry records.
 */
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function resolveSubagentSessionStartedAtInternal(
  entry: Pick<SubagentRunRecord, "sessionStartedAt" | "startedAt" | "createdAt">,
): number | undefined {
  if (typeof entry.sessionStartedAt === "number" && Number.isFinite(entry.sessionStartedAt)) {
    return entry.sessionStartedAt;
  }
  if (typeof entry.startedAt === "number" && Number.isFinite(entry.startedAt)) {
    return entry.startedAt;
  }
  return typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
    ? entry.createdAt
    : undefined;
}

/** Returns the best available session start timestamp for a run record. */
export function getSubagentSessionStartedAt(
  entry: Pick<SubagentRunRecord, "sessionStartedAt" | "startedAt" | "createdAt"> | null | undefined,
): number | undefined {
  return entry ? resolveSubagentSessionStartedAtInternal(entry) : undefined;
}

/** Computes accumulated runtime including the current live run when still active. */
export function getSubagentSessionRuntimeMs(
  entry:
    | Pick<SubagentRunRecord, "startedAt" | "endedAt" | "accumulatedRuntimeMs">
    | null
    | undefined,
  now = Date.now(),
): number | undefined {
  if (!entry) {
    return undefined;
  }

  const accumulatedRuntimeMs =
    typeof entry.accumulatedRuntimeMs === "number" && Number.isFinite(entry.accumulatedRuntimeMs)
      ? Math.max(0, entry.accumulatedRuntimeMs)
      : 0;

  if (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt)) {
    // Archived/recovered rows may only have an accumulated duration.
    return entry.accumulatedRuntimeMs != null ? accumulatedRuntimeMs : undefined;
  }

  const currentRunEndedAt =
    typeof entry.endedAt === "number" && Number.isFinite(entry.endedAt) ? entry.endedAt : now;
  return Math.max(0, accumulatedRuntimeMs + Math.max(0, currentRunEndedAt - entry.startedAt));
}

/** Maps persisted run outcome fields to the compact session status shown in tools/UI. */
export function resolveSubagentSessionStatus(
  entry: Pick<SubagentRunRecord, "endedAt" | "endedReason" | "outcome"> | null | undefined,
): "running" | "killed" | "failed" | "timeout" | "done" | undefined {
  if (!entry) {
    return undefined;
  }
  if (!entry.endedAt) {
    return "running";
  }
  if (entry.endedReason === SUBAGENT_ENDED_REASON_KILLED) {
    return "killed";
  }
  const status = entry.outcome?.status;
  if (status === "error") {
    return "failed";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "done";
}
