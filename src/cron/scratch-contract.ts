/** Publicly stable limits for private per-job scratch content. */
export const CRON_JOB_SCRATCH_MAX_BYTES = 256 * 1024;

export function assertCronJobScratchContent(content: string): void {
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > CRON_JOB_SCRATCH_MAX_BYTES) {
    throw new Error(
      `cron scratch exceeds ${CRON_JOB_SCRATCH_MAX_BYTES} bytes (${sizeBytes} bytes provided)`,
    );
  }
}
