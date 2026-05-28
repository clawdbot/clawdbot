import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { formatRunLabel, sortSubagentRuns } from "./subagents-utils.js";

function formatActiveSubagentDetail(params: {
  entry: SubagentRunRecord;
  now: number;
  pendingDescendants: number;
}): string {
  const { entry, now, pendingDescendants } = params;
  const startedAt = entry.startedAt ?? entry.sessionStartedAt ?? entry.createdAt;
  const durationMs = Math.max(
    0,
    (entry.endedAt && pendingDescendants === 0 ? entry.endedAt : now) - startedAt,
  );
  const duration = formatDurationCompact(durationMs, { spaced: true }) ?? "0s";
  const label = formatRunLabel(entry, { maxLength: 56 });
  const descendantText =
    pendingDescendants > 0
      ? ` · ${pendingDescendants} child${pendingDescendants === 1 ? "" : "ren"} active`
      : "";
  return `  • ${label} · ${duration}${descendantText}`;
}

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
  const activeWithDescendants = runs
    .map((entry) => ({ entry, pendingDescendants: pendingDescendantsForRun(entry) }))
    .filter(({ entry, pendingDescendants }) => !entry.endedAt || pendingDescendants > 0);
  const active = activeWithDescendants.map(({ entry }) => entry);
  const done = runs.length - active.length;
  if (active.length === 0) {
    return verboseEnabled && done > 0 ? `🤖 Subagents: 0 active · ${done} done` : undefined;
  }

  const summary = `🤖 Subagents: ${active.length} active${done > 0 ? ` · ${done} done` : ""}`;
  const now = params.now ?? Date.now();
  const detailLookup = new Map(
    activeWithDescendants.map(({ entry, pendingDescendants }) => [entry.runId, pendingDescendants]),
  );
  const detailLines = sortSubagentRuns(active)
    .slice(0, 3)
    .map((entry) =>
      formatActiveSubagentDetail({
        entry,
        now,
        pendingDescendants: detailLookup.get(entry.runId) ?? 0,
      }),
    );
  return [summary, ...detailLines].join("\n");
}
