// Shared fetch and parsing helpers for provider usage endpoints.
import {
  asDateTimestampMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { parseFiniteNumber as parseFiniteNumberish } from "./parse-finite-number.js";
import { resolveProviderUsageDisplayName } from "./provider-usage.shared.js";
import type { ProviderUsageSnapshot, UsageProviderId } from "./provider-usage.types.js";

/** Fetches JSON-compatible provider usage endpoints with an abort timeout. */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const safeTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
  const timeoutSignal = AbortSignal.timeout(safeTimeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  // Keep the signal alive after headers so stalled response bodies cannot outlive
  // the deadline or caller cancellation. fetch binds it to request and body reads.
  return await fetchFn(url, { ...init, signal });
}

export async function discardUsageResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

export function parseFiniteNumber(value: unknown): number | undefined {
  return parseFiniteNumberish(value);
}

/** Parses a provider reset-time string without leaking an invalid Date timestamp. */
export function parseUsageResetAt(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return asDateTimestampMs(Date.parse(value));
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
    displayName: resolveProviderUsageDisplayName(provider),
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
