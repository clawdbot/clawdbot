// Persists device authorization records for paired nodes.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../config/paths.js";
import {
  type DeviceAuthEntry,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

type DeviceAuthDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "device_auth_tokens" | "gateway_origin_device_tokens"
>;
type DeviceAuthRow = {
  token: string;
  role: string;
  scopes_json: string;
  updated_at_ms: number;
};
// The Gateway lock makes state-directory contents process-stable. Cache both
// outcomes to keep reconnects free of freshness polling; Doctor invalidates
// the entry after its exclusive legacy import removes the retired file.
const legacyPresenceCache = new Map<string, boolean>();

function assertNoLegacyDeviceAuth(env: NodeJS.ProcessEnv | undefined): void {
  const stateDir = resolveStateDir(env);
  let hasLegacy = legacyPresenceCache.get(stateDir);
  if (hasLegacy === undefined) {
    hasLegacy = fs.existsSync(path.join(stateDir, "identity", "device-auth.json"));
    legacyPresenceCache.set(stateDir, hasLegacy);
  }
  if (hasLegacy) {
    throw new Error(
      "Legacy device auth requires migration; stop the Gateway and run `openclaw doctor --fix`.",
    );
  }
}

/** Forget one process-local legacy-state probe after Doctor removes the source. */
export function resetLegacyDeviceAuthPresenceCache(env: NodeJS.ProcessEnv): void {
  legacyPresenceCache.delete(resolveStateDir(env));
}

function fromRow(row: DeviceAuthRow): DeviceAuthEntry | null {
  try {
    const scopes = JSON.parse(row.scopes_json) as unknown;
    if (!Array.isArray(scopes)) {
      return null;
    }
    return {
      token: row.token,
      role: row.role,
      scopes: normalizeDeviceAuthScopes(scopes),
      updatedAtMs: row.updated_at_ms,
    };
  } catch {
    return null;
  }
}

function readDeviceAuthTokenFromDatabase(
  db: DatabaseSync,
  params: { deviceId: string; role: string },
): DeviceAuthEntry | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DeviceAuthDatabase>(db)
      .selectFrom("device_auth_tokens")
      .select(["token", "role", "scopes_json", "updated_at_ms"])
      .where("device_id", "=", params.deviceId)
      .where("role", "=", normalizeDeviceAuthRole(params.role)),
  );
  return row ? fromRow(row) : null;
}

function readOriginDeviceTokenFromDatabase(
  db: DatabaseSync,
  params: { gatewayScope: string; deviceId: string; role: string },
): DeviceAuthEntry | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DeviceAuthDatabase>(db)
      .selectFrom("gateway_origin_device_tokens")
      .select(["token", "role", "scopes_json", "updated_at_ms"])
      .where("gateway_scope", "=", params.gatewayScope)
      .where("device_id", "=", params.deviceId)
      .where("role", "=", normalizeDeviceAuthRole(params.role)),
  );
  return row ? fromRow(row) : null;
}

function createDeviceAuthEntry(params: {
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  return {
    token: params.token,
    role: normalizeDeviceAuthRole(params.role),
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
}

/** Load one cached device-auth token from the shared SQLite state store. */
export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const { db } = openOpenClawStateDatabase({ env: params.env });
  return readDeviceAuthTokenFromDatabase(db, params);
}

/** Load one cached device-auth token without creating or joining writable state. */
export function loadDeviceAuthTokenReadOnly(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => {
        return readDeviceAuthTokenFromDatabase(db, params);
      },
      { env: params.env },
    ) ?? null
  );
}

/** List cached role tokens for one device from the shared SQLite state store. */
export function loadDeviceAuthTokens(params: {
  deviceId: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry[] {
  assertNoLegacyDeviceAuth(params.env);
  const { db } = openOpenClawStateDatabase({ env: params.env });
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<DeviceAuthDatabase>(db)
      .selectFrom("device_auth_tokens")
      .select(["token", "role", "scopes_json", "updated_at_ms"])
      .where("device_id", "=", params.deviceId)
      .orderBy("role"),
  ).rows.flatMap((row) => {
    const entry = fromRow(row);
    return entry ? [entry] : [];
  });
}

/** Persist or replace one device-auth role token in the shared SQLite state store. */
export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
  expectedToken?: string;
}): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const entry = createDeviceAuthEntry(params);
  let stored = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<DeviceAuthDatabase>(db);
      // Fenced writes update only the row that supplied the request snapshot;
      // they never upsert a row that another request rotated or removed.
      const result =
        params.expectedToken === undefined
          ? executeSqliteQuerySync(
              db,
              kysely
                .insertInto("device_auth_tokens")
                .values({
                  device_id: params.deviceId,
                  role: entry.role,
                  token: entry.token,
                  scopes_json: JSON.stringify(entry.scopes),
                  updated_at_ms: entry.updatedAtMs,
                })
                .onConflict((conflict) =>
                  conflict.columns(["device_id", "role"]).doUpdateSet({
                    token: entry.token,
                    scopes_json: JSON.stringify(entry.scopes),
                    updated_at_ms: entry.updatedAtMs,
                  }),
                ),
            )
          : executeSqliteQuerySync(
              db,
              kysely
                .updateTable("device_auth_tokens")
                .set({
                  token: entry.token,
                  scopes_json: JSON.stringify(entry.scopes),
                  updated_at_ms: entry.updatedAtMs,
                })
                .where("device_id", "=", params.deviceId)
                .where("role", "=", entry.role)
                .where("token", "=", params.expectedToken),
            );
      stored = result.numAffectedRows === 1n;
    },
    { env: params.env },
  );
  return stored ? entry : null;
}

