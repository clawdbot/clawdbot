/** Builds the stable diagnostic/session execution id for a single cron run. */
export function createCronExecutionId(jobId: string, startedAt: number): string {
  return `cron:${jobId}:${startedAt}`;
}
