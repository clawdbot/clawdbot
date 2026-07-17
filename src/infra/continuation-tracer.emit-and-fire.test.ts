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
  CONTINUATION_SIGNAL_KINDS,
  emitContinuationCompactionReleasedSpan,
  emitContinuationFanoutSpan,
  formatActiveContinuationTraceparent,
  formatContinuationTraceparent,
  getContinuationTracer,
  resolveContinuationTraceparent,
  startContinuationDelegateSpan,
  runWithDiagnosticTraceContext,
];
void splitLintUse;

describe("continuation-tracer :: emitContinuationDisabledSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options: StartSpanOptions | undefined;
    statusCalls: { status: SpanStatus; message?: string | undefined }[];
    attrCalls: SpanAttributes[];
    exceptions: unknown[];
    ended: boolean;
  };
  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const rec: RecordedSpan = {
          name,
          options,
          statusCalls: [],
          attrCalls: [],
          exceptions: [],
          ended: false,
        };
        spans.push(rec);
        const span: Span = {
          setAttributes(attrs) {
            rec.attrCalls.push(attrs);
          },
          setStatus(status, message) {
            rec.statusCalls.push({ status, message });
          },
          recordException(err) {
            rec.exceptions.push(err);
          },
          end() {
            rec.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.disabled span with full attrs for delegate cap.chain reject", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 0,
      disabledReason: "cap.chain",
      signalKind: "tool-delegate",
      delegateDelivery: "timer",
      delegateMode: "silent",
      reason: "fan out three queries",
    });
    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "disabled span");
    expect(span.name).toBe("continuation.disabled");
    expect(span.options?.attributes).toEqual({
      "chain.step.remaining": 0,
      "disabled.reason": "cap.chain",
      "signal.kind": "tool-delegate",
      "continuation.disabled": true,
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "delegate.delivery": "timer",
      "delegate.mode": "silent",
      "reason.present": true,
      "reason.length": 21,
      "reason.hash": expect.stringMatching(REASON_HASH_RE),
      "reason.redacted": false,
    });
    expectNoAttributeValueContains(span.options?.attributes, "fan out three queries");
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("work-signal reject omits delegate.* attrs (work has no transport/intent axis)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: undefined, // first-step reject — chain never started
      chainStepRemaining: 0,
      disabledReason: "cap.chain",
      signalKind: "bracket-work",
    });
    expect(spans).toHaveLength(1);
    const attrs = expectDefined(spans.at(0), "disabled span").options?.attributes;
    expect(attrs).toEqual({
      "chain.step.remaining": 0,
      "disabled.reason": "cap.chain",
      "signal.kind": "bracket-work",
      "continuation.disabled": true,
    });
    expect(attrs).not.toHaveProperty("chain.id");
    expect(attrs).not.toHaveProperty("delegate.delivery");
    expect(attrs).not.toHaveProperty("delegate.mode");
  });

  it("cost-cap reject for bracket-delegate carries delegate axes", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemaining: 3,
      disabledReason: "cap.cost",
      signalKind: "bracket-delegate",
      delegateDelivery: "immediate",
      delegateMode: "normal",
    });
    expect(expectDefined(spans.at(0), "disabled span").options?.attributes).toMatchObject({
      "disabled.reason": "cap.cost",
      "signal.kind": "bracket-delegate",
      "delegate.delivery": "immediate",
      "delegate.mode": "normal",
      "chain.step.remaining": 3,
    });
  });

  it("per-turn cap reject for tool-delegate carries delegate axes and live headroom", () => {
    const { tracer, spans } = makeRecordingTracer();
    const reason = "poll change status";
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262099",
      chainStepRemaining: 12,
      disabledReason: "cap.delegates_per_turn",
      signalKind: "tool-delegate",
      delegateDelivery: "timer",
      delegateMode: "silent-wake",
      reason,
    });
    expect(expectDefined(spans.at(0), "disabled span").options?.attributes).toMatchObject({
      "disabled.reason": "cap.delegates_per_turn",
      "signal.kind": "tool-delegate",
      "delegate.delivery": "timer",
      "delegate.mode": "silent-wake",
      "chain.step.remaining": 12,
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262099",
      "reason.present": true,
      "reason.length": reason.length,
      "reason.hash": expect.stringMatching(REASON_HASH_RE),
      "reason.redacted": false,
      "continuation.disabled": true,
    });
    expectNoAttributeValueContains(
      expectDefined(spans.at(0), "disabled span").options?.attributes,
      reason,
    );
  });

  it("emits safe reason metadata instead of raw reason text", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const longReason = "x".repeat(200);
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: 0,
      disabledReason: "cap.chain",
      signalKind: "tool-delegate",
      reason: longReason,
    });
    expectSafeReasonAttributes(
      expectDefined(spans.at(0), "disabled span").options?.attributes as ContinuationSpanAttrs,
      longReason,
    );
  });

  it("clamps negative chainStepRemaining to 0", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: -7,
      disabledReason: "cap.chain",
      signalKind: "tool-delegate",
    });
    expect(
      expectDefined(spans.at(0), "disabled span").options?.attributes?.["chain.step.remaining"],
    ).toBe(0);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("tracer-disabled");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: 0,
        disabledReason: "cap.chain",
        signalKind: "tool-delegate",
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.disabled span/);
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() =>
      emitContinuationDisabledSpan({
        chainId: undefined,
        chainStepRemaining: 0,
        disabledReason: "cap.chain",
        signalKind: "tool-delegate",
      }),
    ).not.toThrow();
  });

  it("accepts disabledReason='policy.cross_session_targeting'", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDisabledSpan({
      chainId: undefined,
      chainStepRemaining: 9,
      disabledReason: "policy.cross_session_targeting",
      signalKind: "bracket-delegate",
      delegateDelivery: "immediate",
      delegateMode: "normal",
    });
    expect(expectDefined(spans.at(0), "disabled span").options?.attributes).toMatchObject({
      "disabled.reason": "policy.cross_session_targeting",
      "signal.kind": "bracket-delegate",
      "delegate.delivery": "immediate",
      "delegate.mode": "normal",
      "continuation.disabled": true,
    });
  });
});

