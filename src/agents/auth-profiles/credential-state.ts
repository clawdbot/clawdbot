/**
 * Credential state classification for auth profiles.
 * Centralizes expiry, missing-secret, and unresolved-reference checks used by
 * auth selection, refresh, health, and doctor flows.
 */
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { coerceSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
import type { AuthProfileCredential, OAuthCredential } from "./types.js";

/** Reason code for why a stored auth credential can or cannot be used. */
export type AuthCredentialReasonCode =
  | "ok"
  | "missing_credential"
  | "invalid_expires"
  | "expired"
  | "unresolved_ref"
  | "malformed_api_key";

/** Default OAuth access-token refresh margin before expiry. */
export const DEFAULT_OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Normalized expiry state for token-style credentials. */
export type TokenExpiryState = "missing" | "valid" | "expiring" | "expired" | "invalid_expires";

/** Classifies a token expiry timestamp for auth selection and refresh logic. */
export function resolveTokenExpiryState(
  expires: unknown,
  now = Date.now(),
  opts?: {
    expiringWithinMs?: number;
  },
): TokenExpiryState {
  if (expires === undefined) {
    return "missing";
  }
  if (typeof expires !== "number") {
    return "invalid_expires";
  }
  if (!Number.isFinite(expires) || expires <= 0 || expires > MAX_DATE_TIMESTAMP_MS) {
    return "invalid_expires";
  }
  const remainingMs = expires - now;
  if (remainingMs <= 0) {
    return "expired";
  }
  const expiringWithinMs = Math.max(0, opts?.expiringWithinMs ?? 0);
  if (expiringWithinMs > 0 && remainingMs <= expiringWithinMs) {
    return "expiring";
  }
  return "valid";
}

/** Returns true when an OAuth credential has a non-expiring access token. */
export function hasUsableOAuthCredential(
  credential: OAuthCredential | undefined,
  opts?: {
    now?: number;
    refreshMarginMs?: number;
  },
): boolean {
  if (!credential || credential.type !== "oauth") {
    return false;
  }
  if (typeof credential.access !== "string" || credential.access.trim().length === 0) {
    return false;
  }
  const now = opts?.now ?? Date.now();
  const refreshMarginMs = Math.max(0, opts?.refreshMarginMs ?? DEFAULT_OAUTH_REFRESH_MARGIN_MS);
  return (
    resolveTokenExpiryState(credential.expires, now, {
      expiringWithinMs: refreshMarginMs,
    }) === "valid"
  );
}

// SecretRef and literal secret strings are both valid configured credentials;
// unresolved refs are classified separately so callers can surface useful copy.
function hasConfiguredSecretRef(value: unknown): boolean {
  return coerceSecretRef(value) !== null;
}

function hasConfiguredSecretString(value: unknown): boolean {
  return normalizeSecretInputString(value) !== undefined;
}

export function isMalformedApiKeyInput(value: unknown): boolean {
  const normalized = normalizeSecretInputString(value);
  return (
    normalized !== undefined &&
    /^openclaw\s+onboard(?:\s+.*)?\s+--auth-choice(?:\s|=|$)/i.test(normalized)
  );
}

/** Classifies whether a stored credential is eligible for auth selection. */
export function evaluateStoredCredentialEligibility(params: {
  credential: AuthProfileCredential;
  now?: number;
}): { eligible: boolean; reasonCode: AuthCredentialReasonCode } {
  const now = params.now ?? Date.now();
  const credential = params.credential;

  if (credential.type === "api_key") {
    const hasKey = hasConfiguredSecretString(credential.key);
    const hasKeyRef = hasConfiguredSecretRef(credential.keyRef);
    if (isMalformedApiKeyInput(credential.key)) {
      return { eligible: false, reasonCode: "malformed_api_key" };
    }
    if (!hasKey && !hasKeyRef) {
      return { eligible: false, reasonCode: "missing_credential" };
    }
    return { eligible: true, reasonCode: "ok" };
  }

  if (credential.type === "token") {
    const hasToken = hasConfiguredSecretString(credential.token);
    const hasTokenRef = hasConfiguredSecretRef(credential.tokenRef);
    if (!hasToken && !hasTokenRef) {
      return { eligible: false, reasonCode: "missing_credential" };
    }

    const expiryState = resolveTokenExpiryState(credential.expires, now);
    if (expiryState === "invalid_expires") {
      return { eligible: false, reasonCode: "invalid_expires" };
    }
    if (expiryState === "expired") {
      return { eligible: false, reasonCode: "expired" };
    }
    return { eligible: true, reasonCode: "ok" };
  }

  if (
    normalizeSecretInputString(credential.access) === undefined &&
    normalizeSecretInputString(credential.refresh) === undefined
  ) {
    if (credential.oauthRef) {
      return { eligible: false, reasonCode: "unresolved_ref" };
    }
    return { eligible: false, reasonCode: "missing_credential" };
  }
  return { eligible: true, reasonCode: "ok" };
}
