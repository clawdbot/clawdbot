/** Canonical projection from heartbeat config to system-owned cron monitor jobs. */
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveHeartbeatAgents,
  resolveHeartbeatSchedulerSeed,
} from "../infra/heartbeat-runner.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { resolveHeartbeatIntervalMs } from "../infra/heartbeat-summary.js";
import type { CronJob, CronJobCreate } from "./types.js";

const HEARTBEAT_DECLARATION_PREFIX = "heartbeat:";

function heartbeatMonitorDeclarationKey(agentId: string): string {
  return `${HEARTBEAT_DECLARATION_PREFIX}${agentId}`;
}

export function heartbeatMonitorAgentId(job: CronJob): string | undefined {
  const key = job.declarationKey;
  if (!key?.startsWith(HEARTBEAT_DECLARATION_PREFIX) || job.payload.kind !== "heartbeat") {
    return undefined;
  }
  return key.slice(HEARTBEAT_DECLARATION_PREFIX.length) || undefined;
}

export function resolveHeartbeatMonitorSpecs(
  cfg: OpenClawConfig,
  existingJobs: readonly CronJob[],
  options: { schedulerSeed?: string } = {},
): Array<{ agentId: string; input: CronJobCreate }> {
  const existingByAgentId = new Map<string, CronJob>();
  for (const job of existingJobs) {
    const agentId = heartbeatMonitorAgentId(job);
    if (agentId) {
      existingByAgentId.set(agentId, job);
    }
  }

  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  return resolveHeartbeatAgents(cfg).flatMap((agent) => {
    // Unset config already resolves to the 30m default here, so this is null
    // only for an explicitly disabled cadence ("0m"/invalid). The fallbacks
    // below therefore only shape the retained disabled monitor row; removing an
    // interval override or re-enabling always returns to the resolved config.
    const configuredIntervalMs = resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat);
    const existing = existingByAgentId.get(agent.agentId);
    const intervalMs =
      configuredIntervalMs ??
      (existing?.schedule.kind === "every" ? existing.schedule.everyMs : undefined) ??
      resolveHeartbeatIntervalMs(cfg, DEFAULT_HEARTBEAT_EVERY, agent.heartbeat);
    if (!intervalMs) {
      return [];
    }
    return [
      {
        agentId: agent.agentId,
        input: {
          declarationKey: heartbeatMonitorDeclarationKey(agent.agentId),
          displayName: `Heartbeat (${agent.agentId})`,
          name: `heartbeat-${agent.agentId}`,
          agentId: agent.agentId,
          enabled: configuredIntervalMs !== null,
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
      },
    ];
  });
}
