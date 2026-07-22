// Creates Claw-owned bootstrap and supporting files inside the new agent workspace.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawDiagnostic } from "./types.js";

const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION = "openclaw.clawWorkspaceFileRecord.v1" as const;

const MAX_CLAW_WORKSPACE_FILE_BYTES = 1024 * 1024;

export type PersistedClawWorkspaceFile = {
  schemaVersion: typeof CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION;
  agentId: string;
  workspace: string;
  path: string;
  sourcePath: string;
  contentDigest: string;
  status: "pending" | "complete" | "failed";
  createdAtMs: number;
  updatedAtMs: number;
};

export class ClawWorkspaceWriteError extends Error {
  constructor(
    readonly diagnostics: ClawDiagnostic[],
    readonly createdFiles: PersistedClawWorkspaceFile[],
  ) {
    super("Claw workspace file creation failed");
    this.name = "ClawWorkspaceWriteError";
  }
}

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

function rowToWorkspaceFile(row: WorkspaceFileRow): PersistedClawWorkspaceFile {
  return {
    schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
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

function diagnostic(action: ClawAddPlanAction, code: string, message: string): ClawDiagnostic {
  return {
    level: "error",
    code,
    phase: "mutation",
    path: `$.workspace[${JSON.stringify(action.id)}]`,
    message,
  };
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function containedRelativePath(root: string, path: string): string | undefined {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return undefined;
  }
  return child;
}

function persistWorkspaceFile(
  record: PersistedClawWorkspaceFile,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
    db.prepare(
      `INSERT INTO claw_workspace_files (
         agent_id, target_path, schema_version, workspace, source_path,
         content_digest, status, created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @target_path, @schema_version, @workspace, @source_path,
         @content_digest, @status, @created_at_ms, @updated_at_ms
       )`,
    ).run({
      agent_id: record.agentId,
      target_path: record.path,
      schema_version: record.schemaVersion,
      workspace: record.workspace,
      source_path: record.sourcePath,
      content_digest: record.contentDigest,
      status: record.status,
      created_at_ms: record.createdAtMs,
      updated_at_ms: record.updatedAtMs,
    });
  }, options);
}

type PersistedClawWorkspaceFileRow = {
  schema_version: string;
  agent_id: string;
  workspace: string;
  target_path: string;
  source_path: string;
  content_digest: string;
  status: string;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function readWorkspaceFile(
  agentId: string,
  targetPath: string,
  options: OpenClawStateDatabaseOptions,
): PersistedClawWorkspaceFile | undefined {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const statement = db /* sqlite-allow-raw: one owned Claw state-table row */
      .prepare(
        `SELECT schema_version, agent_id, workspace, target_path, source_path,
              content_digest, status, created_at_ms, updated_at_ms
         FROM claw_workspace_files
        WHERE agent_id = ? AND target_path = ?`,
      );
    const row = statement.get(agentId, targetPath) as PersistedClawWorkspaceFileRow | undefined;
    if (!row) {
      return undefined;
    }
    if (
      row.schema_version !== CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION ||
      (row.status !== "pending" && row.status !== "complete" && row.status !== "failed")
    ) {
      throw new Error(
        `Claw workspace file ${JSON.stringify(targetPath)} has unsupported provenance state.`,
      );
    }
    return {
      schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
      agentId: row.agent_id,
      workspace: row.workspace,
      path: row.target_path,
      sourcePath: row.source_path,
      contentDigest: row.content_digest,
      status: row.status,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }, options);
}

function sameWorkspaceFileOwner(
  existing: PersistedClawWorkspaceFile,
  expected: PersistedClawWorkspaceFile,
): boolean {
  return (
    existing.schemaVersion === expected.schemaVersion &&
    existing.agentId === expected.agentId &&
    existing.workspace === expected.workspace &&
    existing.path === expected.path &&
    existing.sourcePath === expected.sourcePath &&
    existing.contentDigest === expected.contentDigest
  );
}

function updateWorkspaceFileStatus(
  record: PersistedClawWorkspaceFile,
  expectedStatuses: PersistedClawWorkspaceFile["status"][],
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const expectedPlaceholders = expectedStatuses.map(() => "?").join(", ");
    const statement = db /* sqlite-allow-raw: one owned Claw state-table row */
      .prepare(
        `UPDATE claw_workspace_files
          SET status = ?, updated_at_ms = ?
        WHERE agent_id = ? AND target_path = ?
          AND status IN (${expectedPlaceholders})`,
      );
    const result = statement.run(
      record.status,
      record.updatedAtMs,
      record.agentId,
      record.path,
      ...expectedStatuses,
    );
    if (Number(result.changes) !== 1) {
      throw new Error(
        `Claw workspace file ${JSON.stringify(record.path)} changed ownership state concurrently.`,
      );
    }
  }, options);
}

function workspaceFileActions(plan: ClawAddPlan): ClawAddPlanAction[] {
  return plan.actions.filter((action) => action.kind === "workspaceFile");
}

