import { normalizeOptionalString } from "./string-coerce.ts";

type ControlUiAuthSource = {
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
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

export function resolveControlUiAuthToken(source: ControlUiAuthSource): string | null {
  return (
    sanitizeHeaderToken(normalizeOptionalString(source.hello?.auth?.deviceToken) ?? null) ??
    sanitizeHeaderToken(normalizeOptionalString(source.settings?.token) ?? null) ??
    sanitizeHeaderToken(normalizeOptionalString(source.password) ?? null) ??
    null
  );
}

export function resolveControlUiAuthHeader(source: ControlUiAuthSource): string | null {
  const token = resolveControlUiAuthToken(source);
  return token ? `Bearer ${token}` : null;
}

// Ordered list of non-empty, header-safe shared-secret candidates. Used by
// call sites that can retry a single request against an alternate credential
// when the first returns 401 — for example, recovering from a stale
// `settings.token` when the live session is authenticated via `password`.
export function resolveControlUiAuthCandidates(source: ControlUiAuthSource): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [
    normalizeOptionalString(source.hello?.auth?.deviceToken),
    normalizeOptionalString(source.settings?.token),
    normalizeOptionalString(source.password),
  ]) {
    const sanitized = sanitizeHeaderToken(raw ?? null);
    if (sanitized && !seen.has(sanitized)) {
      seen.add(sanitized);
      out.push(sanitized);
    }
  }
  return out;
}