describe("continuation-tracer :: emitContinuationDelegateFireSpan helper", () => {
  type RecordedSpan = {
    name: string;
    options: StartSpanOptions | undefined;
    statusCalls: { status: SpanStatus; message?: string | undefined }[];
    attrCalls: SpanAttributes[];
    exceptions: unknown[];
    ended: boolean;
  };
  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const rec: RecordedSpan = {
          name,
          options,
          statusCalls: [],
          attrCalls: [],
          exceptions: [],
          ended: false,
        };
        spans.push(rec);
        const span: Span = {
          setAttributes(attrs) {
            rec.attrCalls.push(attrs);
          },
          setStatus(status, message) {
            rec.statusCalls.push({ status, message });
          },
          recordException(err) {
            rec.exceptions.push(err);
          },
          end() {
            rec.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits a continuation.delegate.fire span with all required attrs", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "019dcf57-b536-77cc-834b-b803d9262032",
      chainStepRemainingAtDispatch: 4,
      delegateMode: "silent-wake",
      delayMs: 60_000,
      fireDeferredMs: 60_017,
      reason: "fan out three queries",
    });
    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "delegate fire span");
    expect(span.name).toBe("continuation.delegate.fire");
    expect(span.options?.attributes).toEqual({
      "chain.id": "019dcf57-b536-77cc-834b-b803d9262032",
      "chain.step.remaining": 4,
      "delay.ms": 60_000,
      "fire.deferred_ms": 60_017,
      "delegate.delivery": "timer",
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

  it("forwards an internally resolved traceparent to delegate fire spans", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    emitContinuationDelegateFireSpan({
      chainId: "chain-delegate-fire",
      chainStepRemainingAtDispatch: 4,
      delegateMode: "normal",
      delayMs: 1_000,
      fireDeferredMs: 1_010,
      traceparent,
    });

    expect(expectDefined(spans.at(0), "delegate fire span").options?.traceparent).toBe(traceparent);
  });

  it("carries fire.deferred_ms with Math.floor (integer ms, drift formula consumer-ready)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 1,
      delegateMode: "normal",
      delayMs: 1_000,
      fireDeferredMs: 1_234.9, // floored to 1234
    });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "delegate fire span").options?.attributes,
          "delegate fire span attributes",
        ) as ContinuationSpanAttrs
      )["fire.deferred_ms"],
    ).toBe(1234);
  });

  it("clamps negative fireDeferredMs to 0 (defense; should never happen in practice)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 1,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: -3,
    });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "delegate fire span").options?.attributes,
          "delegate fire span attributes",
        ) as ContinuationSpanAttrs
      )["fire.deferred_ms"],
    ).toBe(0);
  });

  it("emits safe reason metadata instead of raw reason text", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const reason = "z".repeat(200);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 0,
      delegateMode: "silent",
      delayMs: 100,
      fireDeferredMs: 105,
      reason,
    });
    expectSafeReasonAttributes(
      expectDefined(
        expectDefined(spans.at(0), "delegate fire span").options?.attributes,
        "delegate fire span attributes",
      ) as ContinuationSpanAttrs,
      reason,
    );
  });

  it("clamps negative chainStepRemainingAtDispatch to 0", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: -2,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: 1,
    });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "delegate fire span").options?.attributes,
          "delegate fire span attributes",
        ) as ContinuationSpanAttrs
      )["chain.step.remaining"],
    ).toBe(0);
  });

  it("threads each delegateMode through unchanged", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    for (const mode of ["normal", "silent", "silent-wake"] as const) {
      emitContinuationDelegateFireSpan({
        chainId: "abc",
        chainStepRemainingAtDispatch: 1,
        delegateMode: mode,
        delayMs: 0,
        fireDeferredMs: 0,
      });
    }
    expect(
      spans.map((s) => (s.options!.attributes as ContinuationSpanAttrs)["delegate.mode"]),
    ).toEqual(["normal", "silent", "silent-wake"]);
  });

  it("always emits delegate.delivery='timer' as a fixed attr (not arg-driven)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationDelegateFireSpan({
      chainId: "abc",
      chainStepRemainingAtDispatch: 0,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: 0,
    });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "delegate fire span").options?.attributes,
          "delegate fire span attributes",
        ) as ContinuationSpanAttrs
      )["delegate.delivery"],
    ).toBe("timer");
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("kaboom-fire");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationDelegateFireSpan({
        chainId: "abc",
        chainStepRemainingAtDispatch: 0,
        delegateMode: "normal",
        delayMs: 0,
        fireDeferredMs: 0,
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.delegate\.fire span/);
    expect(logged[0]).toContain("kaboom-fire");
  });

  it("defense-in-depth: undefined chainId no-ops + logs (invariant break must not crash fire-emit)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationDelegateFireSpan({
      // Sig says `chainId: string`, but a future invariant break could
      // let undefined slip through; cast through unknown to simulate.
      chainId: undefined as unknown as string,
      chainStepRemainingAtDispatch: 0,
      delegateMode: "normal",
      delayMs: 0,
      fireDeferredMs: 0,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/chainId invariant violated/);
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() =>
      emitContinuationDelegateFireSpan({
        chainId: "abc",
        chainStepRemainingAtDispatch: 1,
        delegateMode: "normal",
        delayMs: 0,
        fireDeferredMs: 0,
      }),
    ).not.toThrow();
  });
});

