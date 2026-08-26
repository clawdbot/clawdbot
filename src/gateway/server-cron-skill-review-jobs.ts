// Converges the system-owned skill collection review jobs at startup and reload.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSkillCollectionReviewMonitorSpecs,
  skillCollectionReviewMonitorAgentId,
} from "../cron/skill-collection-review-monitor.js";
import type { CronJob } from "../cron/types.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

type SkillReviewJobCron = Pick<GatewayCronServiceContract, "add" | "list" | "remove">;

export async function reconcileSkillCollectionReviewJobs(params: {
  cron: SkillReviewJobCron;
  cfg: OpenClawConfig;
  logger: { warn: (obj: unknown, msg?: string) => void };
}): Promise<{ ok: boolean }> {
  let ok = true;
  let jobs: CronJob[];
  try {
    jobs = await params.cron.list({ includeDisabled: true });
  } catch (error) {
    params.logger.warn({ err: String(error) }, "cron-skill-review: monitor inventory failed");
    return { ok: false };
  }

  const specs = resolveSkillCollectionReviewMonitorSpecs(params.cfg);
  const desired = new Set(specs.map((spec) => spec.agentId));
  for (const spec of specs) {
    try {
      await params.cron.add(spec.input, {
        enabledExplicit: true,
        systemOwned: true,
        matchesExisting: (job) => skillCollectionReviewMonitorAgentId(job) !== undefined,
      });
    } catch (error) {
      ok = false;
      params.logger.warn(
        { agentId: spec.agentId, err: String(error) },
        "cron-skill-review: monitor convergence failed",
      );
    }
  }

  for (const job of jobs) {
    const agentId = skillCollectionReviewMonitorAgentId(job);
    if (!agentId || desired.has(agentId)) {
      continue;
    }
    try {
      await params.cron.remove(job.id, { systemOwned: true });
    } catch (error) {
      ok = false;
      params.logger.warn(
        { agentId, err: String(error) },
        "cron-skill-review: stale monitor cleanup failed",
      );
    }
  }
  return { ok };
}
