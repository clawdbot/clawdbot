// SQLite row mapping for the device pairing and bootstrap-token stores.
// The domain modules (device-pairing.ts, device-bootstrap.ts) mutate full
// in-memory snapshots under a process-local lock; persistence replaces the
// affected table contents in one immediate transaction. That preserves the
// snapshot semantics the retired devices/*.json files had (including
// cross-process last-writer-wins per store) while WAL + busy_timeout make
// concurrent gateway/CLI access safe at the statement level.
import type {
  DB as OpenClawStateKyselyDatabase,
  DevicePairingPaired,
  DevicePairingPending,
  DeviceBootstrapTokens,
} from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type {
  DeviceAuthToken,
  DeviceBootstrapTokenRecord,
  DevicePairingPendingRecord,
  PairedDevice,
  PairedDeviceApprovalKind,
  PairedDeviceNodeSurface,
  PairedDevicePendingNodeSurface,
} from "./device-pairing.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type DevicePairingStoreState = {
  pendingById: Record<string, DevicePairingPendingRecord>;
  pairedByDeviceId: Record<string, PairedDevice>;
};

type DevicePairingStoreTarget = "pending" | "paired" | "both";

/** Route an explicit pairing base dir (tests, alternate state roots) to that dir's DB. */
function resolveDevicePairingStateDbOptions(baseDir?: string): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

// Read-back allowlist for the approved_via column. The Record type forces
// every PairedDeviceApprovalKind to appear here at compile time: omit one and
// this object is a type error, instead of the stored provenance silently
// dropping to undefined on load (which mergeApprovalKind treats as a legacy
// record). Keep this in sync when adding an approval kind.
const APPROVAL_KIND_MEMBERS = {
  owner: true,
  silent: true,
  "trusted-cidr": true,
  "ssh-verified": true,
  bootstrap: true,
} satisfies Record<PairedDeviceApprovalKind, true>;
const APPROVAL_KINDS = new Set(Object.keys(APPROVAL_KIND_MEMBERS));

function toJsonColumn(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Persisted JSON columns are typed by the receiving field.
function fromJsonColumn<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}

function toBooleanColumn(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

// Column null means the optional record key was absent; keep it absent on read
// so records round-trip byte-identical to the retired JSON store.
function optional<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return value === null ? {} : ({ [key]: value } as { [P in K]: V });
}

function toPendingRow(record: DevicePairingPendingRecord): DevicePairingPending {
  return {
    request_id: record.requestId,
    device_id: record.deviceId,
    public_key: record.publicKey,
    display_name: record.displayName ?? null,
    platform: record.platform ?? null,
    device_family: record.deviceFamily ?? null,
    client_id: record.clientId ?? null,
    client_mode: record.clientMode ?? null,
    role: record.role ?? null,
    roles_json: toJsonColumn(record.roles),
    scopes_json: toJsonColumn(record.scopes),
    remote_ip: record.remoteIp ?? null,
    silent: toBooleanColumn(record.silent),
    is_repair: toBooleanColumn(record.isRepair),
    ts: record.ts,
    refreshed_at_ms: record.refreshedAtMs ?? null,
  };
}

function fromPendingRow(row: DevicePairingPending): DevicePairingPendingRecord {
  return {
    requestId: row.request_id,
    deviceId: row.device_id,
    publicKey: row.public_key,
    ...optional("displayName", row.display_name),
    ...optional("platform", row.platform),
    ...optional("deviceFamily", row.device_family),
    ...optional("clientId", row.client_id),
    ...optional("clientMode", row.client_mode),
    ...optional("role", row.role),
    ...optional("roles", fromJsonColumn<string[]>(row.roles_json) ?? null),
    ...optional("scopes", fromJsonColumn<string[]>(row.scopes_json) ?? null),
    ...optional("remoteIp", row.remote_ip),
    ...optional("silent", row.silent === null ? null : row.silent !== 0),
    ...optional("isRepair", row.is_repair === null ? null : row.is_repair !== 0),
    ts: row.ts,
    ...optional("refreshedAtMs", row.refreshed_at_ms),
  };
}

function toPairedRow(device: PairedDevice): DevicePairingPaired {
  return {
    device_id: device.deviceId,
    public_key: device.publicKey,
    display_name: device.displayName ?? null,
    operator_label: device.operatorLabel ?? null,
    platform: device.platform ?? null,
    device_family: device.deviceFamily ?? null,
    client_id: device.clientId ?? null,
    client_mode: device.clientMode ?? null,
    role: device.role ?? null,
    roles_json: toJsonColumn(device.roles),
    scopes_json: toJsonColumn(device.scopes),
    approved_scopes_json: toJsonColumn(device.approvedScopes),
    remote_ip: device.remoteIp ?? null,
    tokens_json: toJsonColumn(device.tokens),
    approved_via: device.approvedVia ?? null,
    node_surface_json: toJsonColumn(device.nodeSurface),
    pending_node_surface_json: toJsonColumn(device.pendingNodeSurface),
    created_at_ms: device.createdAtMs,
    approved_at_ms: device.approvedAtMs,
    last_seen_at_ms: device.lastSeenAtMs ?? null,
    last_seen_reason: device.lastSeenReason ?? null,
  };
}