describe("continuation-tracer :: emitContinuationWorkFireSpan helper", () => {
  it("forwards an internally resolved traceparent to work fire spans", () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const startSpan = vi.fn(() => noopTracer.startSpan("continuation.work.fire"));
    setContinuationTracer({ startSpan });

    emitContinuationWorkFireSpan({
      chainId: "chain-work-fire",
      chainStepRemainingAtDispatch: 3,
      delayMs: 2_000,
      fireDeferredMs: 2_015,
      traceparent,
    });

    expect(startSpan).toHaveBeenCalledWith(
      "continuation.work.fire",
      expect.objectContaining({ traceparent }),
    );
  });
});

describe("continuation-tracer :: reason/task text privacy", () => {
  type RecordedSpan = {
    name: string;
    options?: StartSpanOptions;
    statusCalls: Array<{ status: SpanStatus; message?: string }>;
    ended: boolean;
  };

  function makeRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
    const spans: RecordedSpan[] = [];
    const tracer: Tracer = {
      startSpan(name, options) {
        const recorded: RecordedSpan = {
          name,
          options,
          statusCalls: [],
          ended: false,
        };
        spans.push(recorded);
        return {
          setAttributes() {},
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException() {},
          end() {
            recorded.ended = true;
          },
        };
      },
    };
    return { tracer, spans };
  }

  it("omits raw continuation reason and delegate task preview text from span attributes", () => {
    const sentinel = "ghp_EXAMPLE_DO_NOT_EXPORT_1121";
    const reasons = [
      `continue later with ${sentinel}`,
      `delegate task preview with ${sentinel}`,
      `disabled delegate task with ${sentinel}`,
      `timer delegate task with ${sentinel}`,
      `timer work reason with ${sentinel}`,
    ];
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    emitContinuationWorkSpan({
      chainId: "chain-work",
      chainStepRemaining: 4,
      delayMs: 1_000,
      reason: reasons[0],
    });
    emitContinuationDelegateSpan({
      chainId: "chain-delegate",
      chainStepRemaining: 3,
      delayMs: 0,
      delivery: "immediate",
      delegateMode: "silent",
      reason: reasons[1],
    });
    emitContinuationDisabledSpan({
      chainId: "chain-disabled",
      chainStepRemaining: 2,
      disabledReason: "cap.chain",
      signalKind: "tool-delegate",
      delegateDelivery: "timer",
      delegateMode: "silent-wake",
      reason: reasons[2],
    });
    emitContinuationDelegateFireSpan({
      chainId: "chain-fire",
      chainStepRemainingAtDispatch: 1,
      delegateMode: "normal",
      delayMs: 1_000,
      fireDeferredMs: 1_010,
      reason: reasons[3],
    });
    emitContinuationWorkFireSpan({
      chainId: "chain-work-fire",
      chainStepRemainingAtDispatch: 0,
      delayMs: 2_000,
      fireDeferredMs: 2_020,
      reason: reasons[4],
    });

    expect(spans.map((span) => span.name)).toEqual([
      "continuation.work",
      "continuation.delegate.dispatch",
      "continuation.disabled",
      "continuation.delegate.fire",
      "continuation.work.fire",
    ]);
    for (const [index, span] of spans.entries()) {
      const attrs = span.options?.attributes;
      expect(attrs).toBeDefined();
      if (!attrs) {
        throw new Error(`missing attributes for span ${span.name}`);
      }
      expectSafeReasonAttributes(attrs, expectDefined(reasons.at(index), "reason"));
      expectNoAttributeValueContains(attrs, sentinel);
    }
  });
});

