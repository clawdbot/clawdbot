import { parseFiniteNumber as parseFiniteNumberish } from "./parse-finite-number.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageProviderId } from "./provider-usage.types.js";

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function parseFiniteNumber(value: unknown): number | undefined {
  return parseFiniteNumberish(value);
}

type BuildUsageHttpErrorSnapshotOptions = {
  provider: UsageProviderId;
  status: number;
  message?: string;
  tokenExpiredStatuses?: readonly number[];
};

export function buildUsageErrorSnapshot(
  provider: UsageProviderId,
  error: string,
): ProviderUsageSnapshot {
  return {
    provider,
    displayName: PROVIDER_LABELS[provider],
    windows: [],
    error,
  };
}

export function buildUsageHttpErrorSnapshot(
  options: BuildUsageHttpErrorSnapshotOptions,
): ProviderUsageSnapshot {
  const tokenExpiredStatuses = options.tokenExpiredStatuses ?? [];
  if (tokenExpiredStatuses.includes(options.status)) {
    return buildUsageErrorSnapshot(options.provider, "Token expired");
  }
  const suffix = options.message?.trim() ? `: ${options.message.trim()}` : "";
  return buildUsageErrorSnapshot(options.provider, `HTTP ${options.status}${suffix}`);
}

export async function readUsageJson(
  provider: UsageProviderId,
  response: Response,
): Promise<{ ok: true; data: unknown } | { ok: false; snapshot: ProviderUsageSnapshot }> {
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return {
      ok: false,
      snapshot: buildUsageErrorSnapshot(provider, "Malformed usage response"),
    };
  }
}
