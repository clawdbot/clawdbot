// Qa Lab plugin module implements shared live-transport RTT behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type { QaEvidenceTiming } from "../../evidence-summary.js";

export type LiveTransportRttOptions<CheckId extends string = string> = {
  count: number;
  timeoutMs: number;
  maxFailures: number;
  checkIds: Set<CheckId>;
};

export type LiveTransportRttSample = {
  rttMs?: number;
  status: "pass" | "fail";
};

function normalizePositiveRttInteger(value: number | undefined) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TIMER_TIMEOUT_MS
  ) {
    return undefined;
  }
  return value;
}

export function normalizeLiveTransportRttOptions<CheckId extends string>(params: {
  count?: number;
  defaultCheckIds: readonly CheckId[];
  knownCheckIds: ReadonlySet<CheckId>;
  maxFailures?: number;
  rawCheckIds?: readonly string[];
  timeoutMs?: number;
  unknownCheckMessage: (checkId: string) => string;
}): LiveTransportRttOptions<CheckId> | undefined {
  const count = normalizePositiveRttInteger(params.count);
  if (count === undefined) {
    return undefined;
  }
  const rawCheckIds =
    params.rawCheckIds && params.rawCheckIds.length > 0
      ? params.rawCheckIds
      : params.defaultCheckIds;
  const checkIds = new Set<CheckId>();
  for (const checkId of rawCheckIds) {
    if (!params.knownCheckIds.has(checkId as CheckId)) {
      throw new Error(params.unknownCheckMessage(checkId));
    }
    checkIds.add(checkId as CheckId);
  }
  return {
    count,
    maxFailures: normalizePositiveRttInteger(params.maxFailures) ?? count,
    checkIds,
    timeoutMs: normalizePositiveRttInteger(params.timeoutMs) ?? 30_000,
  };
}

function percentile(sortedValues: readonly number[], percentileValue: number) {
  if (sortedValues.length === 0) {
    return undefined;
  }
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)];
}

export function summarizeLiveTransportRttSamples(samples: readonly LiveTransportRttSample[]) {
  const passed = samples.filter((sample) => sample.status === "pass" && sample.rttMs !== undefined);
  const sorted = passed.map((sample) => sample.rttMs as number).toSorted((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const timing: QaEvidenceTiming = {
    rttMs: percentile(sorted, 50),
    avgMs: sorted.length > 0 ? Math.round(sum / sorted.length) : undefined,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.at(-1),
    samples: samples.length,
    failedSamples: samples.length - passed.length,
  };
  return { passed: passed.length, failed: samples.length - passed.length, timing };
}
