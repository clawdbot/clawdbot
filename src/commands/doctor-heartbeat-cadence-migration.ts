/** Doctor-owned materialization of heartbeat cadence config into cron monitor rows. */
import { note } from "../../packages/terminal-core/src/note.js";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyHeartbeatMonitorJobs,
  heartbeatMonitorAddOptions,
  resolveHeartbeatMonitorPlan,
  type HeartbeatMonitorChange,
  type HeartbeatMonitorPlan,
} from "../cron/heartbeat-monitor.js";
import { CronService } from "../cron/service.js";
import {
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { resolveHeartbeatSchedulerSeed } from "../infra/heartbeat-schedule.js";
import { shortenHomePath } from "../utils.js";

const HEARTBEAT_CADENCE_MIGRATION_CHECK_ID = "core/doctor/heartbeat-cadence-migration";

type HeartbeatCadenceMigrationResult = {
  changes: string[];
  warnings: string[];
};

function createDoctorCronService(storePath: string, cfg: OpenClawConfig): CronService {
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop };
  return new CronService({
    storePath,
    cronEnabled: false,
    cronConfig: cfg.cron,
    resolveDefaultAgentId: () => tryResolveAmbientOwnerAgentId(cfg),
    log,
    enqueueSystemEvent: () => false,
    requestHeartbeat: noop,
    runIsolatedAgentJob: async () => ({
      status: "skipped",
      error: "doctor does not execute automations",
    }),
  });
}

async function loadHeartbeatMonitorPlanReadOnly(
  cfg: OpenClawConfig,
  storePath: string,
  env: NodeJS.ProcessEnv,
): Promise<HeartbeatMonitorPlan> {
  const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env);
  const schedulerSeed = resolveHeartbeatSchedulerSeed(undefined, { env, readOnly: true });
  return resolveHeartbeatMonitorPlan(cfg, loaded.store.jobs, { schedulerSeed });
}

function describePlannedChange(change: HeartbeatMonitorChange): string {
  if (change.kind === "remove") {
    return `Remove stale heartbeat monitor for agent "${change.agentId}".`;
  }
  const schedule = change.input.schedule;
  const cadence =
    schedule.kind === "every" ? formatDurationCompact(schedule.everyMs) : schedule.kind;
  const action = change.kind === "create" ? "Create" : "Update";
  return `${action} heartbeat monitor for agent "${change.agentId}" at ${cadence}.`;
}

function noteWarnings(warnings: readonly string[], storePath: string): void {
  if (warnings.length === 0) {
    return;
  }
  note(`${warnings.join("\n")}\nCron store: ${shortenHomePath(storePath)}`, "Doctor warnings");
}

function cadenceFinding(params: {
  storePath: string;
  change: HeartbeatMonitorChange;
}): HealthFinding {
  return {
    checkId: HEARTBEAT_CADENCE_MIGRATION_CHECK_ID,
    severity: "warning",
    message: describePlannedChange(params.change),
    path: params.storePath,
    target: params.change.agentId,
    requirement: `heartbeat-monitor-${params.change.kind}`,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to materialize heartbeat cadence in cron.`,
  };
}

/** Reports heartbeat monitor rows that do not yet match cadence config. */
export async function collectHeartbeatCadenceMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  try {
    const plan = await loadHeartbeatMonitorPlanReadOnly(cfg, storePath, env);
    return plan.changes.map((change) => cadenceFinding({ storePath, change }));
  } catch (error) {
    return [
      {
        checkId: HEARTBEAT_CADENCE_MIGRATION_CHECK_ID,
        severity: "error",
        message: `Heartbeat cadence could not be inspected: ${errorMessage(error)}`,
        path: storePath,
        requirement: "heartbeat-monitor-inspection",
        fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} after resolving the cron store error.`,
      },
    ];
  }
}

/** Creates or updates the stable monitor rows used by heartbeat execution. */
export async function ensureHeartbeatMonitorJobs(
  cfg: OpenClawConfig,
  storePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, CronJob>> {
  const cron = createDoctorCronService(storePath, cfg);
  const jobs = await cron.list({ includeDisabled: true });
  const schedulerSeed = resolveHeartbeatSchedulerSeed(undefined, { env });
  const { specs } = resolveHeartbeatMonitorPlan(cfg, jobs, { schedulerSeed });
  const monitors = new Map<string, CronJob>();
  for (const spec of specs) {
    const result = await cron.add(spec.input, heartbeatMonitorAddOptions(spec.agentId));
    const job = "job" in result ? result.job : result;
    monitors.set(spec.agentId, job);
  }
  return monitors;
}

/** Previews or applies config-to-cron heartbeat cadence materialization. */
export async function maybeMigrateHeartbeatCadenceToCron(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<HeartbeatCadenceMigrationResult> {
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.shouldRepair) {
    try {
      const plan = await loadHeartbeatMonitorPlanReadOnly(params.cfg, storePath, env);
      if (plan.changes.length > 0) {
        note(
          plan.changes.map(describePlannedChange).join("\n"),
          "Heartbeat cadence migration preview",
        );
      }
    } catch (error) {
      warnings.push(`Could not inspect heartbeat monitor jobs: ${errorMessage(error)}`);
    }
    noteWarnings(warnings, storePath);
    return { changes, warnings };
  }

  const cron = createDoctorCronService(storePath, params.cfg);
  const schedulerSeed = resolveHeartbeatSchedulerSeed(undefined, { env });
  const result = await applyHeartbeatMonitorJobs({
    cron,
    cfg: params.cfg,
    schedulerSeed,
  });
  changes.push(...result.applied.map(describePlannedChange));
  for (const failure of result.failures) {
    warnings.push(
      failure.change
        ? `Heartbeat monitor for agent "${failure.change.agentId}" was not migrated: ${errorMessage(failure.error)}`
        : `Could not inspect heartbeat monitor jobs: ${errorMessage(failure.error)}`,
    );
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  noteWarnings(warnings, storePath);
  return { changes, warnings };
}
