// SQLite row mapping for device pairing and bootstrap-token snapshots.
import type { DatabaseSync } from "node:sqlite";
import { resolvePairingSetupAccess } from "../shared/device-bootstrap-profile.js";
import {
  ensureDevicePairSetupBootstrapSchema,
  ensureDevicePairSetupCompletionSchema,
} from "../state/openclaw-state-db-schema-additive.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  DeviceBootstrapTokens,
} from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { bindCloudWorkerSetupCompletion } from "./device-pairing-cloud-worker.js";
import {
  DEVICE_BOOTSTRAP_TOKEN_COLUMNS_WITHOUT_SETUP,
  fromBootstrapRow,
  fromPairedRow,
  fromPendingRow,
  fromSetupCompletionRow,
  toBootstrapRow,
  toJsonColumn,
  toPairedRow,
  toPendingRow,
} from "./device-pairing-store-rows.js";
import type {
  DeviceBootstrapTokenRecord,
  DevicePairingPendingRecord,
  DevicePairSetupCompletionRecord,
  PairedDevice,
  PairedDeviceNodeSurface,
} from "./device-pairing.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { clearApnsRegistrationFromDatabase } from "./push-apns-store-transaction.js";

export type DevicePairingStoreState = {
  pendingById: Record<string, DevicePairingPendingRecord>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

type DevicePairingStoreTarget = "pending" | "paired" | "both";

type DevicePairingStorePersistOptions = { clearApnsNodeIds?: readonly string[] };

export type DevicePairingStorePersist = (
  target: DevicePairingStoreTarget,
  options?: DevicePairingStorePersistOptions,
) => void;

type DevicePairingStoreValidityToken = {
  dataVersion: number;
  totalChanges: number;
};

type DevicePairingStoreCache = {
  connection: DatabaseSync;
  path: string;
  state: DevicePairingStoreState;
  validityToken: DevicePairingStoreValidityToken;
};

type DevicePairingStoreMutation<T> = {
  mutated: boolean;
  value: T;
};

type PairedDeviceNodeSurfaceUpdate<T> =
  | { value: T; persist: false }
  | { value: T; persist: true; nodeSurface: PairedDeviceNodeSurface };

type PairedDevicePresenceUpdate<T> =
  | { value: T; persist: false }
  | {
      value: T;
      persist: true;
      lastSeenAtMs: number;
      lastSeenReason: string;
    };

// One materialized pairing snapshot avoids rescanning both tables for every node catalog read.
// The connection token detects other-process writes, and store-owned writes clear it post-commit;
// without both paths, Gateway and CLI pairing mutations could leave node.list serving stale rows.
let devicePairingStoreCache: DevicePairingStoreCache | undefined;

/** Route an explicit pairing base dir (tests, alternate state roots) to that dir's DB. */
function resolveDevicePairingStateDbOptions(baseDir?: string): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function readDataVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown };
  if (typeof row.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}

function readTotalChanges(database: DatabaseSync): number {
  const row = database.prepare("SELECT total_changes() AS value").get() as { value?: unknown };
  if (typeof row.value !== "number") {
    throw new Error("SQLite did not return a numeric total_changes() value");
  }
  return row.value;
}

function readDevicePairingStoreValidityToken(
  database: DatabaseSync,
): DevicePairingStoreValidityToken {
  return {
    dataVersion: readDataVersion(database),
    totalChanges: readTotalChanges(database),
  };
}

function devicePairingStoreValidityTokensEqual(
  left: DevicePairingStoreValidityToken,
  right: DevicePairingStoreValidityToken,
): boolean {
  return left.dataVersion === right.dataVersion && left.totalChanges === right.totalChanges;
}

function invalidateDevicePairingStoreCache(database: OpenClawStateDatabase): void {
  if (
    devicePairingStoreCache?.connection === database.db &&
    devicePairingStoreCache.path === database.path
  ) {
    devicePairingStoreCache = undefined;
  }
}

