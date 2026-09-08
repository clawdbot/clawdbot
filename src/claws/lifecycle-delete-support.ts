import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  isPathOwnedBySurvivingAgent,
  readAgentDeleteDatabaseRegistry,
  resolveSurvivingDatabaseFilePaths,
} from "../agents/agent-delete-databases.js";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, resolveAgentDir } from "../agents/agent-scope.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
} from "../agents/workspace-state-store.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  resolveWorkspaceBootstrapStatus,
} from "../agents/workspace.js";
import { pruneAgentConfig } from "../commands/agents.config.js";
import { moveToTrash } from "../commands/cleanup-utils.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import type { CronJobRow } from "../cron/store/schema.js";
import { isSystemMonitorDeclaration } from "../cron/system-owned-declaration.js";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { RuntimeEnv } from "../runtime.js";
import { unregisterOpenClawAgentDatabases } from "../state/openclaw-agent-db-registry.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawMonitorCleanupGateway, ClawMonitorSnapshot } from "./monitor-cleanup-contract.js";
import { deleteCachedClawInstallSchemaVersion } from "./provenance-runtime-read.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

type ClawRemovalDatabase = Pick<
  DB,
  "claw_workspace_files" | "claw_package_refs" | "claw_installs" | "cron_jobs"
>;

export class ClawRemoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawRemoveError";
  }
}

export function synthesizeOrphanInstall(params: {
  agentId: string;
  clawName?: string;
  workspace?: string;
  updatedAtMs?: number;
}): PersistedClawInstall {
  const updatedAtMs = params.updatedAtMs ?? 0;
  return {
    schemaVersion: "openclaw.clawInstallRecord.v1" as PersistedClawInstall["schemaVersion"],
    claw: {
      kind: "development",
      name: params.clawName ?? `orphan:${params.agentId}`,
      version: "0.0.0",
      packageRoot: "",
      manifestPath: "",
      integrityKind: "development-snapshot",
      integrity: "sha256:orphan",
      byteLength: 0,
    },
    manifestSchemaVersion: 1,
    planIntegrity: "sha256:orphan",
    agentId: params.agentId,
    workspace: params.workspace ?? "",
    agentConfigDigest: "sha256:missing",
    agentOwnedPaths: [],
    status: "partial",
    addedAtMs: updatedAtMs,
    updatedAtMs,
  };
}

export function deletionEffects(
  config: OpenClawConfig,
  agentId: string,
  fallbackWorkspace = "",
  env?: NodeJS.ProcessEnv,
) {
  const agent = listAgentEntries(config).find((candidate) => candidate.id === agentId);
  const pruned = pruneAgentConfig(config, agentId);
  const workspace = agent?.workspace ?? fallbackWorkspace;
  const agentDir = resolveAgentDir(config, agentId, env);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env);
  const workspaceSharedWith = workspace
    ? findOverlappingWorkspaceAgentIds(config, agentId, workspace, env)
    : [];
  return {
    pruned,
    workspace,
    agentDir,
    sessionsDir,
    workspaceSharedWith,
  };
}

export type AttachedCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  agentId: string | null;
  ownerAgentId: string | null;
  storeKey: string;
  declarationKey: string | null;
  revision?: string;
};

/** Inventories cron jobs that would retain a reference to a removed agent. */
export function readAttachedCronJobs(
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): AttachedCronJob[] {
  const { db } = openOpenClawStateDatabase(options);
  if (!tableExists(db, "cron_jobs")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) => {
    const boundAgentId = parameter((value) => value);
    return getNodeSqliteKysely<ClawRemovalDatabase>(db)
      .selectFrom("cron_jobs")
      .selectAll()
      .where((eb) =>
        eb.or([eb("agent_id", "=", boundAgentId), eb("owner_agent_id", "=", boundAgentId)]),
      )
      .orderBy("job_id")
      .orderBy("store_key");
  });
  const rows =
    db /* sqlite-allow-raw: preserve native inventory errors outside the write-transaction owner. */
      .prepare(compiled.sql)
      .all(...bind(agentId)) as CronJobRow[];
  return rows.map((row) => {
    const job = loadedCronStoreFromRows([row]).store.jobs[0];
    return {
      id: row.job_id,
      name: row.name,
      enabled: row.enabled === 1,
      agentId: row.agent_id,
      ownerAgentId: row.owner_agent_id,
      storeKey: row.store_key,
      declarationKey: row.declaration_key,
      revision: job ? resolveCronJobConfigRevision(job) : undefined,
    };
  });
}

