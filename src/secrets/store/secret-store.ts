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
import { normalizeExactAllowedHost } from "../exact-hostname.js";
import { mintSecretSentinel } from "../sentinel.js";
import {
  classifyHiddenGitHubStoreName,
  GITHUB_DEVICE_STORE_MAX_AGE_MS,
  GITHUB_SETUP_HANDOFF_MAX_AGE_MS,
} from "./secret-store-hidden-github.js";
import {
  SECRET_STORE_ALLOWED_HOSTS_MAX,
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";

export {
  deleteHiddenGitHubSecretRecord,
  listHiddenGitHubSecretRecordNames,
  readHiddenGitHubSecretRecord,
  writeHiddenGitHubSecretRecord,
} from "./secret-store-hidden-github.js";
export {
  SECRET_STORE_ALLOWED_HOSTS_MAX,
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "./secret-store-validation-error.js";

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
  allowedHosts?: string[];
  valuePreview?: string;
};

export type SecretStoreEgressBinding = {
  name: string;
  sentinel: string;
  allowedHosts: string[];
};

export type SecretStoreExecEnvironment = {
  env?: Record<string, string>;
  secretSentinels?: Record<string, string>;
  secretEgressBindings?: SecretStoreEgressBinding[];
};

type SecretStoreReadError =
  | { code: "SECRET_STORE_NOT_FOUND"; message: string }
  | { code: "SECRET_STORE_INVALID_NAME"; message: string }
  | { code: "SECRET_STORE_UNAVAILABLE"; message: string; cause: unknown };

const SECRET_STORE_RETENTION_MS = 30 * 24 * 60 * 60_000;

function normalizeScope(_scope: SecretStoreScope): { scopeKind: "team"; scopeId: "" } {
  return { scopeKind: "team", scopeId: "" };
}

function assertSecretStoreEnvName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name)) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      `Secret store name must match ${String(ENV_SECRET_REF_ID_RE)}.`,
    );
  }
}

function assertSecretStoreMutationName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name) && classifyHiddenGitHubStoreName(name) !== "setup") {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_NAME",
      `Secret store name must match ${String(ENV_SECRET_REF_ID_RE)} or github-setup-<32 lowercase hex characters>.`,
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

function normalizeSecretAllowedHost(raw: string): string {
  try {
    return normalizeExactAllowedHost(raw);
  } catch (error) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      error instanceof Error ? error.message : `Allowed host "${raw}" is not a valid hostname.`,
    );
  }
}

export function normalizeSecretAllowedHosts(hosts: readonly string[]): string[] {
  if (hosts.length > SECRET_STORE_ALLOWED_HOSTS_MAX) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      `A secret can allow at most ${SECRET_STORE_ALLOWED_HOSTS_MAX} hosts.`,
    );
  }
  return [...new Set(hosts.map(normalizeSecretAllowedHost))].toSorted();
}

function parseSecretAllowedHosts(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((host) => typeof host === "string")
      ? normalizeSecretAllowedHosts(parsed)
      : [];
  } catch {
    // Corrupt policy is never interpreted permissively: an empty list fails closed.
    return [];
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
    ...(row.kind === "secret" ? { allowedHosts: parseSecretAllowedHosts(row.allowed_hosts) } : {}),
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
        return executeSqliteQuerySync(sqlite, query)
          .rows.filter((row) => classifyHiddenGitHubStoreName(row.name) === undefined)
          .map(toMetadata);
      }, params.database ?? {}) ?? []
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return [];
    }
    throw error;
  }
}

