import type { OtelContentCapturePolicy } from "./service-content-normalization.js";
import type { DiagnosticsMetrics } from "./service-metrics.js";
import type { DiagnosticsTraceRuntime } from "./service-traces.js";

export function createDiagnosticsRecorderRuntime(params: {
  contentCapturePolicy: OtelContentCapturePolicy;
  metrics: DiagnosticsMetrics;
  traces: DiagnosticsTraceRuntime;
  tracesEnabled: boolean;
}) {
  return {
    ...params.metrics,
    ...params.traces,
    contentCapturePolicy: params.contentCapturePolicy,
    tracesEnabled: params.tracesEnabled,
  };
}

export type DiagnosticsRecorderRuntime = ReturnType<typeof createDiagnosticsRecorderRuntime>;