export function readClawWorkspaceFiles(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawWorkspaceFile[] {
  const database = openOpenClawStateDatabase(options);
  // sqlite-allow-raw: read-only Claw workspace-file lookup with a closed agent-id filter.
  const rows =
    database.db /* sqlite-allow-raw: read-only Claw workspace-file lookup with a closed agent-id filter. */
      .prepare(
        `SELECT schema_version, agent_id, workspace, target_path, source_path,
              content_digest, status, created_at_ms, updated_at_ms
         FROM claw_workspace_files
        WHERE agent_id = ?
        ORDER BY target_path`,
      )
      .all(agentId) as WorkspaceFileRow[];
  return rows.map(rowToWorkspaceFile);
}

export async function createClawWorkspaceFiles(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<PersistedClawWorkspaceFile[]> {
  const actions = workspaceFileActions(plan);
  if (actions.length === 0) {
    return [];
  }

  const workspaceRoot = await realpath(resolve(plan.agent.workspace));
  const packageRoot = await realpath(resolve(plan.claw.packageRoot));
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const createdFiles: PersistedClawWorkspaceFile[] = [];
  const nowMs = options.nowMs ?? Date.now();

  for (const action of actions) {
    try {
      if (!action.source || !action.digest) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_plan_invalid",
              "File action lacks source or digest.",
            ),
          ],
          createdFiles,
        );
      }
      const sourcePath = resolve(action.source);
      const targetPath = resolve(action.target);
      const sourceRelative = containedRelativePath(packageRoot, sourcePath);
      const targetRelative = containedRelativePath(workspaceRoot, targetPath);
      if (!sourceRelative || !targetRelative) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_path_escape",
              "Workspace file source and destination must remain inside their owned roots.",
            ),
          ],
          createdFiles,
        );
      }
      const read = await source.read(sourceRelative, {
        hardlinks: "reject",
        maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
        symlinks: "reject",
      });
      if (resolve(read.realPath) !== sourcePath) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_path_alias",
              `Workspace source ${JSON.stringify(action.id)} no longer resolves to the consented file.`,
            ),
          ],
          createdFiles,
        );
      }
      const digest = contentDigest(read.buffer);
      if (digest !== action.digest) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_source_changed",
              `Workspace source for ${JSON.stringify(action.id)} changed after planning.`,
            ),
          ],
          createdFiles,
        );
      }
      const expectedRecord: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        workspace: workspace.rootReal,
        path: targetRelative.replaceAll(sep, "/"),
        sourcePath: sourceRelative.replaceAll(sep, "/"),
        contentDigest: digest,
        status: "pending",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      const existingRecord = readWorkspaceFile(
        expectedRecord.agentId,
        expectedRecord.path,
        options,
      );
      if (existingRecord && !sameWorkspaceFileOwner(existingRecord, expectedRecord)) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_ownership_conflict",
              `Workspace destination ${JSON.stringify(targetRelative)} is already claimed by different Claw provenance.`,
            ),
          ],
          createdFiles,
        );
      }
      if (await workspace.exists(targetRelative)) {
        if (!existingRecord || existingRecord.status === "failed") {
          throw new ClawWorkspaceWriteError(
            [
              diagnostic(
                action,
                "workspace_file_collision",
                `Workspace destination ${JSON.stringify(targetRelative)} already exists.`,
              ),
            ],
            createdFiles,
          );
        }
        const existingTarget = await workspace.read(targetRelative, {
          hardlinks: "reject",
          maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
          symlinks: "reject",
        });
        if (contentDigest(existingTarget.buffer) !== expectedRecord.contentDigest) {
          throw new ClawWorkspaceWriteError(
            [
              diagnostic(
                action,
                "workspace_file_drift",
                `Claw-owned workspace destination ${JSON.stringify(targetRelative)} no longer matches its recorded content.`,
              ),
            ],
            createdFiles,
          );
        }
        const previousStatus = existingRecord.status;
        existingRecord.status = "complete";
        existingRecord.updatedAtMs = nowMs;
        updateWorkspaceFileStatus(existingRecord, [previousStatus], options);
        createdFiles.push(existingRecord);
        continue;
      }
      const record = existingRecord ?? expectedRecord;
      if (existingRecord) {
        const previousStatus = record.status;
        record.status = "pending";
        record.updatedAtMs = nowMs;
        updateWorkspaceFileStatus(record, [previousStatus], options);
      } else {
        persistWorkspaceFile(record, options);
      }
      try {
        await workspace.write(targetRelative, read.buffer, { mkdir: true, overwrite: false });
        record.status = "complete";
        updateWorkspaceFileStatus(record, ["pending"], options);
        createdFiles.push(record);
      } catch (error) {
        record.status = "failed";
        try {
          updateWorkspaceFileStatus(record, ["pending"], options);
        } catch {
          // A pending row intentionally remains as evidence of uncertain owner state.
          record.status = "pending";
        }
        createdFiles.push(record);
        throw error;
      }
    } catch (error) {
      if (error instanceof ClawWorkspaceWriteError) {
        throw error;
      }
      const code =
        error instanceof FsSafeError ? `workspace_file_${error.code}` : "workspace_file_io_error";
      throw new ClawWorkspaceWriteError(
        [diagnostic(action, code, error instanceof Error ? error.message : String(error))],
        createdFiles,
      );
    }
  }
  return createdFiles;
}