/** Offline preview keeps local blockers; only a serving owner can make a monitor removable. */
export async function readClawRemoveCronInventory(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { monitorGateway?: ClawMonitorCleanupGateway },
) {
  let attachedJobs = readAttachedCronJobs(agentId, options);
  let monitors: ClawMonitorSnapshot[] = [];
  let inspectionUnavailable = false;
  if (attachedJobs.some((job) => isSystemMonitorDeclaration(job.declarationKey ?? undefined))) {
    inspectionUnavailable = true;
    if (options.monitorGateway) {
      try {
        monitors = await options.monitorGateway.inspect(agentId);
        inspectionUnavailable = false;
      } catch {
        // An unavailable/uncorroborated owner grants no removal scope.
      }
      attachedJobs = readAttachedCronJobs(agentId, options);
    }
  }
  return { attachedJobs, monitors, inspectionUnavailable };
}

export type ClawCleanupTargets = {
  workspaceDir: string;
  agentDir: string;
  sessionsDir: string;
};
export type ClawTrashPath = typeof moveToTrash;

/** Returns true when removing a workspace would discard anything outside Claw provenance. */
export async function workspaceContainsUntrackedEntries(
  workspaceRoot: string,
  trackedPaths: string[],
): Promise<boolean> {
  const tracked = new Set(trackedPaths.map((entry) => path.normalize(entry)));
  const trackedDirectories = new Set<string>();
  for (const trackedPath of tracked) {
    let parent = path.dirname(trackedPath);
    while (parent && parent !== ".") {
      trackedDirectories.add(parent);
      const next = path.dirname(parent);
      if (next === parent) {
        break;
      }
      parent = next;
    }
  }
  const walk = async (absoluteDir: string, relativeDir = ""): Promise<boolean> => {
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      const relativeEntry = path.join(relativeDir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!trackedDirectories.has(path.normalize(relativeEntry))) {
          return true;
        }
        if (await walk(path.join(absoluteDir, entry.name), relativeEntry)) {
          return true;
        }
        continue;
      }
      if (!tracked.has(path.normalize(relativeEntry))) {
        return true;
      }
    }
    return false;
  };
  try {
    return await walk(workspaceRoot);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Applies canonical post-config filesystem cleanup and reports every failed effect. */
export async function cleanupClawAgentFilesystem(params: {
  agentId: string;
  nextConfig: OpenClawConfig;
  targets: ClawCleanupTargets;
  runtime: RuntimeEnv;
  trashPath?: ClawTrashPath;
  retainWorkspace?: boolean;
  stateDatabase?: OpenClawStateDatabaseOptions;
}): Promise<string[]> {
  const errors: string[] = [];
  const trashPath = params.trashPath ?? moveToTrash;
  const survivingDatabaseFilePaths = resolveSurvivingDatabaseFilePaths(
    readAgentDeleteDatabaseRegistry(params.stateDatabase),
    params.agentId,
    params.stateDatabase?.env,
  );
  const sharedWithSurvivor = (pathname: string) =>
    isPathOwnedBySurvivingAgent(
      params.nextConfig,
      params.agentId,
      pathname,
      survivingDatabaseFilePaths,
      params.stateDatabase?.env,
    );
  if (
    params.targets.workspaceDir &&
    !params.retainWorkspace &&
    !sharedWithSurvivor(params.targets.workspaceDir)
  ) {
    const legacyPlan = prepareLegacyWorkspaceStateReset(params.targets.workspaceDir);
    const statePlan = prepareWorkspaceStateDeletion(params.targets.workspaceDir);
    const workspaceRemoved = await trashPath(params.targets.workspaceDir, params.runtime);
    if (workspaceRemoved) {
      try {
        const legacyCleanup = await removeLegacyWorkspaceStateForReset(legacyPlan);
        for (const warning of legacyCleanup.warnings) {
          params.runtime.log(warning);
        }
        deleteWorkspaceState(statePlan);
      } catch (error) {
        errors.push(coerceErrorMessage(error));
      }
    } else {
      errors.push(`Could not trash workspace ${params.targets.workspaceDir}.`);
    }
  }
  if (
    !sharedWithSurvivor(params.targets.agentDir) &&
    !(await trashPath(params.targets.agentDir, params.runtime))
  ) {
    errors.push(`Could not trash agent state ${params.targets.agentDir}.`);
  }
  if (
    !sharedWithSurvivor(params.targets.sessionsDir) &&
    !(await trashPath(params.targets.sessionsDir, params.runtime))
  ) {
    errors.push(`Could not trash session transcripts ${params.targets.sessionsDir}.`);
  }
  return errors;
}

export const clawRemoveQuietRuntime: RuntimeEnv = {
  log: (..._args: unknown[]) => undefined,
  error: (..._args: unknown[]) => undefined,
  exit: (code?: number): never => {
    throw new Error(`Unexpected exit during Claw removal cleanup: ${code ?? 1}`);
  },
};

type DigestOwnedWorkspaceFile = Pick<
  PersistedClawWorkspaceFile,
  "workspace" | "path" | "contentDigest"
>;

type DigestOwnedWorkspaceFileStatus = {
  state: "unchanged" | "modified" | "missing" | "unsafe";
  message?: string;
};

type ClawRemovableWorkspaceFile = DigestOwnedWorkspaceFile & DigestOwnedWorkspaceFileStatus;

export type RemovedWorkspaceFile = {
  path: string;
  action: "deleted" | "missing" | "retainedModified" | "error";
  message?: string;
};

export type ClawManagedFileStatus = PersistedClawWorkspaceFile & {
  state: "unchanged" | "modified" | "missing" | "unsafe";
  message?: string;
};

export type ClawBootstrapStatus = {
  state: "pending" | "complete" | "modified" | "missing" | "unsafe" | "unknown";
  workspace: string;
  path: string;
  sourcePath?: string;
  contentDigest?: string;
  message?: string;
};

async function inspectDigestOwnedWorkspaceFile(
  record: DigestOwnedWorkspaceFile,
  maxBytes = 1024 * 1024,
): Promise<DigestOwnedWorkspaceFileStatus> {
  try {
    const workspace = await fsSafeRoot(record.workspace, {
      hardlinks: "reject",
      maxBytes,
      symlinks: "reject",
    });
    if (!(await workspace.exists(record.path))) {
      return { state: "missing" };
    }
    const content = await workspace.readBytes(record.path, { maxBytes });
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    return {
      state: digest === record.contentDigest ? "unchanged" : "modified",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
    return {
      state: "unsafe",
      message: coerceErrorMessage(error),
    };
  }
}

export async function inspectClawWorkspaceFile(
  record: PersistedClawWorkspaceFile,
): Promise<ClawManagedFileStatus> {
  return { ...record, ...(await inspectDigestOwnedWorkspaceFile(record)) };
}

export async function inspectClawBootstrap(
  install: PersistedClawInstall,
  options: OpenClawStateDatabaseOptions,
): Promise<ClawBootstrapStatus> {
  const nativeState = await resolveWorkspaceBootstrapStatus(install.workspace, options);
  const setupState = readWorkspaceStateSnapshot(install.workspace, options).setup;
  const base = {
    workspace: install.workspace,
    path: DEFAULT_BOOTSTRAP_FILENAME,
    ...install.bootstrap,
  };
  const nativeBootstrapConsumed =
    typeof setupState.setupCompletedAt === "string" ||
    typeof setupState.bootstrapSeededAt === "string";
  if (nativeState === "complete" && (!install.bootstrap || nativeBootstrapConsumed)) {
    return { ...base, state: "complete" };
  }
  if (!install.bootstrap) {
    return { ...base, state: nativeState };
  }
  const bootstrapSeedingPending =
    install.status === "pending" ||
    install.status === "partial" ||
    install.status === "workspace_ready";
  if (bootstrapSeedingPending) {
    try {
      await fs.lstat(install.workspace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...base, state: "missing" };
      }
    }
  }
  const inspected = await inspectDigestOwnedWorkspaceFile(
    {
      workspace: install.workspace,
      path: DEFAULT_BOOTSTRAP_FILENAME,
      contentDigest: install.bootstrap.contentDigest,
    },
    MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  );
  if (inspected.state === "unchanged") {
    return { ...base, state: "pending" };
  }
  if (inspected.state === "modified" || inspected.state === "unsafe") {
    return {
      ...base,
      state: inspected.state,
      ...(inspected.message ? { message: inspected.message } : {}),
    };
  }
  if (bootstrapSeedingPending) {
    return { ...base, state: "missing" };
  }
  return { ...base, state: "unknown", message: "BOOTSTRAP.md disappeared during inspection." };
}

export async function removeClawWorkspaceFile(
  record: ClawRemovableWorkspaceFile,
  maxBytes = 1024 * 1024,
): Promise<RemovedWorkspaceFile> {
  if (record.state === "missing") {
    return { path: record.path, action: "missing" };
  }
  if (record.state === "modified") {
    return { path: record.path, action: "retainedModified" };
  }
  try {
    const workspace = await fsSafeRoot(record.workspace, {
      hardlinks: "reject",
      maxBytes,
      symlinks: "reject",
    });
    if (!(await workspace.exists(record.path))) {
      return { path: record.path, action: "missing" };
    }
    const stagedPath = `${record.path}.openclaw-claw-remove-${randomUUID()}`;
    await workspace.move(record.path, stagedPath, { overwrite: false });
    const content = await workspace.readBytes(stagedPath, { maxBytes });
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== record.contentDigest) {
      await workspace.move(stagedPath, record.path, { overwrite: false });
      return { path: record.path, action: "retainedModified" };
    }
    await workspace.remove(stagedPath);
    return { path: record.path, action: "deleted" };
  } catch (error) {
    return {
      path: record.path,
      action: "error",
      message: error instanceof FsSafeError ? `${error.code}: ${error.message}` : String(error),
    };
  }
}

