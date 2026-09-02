// Formats subagent status rows for the status command response.
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import {
  hasSubagentRunEnded,
  isLiveUnendedSubagentRun,
} from "../../agents/subagents/registry/subagent-run-liveness.js";
import { sortSubagentRuns } from "../../agents/subagents/registry/subagent-run-view.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatRunLabel } from "./subagents-utils.js";

function formatActiveSubagentDetail(params: {
  entry: SubagentRunRecord;
  now: number;
  pendingDescendants: number;
}): string {
  const { entry, now, pendingDescendants } = params;
  const startedAt = entry.execution.startedAt ?? entry.sessionStartedAt ?? entry.createdAt;
  const durationMs = Math.max(
    0,
    (entry.execution.endedAt && pendingDescendants === 0 ? entry.execution.endedAt : now) -
      startedAt,
  );
  const duration = formatDurationCompact(durationMs, { spaced: true }) ?? "0s";
  const label = formatRunLabel(entry, { maxLength: 56 });
  const descendantText =
    pendingDescendants > 0
      ? ` · ${pendingDescendants} child${pendingDescendants === 1 ? "" : "ren"} active`
      : "";
  return `  • ${label} · ${duration}${descendantText}`;
}

/** Builds the compact status line for active and completed subagents. */
export function buildSubagentsStatusLine(params: {
  runs: SubagentRunRecord[];
  verboseEnabled: boolean;
  pendingDescendantsForRun: (entry: SubagentRunRecord) => number;
  now?: number;
}): string | undefined {
  const { runs, pendingDescendantsForRun, verboseEnabled } = params;
  if (runs.length === 0) {
    return undefined;
  }
  const now = params.now ?? Date.now();
  const details = sortSubagentRuns(runs).map((entry) => ({
    entry,
    pendingDescendants: pendingDescendantsForRun(entry),
    now,
  }));
  const active = details.filter(
    ({ entry, pendingDescendants }) =>
      isLiveUnendedSubagentRun(entry, now) || pendingDescendants > 0,
  );
  const done = details.filter(
    ({ entry, pendingDescendants }) => hasSubagentRunEnded(entry) && pendingDescendants === 0,
  ).length;
  if (active.length === 0) {
    return verboseEnabled && done > 0 ? `🤖 Subagents: 0 active · ${done} done` : undefined;
  }

  const summary = `🤖 Subagents: ${active.length} active${done > 0 ? ` · ${done} done` : ""}`;
  const detailLines = active.slice(0, 3).map(formatActiveSubagentDetail);
  return [summary, ...detailLines].join("\n");
}
