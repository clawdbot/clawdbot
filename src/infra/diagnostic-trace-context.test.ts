import { describe, expect, it } from "vitest";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  formatDiagnosticTraceparent,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  parseDiagnosticTraceparent,
} from "./diagnostic-trace-context.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "7ad6b9a982deb2c9";

describe("diagnostic-trace-context", () => {
  it("validates W3C trace ids, span ids, and trace flags", () => {
    expect(isValidDiagnosticTraceId(TRACE_ID)).toBe(true);
    expect(isValidDiagnosticSpanId(SPAN_ID)).toBe(true);
    expect(isValidDiagnosticTraceFlags("01")).toBe(true);

    expect(isValidDiagnosticTraceId("0".repeat(32))).toBe(false);
    expect(isValidDiagnosticTraceId("xyz")).toBe(false);
    expect(isValidDiagnosticSpanId("0".repeat(16))).toBe(false);
    expect(isValidDiagnosticSpanId("xyz")).toBe(false);
    expect(isValidDiagnosticTraceFlags("xyz")).toBe(false);
  });

  it("parses and formats traceparent values", () => {
    const traceparent = `00-${TRACE_ID}-${SPAN_ID}-01`;

    expect(parseDiagnosticTraceparent(traceparent)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: "01",
    });
    expect(
      formatDiagnosticTraceparent({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: "01",
      }),
    ).toBe(traceparent);
  });

  it("rejects malformed traceparent values", () => {
    expect(parseDiagnosticTraceparent(undefined)).toBeUndefined();
    expect(parseDiagnosticTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-extra`)).toBeUndefined();
    expect(parseDiagnosticTraceparent(`ff-${TRACE_ID}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseDiagnosticTraceparent(`00-${"0".repeat(32)}-${SPAN_ID}-01`)).toBeUndefined();
    expect(parseDiagnosticTraceparent(`00-${TRACE_ID}-${"0".repeat(16)}-01`)).toBeUndefined();
    expect(parseDiagnosticTraceparent(`00-${TRACE_ID}-${SPAN_ID}-xyz`)).toBeUndefined();
  });

  it("rejects oversized traceparent values before parsing", () => {
    expect(
      parseDiagnosticTraceparent(`00-${TRACE_ID}-${SPAN_ID}-01-${"a".repeat(128)}`),
    ).toBeUndefined();
  });

  it("continues future-version traceparents from the first four fields", () => {
    expect(parseDiagnosticTraceparent(`01-${TRACE_ID}-${SPAN_ID}-01-extra`)).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: "01",
    });
  });

  it("creates a normalized context from explicit fields or traceparent", () => {
    expect(
      createDiagnosticTraceContext({
        traceId: TRACE_ID.toUpperCase(),
        spanId: SPAN_ID.toUpperCase(),
        traceFlags: "00",
      }),
    ).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: "00",
    });

    expect(createDiagnosticTraceContext({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` })).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: "01",
    });
  });

  it("generates valid non-zero ids for fallback contexts", () => {
    const context = createDiagnosticTraceContext();

    expect(isValidDiagnosticTraceId(context.traceId)).toBe(true);
    expect(isValidDiagnosticSpanId(context.spanId)).toBe(true);
    expect(formatDiagnosticTraceparent(context)).toBeDefined();
  });

  it("creates child contexts without retaining parent references or self-parenting", () => {
    const parent = createDiagnosticTraceContext({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });
    const child = createChildDiagnosticTraceContext(parent, {
      spanId: CHILD_SPAN_ID,
    });

    expect(child).toEqual({
      traceId: TRACE_ID,
      spanId: CHILD_SPAN_ID,
      parentSpanId: SPAN_ID,
      traceFlags: "01",
    });
    expect(
      createChildDiagnosticTraceContext(parent, { spanId: SPAN_ID }).parentSpanId,
    ).toBeUndefined();
  });

  it("freezes a defensive trace context copy", () => {
    const context = createDiagnosticTraceContext({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: "01",
    });
    const frozen = freezeDiagnosticTraceContext(context);

    expect(frozen).toEqual(context);
    expect(frozen).not.toBe(context);
    expect(Object.isFrozen(frozen)).toBe(true);
  });
});
