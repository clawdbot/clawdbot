// Creates Claw-owned bootstrap and supporting files inside the new agent workspace.
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { Selectable } from "kysely";
import { root as fsSafeRoot, FsSafeError, type Root } from "../infra/fs-safe.js";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { clawContainedRelativePath } from "./path-containment.js";
import { parseClawMarkdown } from "./reader.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawDiagnostic } from "./types.js";

export const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION =
  "openclaw.clawWorkspaceFileRecord.v1" as const;

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

class ClawWorkspaceSourceAliasError extends Error {}

type WorkspaceDatabase = Pick<DB, "claw_workspace_files">;
type WorkspaceFileRow = Selectable<DB["claw_workspace_files"]>;

function selectWorkspaceFiles(db: DatabaseSync) {
  return getNodeSqliteKysely<WorkspaceDatabase>(db)
    .selectFrom("claw_workspace_files")
    .select([
      "schema_version",
      "agent_id",
      "workspace",
      "target_path",
      "source_path",
      "content_digest",
      "status",
      "created_at_ms",
      "updated_at_ms",
    ]);
}

function rowToWorkspaceFile(
  row: WorkspaceFileRow,
  schemaVersion: PersistedClawWorkspaceFile["schemaVersion"] = CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
): PersistedClawWorkspaceFile {
  return {
    schemaVersion,
    agentId: row.agent_id,
    workspace: row.workspace,
    path: row.target_path,
    sourcePath: row.source_path,
    contentDigest: row.content_digest,
    // SAFETY: Inventory keeps its unchecked status contract; the retry reader validates it first.
    status: row.status as PersistedClawWorkspaceFile["status"],
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

function workspaceFileToRow(record: PersistedClawWorkspaceFile): WorkspaceFileRow {
  return {
    agent_id: record.agentId,
    target_path: record.path,
    schema_version: record.schemaVersion,
    workspace: record.workspace,
    source_path: record.sourcePath,
    content_digest: record.contentDigest,
    status: record.status,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
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

export async function readClawWorkspaceActionSource(params: {
  action: ClawAddPlanAction;
  packageRoot: string;
  sourceRoot: Root;
}): Promise<{ content: Buffer; sourcePath: string; sourceRelative: string }> {
  if (!params.action.source) {
    throw new Error("Workspace file action lacks a source.");
  }
  const sourcePath = resolve(params.action.source);
  const sourceRelative = clawContainedRelativePath(params.packageRoot, sourcePath);
  if (!sourceRelative) {
    throw new Error("Workspace file source must remain inside the Claw package.");
  }
  const read = await params.sourceRoot.read(sourceRelative, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  if (resolve(read.realPath) !== sourcePath) {
    throw new ClawWorkspaceSourceAliasError(
      "Workspace source no longer resolves to the consented file.",
    );
  }
  if (params.action.sourceKind !== "clawMarkdownBody") {
    return { content: read.buffer, sourcePath, sourceRelative };
  }
  const parsed = parseClawMarkdown(read.buffer, sourcePath);
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics.map((item) => item.message).join("; "));
  }
  return { content: parsed.body, sourcePath, sourceRelative };
}

function persistWorkspaceFile(
  record: PersistedClawWorkspaceFile,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WorkspaceDatabase>(db)
        .insertInto("claw_workspace_files")
        .values(workspaceFileToRow(record)),
    );
  }, options);
}

function readWorkspaceFile(
  agentId: string,
  targetPath: string,
  options: OpenClawStateDatabaseOptions,
): PersistedClawWorkspaceFile | undefined {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const row = executeSqliteQueryTakeFirstSync(
      db,
      selectWorkspaceFiles(db)
        .where("agent_id", "=", agentId)
        .where("target_path", "=", targetPath)
        .limit(1),
    );
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
    return rowToWorkspaceFile(row);
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
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WorkspaceDatabase>(db)
        .updateTable("claw_workspace_files")
        .set({ status: record.status, updated_at_ms: record.updatedAtMs })
        .where("agent_id", "=", record.agentId)
        .where("target_path", "=", record.path)
        .where("status", "in", expectedStatuses),
    );
    if (result.numAffectedRows !== 1n) {
      throw new Error(
        `Claw workspace file ${JSON.stringify(record.path)} changed ownership state concurrently.`,
      );
    }
  }, options);
}