describe("continuation-tracer :: emitContinuationQueueDrainSpan helper", () => {
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

  it("emits a continuation.queue.drain span with the canonical attrs", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 3,
      drainedContinuationCount: 1,
    });
    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "queue drain span");
    expect(span.name).toBe("continuation.queue.drain");
    const attrs = span.options?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(3);
    expect(attrs["queue.drained_continuation_count"]).toBe(1);
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("emits a 0/0 span on empty drain (absence-of-work, not rejection)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 0,
      drainedContinuationCount: 0,
    });
    expect(spans).toHaveLength(1);
    const attrs = expectDefined(spans.at(0), "queue drain span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(0);
    expect(attrs["queue.drained_continuation_count"]).toBe(0);
    // No `continuation.disabled` attr on empty drain — drain has no gate.
    expect(attrs["continuation.disabled"]).toBeUndefined();
    expect(attrs["disabled.reason"]).toBeUndefined();
  });

  it("parents drain spans to the supplied traceparent when a drained entry carries one", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    emitContinuationQueueDrainSpan({
      drainedCount: 2,
      drainedContinuationCount: 1,
      traceparent,
    });

    expect(expectDefined(spans.at(0), "queue drain span").options?.traceparent).toBe(traceparent);
  });

  it("omits traceparent options for untraced drains", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    emitContinuationQueueDrainSpan({
      drainedCount: 2,
      drainedContinuationCount: 1,
    });

    expect(expectDefined(spans.at(0), "queue drain span").options?.traceparent).toBeUndefined();
  });

  it("does NOT carry chain.id or chain.step.remaining (multi-chain seam)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 5,
      drainedContinuationCount: 2,
    });
    const attrs = expectDefined(spans.at(0), "queue drain span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["chain.id"]).toBeUndefined();
    expect(attrs["chain.step.remaining"]).toBeUndefined();
    expect(attrs["delay.ms"]).toBeUndefined();
    expect(attrs["fire.deferred_ms"]).toBeUndefined();
    expect(attrs["delegate.mode"]).toBeUndefined();
    expect(attrs["signal.kind"]).toBeUndefined();
  });

  it("clamps negative counts to 0 (defense-in-depth on integer hygiene)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: -1,
      drainedContinuationCount: -3,
    });
    const attrs = expectDefined(spans.at(0), "queue drain span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(0);
    expect(attrs["queue.drained_continuation_count"]).toBe(0);
  });

  it("caps drainedContinuationCount by drainedCount (\u2264 invariant defense-in-depth)", () => {
    // The wire site already guarantees continuation <= total (filter over same
    // array), but a less-disciplined caller could violate. Helper enforces the
    // invariant.
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 2,
      drainedContinuationCount: 5,
    });
    const attrs = expectDefined(spans.at(0), "queue drain span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(2);
    expect(attrs["queue.drained_continuation_count"]).toBe(2);
  });

  it("floors fractional counts to integers (OTLP integer round-trip)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationQueueDrainSpan({
      drainedCount: 4.7,
      drainedContinuationCount: 2.9,
    });
    const attrs = expectDefined(spans.at(0), "queue drain span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["queue.drained_count"]).toBe(4);
    expect(attrs["queue.drained_continuation_count"]).toBe(2);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("kaboom-drain");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationQueueDrainSpan({
        drainedCount: 1,
        drainedContinuationCount: 0,
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.queue\.drain span/);
    expect(logged[0]).toContain("kaboom-drain");
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() =>
      emitContinuationQueueDrainSpan({
        drainedCount: 0,
        drainedContinuationCount: 0,
      }),
    ).not.toThrow();
  });
});
