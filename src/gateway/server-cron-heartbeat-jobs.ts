// Converges the system-owned heartbeat monitor jobs that replaced the
// dedicated interval scheduler: one declaration-keyed cron job per
// heartbeat-enabled agent, reconverged at startup and config reload.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  heartbeatMonitorAgentId,
  resolveHeartbeatMonitorSpecs,
} from "../cron/heartbeat-monitor.js";
import type { CronJob } from "../cron/types.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

type HeartbeatJobCron = Pick<GatewayCronServiceContract, "add" | "list" | "remove">;

/**
 * Converges one system-owned heartbeat monitor job per heartbeat-enabled
 * agent and removes monitors for agents no longer configured. Config is the
 * single source of truth: interval changes update the schedule in place and
 * the deterministic per-agent phase keeps multi-agent beats spread out.
 */
export async function reconcileHeartbeatMonitorJobs(params: {
  cron: HeartbeatJobCron;
  cfg: OpenClawConfig;
  logger: { warn: (obj: unknown, msg?: string) => void };
}): Promise<{ ok: boolean }> {
  let ok = true;
  let jobs: CronJob[];
  try {
    jobs = await params.cron.list({ includeDisabled: true });
  } catch (error) {
    params.logger.warn({ err: String(error) }, "cron-heartbeat: monitor inventory failed");
    return { ok: false };
  }

  const specs = resolveHeartbeatMonitorSpecs(params.cfg, jobs);
  const desired = new Set(specs.map((spec) => spec.agentId));
  for (const spec of specs) {
    try {
      await params.cron.add(spec.input, {
        enabledExplicit: true,
        systemOwned: true,
        // Scope declarative matching to real monitors: a pre-existing user
        // job that happens to hold this key is left untouched.
        matchesExisting: (job) => job.payload.kind === "heartbeat",
      });
    } catch (error) {
      ok = false;
      params.logger.warn(
        { agentId: spec.agentId, err: String(error) },
        "cron-heartbeat: monitor convergence failed",
      );
    }
  }

  try {
    for (const job of jobs) {
      const agentId = heartbeatMonitorAgentId(job);
      // Disabled heartbeats retain their stable monitor row (and scratch). Only
      // agents no longer enrolled in heartbeat are pruned.
      if (!agentId || desired.has(agentId)) {
        continue;
      }
      await params.cron.remove(job.id, { systemOwned: true });
    }
  } catch (error) {
    ok = false;
    params.logger.warn({ err: String(error) }, "cron-heartbeat: stale monitor cleanup failed");
  }
  return { ok };
}
