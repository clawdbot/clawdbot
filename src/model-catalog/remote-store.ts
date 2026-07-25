import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

type RemoteModelCatalogDatabase = Pick<OpenClawStateKyselyDatabase, "model_catalog_remote">;
type RemoteModelCatalogStoreRow = Selectable<OpenClawStateKyselyDatabase["model_catalog_remote"]>;

type RemoteModelCatalogWriteResult =
  | { status: "written" }
  | { status: "retained-newer"; row: RemoteModelCatalogStoreRow };

const ensuredDatabases = new WeakSet<DatabaseSync>();
const REMOTE_MODEL_CATALOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS model_catalog_remote (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bundle_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  min_version TEXT,
  source_url TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  checked_at INTEGER NOT NULL
) STRICT;
`;

function ensureRemoteModelCatalogSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; catalog rows use Kysely below.
      db.exec(REMOTE_MODEL_CATALOG_SCHEMA_SQL);
    },
    options,
    { operationLabel: "model-catalog.remote.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function openDatabase(options: OpenClawStateDatabaseOptions) {
  ensureRemoteModelCatalogSchema(options);
  return openOpenClawStateDatabase(options);
}

export function readRemoteModelCatalog(
  options: OpenClawStateDatabaseOptions = {},
): RemoteModelCatalogStoreRow | undefined {
  const state = openDatabase(options);
  const db = getNodeSqliteKysely<RemoteModelCatalogDatabase>(state.db);
  return executeSqliteQueryTakeFirstSync(
    state.db,
    db.selectFrom("model_catalog_remote").selectAll().where("id", "=", 1),
  );
}

export function writeRemoteModelCatalog(
  row: Omit<RemoteModelCatalogStoreRow, "id">,
  options: OpenClawStateDatabaseOptions = {},
): RemoteModelCatalogWriteResult {
  ensureRemoteModelCatalogSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<RemoteModelCatalogDatabase>(sqlite);
      const current = executeSqliteQueryTakeFirstSync(
        sqlite,
        db.selectFrom("model_catalog_remote").selectAll().where("id", "=", 1),
      );
      // The CLI and Gateway can refresh concurrently in separate processes.
      // Compare under BEGIN IMMEDIATE so a slower stale response cannot win the singleton slot.
      if (
        current &&
        current.source_url === row.source_url &&
        (current.generated_at > row.generated_at ||
          (current.generated_at === row.generated_at && current.bundle_json !== row.bundle_json))
      ) {
        return { status: "retained-newer", row: current };
      }
      executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("model_catalog_remote")
          .values({ id: 1, ...row })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({
              bundle_json: row.bundle_json,
              generated_at: row.generated_at,
              min_version: row.min_version,
              source_url: row.source_url,
              etag: row.etag,
              last_modified: row.last_modified,
              checked_at: row.checked_at,
            }),
          ),
      );
      return { status: "written" };
    },
    options,
    { operationLabel: "model-catalog.remote.write" },
  );
}

export function markRemoteModelCatalogChecked(
  checkedAt: number,
  metadata: {
    expected: Pick<
      RemoteModelCatalogStoreRow,
      "source_url" | "generated_at" | "etag" | "last_modified"
    >;
    etag?: string | null;
    lastModified?: string | null;
  },
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  ensureRemoteModelCatalogSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<RemoteModelCatalogDatabase>(sqlite);
      let query = db
        .updateTable("model_catalog_remote")
        .set({
          checked_at: checkedAt,
          ...(metadata.etag !== undefined ? { etag: metadata.etag } : {}),
          ...(metadata.lastModified !== undefined ? { last_modified: metadata.lastModified } : {}),
        })
        .where("id", "=", 1)
        .where("source_url", "=", metadata.expected.source_url)
        .where("generated_at", "=", metadata.expected.generated_at);
      query =
        metadata.expected.etag === null
          ? query.where("etag", "is", null)
          : query.where("etag", "=", metadata.expected.etag);
      query =
        metadata.expected.last_modified === null
          ? query.where("last_modified", "is", null)
          : query.where("last_modified", "=", metadata.expected.last_modified);
      return executeSqliteQuerySync(sqlite, query).numAffectedRows === 1n;
    },
    options,
    { operationLabel: "model-catalog.remote.checked" },
  );
}
