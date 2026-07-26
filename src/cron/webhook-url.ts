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

const WEBHOOK_TOKEN_HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;
const WEBHOOK_TOKEN_IPV6_RE = /^\[[0-9a-f:.]+\]$/u;

function normalizeWebhookTokenHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "");
}

export function isCronWebhookTokenHostEntry(value: string): boolean {
  const entry = normalizeWebhookTokenHost(value);
  if (!entry) {
    return false;
  }
  if (entry === "*") {
    return true;
  }
  if (entry.startsWith("[")) {
    return WEBHOOK_TOKEN_IPV6_RE.test(entry);
  }
  return WEBHOOK_TOKEN_HOSTNAME_RE.test(entry);
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
    const entry = normalizeWebhookTokenHost(host);
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
    return entries.includes(normalizeWebhookTokenHost(new URL(url).hostname));
  } catch {
    return false;
  }
}
