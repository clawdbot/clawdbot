// Process-local record of which cron job owns an active isolated run.
// The cron run owner records the fact at run start and clears it at run end;
// exec-approval creation and gateway allowlist evaluation read it so cron
// standing grants never infer job identity from session keys or run ids.

export type CronRunExecSource = {
  agentId: string;
  jobId: string;
  jobConfigRevision: string;
};

// Bounded by live cron-run concurrency; the cap only guards a leaked
// unregister from growing the map without bound.
const MAX_TRACKED_CRON_RUN_SOURCES = 512;
const activeCronRunExecSources = new Map<string, CronRunExecSource>();

/** Records the cron source for one active isolated run; returns its cleanup. */
export function registerCronRunExecSource(runId: string, source: CronRunExecSource): () => void {
  const key = runId.trim();
  if (!key) {
    return () => {};
  }
  if (
    activeCronRunExecSources.size >= MAX_TRACKED_CRON_RUN_SOURCES &&
    !activeCronRunExecSources.has(key)
  ) {
    const oldest = activeCronRunExecSources.keys().next().value;
    if (oldest !== undefined) {
      activeCronRunExecSources.delete(oldest);
    }
  }
  activeCronRunExecSources.set(key, source);
  return () => {
    if (activeCronRunExecSources.get(key) === source) {
      activeCronRunExecSources.delete(key);
    }
  };
}

/** Reads the recorded cron source for an active run; absence means non-cron. */
export function lookupCronRunExecSource(runId: string | undefined): CronRunExecSource | undefined {
  if (!runId) {
    return undefined;
  }
  return activeCronRunExecSources.get(runId.trim());
}
