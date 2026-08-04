/**
 * Canonical header redaction for debug proxy captures.
 *
 * Both capture writers — the patched-fetch runtime and the standalone proxy
 * server — must redact identically. A capture that leaks credentials is worse
 * than no capture, and the standalone path previously stored raw headers while
 * the runtime path redacted, so this policy lives in one leaf module that both
 * import rather than being duplicated per writer.
 */
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";

export const REDACTED_CAPTURE_HEADER_VALUE = "[REDACTED]";

export function redactCaptureText(value: string): string {
  return redactRegisteredSecretValues(value, () => REDACTED_CAPTURE_HEADER_VALUE);
}

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

export type CaptureHeaderInputLimits = {
  maxEntries: number;
  maxNameChars: number;
  maxValueChars: number;
  maxTotalValueChars: number;
};

export function redactedCaptureHeadersBounded(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
  limits: CaptureHeaderInputLimits,
): { headers: Record<string, string>; truncated: boolean } {
  const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers ?? {});
  const redacted: Record<string, string> = {};
  let processedEntries = 0;
  let retainedValueChars = 0;
  let truncated = false;
  for (const [name, value] of entries) {
    if (processedEntries >= limits.maxEntries) {
      truncated = true;
      break;
    }
    processedEntries += 1;
    if (name.length > limits.maxNameChars) {
      truncated = true;
      continue;
    }
    if (isSensitiveCaptureHeaderName(name)) {
      redacted[name] = REDACTED_CAPTURE_HEADER_VALUE;
      continue;
    }
    const remainingTotalChars = limits.maxTotalValueChars - retainedValueChars;
    const maxAdmittedValueChars = Math.min(limits.maxValueChars, remainingTotalChars);
    let valueChars = 0;
    let valueTooLarge = false;
    if (Array.isArray(value)) {
      for (const [index, part] of value.entries()) {
        valueChars += part.length + (index > 0 ? 2 : 0);
        if (valueChars > maxAdmittedValueChars) {
          valueTooLarge = true;
          break;
        }
      }
    } else {
      valueChars = value?.length ?? 0;
      valueTooLarge = valueChars > maxAdmittedValueChars;
    }
    if (valueTooLarge) {
      truncated = true;
      continue;
    }
    const flattened = Array.isArray(value) ? value.join(", ") : (value ?? "");
    redacted[name] = redactCaptureText(flattened);
    retainedValueChars += valueChars;
  }
  return { headers: redacted, truncated };
}

export function redactedCaptureHeaders(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
  additionalSensitiveNames?: Iterable<string>,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const additionalSensitive = new Set(
    [...(additionalSensitiveNames ?? [])].map((name) => name.trim().toLowerCase()),
  );
  const entries =
    headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers);
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
    redacted[name] = redactCaptureText(flattened);
  }
  return redacted;
}
