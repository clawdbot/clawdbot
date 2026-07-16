import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTINUATION_SIGNAL_KINDS,
  emitContinuationCompactionReleasedSpan,
  emitContinuationDelegateFireSpan,
  emitContinuationDelegateSpan,
  emitContinuationDisabledSpan,
  emitContinuationFanoutSpan,
  emitContinuationQueueDrainSpan,
  emitContinuationWorkFireSpan,
  emitContinuationWorkSpan,
  formatActiveContinuationTraceparent,
  formatContinuationTraceparent,
  getContinuationTracer,
  noopTracer,
  resetContinuationTracer,
  resolveContinuationTraceparent,
  setContinuationTracer,
  startContinuationDelegateSpan,
  type ContinuationSpanAttrs,
  type ContinuationSpanName,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "./continuation-tracer.js";
import { runWithDiagnosticTraceContext } from "./diagnostic-trace-context.js";

afterEach(() => {
  resetContinuationTracer();
});

const REASON_HASH_RE = /^[0-9a-f]{16}$/u;

function expectNoAttributeValueContains(attrs: SpanAttributes | undefined, rawText: string): void {
  for (const value of Object.values(attrs ?? {})) {
    if (typeof value === "string") {
      expect(value).not.toContain(rawText);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          expect(item).not.toContain(rawText);
        }
      }
    }
  }
}

function expectSafeReasonAttributes(attrs: ContinuationSpanAttrs, reason: string): void {
  expect(attrs["reason.present"]).toBe(true);
  expect(attrs["reason.length"]).toBe(reason.length);
  expect(attrs["reason.hash"]).toEqual(expect.stringMatching(REASON_HASH_RE));
  expect(attrs["reason.redacted"]).toEqual(expect.any(Boolean));
  expect(attrs).not.toHaveProperty("reason.preview");
  expectNoAttributeValueContains(attrs, reason);
}

const splitLintUse = [
  emitContinuationCompactionReleasedSpan,
  emitContinuationDelegateFireSpan,
  emitContinuationDisabledSpan,
  emitContinuationFanoutSpan,
  emitContinuationQueueDrainSpan,
  emitContinuationWorkFireSpan,
  startContinuationDelegateSpan,
];
void splitLintUse;

describe("continuation-tracer :: noop default contract", () => {
  it("default tracer is the no-op tracer", () => {
    expect(getContinuationTracer()).toBe(noopTracer);
  });

  it("noopTracer.startSpan returns a span with all methods callable as no-ops", () => {
    const span = noopTracer.startSpan("continuation.work");
    // None of these should throw — the no-op surface is the safety net for
    // un-opted callers.
    expect(() => span.setAttributes({ "chain.id": "x" })).not.toThrow();
    expect(() => span.setStatus("OK")).not.toThrow();
    expect(() => span.setStatus("ERROR", "boom")).not.toThrow();
    expect(() => span.recordException(new Error("boom"))).not.toThrow();
    expect(() => span.recordException("plain-string")).not.toThrow();
    expect(span.traceparent?.()).toBeUndefined();
    expect(() => span.end()).not.toThrow();
    // end() is idempotent.
    expect(() => span.end()).not.toThrow();
  });

  it("noopTracer ignores StartSpanOptions (attrs + traceparent) without throwing", () => {
    const opts: StartSpanOptions = {
      attributes: { "chain.id": "abc", "chain.step.remaining": 5 },
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    };
    expect(() => noopTracer.startSpan("continuation.work", opts)).not.toThrow();
  });
});

