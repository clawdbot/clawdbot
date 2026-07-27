import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import type { CronConfig } from "../config/types.cron.js";

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

function webhookUrlHost(url: string): string | null {
  try {
    return normalizeWebhookTokenHost(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}

export function resolveCronWebhookTokenHosts(cron: CronConfig | undefined): string[] {
  const hosts = normalizeWebhookTokenHosts(cron?.webhookTokenHosts);
  if (cron?.failureAlert?.mode !== "webhook") {
    return hosts;
  }
  const url = normalizeHttpWebhookUrl(cron.failureAlert.to);
  const host = url ? webhookUrlHost(url) : null;
  return host && !hosts.includes(host) ? [...hosts, host] : hosts;
}

export function isCronWebhookTokenHostAllowed(url: string, allowedHosts: unknown): boolean {
  const entries = normalizeWebhookTokenHosts(allowedHosts);
  if (entries.length === 0) {
    return false;
  }
  if (entries.includes("*")) {
    return true;
  }
  const host = webhookUrlHost(url);
  return host !== null && entries.includes(host);
}
