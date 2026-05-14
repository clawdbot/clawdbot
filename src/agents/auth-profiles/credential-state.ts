import { coerceSecretRef, normalizeSecretInputString } from "../../config/types.secrets.js";
import type { AuthProfileCredential, OAuthCredential, OAuthCredentialRef } from "./types.js";

export type AuthCredentialReasonCode =
  | "ok"
  | "missing_credential"
  | "invalid_expires"
  | "expired"
  | "unresolved_ref";

export const DEFAULT_OAUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type TokenExpiryState = "missing" | "valid" | "expiring" | "expired" | "invalid_expires";

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
  if (!Number.isFinite(expires) || expires <= 0) {
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

function hasConfiguredSecretRef(value: unknown): boolean {
  return coerceSecretRef(value) !== null;
}

function hasConfiguredSecretString(value: unknown): boolean {
  return normalizeSecretInputString(value) !== undefined;
}

function hasConfiguredOAuthRef(value: OAuthCredentialRef | undefined): boolean {
  return (
    value?.source === "openclaw-credentials" &&
    value.provider === "openai-codex" &&
    typeof value.id === "string" &&
    /^[a-f0-9]{32}$/.test(value.id)
  );
}

export function evaluateStoredCredentialEligibility(params: {
  credential: AuthProfileCredential;
  now?: number;
}): { eligible: boolean; reasonCode: AuthCredentialReasonCode } {
  const now = params.now ?? Date.now();
  const credential = params.credential;

  if (credential.type === "api_key") {
    const hasKey = hasConfiguredSecretString(credential.key);
    const hasKeyRef = hasConfiguredSecretRef(credential.keyRef);
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
    normalizeSecretInputString(credential.refresh) === undefined &&
    !hasConfiguredOAuthRef(credential.oauthRef)
  ) {
    return { eligible: false, reasonCode: "missing_credential" };
  }
  return { eligible: true, reasonCode: "ok" };
}
