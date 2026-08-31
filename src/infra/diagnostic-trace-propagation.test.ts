import { afterEach, expect, it, vi } from "vitest";
import {
  formatPropagatedDiagnosticTraceparent,
  registerDiagnosticTracePropagationBridge,
  resetDiagnosticTracePropagationForTest,
} from "./diagnostic-trace-propagation.js";

afterEach(resetDiagnosticTracePropagationForTest);

it("shares exporter ordering and cleanup across module instances", async () => {
  const trace = {
    traceId: "1234567890abcdef1234567890abcdef",
    spanId: "1234567890abcdef",
  };
  const older = { resolveTraceContext: () => ({ ...trace, traceFlags: "00" }) };
  const current = { resolveTraceContext: () => undefined };
  const stopOlder = registerDiagnosticTracePropagationBridge(older);
  vi.resetModules();
  const duplicate = await import("./diagnostic-trace-propagation.js");
  const stopCurrent = duplicate.registerDiagnosticTracePropagationBridge(current);
  const stopDuplicate = registerDiagnosticTracePropagationBridge(older);

  expect(formatPropagatedDiagnosticTraceparent(trace)).toBeUndefined();
  stopCurrent();
  expect(duplicate.formatPropagatedDiagnosticTraceparent(trace)).toBe(
    `00-${trace.traceId}-${trace.spanId}-00`,
  );

  const stopLatest = duplicate.registerDiagnosticTracePropagationBridge(current);
  stopOlder();
  stopDuplicate();
  expect(formatPropagatedDiagnosticTraceparent(trace)).toBeUndefined();
  stopLatest();
  expect(formatPropagatedDiagnosticTraceparent(trace)).toBe(
    `00-${trace.traceId}-${trace.spanId}-01`,
  );

  registerDiagnosticTracePropagationBridge(current);
  duplicate.resetDiagnosticTracePropagationForTest();
  expect(formatPropagatedDiagnosticTraceparent(trace)).toBe(
    `00-${trace.traceId}-${trace.spanId}-01`,
  );
});