/** Atomically returns and hard-deletes one exact fresh, non-egress GitHub setup handoff. */
export function consumeGitHubSetupHandoff(params: {
  name: string;
  nowMs?: number;
  database?: OpenClawStateDatabaseOptions;
}): string | undefined {
  if (classifyHiddenGitHubStoreName(params.name) !== "setup") {
    return undefined;
  }
  const now = params.nowMs ?? Date.now();
  try {
    let value: string | undefined;
    runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const row = executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select("value")
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("name", "=", params.name)
            .where("kind", "=", "secret")
            .where("allowed_hosts", "is", null)
            .where("created_at_ms", ">=", now - GITHUB_SETUP_HANDOFF_MAX_AGE_MS)
            .where("created_at_ms", "<=", now)
            .where("deleted_at_ms", "is", null),
        );
        if (!row) {
          return;
        }
        executeSqliteQuerySync(
          sqlite,
          db
            .deleteFrom("secret_store_entries")
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("name", "=", params.name),
        );
        value = row.value;
      },
      params.database,
      { operationLabel: "secrets.store.consume-github-setup-handoff" },
    );
    if (value !== undefined) {
      registerSecretValueForRedaction(value);
    }
    return value;
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Captures one coherent team-store snapshot for an agent run's exec environment. */
export function readSecretStoreExecEnvironment(params: {
  includeSecretSentinels: boolean;
  excludeNames?: readonly string[];
  database?: OpenClawStateDatabaseOptions;
}): SecretStoreExecEnvironment {
  try {
    return (
      withExistingOpenClawStateDatabaseReadOnly(({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const rows = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .selectAll()
            .where("scope_kind", "=", "team")
            .where("scope_id", "=", "")
            .where("deleted_at_ms", "is", null)
            .orderBy("name", "asc"),
        ).rows;
        const env: Record<string, string> = {};
        const secretSentinels: Record<string, string> = {};
        const secretEgressBindings: SecretStoreEgressBinding[] = [];
        const excludedNames = new Set(params.excludeNames ?? []);
        for (const row of rows) {
          if (
            classifyHiddenGitHubStoreName(row.name) !== undefined ||
            excludedNames.has(row.name)
          ) {
            continue;
          }
          if (row.kind === "env") {
            env[row.name] = row.value;
            continue;
          }
          registerSecretValueForRedaction(row.value);
          if (params.includeSecretSentinels) {
            // Named placeholders disclose the credential name. The existing sentinel
            // is authenticated ciphertext, so an escaped value only fails vendor auth.
            const sentinel = mintSecretSentinel(row.value, {
              label: `exec-store:${row.name}`,
            });
            secretSentinels[row.name] = sentinel;
            secretEgressBindings.push({
              name: row.name,
              sentinel,
              allowedHosts: parseSecretAllowedHosts(row.allowed_hosts),
            });
          }
        }
        return {
          ...(Object.keys(env).length > 0 ? { env } : {}),
          ...(Object.keys(secretSentinels).length > 0 ? { secretSentinels } : {}),
          ...(secretEgressBindings.length > 0 ? { secretEgressBindings } : {}),
        };
      }, params.database ?? {}) ?? {}
    );
  } catch (error) {
    if (isMissingSecretStoreTableError(error)) {
      return {};
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
    assertSecretStoreEnvName(params.name);
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
  allowedHosts?: readonly string[];
  updatedBy: string | null;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertSecretStoreMutationName(params.name);
  assertSecretStoreValue(params.value, params.kind);
  if (params.kind === "env" && params.allowedHosts !== undefined) {
    throw new SecretStoreValidationError(
      "SECRET_STORE_INVALID_ALLOWED_HOST",
      "Allowed hosts apply only to secret entries.",
    );
  }
  const allowedHosts =
    params.kind === "secret" && params.allowedHosts !== undefined
      ? normalizeSecretAllowedHosts(params.allowedHosts)
      : undefined;
  const allowedHostsJson = allowedHosts?.length ? JSON.stringify(allowedHosts) : null;
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
            allowed_hosts: allowedHostsJson,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope_kind", "scope_id", "name"]).doUpdateSet({
              value: params.value,
              kind: params.kind,
              updated_at_ms: now,
              updated_by: params.updatedBy,
              deleted_at_ms: null,
              ...(params.kind === "env"
                ? { allowed_hosts: null }
                : allowedHosts !== undefined
                  ? { allowed_hosts: allowedHostsJson }
                  : {}),
            }),
          ),
      );
    },
    params.database,
    { operationLabel: "secrets.store.write" },
  );
}

