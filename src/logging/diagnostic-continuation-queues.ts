import type { DiagnosticContinuationQueueMetrics } from "../infra/diagnostic-events.js";

type DiagnosticContinuationQueueMetricsProvider = (
  now: number,
) => DiagnosticContinuationQueueMetrics | null | undefined;

const continuationQueueMetricsProviders = new Set<DiagnosticContinuationQueueMetricsProvider>();

export function registerDiagnosticContinuationQueueMetricsProvider(
  provider: DiagnosticContinuationQueueMetricsProvider,
): () => void {
  continuationQueueMetricsProviders.add(provider);
  return () => {
    continuationQueueMetricsProviders.delete(provider);
  };
}

function combineContinuationQueueMetrics(
  samples: DiagnosticContinuationQueueMetrics[],
): DiagnosticContinuationQueueMetrics | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  if (samples.length === 1) {
    return samples[0];
  }

  const sampledAt = Math.max(...samples.map((sample) => sample.sampledAt));
  const intervalMsValues = samples
    .map((sample) => sample.intervalMs)
    .filter((value): value is number => typeof value === "number");
  const intervalMs = intervalMsValues.length > 0 ? Math.max(...intervalMsValues) : undefined;
  const enqueuedSinceLastSample = samples.reduce(
    (sum, sample) => sum + sample.enqueuedSinceLastSample,
    0,
  );
  const drainedSinceLastSample = samples.reduce(
    (sum, sample) => sum + sample.drainedSinceLastSample,
    0,
  );
  const failedSinceLastSample = samples.reduce(
    (sum, sample) => sum + sample.failedSinceLastSample,
    0,
  );

  return {
    sampledAt,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    totalQueued: samples.reduce((sum, sample) => sum + sample.totalQueued, 0),
    pendingQueued: samples.reduce((sum, sample) => sum + sample.pendingQueued, 0),
    pendingRunnable: samples.reduce((sum, sample) => sum + sample.pendingRunnable, 0),
    pendingScheduled: samples.reduce((sum, sample) => sum + sample.pendingScheduled, 0),
    stagedPostCompaction: samples.reduce((sum, sample) => sum + sample.stagedPostCompaction, 0),
    invalidQueued: samples.reduce((sum, sample) => sum + sample.invalidQueued, 0),
    enqueuedSinceLastSample,
    drainedSinceLastSample,
    failedSinceLastSample,
    ...(intervalMs !== undefined && intervalMs > 0
      ? {
          enqueueRatePerMinute: (enqueuedSinceLastSample * 60_000) / intervalMs,
          drainRatePerMinute: (drainedSinceLastSample * 60_000) / intervalMs,
          failedRatePerMinute: (failedSinceLastSample * 60_000) / intervalMs,
        }
      : {}),
    topQueues: samples
      .flatMap((sample) => sample.topQueues)
      .toSorted((a, b) => b.totalQueued - a.totalQueued || a.sessionKey.localeCompare(b.sessionKey))
      .slice(0, 8),
    queueDepthHistory: samples
      .flatMap((sample) => sample.queueDepthHistory)
      .toSorted((a, b) => a.sampledAt - b.sampledAt)
      .slice(-8),
  };
}

export function getDiagnosticContinuationQueueMetrics(
  now = Date.now(),
): DiagnosticContinuationQueueMetrics | undefined {
  const samples: DiagnosticContinuationQueueMetrics[] = [];
  for (const provider of continuationQueueMetricsProviders) {
    const sample = provider(now);
    if (sample) {
      samples.push(sample);
    }
  }
  return combineContinuationQueueMetrics(samples);
}