function runDevicePairingStoreMutation<T>(
  baseDir: string | undefined,
  mutate: (database: OpenClawStateDatabase) => DevicePairingStoreMutation<T>,
): T {
  const databaseOptions = resolveDevicePairingStateDbOptions(baseDir);
  const database = openOpenClawStateDatabase(databaseOptions);
  const result = runOpenClawStateWriteTransaction(mutate, { ...databaseOptions, database });
  if (result.mutated) {
    invalidateDevicePairingStoreCache(database);
  }
  return result.value;
}

export function readDevicePairingStoreStateFromDatabase(db: DatabaseSync): DevicePairingStoreState {
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  const pendingById: Record<string, DevicePairingPendingRecord> = {};
  for (const row of executeSqliteQuerySync(
    db,
    kysely.selectFrom("device_pairing_pending").selectAll(),
  ).rows) {
    pendingById[row.request_id] = fromPendingRow(row);
  }
  const pairedByDeviceId: Record<string, PairedDevice> = {};
  for (const row of executeSqliteQuerySync(
    db,
    kysely.selectFrom("device_pairing_paired").selectAll(),
  ).rows) {
    pairedByDeviceId[row.device_id] = fromPairedRow(row);
  }
  return { pendingById, pairedByDeviceId };
}

/** Load the full pending + paired device snapshot from the shared state DB. */
export function loadDevicePairingStoreState(baseDir?: string): DevicePairingStoreState {
  const database = openOpenClawStateDatabase(resolveDevicePairingStateDbOptions(baseDir));
  const { db } = database;
  const validityToken = readDevicePairingStoreValidityToken(db);
  if (
    devicePairingStoreCache?.connection === db &&
    devicePairingStoreCache.path === database.path &&
    devicePairingStoreValidityTokensEqual(devicePairingStoreCache.validityToken, validityToken)
  ) {
    return structuredClone(devicePairingStoreCache.state);
  }
  const state = readDevicePairingStoreStateFromDatabase(db);
  devicePairingStoreCache = {
    connection: db,
    path: database.path,
    state: structuredClone(state),
    validityToken,
  };
  return state;
}

/** Load one paired-device row without materializing either pairing table. */
export function loadPairedDevicePairingStoreRecord(
  deviceId: string,
  baseDir?: string,
): PairedDevice | null {
  const { db } = openOpenClawStateDatabase(resolveDevicePairingStateDbOptions(baseDir));
  return loadPairedDevicePairingStoreRecordFromDatabase(db, deviceId);
}

/** Load one paired-device row from an existing shared-state transaction. */
export function loadPairedDevicePairingStoreRecordFromDatabase(
  db: OpenClawStateDatabase["db"],
  deviceId: string,
): PairedDevice | null {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    return null;
  }
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("device_pairing_paired")
      .selectAll()
      .where("device_id", "=", normalizedDeviceId),
  );
  return row ? fromPairedRow(row) : null;
}

/** Read, validate, and update one paired node surface in a single cross-process transaction. */
export function updatePairedDeviceNodeSurfaceInTransaction<T>(
  deviceId: string,
  baseDir: string | undefined,
  update: (device: PairedDevice | null) => PairedDeviceNodeSurfaceUpdate<T>,
): T {
  return runDevicePairingStoreMutation(baseDir, ({ db }) => {
    const normalizedDeviceId = deviceId.trim();
    const device = normalizedDeviceId
      ? loadPairedDevicePairingStoreRecordFromDatabase(db, normalizedDeviceId)
      : null;
    const result = update(device);
    if (!result.persist) {
      return { mutated: false, value: result.value };
    }
    if (!device) {
      throw new Error("cannot update a missing paired-device node surface");
    }
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("device_pairing_paired")
        .set({ node_surface_json: toJsonColumn(result.nodeSurface) })
        .where("device_id", "=", normalizedDeviceId),
    );
    return { mutated: true, value: result.value };
  });
}

