import type { CronJob } from "./types.js";

export function partitionSystemMonitors(
  jobs: readonly CronJob[],
  resolveAgentId: (job: CronJob) => string | undefined,
) {
  const retained = new Map<string, CronJob>();
  const duplicates: Array<{ agentId: string; job: CronJob }> = [];
  for (const job of jobs) {
    const agentId = resolveAgentId(job);
    if (!agentId) {
      continue;
    }
    const current = retained.get(agentId);
    if (!current) {
      retained.set(agentId, job);
    } else if (job.updatedAtMs > current.updatedAtMs) {
      retained.set(agentId, job);
      duplicates.push({ agentId, job: current });
    } else {
      duplicates.push({ agentId, job });
    }
  }
  return { retained, duplicates };
}
