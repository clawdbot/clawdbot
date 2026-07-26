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

function normalizeWebhookTokenHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) {
    return [];
  }
  const normalized: string[] = [];
  for (const host of hosts) {
    if (typeof host !== "string") {
      continue;
    }
    const entry = host.trim().toLowerCase().replace(/\.+$/, "");
    if (entry && !normalized.includes(entry)) {
      normalized.push(entry);
    }
  }
  return normalized;
}

export function isCronWebhookTokenHostAllowed(url: string, allowedHosts: unknown): boolean {
  const entries = normalizeWebhookTokenHosts(allowedHosts);
  if (entries.length === 0) {
    return false;
  }
  if (entries.includes("*")) {
    return true;
  }
  try {
    return entries.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
