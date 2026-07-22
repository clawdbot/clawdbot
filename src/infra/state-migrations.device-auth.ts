// Doctor-only import for the retired device-auth JSON store.
import fs from "node:fs";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resetLegacyDeviceAuthPresenceCache } from "./device-auth-store.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_PATH = "identity/device-auth.json";
type DeviceAuthMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "device_auth_tokens">;
type LegacyDeviceAuthDetection = {
  sourcePath: string;
  sourcePresent: boolean;
  hasLegacy: boolean;
};

/** Detect the retired device-auth store only when an explicit Doctor flow opts in. */
export function detectLegacyDeviceAuth(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyDeviceAuthDetection {
  const sourcePath = path.join(params.stateDir, LEGACY_PATH);
  const sourcePresent = fs.existsSync(sourcePath);
  return {
    sourcePath,
    sourcePresent,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourcePresent,
  };
}

function parseStore(value: unknown) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.deviceId !== "string" ||
    !value.deviceId.trim() ||
    !isRecord(value.tokens)
  ) {
    throw new Error("legacy device-auth store is invalid or unsupported");
  }
  const entries = Object.entries(value.tokens).flatMap(([rawRole, tokenValue]) => {
    const role = normalizeDeviceAuthRole(rawRole);
    if (!role || !isRecord(tokenValue) || typeof tokenValue.token !== "string") {
      return [];
    }
    return [
      {
        token: tokenValue.token,
        role,
        scopes: normalizeDeviceAuthScopes(
          Array.isArray(tokenValue.scopes) ? tokenValue.scopes : undefined,
        ),
        updatedAtMs:
          typeof tokenValue.updatedAtMs === "number" && Number.isSafeInteger(tokenValue.updatedAtMs)
            ? tokenValue.updatedAtMs
            : 0,
      },
    ];
  });
  // JSON object order is the legacy contract; later aliases of the same
  // normalized role replace earlier entries before SQLite conflict handling.
  return {
    deviceId: value.deviceId,
    entries: [...new Map(entries.map((entry) => [entry.role, entry])).values()],
  };
}

function rowIsCanonical(row: { scopes_json: string; updated_at_ms: number }): boolean {
  try {
    return Array.isArray(JSON.parse(row.scopes_json)) && Number.isSafeInteger(row.updated_at_ms);
  } catch {
    return false;
  }
}

async function importLegacyStore(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const stateRoot = await root(params.stateDir, {
    hardlinks: "reject",
    maxBytes: 256 * 1024,
    symlinks: "reject",
  });
  const source = await stateRoot.read(LEGACY_PATH, {
    hardlinks: "reject",
    maxBytes: 256 * 1024,
    symlinks: "reject",
  });
  const store = parseStore(JSON.parse(source.buffer.toString("utf8")));
  const counts = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<DeviceAuthMigrationDatabase>(db);
      let imported = 0;
      let preserved = 0;
      for (const entry of store.entries) {
        const query = stateDb
          .selectFrom("device_auth_tokens")
          .select(["scopes_json", "updated_at_ms"])
          .where("device_id", "=", store.deviceId)
          .where("role", "=", entry.role);
        const existing = executeSqliteQueryTakeFirstSync(db, query);
        if (existing && rowIsCanonical(existing)) {
          preserved += 1;
          continue;
        }
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("device_auth_tokens")
            .values({
              device_id: store.deviceId,
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
        if (!executeSqliteQueryTakeFirstSync(db, query)) {
          throw new Error("SQLite verification failed for a device-auth token");
        }
        imported += 1;
      }
      return { imported, preserved };
    },
    { env: params.env },
  );
  await stateRoot.remove(LEGACY_PATH);
  resetLegacyDeviceAuthPresenceCache(params.env);
  return {
    changes: [
      `Migrated ${counts.imported} device-auth token${counts.imported === 1 ? "" : "s"} to SQLite.`,
    ],
    warnings: [],
    notices: [
      ...(counts.preserved > 0
        ? [
            `Preserved ${counts.preserved} canonical SQLite device-auth token${counts.preserved === 1 ? "" : "s"}.`,
          ]
        : []),
      "Removed retired device-auth JSON after verified SQLite import.",
    ],
  };
}

/** Import retired device-auth JSON while excluding Gateways that can rewrite it. */
export async function migrateLegacyDeviceAuth(params: {
  detected: LegacyDeviceAuthDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 25,
      role: "sqlite-maintenance",
      timeoutMs: 250,
    });
  } catch (error) {
    const detail =
      error instanceof GatewayLockError
        ? "the Gateway or another SQLite maintenance command owns this state directory"
        : String(error);
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy device auth: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy device auth: exclusive state ownership unavailable."],
    };
  }
  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    result = await importLegacyStore({ ...params, env });
  } catch (error) {
    result.warnings.push(`Failed migrating legacy device auth: ${String(error)}`);
  } finally {
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) {
    result.warnings.push(
      `Device-auth migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}
