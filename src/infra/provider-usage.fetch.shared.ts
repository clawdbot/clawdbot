// Shared fetch and parsing helpers for provider usage endpoints.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { parseFiniteNumber as parseFiniteNumberish } from "./parse-finite-number.js";
import { PROVIDER_LABELS } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageProviderId } from "./provider-usage.types.js";

/** Fetches JSON-compatible provider usage endpoints with an abort timeout. */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const safeTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), safeTimeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function discardUsageResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
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

/** Builds a provider usage snapshot for non-HTTP fetch or parse failures. */
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
    const data = await readProviderJsonResponse<unknown>(response, `${provider} usage`);
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      snapshot: buildUsageErrorSnapshot(provider, "Malformed usage response"),
    };
  }
}
