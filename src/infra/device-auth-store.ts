// Persists device authorization records for paired nodes.
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  type DeviceAuthEntry,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../shared/device-auth.js";
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

type DeviceAuthDatabase = Pick<OpenClawStateKyselyDatabase, "device_auth_tokens">;
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

function fromRow(row: {
  token: string;
  role: string;
  scopes_json: string;
  updated_at_ms: number;
}): DeviceAuthEntry | null {
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

/** Load one cached device-auth token from the shared SQLite state store. */
export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  assertNoLegacyDeviceAuth(params.env);
  const { db } = openOpenClawStateDatabase({ env: params.env });
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
}): DeviceAuthEntry {
  assertNoLegacyDeviceAuth(params.env);
  const entry: DeviceAuthEntry = {
    token: params.token,
    role: normalizeDeviceAuthRole(params.role),
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DeviceAuthDatabase>(db)
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
      );
    },
    { env: params.env },
  );
  return entry;
}

/** Remove one role token for the current gateway device from shared SQLite state. */
export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  assertNoLegacyDeviceAuth(params.env);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DeviceAuthDatabase>(db)
          .deleteFrom("device_auth_tokens")
          .where("device_id", "=", params.deviceId)
          .where("role", "=", normalizeDeviceAuthRole(params.role)),
      );
    },
    { env: params.env },
  );
}
