import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable, Updateable } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { ensureSessionRepositoryWorkspaceSchema } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB, SessionRepositoryWorkspaces } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";

export type SessionRepositoryWorkspaceRecord = {
  workspaceId: string;
  agentId: string;
  sessionKey: string;
  url: string;
  requestedRef: string | null;
  runSetupScript: boolean;
  baseCommit: string | null;
  baseManifestHash: string | null;
  branch: string;
  checkpointRef: string | null;
  manifestHash: string | null;
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
};

type WorkspaceOwner = { agentId: string; sessionKey: string };
type WorkspaceMutation = {
  workspaceId: string;
  expectedRevision: number;
  assertCurrent: () => void;
};
const table = "session_repository_workspaces";
const ensured = new WeakSet<DatabaseSync>();
const query = (db: DatabaseSync) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);
const manifestPattern = /^sha256:[a-f0-9]{64}$/u;
const resultRefPattern = /^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u;

function bounded(value: string, field: string, limit: number): string {
  const result = value.trim();
  if (!result || result.length > limit || /\p{Cc}/u.test(result)) {
    throw new Error(`Repository workspace ${field} is invalid`);
  }
  return result;
}

function project(row: Selectable<SessionRepositoryWorkspaces>): SessionRepositoryWorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    url: row.url,
    requestedRef: row.requested_ref,
    runSetupScript: row.run_setup_script === 1,
    baseCommit: row.base_commit,
    baseManifestHash: row.base_manifest_hash,
    branch: row.branch,
    checkpointRef: row.checkpoint_ref,
    manifestHash: row.manifest_hash,
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function createSessionRepositoryWorkspaceStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const databasePath = (options.database ?? openOpenClawStateDatabase()).path;
  const now = options.now ?? Date.now;
  const read = () => openOpenClawStateDatabase({ path: databasePath }).db;
  const write = <T>(operation: (db: DatabaseSync) => T) =>
    runOpenClawStateWriteTransaction(({ db }) => operation(db), { path: databasePath });
  const ensure = () => {
    const db = read();
    if (!ensured.has(db)) {
      write(ensureSessionRepositoryWorkspaceSchema);
      // A surrounding session transaction may still roll back its first use.
      // Cache only committed DDL, otherwise the next create loses its table.
      if (!db.isTransaction) {
        ensured.add(db);
      }
    }
  };
  const get = (workspaceId: string): SessionRepositoryWorkspaceRecord | undefined => {
    const db = read();
    if (!tableExists(db, table)) {
      return undefined;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      query(db).selectFrom(table).selectAll().where("workspace_id", "=", workspaceId),
    );
    return row ? project(row) : undefined;
  };
  const find = (owner: WorkspaceOwner): SessionRepositoryWorkspaceRecord | undefined => {
    const db = read();
    if (!tableExists(db, table)) {
      return undefined;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      query(db)
        .selectFrom(table)
        .selectAll()
        .where("agent_id", "=", owner.agentId)
        .where("session_key", "=", owner.sessionKey),
    );
    return row ? project(row) : undefined;
  };
  const mutate = (
    input: WorkspaceMutation,
    values: (current: SessionRepositoryWorkspaceRecord) => Updateable<SessionRepositoryWorkspaces>,
  ): SessionRepositoryWorkspaceRecord =>
    write((db) => {
      const current = get(input.workspaceId);
      if (!current || current.revision !== input.expectedRevision) {
        throw new Error("Repository workspace revision changed");
      }
      if (!Number.isSafeInteger(current.revision + 1)) {
        throw new Error("Repository workspace revision is exhausted");
      }
      const patch = values(current);
      input.assertCurrent();
      const updated = executeSqliteQueryTakeFirstSync(
        db,
        query(db)
          .updateTable(table)
          .set({ ...patch, revision: current.revision + 1, updated_at_ms: now() })
          .where("workspace_id", "=", input.workspaceId)
          .where("revision", "=", input.expectedRevision)
          .returningAll(),
      );
      if (!updated) {
        throw new Error("Repository workspace revision changed");
      }
      return project(updated);
    });
  const artifactPath = (workspaceId: string): string => {
    if (!/^[a-f0-9-]{36}$/u.test(workspaceId)) {
      throw new Error("Repository workspace id is invalid");
    }
    return path.join(path.dirname(databasePath), "repository-workspaces", `${workspaceId}.git`);
  };
  return {
    path: databasePath,
    artifactPath,
    get,
    find,
    create(
      input: WorkspaceOwner & {
        url: string;
        requestedRef?: string;
        runSetupScript?: boolean;
        branch?: string;
        assertCurrent: () => void;
      },
    ): SessionRepositoryWorkspaceRecord {
      const agentId = bounded(input.agentId, "agent id", 128);
      const sessionKey = bounded(input.sessionKey, "session key", 1024);
      const url = bounded(input.url, "URL", 4096);
      const requestedRef =
        input.requestedRef === undefined ? null : bounded(input.requestedRef, "ref", 1024);
      const branch = input.branch === undefined ? undefined : bounded(input.branch, "branch", 256);
      input.assertCurrent();
      ensure();
      return write((db) => {
        input.assertCurrent();
        const existing = find({ agentId, sessionKey });
        if (existing) {
          if (
            existing.url !== url ||
            existing.requestedRef !== requestedRef ||
            (branch !== undefined && existing.branch !== branch)
          ) {
            throw new Error("Session already owns a different repository workspace");
          }
          return existing;
        }
        const workspaceId = randomUUID();
        const timestamp = now();
        const inserted = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .insertInto(table)
            .values({
              workspace_id: workspaceId,
              agent_id: agentId,
              session_key: sessionKey,
              url,
              requested_ref: requestedRef,
              run_setup_script: input.runSetupScript ? 1 : 0,
              base_commit: null,
              base_manifest_hash: null,
              branch: branch ?? `openclaw/${workspaceId}`,
              checkpoint_ref: null,
              manifest_hash: null,
              revision: 0,
              created_at_ms: timestamp,
              updated_at_ms: timestamp,
            })
            .returningAll(),
        );
        if (!inserted) {
          throw new Error("Repository workspace creation failed");
        }
        return project(inserted);
      });
    },
    bindBase(
      input: WorkspaceMutation & { baseCommit: string; baseManifestHash?: string },
    ): SessionRepositoryWorkspaceRecord {
      if (
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.baseCommit) ||
        (input.baseManifestHash !== undefined && !manifestPattern.test(input.baseManifestHash))
      ) {
        throw new Error("Repository workspace base is invalid");
      }
      return mutate(input, (current) => {
        if (
          (current.baseCommit !== null && current.baseCommit !== input.baseCommit) ||
          (current.baseManifestHash !== null &&
            input.baseManifestHash !== undefined &&
            current.baseManifestHash !== input.baseManifestHash)
        ) {
          throw new Error("Repository workspace base changed");
        }
        return {
          base_commit: input.baseCommit,
          ...(input.baseManifestHash ? { base_manifest_hash: input.baseManifestHash } : {}),
        };
      });
    },
    acceptCheckpoint(
      input: WorkspaceMutation & { checkpointRef: string; manifestHash: string },
    ): SessionRepositoryWorkspaceRecord {
      if (
        !resultRefPattern.test(input.checkpointRef) ||
        !manifestPattern.test(input.manifestHash)
      ) {
        throw new Error("Repository workspace checkpoint is invalid");
      }
      return mutate(input, (current) => {
        if (!current.baseCommit || !current.baseManifestHash) {
          throw new Error("Repository workspace base has not been captured");
        }
        return { checkpoint_ref: input.checkpointRef, manifest_hash: input.manifestHash };
      });
    },
    async delete(input: { workspaceId: string; assertCurrent: () => void }): Promise<void> {
      const root = artifactPath(input.workspaceId);
      write((db) => {
        input.assertCurrent();
        if (tableExists(db, table)) {
          executeSqliteQueryTakeFirstSync(
            db,
            query(db).deleteFrom(table).where("workspace_id", "=", input.workspaceId),
          );
        }
      });
      // The row disappears first: an interrupted cleanup leaves only unowned artifacts.
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

export type SessionRepositoryWorkspaceStore = ReturnType<
  typeof createSessionRepositoryWorkspaceStore
>;

/** Resolve on use so loading admission code does not open shared state. */
export function getSessionRepositoryWorkspaceStore(): SessionRepositoryWorkspaceStore {
  return createSessionRepositoryWorkspaceStore();
}