function fromApprovedViaColumn(value: string | null): PairedDeviceApprovalKind | null {
  return value !== null && APPROVAL_KINDS.has(value) ? (value as PairedDeviceApprovalKind) : null;
}

function fromPairedRow(row: DevicePairingPaired): PairedDevice {
  return {
    deviceId: row.device_id,
    publicKey: row.public_key,
    ...optional("displayName", row.display_name),
    ...optional("operatorLabel", row.operator_label),
    ...optional("platform", row.platform),
    ...optional("deviceFamily", row.device_family),
    ...optional("clientId", row.client_id),
    ...optional("clientMode", row.client_mode),
    ...optional("role", row.role),
    ...optional("roles", fromJsonColumn<string[]>(row.roles_json) ?? null),
    ...optional("scopes", fromJsonColumn<string[]>(row.scopes_json) ?? null),
    ...optional("approvedScopes", fromJsonColumn<string[]>(row.approved_scopes_json) ?? null),
    ...optional("remoteIp", row.remote_ip),
    ...optional("tokens", fromJsonColumn<Record<string, DeviceAuthToken>>(row.tokens_json) ?? null),
    ...optional("approvedVia", fromApprovedViaColumn(row.approved_via)),
    ...optional(
      "nodeSurface",
      fromJsonColumn<PairedDeviceNodeSurface>(row.node_surface_json) ?? null,
    ),
    ...optional(
      "pendingNodeSurface",
      fromJsonColumn<PairedDevicePendingNodeSurface>(row.pending_node_surface_json) ?? null,
    ),
    createdAtMs: row.created_at_ms,
    approvedAtMs: row.approved_at_ms,
    ...optional("lastSeenAtMs", row.last_seen_at_ms),
    ...optional("lastSeenReason", row.last_seen_reason),
  };
}

function toBootstrapRow(
  tokenKey: string,
  record: DeviceBootstrapTokenRecord,
): DeviceBootstrapTokens {
  return {
    token_key: tokenKey,
    token: record.token,
    ts: record.ts,
    device_id: record.deviceId ?? null,
    public_key: record.publicKey ?? null,
    profile_json: toJsonColumn(record.profile),
    redeemed_profile_json: toJsonColumn(record.redeemedProfile),
    pending_profile_json: toJsonColumn(record.pendingProfile),
    issued_at_ms: record.issuedAtMs,
    last_used_at_ms: record.lastUsedAtMs ?? null,
  };
}

function fromBootstrapRow(row: DeviceBootstrapTokens): DeviceBootstrapTokenRecord {
  return {
    token: row.token,
    ts: row.ts,
    ...optional("deviceId", row.device_id),
    ...optional("publicKey", row.public_key),
    ...optional(
      "profile",
      fromJsonColumn<DeviceBootstrapTokenRecord["profile"]>(row.profile_json) ?? null,
    ),
    ...optional(
      "redeemedProfile",
      fromJsonColumn<DeviceBootstrapTokenRecord["redeemedProfile"]>(row.redeemed_profile_json) ??
        null,
    ),
    ...optional(
      "pendingProfile",
      fromJsonColumn<DeviceBootstrapTokenRecord["pendingProfile"]>(row.pending_profile_json) ??
        null,
    ),
    issuedAtMs: row.issued_at_ms,
    ...optional("lastUsedAtMs", row.last_used_at_ms),
  };
}

/** Load the full pending + paired device snapshot from the shared state DB. */
export function loadDevicePairingStoreState(baseDir?: string): DevicePairingStoreState {
  const { db } = openOpenClawStateDatabase(resolveDevicePairingStateDbOptions(baseDir));
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

/** Replace the pending and/or paired table contents with the given snapshot. */
export function persistDevicePairingStoreState(
  state: DevicePairingStoreState,
  baseDir: string | undefined,
  target: DevicePairingStoreTarget,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
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
  }, resolveDevicePairingStateDbOptions(baseDir));
}

/** Load all bootstrap token records keyed by token key. */
export function loadDeviceBootstrapTokenRecords(
  baseDir?: string,
): Record<string, DeviceBootstrapTokenRecord> {
  const { db } = openOpenClawStateDatabase(resolveDevicePairingStateDbOptions(baseDir));
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  const state: Record<string, DeviceBootstrapTokenRecord> = {};
  for (const row of executeSqliteQuerySync(
    db,
    kysely.selectFrom("device_bootstrap_tokens").selectAll(),
  ).rows) {
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
    const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
    executeSqliteQuerySync(db, kysely.deleteFrom("device_bootstrap_tokens"));
    const rows = Object.entries(state).map(([tokenKey, record]) =>
      toBootstrapRow(tokenKey, record),
    );
    if (rows.length > 0) {
      executeSqliteQuerySync(db, kysely.insertInto("device_bootstrap_tokens").values(rows));
    }
  }, resolveDevicePairingStateDbOptions(baseDir));
}
