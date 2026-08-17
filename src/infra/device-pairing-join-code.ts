// Stores short-lived device onboarding join codes in shared SQLite state.
import type { DatabaseSync } from "node:sqlite";
import { DEVICE_PAIRING_JOIN_CODE_BYTES, isDevicePairingJoinCode } from "../pairing/join-code.js";
import { decodePairingSetupCode, encodePairingSetupCode } from "../pairing/setup-code.js";
import { ensureDevicePairingJoinCodeSchema } from "../state/openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { generateSecureToken } from "./secure-random.js";

type DevicePairingJoinCodeDatabase = Pick<OpenClawStateKyselyDatabase, "device_pairing_join_codes">;
type PairingSetupPayload = ReturnType<typeof decodePairingSetupCode>;

const initializedDatabases = new WeakSet<DatabaseSync>();

function ensureJoinCodeSchema(database: DatabaseSync): void {
  if (initializedDatabases.has(database)) {
    return;
  }
  ensureDevicePairingJoinCodeSchema(database);
  initializedDatabases.add(database);
}

function validatePairingSetupPayload(payload: PairingSetupPayload): PairingSetupPayload {
  return decodePairingSetupCode(encodePairingSetupCode(payload));
}

/** Register one setup payload under a random 128-bit shortcode. */
export function registerDevicePairingJoinCode(params: {
  payload: PairingSetupPayload;
  expiresAtMs: number;
  database?: OpenClawStateDatabaseOptions;
}): string {
  const createdAtMs = Date.now();
  if (!Number.isSafeInteger(params.expiresAtMs) || params.expiresAtMs <= createdAtMs) {
    throw new Error("Device pairing join code requires a future expiry.");
  }
  const payloadJson = JSON.stringify(validatePairingSetupPayload(params.payload));
  const shortcode = generateSecureToken(DEVICE_PAIRING_JOIN_CODE_BYTES);

  runOpenClawStateWriteTransaction(({ db }) => {
    ensureJoinCodeSchema(db);
    const kysely = getNodeSqliteKysely<DevicePairingJoinCodeDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("device_pairing_join_codes").where("expires_at_ms", "<=", createdAtMs),
    );
    executeSqliteQuerySync(
      db,
      kysely.insertInto("device_pairing_join_codes").values({
        shortcode,
        payload_json: payloadJson,
        created_at_ms: createdAtMs,
        expires_at_ms: params.expiresAtMs,
      }),
    );
  }, params.database);
  return shortcode;
}

/** Atomically burn one live shortcode and return its validated setup payload. */
export function redeemDevicePairingJoinCode(params: {
  shortcode: string;
  database?: OpenClawStateDatabaseOptions;
}): PairingSetupPayload | null {
  const shortcode = params.shortcode.trim();
  if (!isDevicePairingJoinCode(shortcode)) {
    return null;
  }
  const nowMs = Date.now();
  const payloadJson = runOpenClawStateWriteTransaction(({ db }) => {
    ensureJoinCodeSchema(db);
    const kysely = getNodeSqliteKysely<DevicePairingJoinCodeDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("device_pairing_join_codes").where("expires_at_ms", "<=", nowMs),
    );
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("device_pairing_join_codes")
        .select("payload_json")
        .where("shortcode", "=", shortcode),
    );
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("device_pairing_join_codes").where("shortcode", "=", shortcode),
    );
    return row?.payload_json;
  }, params.database);
  if (typeof payloadJson !== "string") {
    return null;
  }
  try {
    return decodePairingSetupCode(Buffer.from(payloadJson, "utf8").toString("base64url"), {
      nowMs,
    });
  } catch {
    return null;
  }
}
