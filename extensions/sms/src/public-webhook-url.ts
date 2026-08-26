// Sms public webhook URL validation is shared by startup diagnostics and Twilio callbacks.
import { isIP } from "node:net";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";

// Bound generated callback metadata defensively; Twilio does not publish a
// 4,000-character StatusCallback contract.
const SMS_STATUS_CALLBACK_MAX_LENGTH = 4_000;
const SMS_STATUS_CALLBACK_READ_TIMEOUT_MS = 5_000;
const TWILIO_READ_TIMEOUT_MIN_MS = 100;
const TWILIO_READ_TIMEOUT_MAX_MS = 15_000;
const ABSOLUTE_HTTP_URL_PATTERN = /^https?:\/\//iu;
const RAW_AUTHORITY_PATTERN = /^[a-z0-9.:[\]-]+$/iu;
const RAW_PATH_QUERY_FRAGMENT_PATTERN = /^[a-z0-9\-._~%!$&'()*+,;=:@/?]*$/iu;
const INVALID_PERCENT_ESCAPE_PATTERN = /%(?![0-9a-f]{2})/iu;

function hasForbiddenRawUrlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x20 || codePoint === 0x5c || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasSafeRawUrlCharacters(value: string): boolean {
  const match = /^https?:\/\/([^/?#]*)([^#]*)(?:#(.*))?$/iu.exec(value);
  if (!match) {
    return false;
  }
  return (
    RAW_AUTHORITY_PATTERN.test(match[1] ?? "") &&
    RAW_PATH_QUERY_FRAGMENT_PATTERN.test(match[2] ?? "") &&
    RAW_PATH_QUERY_FRAGMENT_PATTERN.test(match[3] ?? "")
  );
}

function hasValidHostname(url: URL): boolean {
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  if (isBlockedHostnameOrIp(hostname)) {
    return false;
  }
  if (isIP(hostname) !== 0) {
    return true;
  }
  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!normalized.includes(".") || normalized.length > 253) {
    return false;
  }
  return normalized
    .split(".")
    .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
}

export function parseSmsPublicWebhookUrl(value: string): URL | undefined {
  const trimmed = value.trim();
  if (
    !ABSOLUTE_HTTP_URL_PATTERN.test(trimmed) ||
    !hasSafeRawUrlCharacters(trimmed) ||
    INVALID_PERCENT_ESCAPE_PATTERN.test(trimmed) ||
    hasForbiddenRawUrlCharacter(trimmed)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !hasValidHostname(url)
  ) {
    return undefined;
  }
  return url;
}

function parseTwilioRetryPolicies(overrides: URLSearchParams): string[] {
  const policies = overrides
    .getAll("rp")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  return policies.length > 0 ? [...new Set(policies)] : ["ct"];
}

export function resolveTwilioStatusCallbackUrl(publicWebhookUrl: string): string {
  const trimmed = publicWebhookUrl.trim();
  if (!trimmed || !parseSmsPublicWebhookUrl(trimmed)) {
    return "";
  }
  const hashIndex = trimmed.indexOf("#");
  const baseUrl = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const overrides = new URLSearchParams(hashIndex === -1 ? "" : trimmed.slice(hashIndex + 1));
  const retryPolicies = parseTwilioRetryPolicies(overrides);
  const normalizedRetryPolicies = new Set(retryPolicies.map((policy) => policy.toLowerCase()));
  if (!normalizedRetryPolicies.has("all")) {
    for (const requiredPolicy of ["ct", "rt", "5xx"]) {
      if (!normalizedRetryPolicies.has(requiredPolicy)) {
        retryPolicies.push(requiredPolicy);
      }
    }
  }
  overrides.set("rp", retryPolicies.join(","));

  const configuredReadTimeout = Number(overrides.get("rt"));
  const readTimeout =
    Number.isInteger(configuredReadTimeout) &&
    configuredReadTimeout >= TWILIO_READ_TIMEOUT_MIN_MS &&
    configuredReadTimeout <= TWILIO_READ_TIMEOUT_MAX_MS
      ? configuredReadTimeout
      : SMS_STATUS_CALLBACK_READ_TIMEOUT_MS;
  overrides.set("rt", String(readTimeout));

  const configuredRetryCount = Number(overrides.get("rc"));
  const retryCount =
    Number.isInteger(configuredRetryCount) && configuredRetryCount >= 1 && configuredRetryCount <= 5
      ? configuredRetryCount
      : 1;
  overrides.set("rc", String(retryCount));

  // Delivery state is committed before acknowledgement. Retry both a missing
  // response and a resulting 5xx or the observation can disappear silently.
  const callbackUrl = `${baseUrl}#${overrides.toString().replaceAll("%2C", ",")}`;
  if (
    callbackUrl.length > SMS_STATUS_CALLBACK_MAX_LENGTH ||
    !parseSmsPublicWebhookUrl(callbackUrl)
  ) {
    return "";
  }
  return callbackUrl;
}
