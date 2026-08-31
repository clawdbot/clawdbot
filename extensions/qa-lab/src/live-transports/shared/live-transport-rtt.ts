// Qa Lab plugin module implements shared live-transport RTT behavior.
import type { QaEvidenceTiming } from "../../evidence-summary.js";

export type LiveTransportRttSample = {
  rttMs?: number;
  status: "pass" | "fail";
};

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
