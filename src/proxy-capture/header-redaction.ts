/**
 * Canonical header redaction for debug proxy captures.
 *
 * Both capture writers — the patched-fetch runtime and the standalone proxy
 * server — must redact identically. A capture that leaks credentials is worse
 * than no capture, and the standalone path previously stored raw headers while
 * the runtime path redacted, so this policy lives in one leaf module that both
 * import rather than being duplicated per writer.
 */
import { isHeadersLike, type HeadersLike } from "../infra/fetch-headers.js";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";

export const REDACTED_CAPTURE_HEADER_VALUE = "[REDACTED]";

const SENSITIVE_CAPTURE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "auth-token",
  "x-access-token",
  "access-token",
]);
const SENSITIVE_CAPTURE_HEADER_NAME_FRAGMENTS = [
  "api-key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "session",
];

function isSensitiveCaptureHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (SENSITIVE_CAPTURE_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return SENSITIVE_CAPTURE_HEADER_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function redactedCaptureHeaders(
  headers: HeadersLike | Record<string, string | string[] | undefined> | undefined,
  additionalSensitiveNames?: Iterable<string>,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const additionalSensitive = new Set(
    [...(additionalSensitiveNames ?? [])].map((name) => name.trim().toLowerCase()),
  );
  const entries = isHeadersLike(headers) ? Array.from(headers.entries()) : Object.entries(headers);
  const redacted: Record<string, string> = {};
  for (const [name, value] of entries) {
    // Header names are matched exactly and by sensitive fragments because
    // providers use many token/key naming variants. Names that pass the check
    // still run through value redaction so a registered secret pasted into an
    // innocuous header does not survive.
    if (additionalSensitive.has(name.trim().toLowerCase()) || isSensitiveCaptureHeaderName(name)) {
      redacted[name] = REDACTED_CAPTURE_HEADER_VALUE;
      continue;
    }
    const flattened = Array.isArray(value) ? value.join(", ") : (value ?? "");
    redacted[name] = redactRegisteredSecretValues(flattened, () => REDACTED_CAPTURE_HEADER_VALUE);
  }
  return redacted;
}
