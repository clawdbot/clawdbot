export function resolveCronRouteData(search: string): {
  jobId: string | null;
  runId: string | null;
} {
  const params = new URLSearchParams(search);
  const jobId = params.get("job")?.trim() || null;
  return { jobId, runId: jobId ? params.get("run")?.trim() || null : null };
}

const CRON_EXECUTION_ID_RE = /^cron:(.+):(\d+)$/u;

/**
 * Notifications link runs by execution id (`cron:<jobId>:<startedAtMs>`), while
 * ledger entries carry public run ids (receipt UUIDs, `manual:<...>` ids) that
 * never equal it. Match exact ids first, then the entry's recorded run start.
 */
export function cronRunEntryMatchesLink(
  linkedRunId: string,
  entry: { jobId: string; runId?: string; runAtMs?: number },
): boolean {
  if (entry.runId === linkedRunId) {
    return true;
  }
  const match = CRON_EXECUTION_ID_RE.exec(linkedRunId);
  return match !== null && match[1] === entry.jobId && entry.runAtMs === Number(match[2]);
}
