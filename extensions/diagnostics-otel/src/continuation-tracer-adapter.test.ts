// oxlint-disable no-underscore-dangle -- test-internal markers
// These tests pin the adapter behavior at the shim contract level so that
// any future change to the OTEL `@opentelemetry/api` surface that breaks
// the mapping is caught at unit-test time.
//
// Mocks `@opentelemetry/api` minimally: a recording tracer that captures
// every `startSpan` call (name, options, parent context) and returns a
// recording span that captures `setAttributes` / `setStatus` /
// `recordException` / `end` calls.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startSpanCalls: Array<{
  name: string;
  options: unknown;
  parentCtx: unknown;
}> = [];
const recordedOnSpan: Array<{ method: string; args: unknown[] }> = [];

const recordingTracer = {
  startSpan(name: string, options: unknown, parentCtx?: unknown) {
    startSpanCalls.push({ name, options, parentCtx });
    const parentSpanContext = (parentCtx as { sc?: { traceId?: string } } | undefined)?.sc;
    const callIndex = startSpanCalls.length - 1;
    const spanContext = {
      traceId: parentSpanContext?.traceId ?? "cccccccccccccccccccccccccccccccc",
      spanId:
        callIndex === 0
          ? "dddddddddddddddd"
          : callIndex === 1
            ? "eeeeeeeeeeeeeeee"
            : callIndex.toString(16).padStart(16, "0"),
      traceFlags: 1,
    };
    return {
      spanContext: () => spanContext,
      setAttributes(attrs: unknown) {
        recordedOnSpan.push({ method: "setAttributes", args: [attrs] });
      },
      setStatus(status: unknown) {
        recordedOnSpan.push({ method: "setStatus", args: [status] });
      },
      recordException(err: unknown) {
        recordedOnSpan.push({ method: "recordException", args: [err] });
      },
      end() {
        recordedOnSpan.push({ method: "end", args: [] });
      },
    };
  },
};

vi.mock("@opentelemetry/api", () => {
  // Minimal shape — just the surface our adapter touches.
  const TraceFlags = { NONE: 0, SAMPLED: 1 } as const;
  const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
  return {
    TraceFlags,
    SpanStatusCode,
    trace: {
      getTracer: vi.fn(() => recordingTracer),
      setSpanContext: vi.fn((_ctx: unknown, sc: unknown) => ({
        __tag: "parentCtx",
        sc,
      })),
    },
    context: {
      active: vi.fn(() => ({ __tag: "rootCtx" })),
    },
  };
});

import { trace, type Context } from "@opentelemetry/api";
import {
  CONTINUATION_OTEL_TRACER_NAME,
  createContinuationOtelTracerAdapter,
} from "./continuation-tracer-adapter.js";

