// Control UI module implements control ui auth behavior.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";

/** Every source a Control UI HTTP credential can come from, in one shape. */
export type ControlUiAuthSource = {
  hello?: {
    auth?: {
      deviceToken?: string | null;
      httpCredential?: string | null;
      /**
       * Deadline the Gateway minted `httpCredential` against. Optional because
       * only the lane that issues that credential sends it; a paired-device or
       * older peer omits it and every consumer must behave as it did before.
       */
      httpCredentialExpiresAtMs?: number | null;
    } | null;
  } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
};

// The gateway's shared-secret auth contract accepts either `token` or
// `password` as the Bearer credential on authenticated control-UI routes.
// Passing the password through the Authorization header is the intended
// server-side contract for `gateway.auth.mode="password"`. Callers that need
// resilience to stale credentials should use `resolveControlUiAuthCandidates`
// below to retry with the alternate credential on 401.
function sanitizeHeaderToken(value: string | null): string | null {
  if (!value) {
    return null;
  }
  // Reject tokens that would smuggle CR/LF into the HTTP header.
  return /[\r\n]/.test(value) ? null : value;
}

// `httpCredential` is the Gateway's answer for sessions that authenticate on a
// lane issuing no device token (Control UI over Tailscale Serve). It ranks below
// the device token so a paired browser keeps presenting its durable credential.
export function resolveControlUiAuthToken(source: ControlUiAuthSource): string | null {
  return (
    sanitizeHeaderToken(normalizeOptionalString(source.hello?.auth?.deviceToken) ?? null) ??
    sanitizeHeaderToken(normalizeOptionalString(source.hello?.auth?.httpCredential) ?? null) ??
    sanitizeHeaderToken(normalizeOptionalString(source.settings?.token) ?? null) ??
    sanitizeHeaderToken(normalizeOptionalString(source.password) ?? null) ??
    null
  );
}

// Only the Gateway-minted `httpCredential` expires out from under a live
// browser: a paired device token, a saved settings token and a password all
// outlive the session. So the deadline is reported only when that credential is
// the one this source actually presents, which keeps every other lane inert.
export function resolveControlUiCredentialExpiryMs(source: ControlUiAuthSource): number | null {
  const credential = sanitizeHeaderToken(
    normalizeOptionalString(source.hello?.auth?.httpCredential) ?? null,
  );
  if (!credential || resolveControlUiAuthToken(source) !== credential) {
    return null;
  }
  const expiresAtMs = source.hello?.auth?.httpCredentialExpiresAtMs;
  return typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs) && expiresAtMs > 0
    ? expiresAtMs
    : null;
}

export function resolveControlUiAuthHeader(source: ControlUiAuthSource): string | null {
  const token = resolveControlUiAuthToken(source);
  return token ? `Bearer ${token}` : null;
}

// Ordered list of non-empty, header-safe Control UI credentials. Used by
// call sites that can retry a single request against an alternate credential
// when the first returns 401 — for example, recovering from a stale
// `settings.token` when the live session is authenticated via `password`.
export function resolveControlUiAuthCandidates(source: ControlUiAuthSource): string[] {
  return uniqueStrings(
    [
      normalizeOptionalString(source.hello?.auth?.deviceToken),
      normalizeOptionalString(source.hello?.auth?.httpCredential),
      normalizeOptionalString(source.settings?.token),
      normalizeOptionalString(source.password),
    ].flatMap((raw) => sanitizeHeaderToken(raw ?? null) ?? []),
  );
}
