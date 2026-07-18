/**
 * Status-safe channel account projection helpers for CLI, status APIs, and plugin SDK callers.
 * This file is the redaction boundary between runtime account objects and public snapshots.
 */
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { stripUrlUserInfo } from "@openclaw/net-policy/url-userinfo";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isRecord } from "../utils.js";
import { asBoolean } from "../utils/boolean.js";
import type { ChannelAccountSnapshot } from "./plugins/types.core.js";

type CredentialUnavailableDiagnostic = {
  code: "CREDENTIAL_FILE_UNAVAILABLE";
  path: string;
  reason: string;
};

const CREDENTIAL_STATUS_KEYS = [
  "tokenStatus",
  "botTokenStatus",
  "appTokenStatus",
  "signingSecretStatus",
  "userTokenStatus",
] as const;

type CredentialStatusKey = (typeof CREDENTIAL_STATUS_KEYS)[number];

/** Redacts a plugin-provided base URL after status hooks have produced their final record. */
export function redactChannelStatusSummaryBaseUrl<T>(summary: T): T {
  if (!isRecord(summary) || typeof summary.baseUrl !== "string" || !summary.baseUrl) {
    return summary;
  }
  const redactedBaseUrl = stripUrlUserInfo(redactSensitiveUrlLikeString(summary.baseUrl));
  return redactedBaseUrl === summary.baseUrl
    ? summary
    : ({ ...summary, baseUrl: redactedBaseUrl } as T);
}

/** Redacts a plugin-provided base URL at the public account-snapshot boundary. */
export function redactChannelAccountSnapshotBaseUrl<T extends Partial<ChannelAccountSnapshot>>(
  snapshot: T,
): T {
  return redactChannelStatusSummaryBaseUrl(snapshot);
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  return asBoolean(record[key]);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return asFiniteNumber(value);
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (record[key] === null) {
    return null;
  }
  return readNumber(record, key);
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(
    value.map((entry) => (typeof entry === "string" || typeof entry === "number" ? entry : "")),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function readCredentialStatus(record: Record<string, unknown>, key: CredentialStatusKey) {
  const value = record[key];
  return value === "available" || value === "configured_unavailable" || value === "missing"
    ? value
    : undefined;
}

/**
 * Infers whether any known credential status makes an account configured.
 *
 * Status commands need this metadata for "configured but unavailable" accounts without reading
 * raw credentials from runtime-only helpers.
 */
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

/** Infers configured state only from the credential status keys required by a channel. */
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

/** Returns true when a credential exists but cannot be resolved at status-render time. */
export function hasConfiguredUnavailableCredentialStatus(account: unknown): boolean {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return false;
  }
  return CREDENTIAL_STATUS_KEYS.some(
    (key) => readCredentialStatus(record, key) === "configured_unavailable",
  );
}

/** Reads typed, redacted credential diagnostics from a resolved channel account. */
export function getCredentialUnavailableDiagnostics(
  account: unknown,
): CredentialUnavailableDiagnostic[] {
  const record = isRecord(account) ? account : null;
  if (!record || !Array.isArray(record.credentialDiagnostics)) {
    return [];
  }
  const diagnostics: CredentialUnavailableDiagnostic[] = [];
  for (const value of record.credentialDiagnostics) {
    if (!isRecord(value) || value.code !== "CREDENTIAL_FILE_UNAVAILABLE") {
      continue;
    }
    const path = normalizeOptionalString(value.path);
    const reason = normalizeOptionalString(value.reason);
    if (path && reason) {
      diagnostics.push({ code: value.code, path, reason });
    }
  }
  return diagnostics;
}

/** Returns true when account data contains a resolved credential value or available status. */
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

/** Projects credential source/status metadata while omitting raw credential values. */
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

  // Only project source/status fields. Token-like values stay out of account snapshots even when
  // callers pass full runtime account objects.
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

/**
 * Projects status-safe account fields for read-only channel/account snapshots.
 *
 * This is the boundary between runtime account objects and status renderers; keep it explicit so
 * new channel fields do not accidentally expose webhook URLs, public keys, or raw credentials.
 */
export function projectSafeChannelAccountSnapshotFields(
  account: unknown,
): Partial<ChannelAccountSnapshot> {
  const record = isRecord(account) ? account : null;
  if (!record) {
    return {};
  }
  const name = normalizeOptionalString(record.name);
  const statusState = normalizeOptionalString(record.statusState);
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
    ...(readBoolean(record, "restartPending") !== undefined
      ? { restartPending: readBoolean(record, "restartPending") }
      : {}),
    ...(readNumber(record, "reconnectAttempts") !== undefined
      ? { reconnectAttempts: readNumber(record, "reconnectAttempts") }
      : {}),
    ...(readNullableNumber(record, "lastConnectedAt") !== undefined
      ? { lastConnectedAt: readNullableNumber(record, "lastConnectedAt") }
      : {}),
    ...(readNumber(record, "lastInboundAt") !== undefined
      ? { lastInboundAt: readNumber(record, "lastInboundAt") }
      : {}),
    ...(readNullableNumber(record, "lastOutboundAt") !== undefined
      ? { lastOutboundAt: readNullableNumber(record, "lastOutboundAt") }
      : {}),
    ...(readNullableNumber(record, "lastMessageAt") !== undefined
      ? { lastMessageAt: readNullableNumber(record, "lastMessageAt") }
      : {}),
    ...(readNullableNumber(record, "lastEventAt") !== undefined
      ? { lastEventAt: readNullableNumber(record, "lastEventAt") }
      : {}),
    ...(readNumber(record, "lastTransportActivityAt") !== undefined
      ? { lastTransportActivityAt: readNumber(record, "lastTransportActivityAt") }
      : {}),
    ...(statusState ? { statusState } : {}),
    ...(healthState ? { healthState } : {}),
    ...(readBoolean(record, "terminalDisconnect") !== undefined
      ? { terminalDisconnect: readBoolean(record, "terminalDisconnect") }
      : {}),
    ...(readBoolean(record, "busy") !== undefined ? { busy: readBoolean(record, "busy") } : {}),
    ...(readNumber(record, "activeRuns") !== undefined
      ? { activeRuns: readNumber(record, "activeRuns") }
      : {}),
    ...(readNullableNumber(record, "lastRunActivityAt") !== undefined
      ? { lastRunActivityAt: readNullableNumber(record, "lastRunActivityAt") }
      : {}),
    ...(mode ? { mode } : {}),
    ...(dmPolicy ? { dmPolicy } : {}),
    ...(readStringArray(record, "allowFrom")
      ? { allowFrom: readStringArray(record, "allowFrom") }
      : {}),
    ...projectCredentialSnapshotFields(account),
    // Base URLs are useful diagnostics, but embedded credentials must not cross this boundary.
    ...(baseUrl ? { baseUrl: stripUrlUserInfo(redactSensitiveUrlLikeString(baseUrl)) } : {}),
    ...(readBoolean(record, "allowUnmentionedGroups") !== undefined
      ? { allowUnmentionedGroups: readBoolean(record, "allowUnmentionedGroups") }
      : {}),
    ...(cliPath ? { cliPath } : {}),
    ...(dbPath ? { dbPath } : {}),
    ...(readNumber(record, "port") !== undefined ? { port: readNumber(record, "port") } : {}),
  };
}