export function releaseClawRemoveRows(
  agentId: string,
  files: RemovedWorkspaceFile[],
  cleanupErrors: string[],
  assertCurrent: (database: OpenClawStateDatabase) => void,
  completeDeletion: (database: OpenClawStateDatabase) => void,
  options: OpenClawStateDatabaseOptions,
): boolean {
  const complete = cleanupErrors.length === 0;
  try {
    runOpenClawStateWriteTransaction((database) => {
      assertCurrent(database);
      if (complete) {
        // Discovery and owned rows must retire under the same current-operation transaction.
        unregisterOpenClawAgentDatabases({ agentId, env: options.env, database });
      }
      const { db } = database;
      const query = getNodeSqliteKysely<ClawRemovalDatabase>(db);
      if (tableExists(db, "claw_workspace_files")) {
        for (const file of files.filter((candidate) => candidate.action !== "error")) {
          executeSqliteQuerySync(
            db,
            query
              .deleteFrom("claw_workspace_files")
              .where("agent_id", "=", agentId)
              .where("target_path", "=", file.path),
          );
        }
      }
      // Partial removals keep both the journal fence and install retry owner intact.
      if (!complete) {
        return;
      }
      if (tableExists(db, "claw_package_refs")) {
        executeSqliteQuerySync(
          db,
          query.deleteFrom("claw_package_refs").where("agent_id", "=", agentId),
        );
      }
      if (tableExists(db, "claw_installs")) {
        executeSqliteQuerySync(
          db,
          query.deleteFrom("claw_installs").where("agent_id", "=", agentId),
        );
      }
      // Complete removals release the fence and retry owner in the same transaction.
      completeDeletion(database);
    }, options);
    if (complete) {
      deleteCachedClawInstallSchemaVersion(agentId, options);
    }
  } catch (error) {
    if (complete) {
      throw error;
    }
    cleanupErrors.push(coerceErrorMessage(error));
  }
  return complete;
}