describe("continuation-tracer :: registry (set/get/reset)", () => {
  it("setContinuationTracer installs a custom tracer; getContinuationTracer returns it", () => {
    const calls: Array<{ name: string; opts?: StartSpanOptions }> = [];
    const recorded: Array<{ method: string; args: unknown[] }> = [];

    const recordingSpan: Span = {
      setAttributes(attrs: SpanAttributes): void {
        recorded.push({ method: "setAttributes", args: [attrs] });
      },
      setStatus(status: SpanStatus, message?: string): void {
        recorded.push({ method: "setStatus", args: [status, message] });
      },
      recordException(err: unknown): void {
        recorded.push({ method: "recordException", args: [err] });
      },
      end(): void {
        recorded.push({ method: "end", args: [] });
      },
    };

    const recordingTracer: Tracer = {
      startSpan(name: string, opts?: StartSpanOptions): Span {
        calls.push({ name, opts });
        return recordingSpan;
      },
    };

    setContinuationTracer(recordingTracer);
    expect(getContinuationTracer()).toBe(recordingTracer);

    const span = getContinuationTracer().startSpan("continuation.work", {
      attributes: { "chain.id": "test-chain" },
    });
    span.setAttributes({ "chain.step.remaining": 4 });
    span.setStatus("OK");
    span.end();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("continuation.work");
    expect(calls[0]?.opts?.attributes?.["chain.id"]).toBe("test-chain");
    expect(recorded.map((r) => r.method)).toEqual(["setAttributes", "setStatus", "end"]);
  });

  it("setContinuationTracer(null) resets to the no-op default", () => {
    const customTracer: Tracer = { startSpan: () => noopTracer.startSpan("x") };
    setContinuationTracer(customTracer);
    expect(getContinuationTracer()).toBe(customTracer);

    setContinuationTracer(null);
    expect(getContinuationTracer()).toBe(noopTracer);
  });

  it("setContinuationTracer(undefined) resets to the no-op default", () => {
    const customTracer: Tracer = { startSpan: () => noopTracer.startSpan("x") };
    setContinuationTracer(customTracer);
    expect(getContinuationTracer()).toBe(customTracer);

    setContinuationTracer(undefined);
    expect(getContinuationTracer()).toBe(noopTracer);
  });

  it("resetContinuationTracer() resets to the no-op default", () => {
    const customTracer: Tracer = { startSpan: () => noopTracer.startSpan("x") };
    setContinuationTracer(customTracer);
    expect(getContinuationTracer()).toBe(customTracer);

    resetContinuationTracer();
    expect(getContinuationTracer()).toBe(noopTracer);
  });

  it("formats traceparents through the active tracer when available", () => {
    const context = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    const exportedTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const customTracer: Tracer = {
      startSpan: () => noopTracer.startSpan("x"),
      formatTraceparent: (traceContext) =>
        traceContext.spanId === context.spanId ? exportedTraceparent : undefined,
    };
    setContinuationTracer(customTracer);

    expect(formatContinuationTraceparent(context)).toBe(exportedTraceparent);
  });

  it("falls back to the diagnostic traceparent when no tracer formatter resolves", () => {
    const context = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    setContinuationTracer({ startSpan: () => noopTracer.startSpan("x") });

    expect(formatContinuationTraceparent(context)).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
  });

  it("resolves carried traceparents through the active tracer before forwarding", () => {
    const logicalTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const exportedTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    setContinuationTracer({
      startSpan: () => noopTracer.startSpan("x"),
      formatTraceparent: (traceContext) =>
        traceContext.traceId === "4bf92f3577b34da6a3ce929d0e0e4736"
          ? exportedTraceparent
          : undefined,
    });

    expect(resolveContinuationTraceparent(logicalTraceparent)).toBe(exportedTraceparent);
    expect(resolveContinuationTraceparent("not-a-traceparent")).toBeUndefined();
  });

  it("formats active traceparents from the stable active parent when present", () => {
    const activeToolContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "2222222222222222",
      parentSpanId: "1111111111111111",
      traceFlags: "01",
    };
    const exportedParentTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const formattedContexts: Array<{ spanId?: string; parentSpanId?: string }> = [];
    setContinuationTracer({
      startSpan: () => noopTracer.startSpan("x"),
      formatTraceparent: (traceContext) => {
        formattedContexts.push({
          spanId: traceContext.spanId,
          parentSpanId: traceContext.parentSpanId,
        });
        return traceContext.spanId === activeToolContext.parentSpanId
          ? exportedParentTraceparent
          : undefined;
      },
    });

    const result = runWithDiagnosticTraceContext(activeToolContext, () =>
      formatActiveContinuationTraceparent(),
    );

    expect(result).toBe(exportedParentTraceparent);
    expect(formattedContexts).toEqual([
      { spanId: activeToolContext.parentSpanId, parentSpanId: undefined },
    ]);
  });

  it("shares the installed tracer across module reloads", async () => {
    const customTracer: Tracer = { startSpan: () => noopTracer.startSpan("x") };
    setContinuationTracer(customTracer);

    vi.resetModules();
    const reloaded = await import("./continuation-tracer.js");

    expect(reloaded.getContinuationTracer()).toBe(customTracer);
    reloaded.resetContinuationTracer();
  });
});

