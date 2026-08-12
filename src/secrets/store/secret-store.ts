import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { Selectable } from "kysely";
import { ENV_SECRET_REF_ID_RE } from "../../config/types.secrets.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../../infra/sqlite-number.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { ensureSecretStoreSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

type SecretStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;
type SecretStoreRow = Selectable<OpenClawStateKyselyDatabase["secret_store_entries"]>;
type SecretStoreScope = { kind: "team" };
type SecretStoreKind = "secret" | "env";

export type SecretStoreEntryMetadata = {
  name: string;
  kind: SecretStoreKind;
  scopeKind: "team" | "identity";
  scopeId: string;
  updatedAtMs: number;
  createdAtMs: number;
  updatedBy: string | null;
  valuePreview?: string;
};

type SecretStoreReadError =
  | { code: "SECRET_STORE_NOT_FOUND"; message: string }
  | { code: "SECRET_STORE_INVALID_NAME"; message: string }
  | { code: "SECRET_STORE_UNAVAILABLE"; message: string; cause: unknown };

type SecretStoreValidationCode =
  | "SECRET_STORE_INVALID_NAME"
  | "SECRET_STORE_VALUE_TOO_LARGE"
  | "SECRET_STORE_VALUE_EMPTY";

export class SecretStoreValidationError extends Error {
  constructor(
    readonly code: SecretStoreValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreValidationError";
  }
}

export const SECRET_STORE_VALUE_MAX_BYTES = 64 * 1024;
const SECRET_STORE_RETENTION_MS = 30 * 24 * 60 * 60_000;

function normalizeScope(_scope: SecretStoreScope): { scopeKind: "team"; scopeId: "" } {
  return { scopeKind: "team", scopeId: "" };
}

function assertSecretStoreName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name)) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      `Secret store name must match ${String(ENV_SECRET_REF_ID_RE)}.`,
    );
  }
}

function assertSecretStoreValue(value: string, kind: SecretStoreKind): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > SECRET_STORE_VALUE_MAX_BYTES) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_TOO_LARGE",
      `Secret store value exceeds ${SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  // An empty credential is never meaningful and cannot be diagnosed later: `get`
  // refuses secret kinds and listings mask them, so a silently-empty secret (a
  // failed `op read |` pipe, for example) would surface only as a confusing 401.
  // Env entries may legitimately be empty.
  if (kind === "secret" && value.length === 0) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_EMPTY",
      "Secret store value is empty. Secret entries require a value; check the command that produced it.",
    );
  }
}

function isMissingSecretStoreTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    error.message === "no such table: secret_store_entries"
  );
}

function toMetadata(row: SecretStoreRow): SecretStoreEntryMetadata {
  if (row.kind === "secret") {
    registerSecretValueForRedaction(row.value);
  }
  return {
    name: row.name,
    kind: row.kind as SecretStoreKind,
    scopeKind: row.scope_kind as "team" | "identity",
    scopeId: row.scope_id,
    updatedAtMs: normalizeSqliteNumber(row.updated_at_ms) ?? 0,
    createdAtMs: normalizeSqliteNumber(row.created_at_ms) ?? 0,
    updatedBy: row.updated_by,
    ...(row.kind === "env" ? { valuePreview: row.value } : {}),
  };
}

export function listSecretStoreEntries(params: {
  scope: SecretStoreScope;
  includeDeleted?: boolean;
  database?: OpenClawStateDatabaseOptions;
}): SecretStoreEntryMetadata[] {
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        let query = db
          .selectFrom("secret_store_entries")
          .selectAll()
          .where("scope_kind", "=", scopeKind)
          .where("scope_id", "=", scopeId)
          .orderBy("name", "asc");
        if (!params.includeDeleted) {
          query = query.where("deleted_at_ms", "is", null);
        }
        return executeSqliteQuerySync(sqlite, query).rows.map(toMetadata);
      }, params.database ?? {}) ?? []
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return [];
    }
    throw error;
  }
}

export function readSecretStoreValue(params: {
  scope: SecretStoreScope;
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): Result<string, SecretStoreReadError> {
  try {
    assertSecretStoreName(params.name);
    const { scopeKind, scopeId } = normalizeScope(params.scope);
    const row = withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      return executeSqliteQueryTakeFirstSync(
        sqlite,
        db
          .selectFrom("secret_store_entries")
          .select(["value", "kind"])
          .where("scope_kind", "=", scopeKind)
          .where("scope_id", "=", scopeId)
          .where("name", "=", params.name)
          .where("deleted_at_ms", "is", null),
      );
    }, params.database ?? {});
    if (!row) {
      return err({
        code: "SECRET_STORE_NOT_FOUND",
        message: `Secret store entry "${params.name}" was not found.`,
      });
    }
    if (row.kind === "secret") {
      registerSecretValueForRedaction(row.value);
    }
    return ok(row.value);
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return err({
        code: "SECRET_STORE_NOT_FOUND",
        message: `Secret store entry "${params.name}" was not found.`,
      });
    }
    if (error instanceof SecretStoreValidationError) {
      return err({ code: "SECRET_STORE_INVALID_NAME", message: error.message });
    }
    return err({
      code: "SECRET_STORE_UNAVAILABLE",
      message: "Secret store database is unavailable.",
      cause: error,
    });
  }
}

export function writeSecretStoreEntry(params: {
  scope: SecretStoreScope;
  name: string;
  value: string;
  kind: SecretStoreKind;
  updatedBy: string | null;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertSecretStoreName(params.name);
  assertSecretStoreValue(params.value, params.kind);
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      ensureSecretStoreSchema(sqlite);
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("secret_store_entries")
          .values({
            scope_kind: scopeKind,
            scope_id: scopeId,
            name: params.name,
            value: params.value,
            kind: params.kind,
            created_at_ms: now,
            updated_at_ms: now,
            updated_by: params.updatedBy,
            deleted_at_ms: null,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet({
              value: params.value,
              kind: params.kind,
              updated_at_ms: now,
              updated_by: params.updatedBy,
              deleted_at_ms: null,
            }),
          ),
      );
    },
    params.database,
    { operationLabel: "secrets.store.write" },
  );
}

export function deleteSecretStoreEntry(params: {
  scope: SecretStoreScope;
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertSecretStoreName(params.name);
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  const state = openOpenClawStateDatabase(params.database);
  const now = Date.now();
  try {
    runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        executeSqliteQuerySync(
          sqlite,
          db
            .updateTable("secret_store_entries")
            .set({ deleted_at_ms: now, updated_at_ms: now })
            .where("scope_kind", "=", scopeKind)
            .where("scope_id", "=", scopeId)
            .where("name", "=", params.name)
            .where("deleted_at_ms", "is", null),
        );
      },
      { ...params.database, database: state },
      { operationLabel: "secrets.store.delete" },
    );
  } catch (error) {
    if (!isMissingSecretStoreTableError(error)) {
      throw error;
    }
  }
}

export function purgeExpiredSecretStoreEntries(
  params: {
    database?: OpenClawStateDatabaseOptions;
  } = {},
): number {
  const state = openOpenClawStateDatabase(params.database);
  const threshold = Date.now() - SECRET_STORE_RETENTION_MS;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const deleted = executeSqliteQuerySync(
          sqlite,
          db
            .deleteFrom("secret_store_entries")
            .where("deleted_at_ms", "is not", null)
            .where("deleted_at_ms", "<", threshold),
        );
        return Number(deleted.numAffectedRows ?? 0n);
      },
      { ...params.database, database: state },
      { operationLabel: "secrets.store.purge" },
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return 0;
    }
    throw error;
  }
}
