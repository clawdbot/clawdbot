/** Canonical ordering and visibility for numbered subagent lists and targets. */
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isLiveUnendedSubagentRun } from "./subagent-run-liveness.js";
import { isSubagentChildStopUnconfirmed } from "./subagent-session-metrics.js";

export function sortSubagentRuns(runs: readonly SubagentRunRecord[]): SubagentRunRecord[] {
  return runs.toSorted((a, b) => {
    const aTime = a.execution.startedAt ?? a.createdAt ?? 0;
    const bTime = b.execution.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

/** Keep display indices and command targets on the same latest-run/liveness policy. */
export function buildSubagentRunView(params: {
  runs: readonly SubagentRunRecord[];
  recentMinutes: number;
  countPendingDescendantRuns: (sessionKey: string) => number;
  now?: number;
}) {
  const now = params.now ?? Date.now();
  const recentCutoff = now - params.recentMinutes * 60_000;
  const latest: SubagentRunRecord[] = [];
  const active: SubagentRunRecord[] = [];
  const recent: SubagentRunRecord[] = [];
  const seen = new Set<string>();
  for (const entry of sortSubagentRuns(params.runs)) {
    if (seen.has(entry.childSessionKey)) {
      continue;
    }
    // Steering/retries can leave several records for one child; the newest display row wins.
    seen.add(entry.childSessionKey);
    latest.push(entry);
    if (
      isLiveUnendedSubagentRun(entry, now) ||
      // A row whose wait expired without observing the child stop has an
      // `endedAt`, so the unended test above rejects it — which would file a
      // possibly-live child under "recent" alongside genuinely finished runs.
      // The listing a parent reads before deciding whether to spawn a
      // replacement has to keep it visible as live work.
      isSubagentChildStopUnconfirmed(entry) ||
      params.countPendingDescendantRuns(entry.childSessionKey) > 0
    ) {
      active.push(entry);
    } else if (entry.execution.endedAt && entry.execution.endedAt >= recentCutoff) {
      recent.push(entry);
    }
  }
  return { latest, active, recent };
}