describe("continuation-tracer :: contract pin", () => {
  // These tests pin the canonical span names and attribute names so a rename
  // fails near the source.

  it("canonical continuation span names are accepted by the surface", () => {
    const recorded: string[] = [];
    setContinuationTracer({
      startSpan: (name) => {
        recorded.push(name);
        return noopTracer.startSpan(name);
      },
    });

    const tracer = getContinuationTracer();
    tracer.startSpan("continuation.work");
    tracer.startSpan("continuation.work.fire");
    tracer.startSpan("continuation.delegate.dispatch");
    tracer.startSpan("continuation.delegate.fire");
    tracer.startSpan("continuation.queue.enqueue");
    tracer.startSpan("continuation.queue.fanout");
    tracer.startSpan("continuation.queue.drain");
    tracer.startSpan("continuation.compaction.released");
    tracer.startSpan("continuation.disabled");
    tracer.startSpan("heartbeat");

    expect(recorded).toEqual([
      "continuation.work",
      "continuation.work.fire",
      "continuation.delegate.dispatch",
      "continuation.delegate.fire",
      "continuation.queue.enqueue",
      "continuation.queue.fanout",
      "continuation.queue.drain",
      "continuation.compaction.released",
      "continuation.disabled",
      "heartbeat",
    ]);
  });

  it("canonical attribute names round-trip through the surface", () => {
    let captured: SpanAttributes | undefined;
    setContinuationTracer({
      startSpan: (_name, opts) => {
        captured = opts?.attributes;
        return noopTracer.startSpan(_name);
      },
    });

    getContinuationTracer().startSpan("continuation.work", {
      attributes: {
        "chain.id": "01J0X0000000000000000000A0",
        "chain.step.remaining": 4,
        "delay.ms": 30000,
        "reason.present": true,
        "reason.length": 24,
        "reason.hash": "0123456789abcdef",
        "reason.redacted": false,
      },
    });

    expect(captured?.["chain.id"]).toBe("01J0X0000000000000000000A0");
    expect(captured?.["chain.step.remaining"]).toBe(4);
    expect(captured?.["delay.ms"]).toBe(30000);
    expect(captured?.["reason.present"]).toBe(true);
    expect(captured?.["reason.length"]).toBe(24);
    expect(captured?.["reason.hash"]).toBe("0123456789abcdef");
    expect(captured?.["reason.redacted"]).toBe(false);
  });

  // Type-level pin: ContinuationSpanAttrs is the load-bearing canonical
  // attribute-name shape. If the OTEL adapter ever drifts to
  // chain_id / chainId / camelCase / etc., the assignment below fails
  // compile before runtime trace assertions could catch it.
  it("ContinuationSpanAttrs is structurally compatible with SpanAttributes", () => {
    const canonical: ContinuationSpanAttrs = {
      "chain.id": "abc",
      "chain.step.remaining": 3,
      "delay.ms": 1000,
      "reason.present": true,
      "reason.length": 1,
      "reason.hash": "0123456789abcdef",
      "reason.redacted": false,
      "delegate.mode": "silent-wake",
      "continuation.disabled": false,
    };
    // Assignment to SpanAttributes is the compile-time pin: every
    // ContinuationSpanAttrs MUST be a valid SpanAttributes for the shim
    // surface to accept it.
    const broad: SpanAttributes = canonical;
    expect(broad["chain.id"]).toBe("abc");
  });

  it("ContinuationSpanName values are all accepted by startSpan", () => {
    // Compile-time pin: each canonical name MUST be assignable to the
    // ContinuationSpanName union.
    const names: ContinuationSpanName[] = [
      "continuation.work",
      "continuation.work.fire",
      "continuation.delegate.dispatch",
      "continuation.delegate.fire",
      "continuation.queue.enqueue",
      "continuation.queue.fanout",
      "continuation.queue.drain",
      "continuation.compaction.released",
      "continuation.disabled",
      "heartbeat",
    ];
    for (const name of names) {
      expect(() => noopTracer.startSpan(name)).not.toThrow();
    }
  });

  it("signal.kind canonical values round-trip through the surface (runtime pin, SSOT-derived)", () => {
    // Derived from CONTINUATION_SIGNAL_KINDS SSOT — no inline re-enumeration.
    let captured: SpanAttributes | undefined;
    setContinuationTracer({
      startSpan: (_name, opts) => {
        captured = opts?.attributes;
        return noopTracer.startSpan(_name);
      },
    });
    for (const kind of CONTINUATION_SIGNAL_KINDS) {
      getContinuationTracer().startSpan("heartbeat", {
        attributes: { "signal.kind": kind },
      });
      expect(captured?.["signal.kind"]).toBe(kind);
    }
  });

  it("signal.kind canonical values are type-compatible with ContinuationSpanAttrs (type-pin, SSOT-derived)", () => {
    // Derived from CONTINUATION_SIGNAL_KINDS SSOT — no inline re-enumeration.
    for (const v of CONTINUATION_SIGNAL_KINDS) {
      const attrs: ContinuationSpanAttrs = { "signal.kind": v };
      const broad: SpanAttributes = attrs;
      expect(broad["signal.kind"]).toBe(v);
    }
  });
});