export function upsertClawWorkspaceFile(
  record: PersistedClawWorkspaceFile,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WorkspaceDatabase>(db)
        .insertInto("claw_workspace_files")
        .values(workspaceFileToRow(record))
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "target_path"]).doUpdateSet((eb) => ({
            schema_version: eb.ref("excluded.schema_version"),
            workspace: eb.ref("excluded.workspace"),
            source_path: eb.ref("excluded.source_path"),
            content_digest: eb.ref("excluded.content_digest"),
            status: eb.ref("excluded.status"),
            // Update rollback restores the complete prior record, including its creation time.
            created_at_ms: eb.ref("excluded.created_at_ms"),
            updated_at_ms: eb.ref("excluded.updated_at_ms"),
          })),
        ),
    );
  }, options);
}

export function deleteClawWorkspaceFileRecord(
  agentId: string,
  path: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WorkspaceDatabase>(db)
        .deleteFrom("claw_workspace_files")
        .where("agent_id", "=", agentId)
        .where("target_path", "=", path),
    );
  }, options);
}

function workspaceFileActions(plan: ClawAddPlan): ClawAddPlanAction[] {
  return plan.actions.filter((action) => action.kind === "workspaceFile");
}

export function readClawWorkspaceFiles(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawWorkspaceFile[] {
  const { db } = openOpenClawStateDatabase(options);
  if (options.readOnly && !tableExists(db, "claw_workspace_files")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string, WorkspaceFileRow>((parameter) =>
    selectWorkspaceFiles(db)
      .where(
        "agent_id",
        "=",
        parameter((value) => value),
      )
      .orderBy("target_path"),
  );
  const rows =
    db /* sqlite-allow-raw: preserve native list errors outside the write-transaction owner. */
      .prepare(compiled.sql)
      .all(...bind(agentId)) as WorkspaceFileRow[];
  return rows.map((row) => rowToWorkspaceFile(row));
}

export function readAllClawWorkspaceFiles(
  options: OpenClawStateDatabaseOptions,
): PersistedClawWorkspaceFile[] {
  const { db } = openOpenClawStateDatabase(options);
  if (!tableExists(db, "claw_workspace_files")) {
    return [];
  }
  const compiled = selectWorkspaceFiles(db).orderBy("agent_id").orderBy("target_path").compile();
  const rows =
    db /* sqlite-allow-raw: preserve native orphan inventory errors without a write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and shared explicit projection provide this generated row shape.
      .all() as WorkspaceFileRow[];
  // Orphan inventory reports the stored version; per-agent inventory uses the current constant.
  return rows.map((row) =>
    rowToWorkspaceFile(row, row.schema_version as PersistedClawWorkspaceFile["schemaVersion"]),
  );
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
      const targetPath = resolve(action.target);
      const targetRelative = clawContainedRelativePath(workspaceRoot, targetPath);
      if (!targetRelative) {
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
      const resolvedSource = await readClawWorkspaceActionSource({
        action,
        packageRoot,
        sourceRoot: source,
      });
      const digest = contentDigest(resolvedSource.content);
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
        sourcePath: resolvedSource.sourceRelative.replaceAll(sep, "/"),
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
        await workspace.write(targetRelative, resolvedSource.content, {
          mkdir: true,
          overwrite: false,
        });
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
        error instanceof ClawWorkspaceSourceAliasError
          ? "workspace_file_path_alias"
          : error instanceof FsSafeError
            ? `workspace_file_${error.code}`
            : "workspace_file_io_error";
      throw new ClawWorkspaceWriteError(
        [diagnostic(action, code, coerceErrorMessage(error))],
        createdFiles,
      );
    }
  }
  return createdFiles;
}
