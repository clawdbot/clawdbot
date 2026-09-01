import type { DatabaseSync } from "node:sqlite";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeDeviceBootstrapProfile,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { ensureDevicePairSetupBootstrapSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  DeviceBootstrapTokens,
} from "../state/openclaw-state-db.generated.js";
import type { DeviceBootstrapTokenRecord } from "./device-pairing.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

const DEVICE_BOOTSTRAP_TOKEN_COLUMNS_WITHOUT_SETUP = [
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

type PersistedPendingBootstrapState = Partial<DeviceBootstrapProfile> & {
  approvalRequests?: unknown;
};

function encodePendingBootstrapState(
  record: DeviceBootstrapTokenRecord,
): PersistedPendingBootstrapState | undefined {
  if (!record.pendingProfile && !record.pendingApprovalRequests?.length) {
    return undefined;
  }
  return {
    ...record.pendingProfile,
    ...(record.pendingApprovalRequests?.length
      ? { approvalRequests: record.pendingApprovalRequests }
      : {}),
  };
}

function decodePendingBootstrapState(value: unknown): {
  pendingProfile?: DeviceBootstrapProfile;
  pendingApprovalRequests?: DeviceBootstrapTokenRecord["pendingApprovalRequests"];
} {
  if (!value || typeof value !== "object") {
    return {};
  }
  const pendingState = asRecord(value);
  const requests = Array.isArray(pendingState.approvalRequests)
    ? pendingState.approvalRequests.flatMap((request) => {
        if (!request || typeof request !== "object") {
          return [];
        }
        const candidate = asRecord(request);
        const requestId = typeof candidate.requestId === "string" ? candidate.requestId.trim() : "";
        const role = typeof candidate.role === "string" ? candidate.role.trim() : "";
        const scopes = Array.isArray(candidate.scopes)
          ? candidate.scopes.filter((scope): scope is string => typeof scope === "string")
          : [];
        return requestId && role ? [{ requestId, role, scopes }] : [];
      })
    : [];
  const hasProfile =
    "roles" in pendingState || "scopes" in pendingState || "purpose" in pendingState;
  return {
    ...(hasProfile ? { pendingProfile: normalizeDeviceBootstrapProfile(pendingState) } : {}),
    ...(requests.length > 0 ? { pendingApprovalRequests: requests } : {}),
  };
}

function optional<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  // SAFETY: the computed property is exactly the generic key and retains the supplied value type.
  return value === null ? {} : ({ [key]: value } as { [P in K]: V });
}

function fromJsonColumn(value: string | null): unknown {
  return value === null ? undefined : JSON.parse(value);
}

function toBootstrapRow(
  tokenKey: string,
  record: DeviceBootstrapTokenRecord,
): DeviceBootstrapTokens {
  const toJsonColumn = (value: unknown): string | null =>
    value === undefined ? null : JSON.stringify(value);
  return {
    token_key: tokenKey,
    token: record.token,
    setup_id: record.setupId ?? null,
    ts: record.ts,
    device_id: record.deviceId ?? null,
    public_key: record.publicKey ?? null,
    profile_json: toJsonColumn(record.profile),
    redeemed_profile_json: toJsonColumn(record.redeemedProfile),
    pending_profile_json: toJsonColumn(encodePendingBootstrapState(record)),
    issued_at_ms: record.issuedAtMs,
    last_used_at_ms: record.lastUsedAtMs ?? null,
  };
}

export function fromBootstrapRow(row: DeviceBootstrapTokens): DeviceBootstrapTokenRecord {
  const profile = fromJsonColumn(row.profile_json);
  const redeemedProfile = fromJsonColumn(row.redeemed_profile_json);
  const pendingState = decodePendingBootstrapState(fromJsonColumn(row.pending_profile_json));
  return {
    token: row.token,
    ...optional("setupId", row.setup_id),
    ts: row.ts,
    ...optional("deviceId", row.device_id),
    ...optional("publicKey", row.public_key),
    ...optional(
      "profile",
      profile === undefined ? null : normalizeDeviceBootstrapProfile(asRecord(profile)),
    ),
    ...optional(
      "redeemedProfile",
      redeemedProfile === undefined
        ? null
        : normalizeDeviceBootstrapProfile(asRecord(redeemedProfile)),
    ),
    ...pendingState,
    issuedAtMs: row.issued_at_ms,
    ...optional("lastUsedAtMs", row.last_used_at_ms),
  };
}

export function loadDeviceBootstrapTokenRecordsFromDatabase(
  db: DatabaseSync,
): Record<string, DeviceBootstrapTokenRecord> {
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

export function replaceDeviceBootstrapTokenRecordsInDatabase(
  db: DatabaseSync,
  state: Record<string, DeviceBootstrapTokenRecord>,
): void {
  const rows = Object.entries(state).map(([tokenKey, record]) => toBootstrapRow(tokenKey, record));
  if (rows.some((row) => row.setup_id !== null)) {
    ensureDevicePairSetupBootstrapSchema(db);
  }
  const kysely = getNodeSqliteKysely<OpenClawStateKyselyDatabase>(db);
  executeSqliteQuerySync(db, kysely.deleteFrom("device_bootstrap_tokens"));
  if (rows.length === 0) {
    return;
  }
  if (tableHasColumn(db, "device_bootstrap_tokens", "setup_id")) {
    executeSqliteQuerySync(db, kysely.insertInto("device_bootstrap_tokens").values(rows));
    return;
  }
  const rowsWithoutSetup = rows.map(({ setup_id: _setupId, ...row }) => row);
  executeSqliteQuerySync(db, kysely.insertInto("device_bootstrap_tokens").values(rowsWithoutSetup));
}
