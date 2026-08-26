/** Canonical projection from heartbeat config to system-owned cron monitor jobs. */
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "../infra/heartbeat-config.js";
import {
  resolveHeartbeatPhaseMs,
  resolveHeartbeatSchedulerSeed,
} from "../infra/heartbeat-schedule.js";
import type { CronJob, CronJobCreate } from "./types.js";

const HEARTBEAT_DECLARATION_PREFIX = "heartbeat:";

type HeartbeatMonitorSpec = { agentId: string; input: CronJobCreate };

export type HeartbeatMonitorChange =
  | ({ kind: "create" | "update" } & HeartbeatMonitorSpec)
  | { kind: "remove"; agentId: string; job: CronJob };

export type HeartbeatMonitorPlan = {
  specs: HeartbeatMonitorSpec[];
  changes: HeartbeatMonitorChange[];
};

function heartbeatMonitorDeclarationKey(agentId: string): string {
  return `${HEARTBEAT_DECLARATION_PREFIX}${agentId}`;
}

function heartbeatMonitorAgentId(job: CronJob): string | undefined {
  const key = job.declarationKey;
  if (!key?.startsWith(HEARTBEAT_DECLARATION_PREFIX) || job.payload.kind !== "heartbeat") {
    return undefined;
  }
  return key.slice(HEARTBEAT_DECLARATION_PREFIX.length) || undefined;
}

/** Keeps declarative upserts scoped to the exact system-owned monitor. */
export function heartbeatMonitorAddOptions(agentId: string) {
  return {
    enabledExplicit: true,
    systemOwned: true,
    matchesExisting: (job: CronJob) => heartbeatMonitorAgentId(job) === agentId,
  } as const;
}

function heartbeatMonitorDeclarativeFields(job: CronJob | CronJobCreate) {
  return {
    declarationKey: job.declarationKey,
    name: job.name,
    agentId: job.agentId,
    schedule: job.schedule,
    pacing: job.pacing,
    trigger: job.trigger,
    payload: job.payload,
    delivery: job.delivery,
    displayName: job.displayName,
    enabled: job.enabled,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
  };
}

/** Projects configured monitor state and its create/update/remove changes together. */
export function resolveHeartbeatMonitorPlan(
  cfg: OpenClawConfig,
  existingJobs: readonly CronJob[],
  options: { schedulerSeed?: string } = {},
): HeartbeatMonitorPlan {
  const existingByAgentId = new Map<string, CronJob>();
  for (const job of existingJobs) {
    const agentId = heartbeatMonitorAgentId(job);
    if (agentId) {
      existingByAgentId.set(agentId, job);
    }
  }

  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  const specs: HeartbeatMonitorSpec[] = resolveHeartbeatAgents(cfg).flatMap((agent) => {
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

  const changes: HeartbeatMonitorChange[] = [];
  for (const spec of specs) {
    const existing = existingByAgentId.get(spec.agentId);
    if (!existing) {
      changes.push({ kind: "create", ...spec });
      continue;
    }
    existingByAgentId.delete(spec.agentId);
    if (
      !isDeepStrictEqual(
        heartbeatMonitorDeclarativeFields(existing),
        heartbeatMonitorDeclarativeFields(spec.input),
      )
    ) {
      changes.push({ kind: "update", ...spec });
    }
  }
  for (const [agentId, job] of existingByAgentId) {
    changes.push({ kind: "remove", agentId, job });
  }
  return { specs, changes };
}
