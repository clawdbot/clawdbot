/** Canonical projection from heartbeat config to system-owned cron monitor jobs. */
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "../infra/heartbeat-config.js";
import {
  resolveHeartbeatPhaseMs,
  resolveHeartbeatSchedulerSeed,
} from "../infra/heartbeat-schedule.js";
import type { CronService } from "./service.js";
import { partitionSystemMonitors } from "./system-monitor-jobs.js";
import { HEARTBEAT_DECLARATION_PREFIX } from "./system-owned-declaration.js";
import type { CronJob, CronJobCreate } from "./types.js";

type HeartbeatMonitorSpec = { agentId: string; input: CronJobCreate };

export type HeartbeatMonitorChange =
  | ({ kind: "create" | "update" } & HeartbeatMonitorSpec)
  | { kind: "remove"; agentId: string; job: CronJob };

export type HeartbeatMonitorPlan = {
  specs: HeartbeatMonitorSpec[];
  changes: HeartbeatMonitorChange[];
};

type HeartbeatMonitorReconcileResult = {
  ok: boolean;
  applied: HeartbeatMonitorChange[];
  failures: Array<{ change?: HeartbeatMonitorChange; error: unknown }>;
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
  const { retained: existingByAgentId, duplicates } = partitionSystemMonitors(
    existingJobs,
    heartbeatMonitorAgentId,
  );

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

  // Remove duplicate declaration keys before declarative upserts, which reject
  // ambiguous matches by design.
  const changes: HeartbeatMonitorChange[] = duplicates.map(({ agentId, job }) => ({
    kind: "remove",
    agentId,
    job,
  }));
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

/** Applies the canonical heartbeat monitor plan while isolating per-row failures. */
export async function applyHeartbeatMonitorJobs(params: {
  cron: Pick<CronService, "add" | "list" | "remove">;
  cfg: OpenClawConfig;
  schedulerSeed?: string;
  logger?: { warn: (obj: unknown, msg?: string) => void };
  commitGuard?: () => void;
}): Promise<HeartbeatMonitorReconcileResult> {
  let jobs: CronJob[];
  try {
    jobs = await params.cron.list({ includeDisabled: true });
  } catch (error) {
    params.logger?.warn({ err: String(error) }, "cron-heartbeat: monitor inventory failed");
    return { ok: false, applied: [], failures: [{ error }] };
  }
  params.commitGuard?.();

  const { changes } = resolveHeartbeatMonitorPlan(params.cfg, jobs, {
    schedulerSeed: params.schedulerSeed,
  });
  const applied: HeartbeatMonitorChange[] = [];
  const failures: HeartbeatMonitorReconcileResult["failures"] = [];
  for (const change of changes) {
    // Settled CRUD promises do not yield to I/O; reject a superseded pass
    // after the event-loop turn, before entering its next mutation wrapper.
    await yieldToEventLoop();
    params.commitGuard?.();
    try {
      if (change.kind === "remove") {
        await params.cron.remove(change.job.id, {
          systemOwned: true,
          ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
        });
      } else {
        await params.cron.add(change.input, {
          ...heartbeatMonitorAddOptions(change.agentId),
          ...(params.commitGuard ? { commitGuard: params.commitGuard } : {}),
        });
      }
      applied.push(change);
    } catch (error) {
      params.commitGuard?.();
      failures.push({ change, error });
      params.logger?.warn(
        { agentId: change.agentId, err: String(error) },
        change.kind === "remove"
          ? "cron-heartbeat: stale monitor cleanup failed"
          : "cron-heartbeat: monitor convergence failed",
      );
    }
  }
  return { ok: failures.length === 0, applied, failures };
}

/** Gateway-facing reconciliation keeps the established compact result contract. */
export async function reconcileHeartbeatMonitorJobs(
  params: Parameters<typeof applyHeartbeatMonitorJobs>[0] & {
    logger: { warn: (obj: unknown, msg?: string) => void };
  },
): Promise<{ ok: boolean }> {
  const { ok } = await applyHeartbeatMonitorJobs(params);
  return { ok };
}
