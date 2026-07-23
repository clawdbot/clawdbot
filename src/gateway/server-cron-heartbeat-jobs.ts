// Converges the system-owned heartbeat monitor jobs that replaced the
// dedicated interval scheduler: one declaration-keyed cron job per
// heartbeat-enabled agent, reconverged at startup and config reload.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveHeartbeatAgents,
  resolveHeartbeatSchedulerSeed,
} from "../infra/heartbeat-runner.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { resolveHeartbeatIntervalMs } from "../infra/heartbeat-summary.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

const HEARTBEAT_DECLARATION_PREFIX = "heartbeat:";

function heartbeatMonitorDeclarationKey(agentId: string): string {
  return `${HEARTBEAT_DECLARATION_PREFIX}${agentId}`;
}

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
  const schedulerSeed = resolveHeartbeatSchedulerSeed();
  const desired = new Set<string>();
  for (const agent of resolveHeartbeatAgents(params.cfg)) {
    const intervalMs = resolveHeartbeatIntervalMs(params.cfg, undefined, agent.heartbeat);
    if (!intervalMs) {
      continue;
    }
    desired.add(agent.agentId);
    try {
      await params.cron.add(
        {
          declarationKey: heartbeatMonitorDeclarationKey(agent.agentId),
          displayName: `Heartbeat (${agent.agentId})`,
          name: `heartbeat-${agent.agentId}`,
          agentId: agent.agentId,
          enabled: true,
          schedule: {
            kind: "every",
            everyMs: intervalMs,
            anchorMs: resolveHeartbeatPhaseMs({
              schedulerSeed,
              agentId: agent.agentId,
              intervalMs,
            }),
          },
          payload: { kind: "heartbeat" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
        },
        {
          enabledExplicit: true,
          systemOwned: true,
          // Scope declarative matching to real monitors: a pre-existing user
          // job that happens to hold this key is left untouched.
          matchesExisting: (job) => job.payload.kind === "heartbeat",
        },
      );
    } catch (error) {
      ok = false;
      params.logger.warn(
        { agentId: agent.agentId, err: String(error) },
        "cron-heartbeat: monitor convergence failed",
      );
    }
  }
  try {
    const jobs = await params.cron.list({ includeDisabled: true });
    for (const job of jobs) {
      const key = job.declarationKey;
      // Prune only proven monitors: prefix alone must never delete an
      // unrelated declaration-keyed job that happens to share the namespace.
      if (!key?.startsWith(HEARTBEAT_DECLARATION_PREFIX) || job.payload.kind !== "heartbeat") {
        continue;
      }
      if (desired.has(key.slice(HEARTBEAT_DECLARATION_PREFIX.length))) {
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
