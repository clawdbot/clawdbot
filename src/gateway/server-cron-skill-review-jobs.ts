// Converges the system-owned skill collection review jobs at startup and reload.
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSkillCollectionReviewMonitorSpecs,
  skillCollectionReviewMonitorAgentId,
} from "../cron/skill-collection-review-monitor.js";
import { partitionSystemMonitors } from "../cron/system-monitor-jobs.js";
import type { CronJob } from "../cron/types.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

type SkillReviewJobCron = Pick<GatewayCronServiceContract, "add" | "list" | "remove">;

export async function reconcileSkillCollectionReviewJobs(params: {
  cron: SkillReviewJobCron;
  cfg: OpenClawConfig;
  logger: { warn: (obj: unknown, msg?: string) => void };
  commitGuard?: () => void;
}): Promise<{ ok: boolean }> {
  let ok = true;
  let jobs: CronJob[];
  try {
    jobs = await params.cron.list({ includeDisabled: true });
  } catch (error) {
    params.logger.warn({ err: String(error) }, "cron-skill-review: monitor inventory failed");
    return { ok: false };
  }
  params.commitGuard?.();

  const specs = resolveSkillCollectionReviewMonitorSpecs(params.cfg);
  const desired = new Set(specs.map((spec) => spec.agentId));
  const { retained, duplicates } = partitionSystemMonitors(
    jobs,
    skillCollectionReviewMonitorAgentId,
  );
  // Let I/O run between mutations, then fence stale passes before wrappers
  // that can stop process owners ahead of their database commit guard.
  for (const { agentId, job } of duplicates) {
    await yieldToEventLoop();
    params.commitGuard?.();
    try {
      await params.cron.remove(job.id, {
        systemOwned: true,
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
      });
    } catch (error) {
      params.commitGuard?.();
      ok = false;
      params.logger.warn(
        { agentId, err: String(error) },
        "cron-skill-review: duplicate monitor cleanup failed",
      );
    }
  }
  for (const spec of specs) {
    await yieldToEventLoop();
    params.commitGuard?.();
    try {
      await params.cron.add(spec.input, {
        enabledExplicit: true,
        systemOwned: true,
        matchesExisting: (job) => skillCollectionReviewMonitorAgentId(job) === spec.agentId,
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
      });
    } catch (error) {
      params.commitGuard?.();
      ok = false;
      params.logger.warn(
        { agentId: spec.agentId, err: String(error) },
        "cron-skill-review: monitor convergence failed",
      );
    }
  }

  for (const [agentId, job] of retained) {
    if (desired.has(agentId)) {
      continue;
    }
    await yieldToEventLoop();
    params.commitGuard?.();
    try {
      await params.cron.remove(job.id, {
        systemOwned: true,
        ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
      });
    } catch (error) {
      params.commitGuard?.();
      ok = false;
      params.logger.warn(
        { agentId, err: String(error) },
        "cron-skill-review: stale monitor cleanup failed",
      );
    }
  }
  return { ok };
}