export function updateSecretStoreAllowedHosts(params: {
  scope: SecretStoreScope;
  name: string;
  allowedHosts: readonly string[];
  updatedBy: string | null;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertSecretStoreEnvName(params.name);
  const allowedHosts = normalizeSecretAllowedHosts(params.allowedHosts);
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      ensureSecretStoreSchema(sqlite);
      const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
      const updated = executeSqliteQuerySync(
        sqlite,
        db
          .updateTable("secret_store_entries")
          .set({
            allowed_hosts: allowedHosts.length ? JSON.stringify(allowedHosts) : null,
            updated_at_ms: now,
            updated_by: params.updatedBy,
          })
          .where("scope_kind", "=", scopeKind)
          .where("scope_id", "=", scopeId)
          .where("name", "=", params.name)
          .where("kind", "=", "secret")
          .where("deleted_at_ms", "is", null),
      );
      if (Number(updated.numAffectedRows ?? 0n) !== 1) {
        throw new SecretStoreValidationError(
          "SECRET_STORE_INVALID_ALLOWED_HOST",
          `Secret store entry "${params.name}" is missing or is not a secret entry.`,
        );
      }
    },
    params.database,
    { operationLabel: "secrets.store.allowed-hosts" },
  );
}

export function deleteSecretStoreEntry(params: {
  scope: SecretStoreScope;
  name: string;
  database?: OpenClawStateDatabaseOptions;
}): void {
  assertSecretStoreMutationName(params.name);
  const { scopeKind, scopeId } = normalizeScope(params.scope);
  const state = openOpenClawStateDatabase(params.database);
  const now = Date.now();
  try {
    runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const db = getNodeSqliteKysely<SecretStoreDatabase>(sqlite);
        const query =
          classifyHiddenGitHubStoreName(params.name) === "setup"
            ? db
                .deleteFrom("secret_store_entries")
                .where("scope_kind", "=", scopeKind)
                .where("scope_id", "=", scopeId)
                .where("name", "=", params.name)
            : db
                .updateTable("secret_store_entries")
                .set({ deleted_at_ms: now, updated_at_ms: now })
                .where("scope_kind", "=", scopeKind)
                .where("scope_id", "=", scopeId)
                .where("name", "=", params.name)
                .where("deleted_at_ms", "is", null);
        executeSqliteQuerySync(sqlite, query);
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
  const handoffThreshold = Date.now() - GITHUB_SETUP_HANDOFF_MAX_AGE_MS;
  const deviceThreshold = Date.now() - GITHUB_DEVICE_STORE_MAX_AGE_MS;
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
        const hiddenRows = executeSqliteQuerySync(
          sqlite,
          db
            .selectFrom("secret_store_entries")
            .select(["scope_kind", "scope_id", "name", "created_at_ms"])
            .where("deleted_at_ms", "is", null)
            .where("created_at_ms", "<=", Math.max(handoffThreshold, deviceThreshold)),
        ).rows.filter((row) => {
          const kind = classifyHiddenGitHubStoreName(row.name);
          const createdAtMs = normalizeSqliteNumber(row.created_at_ms);
          return (
            createdAtMs !== undefined &&
            ((kind === "setup" && createdAtMs < handoffThreshold) ||
              (kind === "device" && createdAtMs <= deviceThreshold))
          );
        });
        let expiredHidden = 0;
        for (const row of hiddenRows) {
          const result = executeSqliteQuerySync(
            sqlite,
            db
              .deleteFrom("secret_store_entries")
              .where("scope_kind", "=", row.scope_kind)
              .where("scope_id", "=", row.scope_id)
              .where("name", "=", row.name),
          );
          expiredHidden += Number(result.numAffectedRows ?? 0n);
        }
        return Number(deleted.numAffectedRows ?? 0n) + expiredHidden;
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
