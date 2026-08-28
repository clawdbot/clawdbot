import {
  getContinuationTracer,
  resetContinuationTracer,
  type Tracer,
} from "openclaw/plugin-sdk/diagnostic-runtime";

export function resetContinuationTracerIfOwned(expectedTracer: Tracer): boolean {
  if (getContinuationTracer() !== expectedTracer) {
    return false;
  }
  resetContinuationTracer();
  return true;
}
