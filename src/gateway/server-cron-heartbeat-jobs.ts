// Converges the system-owned heartbeat monitor jobs that replaced the
// dedicated interval scheduler: one declaration-keyed cron job per
// heartbeat-enabled agent, reconverged at startup and config reload.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  heartbeatMonitorAddOptions,
  resolveHeartbeatMonitorPlan,
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

  const { changes } = resolveHeartbeatMonitorPlan(params.cfg, jobs);
  for (const change of changes) {
    try {
      if (change.kind === "remove") {
        await params.cron.remove(change.job.id, { systemOwned: true });
      } else {
        await params.cron.add(change.input, heartbeatMonitorAddOptions(change.agentId));
      }
    } catch (error) {
      ok = false;
      params.logger.warn(
        { agentId: change.agentId, err: String(error) },
        change.kind === "remove"
          ? "cron-heartbeat: stale monitor cleanup failed"
          : "cron-heartbeat: monitor convergence failed",
      );
    }
  }
  return { ok };
}
