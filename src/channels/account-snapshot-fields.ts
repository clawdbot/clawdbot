import { stripUrlUserInfo } from "../shared/net/url-userinfo.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import type { ChannelAccountSnapshot } from "./plugins/types.core.js";

// Read-only status commands project a safe subset of account fields into snapshots
// so renderers can preserve "configured but unavailable" state without touching
// strict runtime-only credential helpers.

const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

type CredentialStatusKey = (typeof CREDENTIAL_STATUS_KEYS)[number];

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" || typeof entry === "number" ? String(entry) : ""))
    .map((entry) => entry.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function readCredentialStatus(record: Record<string, unknown>, key: CredentialStatusKey) {
  const value = record[key];
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : undefined;
}

export function resolveConfiguredFromCredentialStatuses(account: unknown): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of CREDENTIAL_STATUS_KEYS) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status !== "missing") {
      return true;
    }
  }
  return sawCredentialStatus ? false : undefined;
}

export function resolveConfiguredFromRequiredCredentialStatuses(
  account: unknown,
  requiredKeys: CredentialStatusKey[],
): boolean | undefined {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return undefined;
  }
  let sawCredentialStatus = false;
  for (const key of requiredKeys) {
    const status = readCredentialStatus(record, key);
    if (!status) {
      continue;
    }
    sawCredentialStatus = true;
    if (status === "missing") {
      return false;
    }
  }
  return sawCredentialStatus ? true : undefined;
}

export function hasConfiguredUnavailableCredentialStatus(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return CREDENTIAL_STATUS_KEYS.some(
    (key) => readCredentialStatus(record, key) === "configured_unavailable",
  );
}

export function hasResolvedCredentialValue(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return (
    ["token", "botToken", "appToken", "signingSecret", "userToken"].some((key) => {
      return normalizeOptionalString(record[key]) !== undefined;
    }) || CREDENTIAL_STATUS_KEYS.some((key) => readCredentialStatus(record, key) === "available")
  );
}

export function projectCredentialSnapshotFields(
  account: unknown,
): Pick<
  Partial<ChannelAccountSnapshot>,
  | "tokenSource"
  | "botTokenSource"
  | "appTokenSource"
  | "signingSecretSource"
  | "tokenStatus"
  | "botTokenStatus"
  | "appTokenStatus"
  | "signingSecretStatus"
  | "userTokenStatus"
> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const tokenSource = normalizeOptionalString(record.tokenSource);
  const botTokenSource = normalizeOptionalString(record.botTokenSource);
  const appTokenSource = normalizeOptionalString(record.appTokenSource);
  const signingSecretSource = normalizeOptionalString(record.signingSecretSource);

  return {
    ...(tokenSource ? { tokenSource } : {}),
    ...(botTokenSource ? { botTokenSource } : {}),
    ...(appTokenSource ? { appTokenSource } : {}),
    ...(signingSecretSource ? { signingSecretSource } : {}),
    ...(readCredentialStatus(record, "tokenStatus")
      ? { tokenStatus: readCredentialStatus(record, "tokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "botTokenStatus")
      ? { botTokenStatus: readCredentialStatus(record, "botTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "appTokenStatus")
      ? { appTokenStatus: readCredentialStatus(record, "appTokenStatus") }
      : {}),
    ...(readCredentialStatus(record, "signingSecretStatus")
      ? { signingSecretStatus: readCredentialStatus(record, "signingSecretStatus") }
      : {}),
    ...(readCredentialStatus(record, "userTokenStatus")
      ? { userTokenStatus: readCredentialStatus(record, "userTokenStatus") }
      : {}),
  };
}

export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const name = normalizeOptionalString(record.name);
  const healthState = normalizeOptionalString(record.healthState);
  const mode = normalizeOptionalString(record.mode);
  const dmPolicy = normalizeOptionalString(record.dmPolicy);
  const baseUrl = normalizeOptionalString(record.baseUrl);
  const cliPath = normalizeOptionalString(record.cliPath);
  const dbPath = normalizeOptionalString(record.dbPath);

  return {
    ...(name ? { name } : {}),
    ...(readBoolean(record, "linked") !== undefined
      ? { linked: readBoolean(record, "linked") }
      : {}),
    ...(readBoolean(record, "running") !== undefined
      ? { running: readBoolean(record, "running") }
      : {}),
    ...(readBoolean(record, "connected") !== undefined
      ? { connected: readBoolean(record, "connected") }
      : {}),
    ...(readNumber(record, "reconnectAttempts") !== undefined
      ? { reconnectAttempts: readNumber(record, "reconnectAttempts") }
      : {}),
    ...(readNumber(record, "lastInboundAt") !== undefined
      ? { lastInboundAt: readNumber(record, "lastInboundAt") }
      : {}),
    ...(readNumber(record, "lastTransportActivityAt") !== undefined
      ? { lastTransportActivityAt: readNumber(record, "lastTransportActivityAt") }
      : {}),
    ...(healthState ? { healthState } : {}),
    ...(mode ? { mode } : {}),
    ...(dmPolicy ? { dmPolicy } : {}),
    ...(readStringArray(record, "allowFrom")
      ? { allowFrom: readStringArray(record, "allowFrom") }
      : {}),
    ...projectCredentialSnapshotFields(account),
    ...(baseUrl ? { baseUrl: stripUrlUserInfo(baseUrl) } : {}),
    ...(readBoolean(record, "allowUnmentionedGroups") !== undefined
      ? { allowUnmentionedGroups: readBoolean(record, "allowUnmentionedGroups") }
      : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(readNumber(record, "port") !== undefined ? { port: readNumber(record, "port") } : {}),
  };
}
