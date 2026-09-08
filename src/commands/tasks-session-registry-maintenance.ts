// Session-registry sweep for `openclaw tasks maintenance`: prunes stale task
// session rows while preserving transcripts owned by running cron jobs.
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  runSessionRegistryMaintenanceForStore,
} from "../config/sessions.js";
import { loadCronJobsStoreSync, resolveCronJobsStorePath } from "../cron/store.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";

const SESSION_REGISTRY_RETENTION_MS = 7 * 24 * 60 * 60_000;

type SessionRegistryMaintenanceStoreIdentity = {
  agentId: string;
  storePath: string;
};

type SessionRegistryMaintenanceStoreSummary =
  | (SessionRegistryMaintenanceStoreIdentity & {
      beforeCount: number;
      afterCount: number;
      pruned: number;
      preservedRunning: number;
    })
  | (SessionRegistryMaintenanceStoreIdentity & {
      skippedReason: "agent-deletion-complete";
    });

type SessionRegistryMaintenanceSummary = {
  retentionMs: number;
  runningCronJobs: number;
  pruned: number;
  skippedStores: number;
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
    // A running detached job may have been retargeted after its session was created. Keep its
    // explicit session segment because the registry has no producer metadata for the transcript.
    const ids = new Set<string>();
    for (const job of runningJobs) {
      ids.add(job.id.toLowerCase());
      if (job.sessionTarget === "main") {
        continue;
      }
      const explicitSessionSegment = resolveExplicitCronSessionSegment(job.sessionKey);
      if (explicitSessionSegment) {
        ids.add(explicitSessionSegment);
      }
    }
    return {
      ok: true,
      ids,
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
      skippedStores: 0,
      stores: [],
      skippedReason: `cron store unreadable: ${runningCronJobs.reason}`,
    };
  }
  const stores: SessionRegistryMaintenanceStoreSummary[] = [];
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    const deletion = readAgentDeletionJournal(target.agentId);
    if (deletion?.cleanupCompleted) {
      // Completed tombstones intentionally keep retired stores unavailable.
      // Record that lifecycle outcome instead of reopening the fenced database.
      stores.push({ ...target, skippedReason: "agent-deletion-complete" });
      continue;
    }
    const result = await runSessionRegistryMaintenanceForStore({
      ...target,
      apply: params.apply,
      retentionMs: SESSION_REGISTRY_RETENTION_MS,
      runningCronJobIds: runningCronJobs.ids,
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
    pruned: stores.reduce((total, store) => total + ("pruned" in store ? store.pruned : 0), 0),
    skippedStores: stores.filter((store) => "skippedReason" in store).length,
    stores,
  };
}