/** Read, validate, and update one paired-device presence row in one transaction. */
export function updatePairedDevicePresenceInTransaction<T>(
  deviceId: string,
  baseDir: string | undefined,
  update: (device: PairedDevice | null) => PairedDevicePresenceUpdate<T>,
): T {
  return runDevicePairingStoreMutation(baseDir, ({ db }) => {
    const normalizedDeviceId = deviceId.trim();
    const device = normalizedDeviceId
      ? loadPairedDevicePairingStoreRecordFromDatabase(db, normalizedDeviceId)
      : null;
    const result = update(device);
    if (!result.persist) {
      return { mutated: false, value: result.value };
    }
    if (!device) {
      throw new Error("cannot update presence for a missing paired device");
    }
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("device_pairing_paired")
        .set({
          last_seen_at_ms: result.lastSeenAtMs,
          last_seen_reason: result.lastSeenReason,
        })
        .where("device_id", "=", normalizedDeviceId),
    );
    return { mutated: true, value: result.value };
  });
}

function writeDevicePairingStoreTables(
  db: DatabaseSync,
  state: DevicePairingStoreState,
  target: DevicePairingStoreTarget,
  options?: DevicePairingStorePersistOptions,
): void {
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  if (target !== "paired") {
    executeSqliteQuerySync(db, kysely.deleteFrom("device_pairing_pending"));
    const rows = Object.values(state.pendingById).map(toPendingRow);
    if (rows.length > 0) {
      executeSqliteQuerySync(db, kysely.insertInto("device_pairing_pending").values(rows));
    }
  }
  if (target !== "pending") {
    executeSqliteQuerySync(db, kysely.deleteFrom("device_pairing_paired"));
    const rows = Object.values(state.pairedByDeviceId).map(toPairedRow);
    if (rows.length > 0) {
      executeSqliteQuerySync(db, kysely.insertInto("device_pairing_paired").values(rows));
    }
  }
  for (const nodeId of new Set(options?.clearApnsNodeIds ?? [])) {
    clearApnsRegistrationFromDatabase(db, nodeId);
  }
}

/** Replace the pending and/or paired table contents with the given snapshot. */
export function persistDevicePairingStoreState(
  state: DevicePairingStoreState,
  baseDir: string | undefined,
  target: DevicePairingStoreTarget,
  options?: DevicePairingStorePersistOptions,
): void {
  runDevicePairingStoreMutation(baseDir, ({ db }) => {
    writeDevicePairingStoreTables(db, state, target, options);
    return { mutated: true, value: undefined };
  });
}

export function mutateDevicePairingStoreStateInTransaction<T>(
  baseDir: string | undefined,
  mutate: (state: DevicePairingStoreState, persist: DevicePairingStorePersist) => T,
): T {
  return runDevicePairingStoreMutation(baseDir, ({ db }) => {
    const state = readDevicePairingStoreStateFromDatabase(db);
    let requested: { target: DevicePairingStoreTarget; clearApnsNodeIds: string[] } | undefined;
    const persist: DevicePairingStorePersist = (target, options) => {
      requested = {
        target: requested && requested.target !== target ? "both" : target,
        clearApnsNodeIds: [
          ...(requested?.clearApnsNodeIds ?? []),
          ...(options?.clearApnsNodeIds ?? []),
        ],
      };
    };
    const value = mutate(state, persist);
    if (!requested) {
      return { mutated: false, value };
    }
    writeDevicePairingStoreTables(db, state, requested.target, {
      clearApnsNodeIds: requested.clearApnsNodeIds,
    });
    return { mutated: true, value };
  });
}