describe("continuation-tracer :: emitContinuationWorkSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    setAttributesCalls: SpanAttributes[];
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    exceptionCalls: unknown[];
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          setAttributesCalls: [],
          statusCalls: [],
          exceptionCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes(attrs) {
            recorded.setAttributesCalls.push(attrs);
          },
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException(err) {
            recorded.exceptionCalls.push(err);
          },
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.work span with all expected attrs when chainId is present", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 7,
      delayMs: 30000,
      reason: "more work to do",
    });
    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "work span");
    expect(span.name).toBe("continuation.work");
    expect(span.options?.attributes).toEqual({
      "delay.ms": 30000,
      "chain.step.remaining": 7,
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "reason.present": true,
      "reason.length": 15,
      "reason.hash": expect.stringMatching(REASON_HASH_RE),
      "reason.redacted": false,
    });
    expectNoAttributeValueContains(span.options?.attributes, "more work to do");
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("parents continuation.work spans to a supplied traceparent", () => {
    const { tracer, spans } = makeRecordingTracer();
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 7,
      delayMs: 30000,
      reason: "more work to do",
      traceparent,
    });

    expect(spans).toHaveLength(1);
    expect(expectDefined(spans.at(0), "work span").options?.traceparent).toBe(traceparent);
  });

  it("omits chain.id and reason metadata when not provided", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({
      chainId: undefined,
      chainStepRemaining: 0,
      delayMs: 5000,
    });
    expect(expectDefined(spans.at(0), "work span").options?.attributes).toEqual({
      "delay.ms": 5000,
      "chain.step.remaining": 0,
    });
  });

  it("emits safe reason metadata instead of raw reason text", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const long = "x".repeat(200);
    emitContinuationWorkSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 100,
      reason: long,
    });
    const attrs = expectDefined(spans.at(0), "work span").options
      ?.attributes as ContinuationSpanAttrs;
    expectSafeReasonAttributes(attrs, long);
  });

  it("rounds delayMs to integer", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({ chainId: undefined, chainStepRemaining: 0, delayMs: 1234.7 });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "work span").options?.attributes,
          "work span attributes",
        ) as ContinuationSpanAttrs
      )["delay.ms"],
    ).toBe(1235);
  });

  it("clamps negative chainStepRemaining to 0", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationWorkSpan({ chainId: undefined, chainStepRemaining: -3, delayMs: 0 });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "work span").options?.attributes,
          "work span attributes",
        ) as ContinuationSpanAttrs
      )["chain.step.remaining"],
    ).toBe(0);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwingTracer: Tracer = {
      startSpan() {
        throw new Error("boom");
      },
    };
    setContinuationTracer(throwingTracer);
    const messages: string[] = [];
    expect(() =>
      emitContinuationWorkSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        log: (m) => messages.push(m),
      }),
    ).not.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("boom");
  });

  it("is a no-op (no throw) against the default noop tracer", () => {
    expect(getContinuationTracer()).toBe(noopTracer);
    expect(() =>
      emitContinuationWorkSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        reason: "r",
      }),
    ).not.toThrow();
  });
});

