import { isHttpUrl } from "@openclaw/net-policy/url-protocol";

/** Normalizes cron webhook URLs while rejecting empty, malformed, and non-HTTP(S) values. */
export function normalizeHttpWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!isHttpUrl(trimmed)) {
    return null;
  }
  return trimmed;
}
