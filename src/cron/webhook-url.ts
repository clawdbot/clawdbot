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
  try {
    const parsed = new URL(trimmed);
    // Fetch rejects URL userinfo before dispatch. Fail at the shared boundary so
    // validation and doctor migration do not preserve a target that cannot deliver.
    if (!isHttpUrl(parsed) || parsed.username || parsed.password) {
      return null;
    }
  } catch {
    return null;
  }
  return trimmed;
}