/** Load all bootstrap token records keyed by token key. */
export function loadDeviceBootstrapTokenRecords(
  baseDir?: string,
): Record<string, DeviceBootstrapTokenRecord> {
  const { db } = openOpenClawStateDatabase(resolveDevicePairingStateDbOptions(baseDir));
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  const state: Record<string, DeviceBootstrapTokenRecord> = {};
  const hasSetupId = tableHasColumn(db, "device_bootstrap_tokens", "setup_id");
  const rows: DeviceBootstrapTokens[] = hasSetupId
    ? executeSqliteQuerySync(db, kysely.selectFrom("device_bootstrap_tokens").selectAll()).rows
    : executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("device_bootstrap_tokens")
          .select(DEVICE_BOOTSTRAP_TOKEN_COLUMNS_WITHOUT_SETUP),
      ).rows.map((row) => Object.assign(row, { setup_id: null }));
  for (const row of rows) {
    state[row.token_key] = fromBootstrapRow(row);
  }
  return state;
}

/** Replace the bootstrap token table contents with the given snapshot. */
export function persistDeviceBootstrapTokenRecords(
  state: Record<string, DeviceBootstrapTokenRecord>,
  baseDir?: string,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const rows = Object.entries(state).map(([tokenKey, record]) =>
      toBootstrapRow(tokenKey, record),
    );
    if (rows.some((row) => row.setup_id !== null)) {
      ensureDevicePairSetupBootstrapSchema(db);
    }
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    executeSqliteQuerySync(db, kysely.deleteFrom("device_bootstrap_tokens"));
    if (rows.length > 0) {
      if (tableHasColumn(db, "device_bootstrap_tokens", "setup_id")) {
        executeSqliteQuerySync(db, kysely.insertInto("device_bootstrap_tokens").values(rows));
      } else {
        const rowsWithoutSetup = rows.map(({ setup_id: _setupId, ...row }) => row);
        executeSqliteQuerySync(
          db,
          kysely.insertInto("device_bootstrap_tokens").values(rowsWithoutSetup),
        );
      }
    }
  }, resolveDevicePairingStateDbOptions(baseDir));
}

/** Consume one bound bootstrap credential and record its setup outcome atomically. */
export function consumeDeviceBootstrapTokenWithSetupCompletionInTransaction(params: {
  token: string;
  deviceId: string;
  completedAtMs: number;
  oldestValidIssuedAtMs: number;
  retentionNowMs: number;
  retainUntilMs: number;
  pairedDeviceMatches?: (device: PairedDevice | null) => boolean;
  baseDir?: string;
}): { record: DeviceBootstrapTokenRecord; completion?: DevicePairSetupCompletionRecord } | null {
  const token = params.token.trim();
  const deviceId = params.deviceId.trim();
  if (!token || !deviceId) {
    return null;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    ensureDevicePairSetupBootstrapSchema(db);
    ensureDevicePairSetupCompletionSchema(db);
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    // Verification precedes async pairing work, so expiry must be checked again
    // against the authoritative row before consumption becomes terminal.
    const tokenRow = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("device_bootstrap_tokens")
        .selectAll()
        .where("token_key", "=", token)
        .where("issued_at_ms", ">=", params.oldestValidIssuedAtMs),
    );
    if (!tokenRow || tokenRow.token !== token || tokenRow.device_id?.trim() !== deviceId) {
      return null;
    }
    const record = fromBootstrapRow(tokenRow);
    const paired =
      record.setupId || params.pairedDeviceMatches
        ? loadPairedDevicePairingStoreRecordFromDatabase(db, deviceId)
        : null;
    if (params.pairedDeviceMatches && !params.pairedDeviceMatches(paired)) {
      return null;
    }
    const deviceName = paired?.operatorLabel ?? paired?.displayName;
    const completion: DevicePairSetupCompletionRecord | undefined = record.setupId
      ? {
          setupId: record.setupId,
          deviceId,
          ...(deviceName ? { deviceName } : {}),
          access: resolvePairingSetupAccess(record.profile),
          completedAtMs: params.completedAtMs,
          deliveryState: "uncertain",
          retainUntilMs: params.retainUntilMs,
        }
      : undefined;

    // Cloud workers can retry an undelivered hello only with this exact bound bearer;
    // delivery confirmation retires it atomically with the confirmed completion.
    if (!completion || record.profile?.purpose !== "cloud-worker") {
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("device_bootstrap_tokens").where("token_key", "=", tokenRow.token_key),
      );
    }
    if (completion) {
      if (record.profile?.purpose === "cloud-worker") {
        bindCloudWorkerSetupCompletion({ db, completion });
      }
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("device_pair_setup_completions")
          .where((eb) =>
            eb.or([
              eb("retain_until_ms", "<=", params.retentionNowMs),
              eb("setup_id", "=", completion.setupId),
            ]),
          ),
      );
      executeSqliteQuerySync(
        db,
        kysely.insertInto("device_pair_setup_completions").values({
          setup_id: completion.setupId,
          device_id: completion.deviceId,
          device_name: completion.deviceName ?? null,
          access: completion.access,
          completed_at_ms: completion.completedAtMs,
          delivery_state: completion.deliveryState,
          retain_until_ms: completion.retainUntilMs,
        }),
      );
    }
    return { record, ...(completion ? { completion } : {}) };
  }, resolveDevicePairingStateDbOptions(params.baseDir));
}