beforeEach(() => {
  startSpanCalls.length = 0;
  recordedOnSpan.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function parseAndAssertValidTraceparent(traceparent: string | null | undefined): {
  traceId: string;
  spanId: string;
} {
  expect(traceparent).not.toBeNull();
  expect(traceparent).not.toBeUndefined();
  expect(traceparent).not.toBe("");
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent ?? "");
  expect(match).not.toBeNull();
  const traceId = match?.[1] ?? "";
  const spanId = match?.[2] ?? "";
  expect(traceId).not.toBe("");
  expect(spanId).not.toBe("");
  expect(traceId).not.toBe("00000000000000000000000000000000");
  expect(spanId).not.toBe("0000000000000000");
  return { traceId, spanId };
}

describe("continuation-tracer adapter :: tracer acquisition", () => {
  it("uses the dedicated 'openclaw.continuation' tracer scope", () => {
    createContinuationOtelTracerAdapter();
    // oxlint-disable-next-line typescript/unbound-method -- mock-fn ref for jest-style assertion; vi.fn does not access `this`
    expect(trace.getTracer).toHaveBeenCalledWith(CONTINUATION_OTEL_TRACER_NAME);
    expect(CONTINUATION_OTEL_TRACER_NAME).toBe("openclaw.continuation");
  });
});

describe("continuation-tracer adapter :: startSpan without traceparent", () => {
  it("starts a new root span when no traceparent is provided", () => {
    const adapter = createContinuationOtelTracerAdapter();
    adapter.startSpan("continuation.work");
    expect(startSpanCalls).toHaveLength(1);
    expect(startSpanCalls[0]?.name).toBe("continuation.work");
    // No parent context arg when traceparent is absent.
    expect(startSpanCalls[0]?.parentCtx).toBeUndefined();
  });

  it("passes attributes through to the underlying OTEL startSpan options", () => {
    const adapter = createContinuationOtelTracerAdapter();
    adapter.startSpan("continuation.work", {
      attributes: {
        "chain.id": "abc",
        "chain.step.remaining": 5,
        "continuation.disabled": false,
      },
    });
    expect(startSpanCalls).toHaveLength(1);
    const opts = startSpanCalls[0]?.options as { attributes?: Record<string, unknown> };
    expect(opts.attributes).toEqual({
      "chain.id": "abc",
      "chain.step.remaining": 5,
      "continuation.disabled": false,
    });
  });
});

describe("continuation-tracer adapter :: startSpan with traceparent (parent stitch)", () => {
  it("stitches a parent context derived from a valid traceparent", () => {
    const adapter = createContinuationOtelTracerAdapter();
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    adapter.startSpan("continuation.delegate.dispatch", { traceparent });
    expect(startSpanCalls).toHaveLength(1);
    // Parent context must be present (the stitched setSpanContext result).
    const parentCtx = startSpanCalls[0]?.parentCtx as {
      __tag: string;
      sc: Record<string, unknown>;
    };
    expect(parentCtx?.__tag).toBe("parentCtx");
    expect(parentCtx?.sc?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(parentCtx?.sc?.spanId).toBe("b7ad6b7169203331");
    expect(parentCtx?.sc?.isRemote).toBe(true);
    // SAMPLED flag preserved (01 = sampled).
    expect(parentCtx?.sc?.traceFlags).toBe(1);
  });

  it("uses a supplied DiagnosticTraceContext parent resolver before raw traceparent fallback", () => {
    const resolvedParent = { __tag: "resolvedParentCtx" } as unknown as Context;
    const resolveParentContext = vi.fn(() => resolvedParent);
    const adapter = createContinuationOtelTracerAdapter({ resolveParentContext });
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    adapter.startSpan("continuation.delegate.dispatch", { traceparent });

    expect(resolveParentContext).toHaveBeenCalledWith({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: "01",
    });
    expect(startSpanCalls).toHaveLength(1);
    expect(startSpanCalls[0]?.parentCtx).toBe(resolvedParent);
    expect(trace.setSpanContext).not.toHaveBeenCalled();
  });

  it("can stitch and format using a resolved exported span context", () => {
    const resolveSpanContext = vi.fn(() => ({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      traceFlags: 1,
    }));
    const adapter = createContinuationOtelTracerAdapter({ resolveSpanContext });
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    expect(
      adapter.formatTraceparent?.({
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: "01",
      }),
    ).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    adapter.startSpan("continuation.delegate.dispatch", { traceparent });

    expect(resolveSpanContext).toHaveBeenCalledWith({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: "01",
    });
    expect(startSpanCalls).toHaveLength(1);
    const parentCtx = startSpanCalls[0]?.parentCtx as {
      __tag: string;
      sc: Record<string, unknown>;
    };
    expect(parentCtx?.sc?.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(parentCtx?.sc?.spanId).toBe("bbbbbbbbbbbbbbbb");
  });

  it("falls back to root span when traceparent is malformed", () => {
    const adapter = createContinuationOtelTracerAdapter();
    adapter.startSpan("continuation.work", { traceparent: "not-a-valid-traceparent" });
    expect(startSpanCalls).toHaveLength(1);
    expect(startSpanCalls[0]?.parentCtx).toBeUndefined();
  });

  it.each([
    ["continuation.delegate.fire", "continuation.delegate.dispatch"],
    ["continuation.work.fire", "continuation.work"],
  ])("keeps %s and %s on one valid trace with distinct span IDs", (fireName, pairedName) => {
    const adapter = createContinuationOtelTracerAdapter();
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const fire = parseAndAssertValidTraceparent(
      adapter.startSpan(fireName, { traceparent }).traceparent?.(),
    );
    const paired = parseAndAssertValidTraceparent(
      adapter.startSpan(pairedName, { traceparent }).traceparent?.(),
    );

    expect(fire.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(paired.traceId).toBe(fire.traceId);
    expect(paired.spanId).not.toBe(fire.spanId);
  });
});

describe("continuation-tracer adapter :: returned Span behavior", () => {
  it("setAttributes forwards to the underlying OTEL span", () => {
    const adapter = createContinuationOtelTracerAdapter();
    const span = adapter.startSpan("continuation.work");
    span.setAttributes({ "chain.id": "xyz" });
    const setAttrsCalls = recordedOnSpan.filter((c) => c.method === "setAttributes");
    expect(setAttrsCalls).toHaveLength(1);
    expect(setAttrsCalls[0]?.args[0]).toEqual({ "chain.id": "xyz" });
  });

  it("setStatus maps continuation status to OTEL SpanStatusCode", () => {
    const adapter = createContinuationOtelTracerAdapter();
    const span = adapter.startSpan("continuation.work");
    span.setStatus("OK");
    span.setStatus("ERROR", "boom");
    span.setStatus("UNSET");
    const setStatusCalls = recordedOnSpan.filter((c) => c.method === "setStatus");
    expect(setStatusCalls).toHaveLength(3);
    // OK = 1, ERROR = 2, UNSET = 0 in our mock.
    expect((setStatusCalls[0]?.args[0] as { code: number } | undefined)?.code).toBe(1);
    expect(setStatusCalls[1]?.args[0]).toEqual({ code: 2, message: "boom" });
    expect((setStatusCalls[2]?.args[0] as { code: number } | undefined)?.code).toBe(0);
  });

  it("recordException forwards Error instances directly", () => {
    const adapter = createContinuationOtelTracerAdapter();
    const span = adapter.startSpan("continuation.work");
    const err = new Error("kaboom");
    span.recordException(err);
    const calls = recordedOnSpan.filter((c) => c.method === "recordException");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe(err);
  });

  it("recordException wraps non-Error exceptions in a synthetic shape", () => {
    const adapter = createContinuationOtelTracerAdapter();
    const span = adapter.startSpan("continuation.work");
    span.recordException("string-only-failure");
    const calls = recordedOnSpan.filter((c) => c.method === "recordException");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toEqual({
      name: "ContinuationException",
      message: "string-only-failure",
    });
  });

  it("traceparent returns the underlying exported OTEL span context", () => {
    const adapter = createContinuationOtelTracerAdapter();
    const span = adapter.startSpan("continuation.delegate.dispatch");

    expect(span.traceparent?.()).toBe("00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01");
  });

  it("end is idempotent — only the first call reaches the underlying span", () => {
    const adapter = createContinuationOtelTracerAdapter();
    const span = adapter.startSpan("continuation.work");
    span.end();
    span.end();
    span.end();
    const endCalls = recordedOnSpan.filter((c) => c.method === "end");
    expect(endCalls).toHaveLength(1);
  });
});
