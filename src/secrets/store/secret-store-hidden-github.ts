import type { Selectable } from "kysely";
import { hasErrnoCode } from "../../infra/errno.js";
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
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";

type HiddenGitHubStoreDatabase = Pick<OpenClawStateKyselyDatabase, "secret_store_entries">;
type HiddenGitHubStoreRow = Selectable<OpenClawStateKyselyDatabase["secret_store_entries"]>;
type HiddenGitHubStoreKind = "device" | "oauth";
type HiddenGitHubStoreNameKind = "setup" | HiddenGitHubStoreKind;
type HiddenGitHubStorePrefix = "github-device" | "github-oauth";

export const GITHUB_SETUP_HANDOFF_MAX_AGE_MS = 10 * 60_000;
export const GITHUB_DEVICE_STORE_MAX_AGE_MS = 15 * 60_000;
const HIDDEN_GITHUB_STORE_NAME_PATTERN = /^github-(setup|device|oauth)-[a-f0-9]{32}$/u;

export function classifyHiddenGitHubStoreName(name: string): HiddenGitHubStoreNameKind | undefined {
  const kind = HIDDEN_GITHUB_STORE_NAME_PATTERN.exec(name)?.[1];
  return kind === "setup" || kind === "device" || kind === "oauth" ? kind : undefined;
}

function assertHiddenGitHubSecretRecordName(name: string): HiddenGitHubStoreKind {
  const kind = classifyHiddenGitHubStoreName(name);
  if (kind !== "device" && kind !== "oauth") {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      "Hidden GitHub secret record name must match github-device-<32 lowercase hex characters> or github-oauth-<32 lowercase hex characters>.",
    );
  }
  return kind;
}

function hiddenGitHubStoreKindFromPrefix(prefix: HiddenGitHubStorePrefix): HiddenGitHubStoreKind {
  if (prefix === "github-device") {
    return "device";
  }
  if (prefix === "github-oauth") {
    return "oauth";
  }
  throw new SecretStoreValidationError(
    "SECRET_STORE_INVALID_NAME",
    'Hidden GitHub secret record prefix must be "github-device" or "github-oauth".',
  );
}

function isMissingSecretStoreTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
    error.message === "no such table: secret_store_entries"
  );
}

function validateHiddenGitHubSecretValue(value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > SECRET_STORE_VALUE_MAX_BYTES) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_TOO_LARGE",
      `Secret store value exceeds ${SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (value.length === 0) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_VALUE_EMPTY",
      "Secret store value is empty. Secret entries require a value; check the command that produced it.",
    );
  }
}

function isLiveHiddenGitHubStoreRow(
  row: Pick<HiddenGitHubStoreRow, "created_at_ms" | "updated_at_ms">,
  kind: HiddenGitHubStoreKind,
  now: number,
): boolean {
  const createdAtMs = normalizeSqliteNumber(row.created_at_ms);
  const updatedAtMs = normalizeSqliteNumber(row.updated_at_ms);
  return (
    createdAtMs !== undefined &&
    updatedAtMs !== undefined &&
    createdAtMs <= now &&
    (kind !== "device" || createdAtMs > now - GITHUB_DEVICE_STORE_MAX_AGE_MS)
  );
}

/** Writes one hidden GitHub authorization record without exposing a generic mutation path. */
export function writeHiddenGitHubSecretRecord(params: {
  name: string;
  value: string;
  updatedBy?: string | null;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertHiddenGitHubSecretRecordName(params.name);
  validateHiddenGitHubSecretValue(params.value);
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      ensureSecretStoreSchema(sqlite);
      const db = getNodeSqliteKysely<HiddenGitHubStoreDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("secret_store_entries")
          .values({
            scope_kind: "team",
            scope_id: "",
            name: params.name,
            value: params.value,
            kind: "secret",
            created_at_ms: now,
            updated_at_ms: now,
            updated_by: params.updatedBy ?? null,
            deleted_at_ms: null,
            allowed_hosts: null,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet({
              value: params.value,
              kind: "secret",
              updated_at_ms: now,
              updated_by: params.updatedBy ?? null,
              deleted_at_ms: null,
              allowed_hosts: null,
            }),
          ),
      );
    },
    params.database,
    { operationLabel: "secrets.store.write" },
  );
  registerSecretValueForRedaction(params.value);
}

/** Reads one exact live hidden GitHub authorization record. */
export function readHiddenGitHubSecretRecord(params: {
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): string | undefined {
  const kind = assertHiddenGitHubSecretRecordName(params.name);
  try {
    const row = withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
      const db = getNodeSqliteKysely<HiddenGitHubStoreDatabase>(sqlite);
      return executeSqliteQueryTakeFirstSync(
        sqlite,
        db
          .selectFrom("secret_store_entries")
          .select(["name", "value", "created_at_ms", "updated_at_ms"])
          .where("scope_kind", "=", "team")
          .where("scope_id", "=", "")
          .where("name", "=", params.name)
          .where("kind", "=", "secret")
          .where("allowed_hosts", "is", null)
          .where("deleted_at_ms", "is", null),
      );
    }, params.database ?? {});
    if (!row || !isLiveHiddenGitHubStoreRow(row, kind, Date.now())) {
      return undefined;
    }
    registerSecretValueForRedaction(row.value);
    return row.value;
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Lists live hidden GitHub authorization records of one exact class. */
export function listHiddenGitHubSecretRecordNames(params: {
  prefix: HiddenGitHubStorePrefix;
  database?: OpenClawStateDatabaseOptions;
}): string[] {
  try {
    const now = Date.now();
    const kind = hiddenGitHubStoreKindFromPrefix(params.prefix);
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<HiddenGitHubStoreDatabase>(sqlite);
        const rows = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select(["name", "value", "created_at_ms", "updated_at_ms"])
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("kind", "=", "secret")
            .where("allowed_hosts", "is", null)
            .where("deleted_at_ms", "is", null)
            .orderBy("name", "asc"),
        ).rows;
        return rows.flatMap((row) => {
          if (
            classifyHiddenGitHubStoreName(row.name) !== kind ||
            !isLiveHiddenGitHubStoreRow(row, kind, now)
          ) {
            return [];
          }
          registerSecretValueForRedaction(row.value);
          return [row.name];
        });
      }, params.database ?? {}) ?? []
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return [];
    }
    throw error;
  }
}

/** Hard-deletes one exact hidden GitHub authorization record. */
export function deleteHiddenGitHubSecretRecord(params: {
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertHiddenGitHubSecretRecordName(params.name);
  try {
    runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<HiddenGitHubStoreDatabase>(sqlite);
        executeSqliteQuerySync(
          sqlite,
          db
            .deleteFrom("secret_store_entries")
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("name", "=", params.name),
        );
      },
      params.database,
      { operationLabel: "secrets.store.delete-hidden-github" },
    );
  } catch (error) {
    if (!isMissingSecretStoreTableError(error)) {
      throw error;
    }
  }
}
