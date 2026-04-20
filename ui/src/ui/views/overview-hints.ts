import {
  ConnectErrorDetailCodes,
  readConnectPairingRequiredMessage,
} from "../../../../src/gateway/protocol/connect-error-details.js";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

const AUTH_REQUIRED_CODES = new Set<string>([
  ConnectErrorDetailCodes.AUTH_REQUIRED,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED,
  ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED,
]);

const AUTH_FAILURE_CODES = new Set<string>([
  ...AUTH_REQUIRED_CODES,
  ConnectErrorDetailCodes.AUTH_UNAUTHORIZED,
  ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISSING,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_PROXY_MISSING,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_WHOIS_FAILED,
  ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH,
]);

const INSECURE_CONTEXT_CODES = new Set<string>([
  ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
  ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
]);

type AuthHintKind = "required" | "failed";

export type PairingHint =
  | {
      kind: "pairing-required";
      requestId: string | null;
    }
  | {
      kind: "scope-upgrade-pending" | "role-upgrade-pending" | "metadata-upgrade-pending";
      requestId: string | null;
    };

export function resolvePairingHint(
  connected: boolean,
  lastError: string | null,
  lastErrorCode?: string | null,
): PairingHint | null {
  if (connected || !lastError) {
    return null;
  }
  const pairing = readConnectPairingRequiredMessage(lastError);
  if (pairing) {
    return {
      kind:
        pairing.reason === "scope-upgrade"
          ? "scope-upgrade-pending"
          : pairing.reason === "role-upgrade"
            ? "role-upgrade-pending"
            : pairing.reason === "metadata-upgrade"
              ? "metadata-upgrade-pending"
              : "pairing-required",
      requestId: pairing.requestId ?? null,
    };
  }
  if (lastErrorCode === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
    return { kind: "pairing-required", requestId: null };
  }
  return null;
}

/** Whether the overview should show device-pairing guidance for this error. */
export function shouldShowPairingHint(
  connected: boolean,
  lastError: string | null,
  lastErrorCode?: string | null,
): boolean {
  return resolvePairingHint(connected, lastError, lastErrorCode) !== null;
}

/**
 * Return the overview auth hint to show, if any.
 *
 * Keep fallback string matching narrow so generic "connect failed" close reasons
 * do not get misclassified as token/password problems.
 */
export function resolveAuthHintKind(params: {
  connected: boolean;
  lastError: string | null;
  lastErrorCode?: string | null;
  hasToken: boolean;
  hasPassword: boolean;
}): AuthHintKind | null {
  if (params.connected || !params.lastError) {
    return null;
  }
  if (params.lastErrorCode) {
    if (!AUTH_FAILURE_CODES.has(params.lastErrorCode)) {
      return null;
    }
    return AUTH_REQUIRED_CODES.has(params.lastErrorCode) ? "required" : "failed";
  }

  const lower = normalizeLowercaseStringOrEmpty(params.lastError);
  if (!lower.includes("unauthorized")) {
    return null;
  }
  return !params.hasToken && !params.hasPassword ? "required" : "failed";
}

export function shouldShowInsecureContextHint(
  connected: boolean,
  lastError: string | null,
  lastErrorCode?: string | null,
): boolean {
  if (connected || !lastError) {
    return false;
  }
  if (lastErrorCode) {
    return INSECURE_CONTEXT_CODES.has(lastErrorCode);
  }
  const lower = normalizeLowercaseStringOrEmpty(lastError);
  return lower.includes("secure context") || lower.includes("device identity required");
}
