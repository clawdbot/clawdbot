import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { listAgentEntries, resolveAgentDir } from "../agents/agent-scope.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import { pruneAgentConfig } from "../commands/agents.config.js";
import { moveToTrash } from "../commands/onboard-helpers.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

type WorkspaceFileRow = {
  schema_version: string;
  agent_id: string;
  workspace: string;
  target_path: string;
  source_path: string;
  content_digest: string;
  status: PersistedClawWorkspaceFile["status"];
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

export class ClawRemoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawRemoveError";
  }
}

function clawStateTableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db /* sqlite-allow-raw: schema probe for optional Claw state tables. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

function rowToWorkspaceFile(row: WorkspaceFileRow): PersistedClawWorkspaceFile {
  return {
    schemaVersion: row.schema_version as PersistedClawWorkspaceFile["schemaVersion"],
    agentId: row.agent_id,
    workspace: row.workspace,
    path: row.target_path,
    sourcePath: row.source_path,
    contentDigest: row.content_digest,
    status: row.status,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function readAllClawWorkspaceFiles(
  options: OpenClawStateDatabaseOptions,
): PersistedClawWorkspaceFile[] {
  const database = openOpenClawStateDatabase(options);
  if (!clawStateTableExists(database.db, "claw_workspace_files")) {
    return [];
  }
  const rows = database.db /* sqlite-allow-raw: read-only Claw workspace-file orphan inventory. */
    .prepare(
      `SELECT schema_version, agent_id, workspace, target_path, source_path,
              content_digest, status, created_at_ms, updated_at_ms
         FROM claw_workspace_files
        ORDER BY agent_id, target_path`,
    )
    .all() as WorkspaceFileRow[];
  return rows.map(rowToWorkspaceFile);
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

export function deletionEffects(config: OpenClawConfig, agentId: string, fallbackWorkspace = "") {
  const agent = listAgentEntries(config).find((candidate) => candidate.id === agentId);
  const pruned = pruneAgentConfig(config, agentId);
  const workspace = agent?.workspace ?? fallbackWorkspace;
  const agentDir = resolveAgentDir(config, agentId);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  const workspaceSharedWith = workspace
    ? findOverlappingWorkspaceAgentIds(config, agentId, workspace)
    : [];
  return {
    pruned,
    workspace,
    agentDir,
    sessionsDir,
    workspaceSharedWith,
    workspaceRetained: workspaceSharedWith.length > 0,
  };
}

type AttachedCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  agentId: string | null;
  ownerAgentId: string | null;
};

/** Inventories cron jobs that would retain a reference to a removed agent. */
export function readAttachedCronJobs(
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): AttachedCronJob[] {
  const database = openOpenClawStateDatabase(options);
  if (!clawStateTableExists(database.db, "cron_jobs")) {
    return [];
  }
  return database.db /* sqlite-allow-raw: read-only cron references for Claw removal planning. */
    .prepare(
      `SELECT job_id AS id, name, enabled, agent_id AS agentId, owner_agent_id AS ownerAgentId
         FROM cron_jobs
        WHERE agent_id = ? OR owner_agent_id = ?
        ORDER BY job_id`,
    )
    .all(agentId, agentId)
    .map((row) => {
      const value = row as {
        id: string;
        name: string;
        enabled: number;
        agentId: string | null;
        ownerAgentId: string | null;
      };
      return {
        id: value.id,
        name: value.name,
        enabled: value.enabled === 1,
        agentId: value.agentId,
        ownerAgentId: value.ownerAgentId,
      };
    });
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
}): Promise<string[]> {
  const errors: string[] = [];
  const trashPath = params.trashPath ?? moveToTrash;
  const workspaceSharedWith = params.targets.workspaceDir
    ? findOverlappingWorkspaceAgentIds(
        params.nextConfig,
        params.agentId,
        params.targets.workspaceDir,
      )
    : [];
  if (params.targets.workspaceDir && !params.retainWorkspace && workspaceSharedWith.length === 0) {
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
        errors.push(error instanceof Error ? error.message : String(error));
      }
    } else {
      errors.push(`Could not trash workspace ${params.targets.workspaceDir}.`);
    }
  }
  if (!(await trashPath(params.targets.agentDir, params.runtime))) {
    errors.push(`Could not trash agent state ${params.targets.agentDir}.`);
  }
  if (!(await trashPath(params.targets.sessionsDir, params.runtime))) {
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

type ClawRemovableWorkspaceFile = PersistedClawWorkspaceFile & {
  state: "unchanged" | "modified" | "missing" | "unsafe";
  message?: string;
};

export type RemovedWorkspaceFile = {
  path: string;
  action: "deleted" | "missing" | "retainedModified" | "error";
  message?: string;
};

export type ClawManagedFileStatus = PersistedClawWorkspaceFile & {
  state: "unchanged" | "modified" | "missing" | "unsafe";
  message?: string;
};

export async function inspectClawWorkspaceFile(
  record: PersistedClawWorkspaceFile,
): Promise<ClawManagedFileStatus> {
  try {
    const workspace = await fsSafeRoot(record.workspace, {
      hardlinks: "reject",
      maxBytes: 1024 * 1024,
      symlinks: "reject",
    });
    if (!(await workspace.exists(record.path))) {
      return { ...record, state: "missing" };
    }
    const content = await workspace.readBytes(record.path, { maxBytes: 1024 * 1024 });
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    return { ...record, state: digest === record.contentDigest ? "unchanged" : "modified" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...record, state: "missing" };
    }
    return {
      ...record,
      state: "unsafe",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function removeClawWorkspaceFile(
  record: ClawRemovableWorkspaceFile,
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
      maxBytes: 1024 * 1024,
      symlinks: "reject",
    });
    if (!(await workspace.exists(record.path))) {
      return { path: record.path, action: "missing" };
    }
    const stagedPath = `${record.path}.openclaw-claw-remove-${randomUUID()}`;
    await workspace.move(record.path, stagedPath, { overwrite: false });
    const content = await workspace.readBytes(stagedPath, { maxBytes: 1024 * 1024 });
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
  complete: boolean,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    if (clawStateTableExists(db, "claw_workspace_files")) {
      for (const file of files.filter((candidate) => candidate.action !== "error")) {
        db /* sqlite-allow-raw: remove one owned Claw workspace-file row. */
          .prepare("DELETE FROM claw_workspace_files WHERE agent_id = ? AND target_path = ?")
          .run(agentId, file.path);
      }
    }
    if (!complete) {
      return;
    }
    if (clawStateTableExists(db, "claw_package_refs")) {
      db /* sqlite-allow-raw: release package refs for a removed Claw agent. */
        .prepare("DELETE FROM claw_package_refs WHERE agent_id = ?")
        .run(agentId);
    }
    if (clawStateTableExists(db, "claw_installs")) {
      db /* sqlite-allow-raw: remove the completed Claw install owner row. */
        .prepare("DELETE FROM claw_installs WHERE agent_id = ?")
        .run(agentId);
    }
  }, options);
}