describe("continuation-tracer :: emitContinuationDelegateSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    setAttributesCalls: SpanAttributes[];
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    exceptionCalls: unknown[];
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          setAttributesCalls: [],
          statusCalls: [],
          exceptionCalls: [],
          ended: false,
        };
        spans.push(recorded);
        const span: Span = {
          setAttributes(attrs) {
            recorded.setAttributesCalls.push(attrs);
          },
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException(err) {
            recorded.exceptionCalls.push(err);
          },
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.delegate.dispatch span with all expected attrs", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 5,
      delayMs: 60000,
      delivery: "timer",
      delegateMode: "silent-wake",
      reason: "fan out three queries",
    });
    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "delegate span");
    expect(span.name).toBe("continuation.delegate.dispatch");
    expect(span.options?.attributes).toEqual({
      "delay.ms": 60000,
      "chain.step.remaining": 5,
      "delegate.delivery": "timer",
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "delegate.mode": "silent-wake",
      "reason.present": true,
      "reason.length": 21,
      "reason.hash": expect.stringMatching(REASON_HASH_RE),
      "reason.redacted": false,
    });
    expectNoAttributeValueContains(span.options?.attributes, "fan out three queries");
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("immediate-delivery shape with no chainId or mode", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateSpan({
      chainId: undefined,
      chainStepRemaining: 0,
      delayMs: 0,
      delivery: "immediate",
    });
    expect(expectDefined(spans.at(0), "delegate span").options?.attributes).toEqual({
      "delay.ms": 0,
      "chain.step.remaining": 0,
      "delegate.delivery": "immediate",
    });
  });

  it("parents dispatch spans to a supplied traceparent", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    emitContinuationDelegateSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 0,
      delivery: "immediate",
      traceparent,
    });

    expect(expectDefined(spans.at(0), "delegate span").options?.traceparent).toBe(traceparent);
  });

  it("omits traceparent options when no parent carrier is supplied", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    emitContinuationDelegateSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 0,
      delivery: "immediate",
    });

    expect(expectDefined(spans.at(0), "delegate span").options?.traceparent).toBeUndefined();
  });

  it("threads delegate.mode through unchanged", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    for (const mode of ["normal", "silent", "silent-wake", "post-compaction"] as const) {
      emitContinuationDelegateSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        delivery: "immediate",
        delegateMode: mode,
      });
    }
    expect(
      spans.map((s) => (s.options!.attributes as ContinuationSpanAttrs)["delegate.mode"]),
    ).toEqual(["normal", "silent", "silent-wake", "post-compaction"]);
  });

  it("emits safe reason metadata instead of raw reason text", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const reason = "y".repeat(200);
    emitContinuationDelegateSpan({
      chainId: "abc",
      chainStepRemaining: 1,
      delayMs: 100,
      delivery: "timer",
      reason,
    });
    expectSafeReasonAttributes(
      expectDefined(
        expectDefined(spans.at(0), "delegate span").options?.attributes,
        "delegate span attributes",
      ) as ContinuationSpanAttrs,
      reason,
    );
  });

  it("rounds delayMs and clamps negative chainStepRemaining", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateSpan({
      chainId: undefined,
      chainStepRemaining: -2,
      delayMs: 4567.89,
      delivery: "timer",
    });
    const attrs = expectDefined(spans.at(0), "delegate span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["delay.ms"]).toBe(4568);
    expect(attrs["chain.step.remaining"]).toBe(0);
  });

  it("swallows tracer errors and forwards to log callback", () => {
    const throwingTracer: Tracer = {
      startSpan() {
        throw new Error("kaboom");
      },
    };
    setContinuationTracer(throwingTracer);
    const messages: string[] = [];
    expect(() =>
      emitContinuationDelegateSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        delivery: "immediate",
        log: (m) => messages.push(m),
      }),
    ).not.toThrow();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("kaboom");
    expect(messages[0]).toContain("continuation.delegate.dispatch");
  });

  it("is a no-op against the default noop tracer", () => {
    expect(getContinuationTracer()).toBe(noopTracer);
    expect(() =>
      emitContinuationDelegateSpan({
        chainId: "abc",
        chainStepRemaining: 1,
        delayMs: 0,
        delivery: "immediate",
        delegateMode: "normal",
      }),
    ).not.toThrow();
  });
});
