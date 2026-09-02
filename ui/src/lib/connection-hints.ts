import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
// Connection-failure hint classification shared by the login gate.
import {
  ConnectErrorDetailCodes,
  readConnectPairingRequiredMessage,
} from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { formatUiError } from "./format-error.ts";

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

const BROWSER_WEBSOCKET_SECURITY_ERROR_CODE = "BROWSER_WEBSOCKET_SECURITY_ERROR";

const INSECURE_CONTEXT_CODES = new Set<string>([
  BROWSER_WEBSOCKET_SECURITY_ERROR_CODE,
  ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
  ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
]);

const PROXY_AUTH_REASONS = new Set<string>([
  "trusted_proxy_no_request",
  "trusted_proxy_untrusted_source",
  "trusted_proxy_loopback_source",
  "trusted_proxy_local_interface_check_failed",
  "trusted_proxy_local_interface_source",
  "trusted_proxy_user_missing",
  "trusted_proxy_user_not_allowed",
  "trusted_proxy_config_missing",
  "trusted_proxy_no_proxies_configured",
  "proxy_attribution_required",
]);

// Generic unauthorized codes need their proxy reason; retain only these fixed
// producer values rather than arbitrary server details in the application snapshot.
export function readConnectionAuthReason(details: unknown): string | null {
  const reason = asNullableRecord(details)?.authReason;
  return typeof reason === "string" && PROXY_AUTH_REASONS.has(reason) ? reason : null;
}

type AuthHintKind = "required" | "failed" | "trusted-proxy";

type PairingHint =
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

/**
 * Return the connection auth hint to show, if any.
 *
 * Keep fallback string matching narrow so generic "connect failed" close reasons
 * do not get misclassified as token/password problems.
 */
export function resolveAuthHintKind(params: {
  connected: boolean;
  lastError: string | null;
  lastErrorCode?: string | null;
  lastErrorAuthReason?: string | null;
  hasToken: boolean;
  hasPassword: boolean;
}): AuthHintKind | null {
  if (params.connected || !params.lastError) {
    return null;
  }
  if (params.lastErrorCode) {
    if (
      params.lastErrorCode === ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED ||
      (params.lastErrorCode === ConnectErrorDetailCodes.AUTH_UNAUTHORIZED &&
        typeof params.lastErrorAuthReason === "string" &&
        PROXY_AUTH_REASONS.has(params.lastErrorAuthReason))
    ) {
      return "trusted-proxy";
    }
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

// Shared with offline presentation so no disconnected surface prints credentials.
export function redactLoginFailureError(value: string): string {
  const redacted = value
    .replace(
      /([?#&])(?:access_token|auth|deviceToken|password|refresh_token|token)=([^&#\s]+)/gi,
      "$1[redacted-credential]",
    )
    .replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:access|accessToken|deviceToken|password|refresh|refreshToken|token)["']?\s*[:=]\s*)["']?[^"',\s}]+/gi,
      "$1[redacted]",
    );
  return formatUiError(redacted);
}
