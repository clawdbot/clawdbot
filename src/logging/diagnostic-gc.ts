import { performance, PerformanceObserver } from "node:perf_hooks";
import { hasInternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";

let observer: PerformanceObserver | undefined;

export function stopDiagnosticGcObserver(): void {
  const current = observer;
  observer = undefined;
  current?.disconnect();
}

export function reconcileDiagnosticGcObserver(): void {
  if (
    !areDiagnosticsEnabledForProcess() ||
    !hasInternalDiagnosticEventInterest("diagnostic.gc") ||
    !PerformanceObserver.supportedEntryTypes.includes("gc")
  ) {
    stopDiagnosticGcObserver();
    return;
  }
  if (observer) {
    return;
  }

  const activatedAt = performance.now();
  const current = new PerformanceObserver((list) => {
    if (
      observer !== current ||
      !areDiagnosticsEnabledForProcess() ||
      !hasInternalDiagnosticEventInterest("diagnostic.gc")
    ) {
      return;
    }
    runWithDiagnosticTraceContext(undefined, () => {
      for (const entry of list.getEntries()) {
        // Node can deliver a queued native GC entry to a replacement observer.
        // Disconnect clears JS buffers, but does not cancel that native delivery.
        if (entry.startTime >= activatedAt) {
          emitInternalDiagnosticEvent({ type: "diagnostic.gc", durationMs: entry.duration });
        }
      }
    });
  });
  observer = current;
  current.observe({ entryTypes: ["gc"] });
}