/** Remove one role token for the current gateway device from shared SQLite state. */
export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
  expectedToken?: string;
}): boolean {
  assertNoLegacyDeviceAuth(params.env);
  let cleared = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const baseQuery = getNodeSqliteKysely<DeviceAuthDatabase>(db)
        .deleteFrom("device_auth_tokens")
        .where("device_id", "=", params.deviceId)
        .where("role", "=", normalizeDeviceAuthRole(params.role));
      const query =
        params.expectedToken === undefined
          ? baseQuery
          : baseQuery.where("token", "=", params.expectedToken);
      cleared = executeSqliteQuerySync(db, query).numAffectedRows === 1n;
    },
    { env: params.env },
  );
  return cleared;
}

/** Load one device token bound to an exact normalized gateway origin. */
export function loadOriginDeviceToken(params: {
  gatewayScope: string;
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const { db } = openOpenClawStateDatabase({ env: params.env });
  return readOriginDeviceTokenFromDatabase(db, params);
}

/** Load one origin-bound device token without schema creation or writable state access. */
export function loadOriginDeviceTokenReadOnly(params: {
  gatewayScope: string;
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => {
        return readOriginDeviceTokenFromDatabase(db, params);
      },
      { env: params.env },
    ) ?? null
  );
}

/** Persist one device token under an exact normalized gateway origin. */
export function storeOriginDeviceToken(params: {
  gatewayScope: string;
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
  expectedToken?: string;
}): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const entry = createDeviceAuthEntry(params);
  let stored = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<DeviceAuthDatabase>(db);
      const result =
        params.expectedToken === undefined
          ? executeSqliteQuerySync(
              db,
              kysely
                .insertInto("gateway_origin_device_tokens")
                .values({
                  gateway_scope: params.gatewayScope,
                  device_id: params.deviceId,
                  role: entry.role,
                  token: entry.token,
                  scopes_json: JSON.stringify(entry.scopes),
                  updated_at_ms: entry.updatedAtMs,
                })
                .onConflict((conflict) =>
                  conflict.columns(["gateway_scope", "device_id", "role"]).doUpdateSet({
                    token: entry.token,
                    scopes_json: JSON.stringify(entry.scopes),
                    updated_at_ms: entry.updatedAtMs,
                  }),
                ),
            )
          : executeSqliteQuerySync(
              db,
              kysely
                .updateTable("gateway_origin_device_tokens")
                .set({
                  token: entry.token,
                  scopes_json: JSON.stringify(entry.scopes),
                  updated_at_ms: entry.updatedAtMs,
                })
                .where("gateway_scope", "=", params.gatewayScope)
                .where("device_id", "=", params.deviceId)
                .where("role", "=", entry.role)
                .where("token", "=", params.expectedToken),
            );
      stored = result.numAffectedRows === 1n;
    },
    { env: params.env },
  );
  return stored ? entry : null;
}

/** Remove one device token only from its exact normalized gateway origin. */
export function clearOriginDeviceToken(params: {
  gatewayScope: string;
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
  expectedToken?: string;
}): boolean {
  assertNoLegacyDeviceAuth(params.env);
  let cleared = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const baseQuery = getNodeSqliteKysely<DeviceAuthDatabase>(db)
        .deleteFrom("gateway_origin_device_tokens")
        .where("gateway_scope", "=", params.gatewayScope)
        .where("device_id", "=", params.deviceId)
        .where("role", "=", normalizeDeviceAuthRole(params.role));
      const query =
        params.expectedToken === undefined
          ? baseQuery
          : baseQuery.where("token", "=", params.expectedToken);
      cleared = executeSqliteQuerySync(db, query).numAffectedRows === 1n;
    },
    { env: params.env },
  );
  return cleared;
}
