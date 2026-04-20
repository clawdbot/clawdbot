export function createCronExecutionId(jobId: string, startedAt: number): string {
  return `cron:${jobId}:${startedAt}`;
}
