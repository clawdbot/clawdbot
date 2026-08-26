export function resolveCronRouteData(search: string): {
  jobId: string | null;
  runId: string | null;
} {
  const params = new URLSearchParams(search);
  const jobId = params.get("job")?.trim() || null;
  return { jobId, runId: jobId ? params.get("run")?.trim() || null : null };
}
