// Session-registry sweep for `openclaw tasks maintenance`: prunes stale task
// session rows while preserving transcripts owned by running cron jobs.
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  runSessionRegistryMaintenanceForStore,
} from "../config/sessions.js";
import { normalizeCronLaneSegment } from "../cron/service/task-runs.js";
import { loadCronJobsStoreSync, resolveCronJobsStorePath } from "../cron/store.js";
import { formatErrorMessage } from "../infra/errors.js";

const SESSION_REGISTRY_RETENTION_MS = 7 * 24 * 60 * 60_000;

type SessionRegistryMaintenanceStoreSummary = {
  agentId: string;
  storePath: string;
  beforeCount: number;
  afterCount: number;
  pruned: number;
  preservedRunning: number;
};

export type SessionRegistryMaintenanceSummary = {
  retentionMs: number;
  runningCronJobs: number;
  pruned: number;
  stores: SessionRegistryMaintenanceStoreSummary[];
  /** Set when the sweep did not run; pruning without cron facts would archive live transcripts. */
  skippedReason?: string;
};

function resolveExplicitCronSessionSegment(sessionKey: string | undefined): string | undefined {
  const match = /^(?:agent:[^:]+:)?cron:([^:]+)$/u.exec(sessionKey?.trim() ?? "");
  return match?.[1]?.toLowerCase();
}

type RunningCronJobIds =
  | { ok: true; ids: Set<string>; count: number }
  | { ok: false; reason: string };

function readRunningCronJobIds(): RunningCronJobIds {
  try {
    const cronStorePath = resolveCronJobsStorePath();
    const runningJobs = loadCronJobsStoreSync(cronStorePath).jobs.filter(
      (job) => typeof job.state?.runningAtMs === "number",
    );
    return {
      ok: true,
      // A running job may have been retargeted after its session was created. Keep both historical
      // shapes; the registry has no producer metadata, so retaining an ambiguous alias is safer
      // than pruning a live transcript.
      ids: new Set(
        runningJobs.flatMap((job) => [
          job.id.toLowerCase(),
          normalizeCronLaneSegment(job.id, "job"),
          ...(job.sessionTarget !== "main" && job.sessionKey
            ? [resolveExplicitCronSessionSegment(job.sessionKey)].filter(
                (segment): segment is string => segment !== undefined,
              )
            : []),
        ]),
      ),
      count: runningJobs.length,
    };
  } catch (err) {
    // An unreadable cron store must not look like "no running jobs": the
    // session sweep would then archive transcripts of jobs that are running.
    return { ok: false, reason: formatErrorMessage(err) };
  }
}

export async function runSessionRegistryMaintenance(params: {
  apply: boolean;
}): Promise<SessionRegistryMaintenanceSummary> {
  const cfg = getRuntimeConfig();
  const runningCronJobs = readRunningCronJobIds();
  if (!runningCronJobs.ok) {
    return {
      retentionMs: SESSION_REGISTRY_RETENTION_MS,
      runningCronJobs: 0,
      pruned: 0,
      stores: [],
      skippedReason: `cron store unreadable: ${runningCronJobs.reason}`,
    };
  }
  const stores: SessionRegistryMaintenanceStoreSummary[] = [];
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    const result = await runSessionRegistryMaintenanceForStore({
      apply: params.apply,
      retentionMs: SESSION_REGISTRY_RETENTION_MS,
      runningCronJobIds: runningCronJobs.ids,
      storePath: target.storePath,
    });
    stores.push({
      agentId: target.agentId,
      storePath: target.storePath,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      pruned: result.pruned,
      preservedRunning: result.preservedRunning,
    });
  }
  return {
    retentionMs: SESSION_REGISTRY_RETENTION_MS,
    runningCronJobs: runningCronJobs.count,
    pruned: stores.reduce((total, store) => total + store.pruned, 0),
    stores,
  };
}