/** Mark one consumed setup handoff as delivered without reviving an expired or replaced row. */
export function confirmDevicePairSetupCompletionDeliveryInTransaction(params: {
  setupId: string;
  deviceId: string;
  nowMs: number;
  baseDir?: string;
}): DevicePairSetupCompletionRecord | null {
  const setupId = params.setupId.trim();
  const deviceId = params.deviceId.trim();
  if (!setupId || !deviceId) {
    return null;
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    ensureDevicePairSetupCompletionSchema(db);
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .updateTable("device_pair_setup_completions")
        .set({ delivery_state: "confirmed" })
        .where("setup_id", "=", setupId)
        .where("device_id", "=", deviceId)
        .where("retain_until_ms", ">", params.nowMs)
        .returningAll(),
    );
    if (!row) {
      return null;
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("device_bootstrap_tokens")
        .where("setup_id", "=", setupId)
        .where("device_id", "=", deviceId),
    );
    return fromSetupCompletionRow(row);
  }, resolveDevicePairingStateDbOptions(params.baseDir));
}

/** Prune retained setup outcomes when the Gateway maintenance owner ticks. */
export function pruneExpiredDevicePairSetupCompletionRecords(
  nowMs: number,
  baseDir?: string,
): number {
  const databaseOptions = resolveDevicePairingStateDbOptions(baseDir);
  const database = openOpenClawStateDatabase(databaseOptions);
  if (!tableExists(database.db, "device_pair_setup_completions")) {
    return 0;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      const result = executeSqliteQuerySync(
        db,
        kysely.deleteFrom("device_pair_setup_completions").where("retain_until_ms", "<=", nowMs),
      );
      return Number(result.numAffectedRows ?? 0);
    },
    { ...databaseOptions, database },
  );
}

/** Prune elapsed setup completions, then read one live record. */
export function loadDevicePairSetupCompletionRecord(
  setupId: string,
  nowMs: number,
  baseDir?: string,
): DevicePairSetupCompletionRecord | null {
  const databaseOptions = resolveDevicePairingStateDbOptions(baseDir);
  const database = openOpenClawStateDatabase(databaseOptions);
  ensureDevicePairSetupCompletionSchema(database.db);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely.deleteFrom("device_pair_setup_completions").where("retain_until_ms", "<=", nowMs),
      );
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("device_pair_setup_completions")
          .selectAll()
          .where("setup_id", "=", setupId),
      );
      return row ? fromSetupCompletionRow(row) : null;
    },
    { ...databaseOptions, database },
  );
}
