import type { PairingSetupAccess } from "../shared/device-bootstrap-profile.js";
import type {
  DevicePairingPaired,
  DevicePairingPending,
  DeviceBootstrapTokens,
  DevicePairSetupCompletions,
} from "../state/openclaw-state-db.generated.js";
import type {
  DeviceAuthToken,
  DeviceBootstrapTokenRecord,
  DevicePairingPendingRecord,
  DevicePairSetupCompletionRecord,
  PairedDevice,
  PairedDeviceApprovalKind,
  PairedDeviceNodeSurface,
  PairedDevicePendingNodeSurface,
} from "./device-pairing.types.js";

export const DEVICE_BOOTSTRAP_TOKEN_COLUMNS_WITHOUT_SETUP = [
  "device_id",
  "issued_at_ms",
  "last_used_at_ms",
  "pending_profile_json",
  "profile_json",
  "public_key",
  "redeemed_profile_json",
  "token",
  "token_key",
  "ts",
] as const satisfies readonly (keyof DeviceBootstrapTokens)[];

// Read-back allowlist for the approved_via column. The Record type forces
// every PairedDeviceApprovalKind to appear here at compile time: omit one and
// this object is a type error, instead of the stored provenance silently
// dropping to undefined on load (which mergeApprovalKind treats as a legacy
// record). Keep this in sync when adding an approval kind.
const APPROVAL_KIND_MEMBERS = {
  owner: true,
  silent: true,
  "trusted-cidr": true,
  "trusted-proxy": true,
  "ssh-verified": true,
  bootstrap: true,
} satisfies Record<PairedDeviceApprovalKind, true>;
const APPROVAL_KINDS = new Set(Object.keys(APPROVAL_KIND_MEMBERS));

export function toJsonColumn(value: unknown): string | null {
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

export function toPendingRow(record: DevicePairingPendingRecord): DevicePairingPending {
  return {
    request_id: record.requestId,
    device_id: record.deviceId,
    public_key: record.publicKey,
    display_name: record.displayName ?? null,
    platform: record.platform ?? null,
    device_family: record.deviceFamily ?? null,
    client_id: record.clientId ?? null,
    client_mode: record.clientMode ?? null,
    browser_origin: record.browserOrigin ?? null,
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

export function fromPendingRow(row: DevicePairingPending): DevicePairingPendingRecord {
  return {
    requestId: row.request_id,
    deviceId: row.device_id,
    publicKey: row.public_key,
    ...optional("displayName", row.display_name),
    ...optional("platform", row.platform),
    ...optional("deviceFamily", row.device_family),
    ...optional("clientId", row.client_id),
    ...optional("clientMode", row.client_mode),
    ...optional("browserOrigin", row.browser_origin),
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

export function toPairedRow(device: PairedDevice): DevicePairingPaired {
  return {
    device_id: device.deviceId,
    public_key: device.publicKey,
    display_name: device.displayName ?? null,
    operator_label: device.operatorLabel ?? null,
    platform: device.platform ?? null,
    device_family: device.deviceFamily ?? null,
    client_id: device.clientId ?? null,
    client_mode: device.clientMode ?? null,
    browser_origin: device.browserOrigin ?? null,
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

// Same compile-time exhaustiveness contract as APPROVAL_KIND_MEMBERS: the
// completion access level is presented to the operator, so an unrecognized
// stored value must fall back to the least-privilege label, never leak through.
const PAIRING_SETUP_ACCESS_MEMBERS = {
  full: true,
  limited: true,
  node: true,
} satisfies Record<PairingSetupAccess, true>;
const PAIRING_SETUP_ACCESS_VALUES = new Set(Object.keys(PAIRING_SETUP_ACCESS_MEMBERS));

function fromSetupCompletionAccessColumn(value: string): PairingSetupAccess {
  return PAIRING_SETUP_ACCESS_VALUES.has(value) ? (value as PairingSetupAccess) : "limited";
}

function fromSetupCompletionDeliveryStateColumn(
  value: string,
): DevicePairSetupCompletionRecord["deliveryState"] {
  return value === "confirmed" ? "confirmed" : "uncertain";
}

export function fromPairedRow(row: DevicePairingPaired): PairedDevice {
  return {
    deviceId: row.device_id,
    publicKey: row.public_key,
    ...optional("displayName", row.display_name),
    ...optional("operatorLabel", row.operator_label),
    ...optional("platform", row.platform),
    ...optional("deviceFamily", row.device_family),
    ...optional("clientId", row.client_id),
    ...optional("clientMode", row.client_mode),
    ...optional("browserOrigin", row.browser_origin),
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

export function toBootstrapRow(
  tokenKey: string,
  record: DeviceBootstrapTokenRecord,
): DeviceBootstrapTokens {
  return {
    token_key: tokenKey,
    token: record.token,
    setup_id: record.setupId ?? null,
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

export function fromBootstrapRow(row: DeviceBootstrapTokens): DeviceBootstrapTokenRecord {
  return {
    token: row.token,
    ...optional("setupId", row.setup_id),
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

export function fromSetupCompletionRow(
  row: DevicePairSetupCompletions,
): DevicePairSetupCompletionRecord {
  return {
    setupId: row.setup_id,
    deviceId: row.device_id,
    ...optional("deviceName", row.device_name),
    access: fromSetupCompletionAccessColumn(row.access),
    completedAtMs: row.completed_at_ms,
    deliveryState: fromSetupCompletionDeliveryStateColumn(row.delivery_state),
    retainUntilMs: row.retain_until_ms,
  };
}
