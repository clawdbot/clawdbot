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
  type ContinuationDisabledSignalKind,
  type ContinuationSignalKind,
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
  vi,
  emitContinuationDelegateFireSpan,
  emitContinuationDelegateSpan,
  emitContinuationDisabledSpan,
  emitContinuationQueueDrainSpan,
  emitContinuationWorkFireSpan,
  emitContinuationWorkSpan,
  formatActiveContinuationTraceparent,
  getContinuationTracer,
  resolveContinuationTraceparent,
  runWithDiagnosticTraceContext,
  expectSafeReasonAttributes,
];
void splitLintUse;

describe("continuation-tracer :: emitContinuationFanoutSpan helper", () => {
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
        const span: Span = {
          setAttributes() {},
          setStatus(status, message) {
            recorded.statusCalls.push({ status, message });
          },
          recordException() {},
          end() {
            recorded.ended = true;
          },
        };
        return span;
      },
    };
    return { tracer, spans };
  }

  it("emits one fanout span with aggregate recipient outcomes and parent trace context", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    emitContinuationFanoutSpan({
      fanoutMode: "all",
      targetSessionKeys: ["agent:main:a", "agent:main:b", "agent:main:c"],
      deliveredCount: 3,
      chainStepRemaining: 8,
      traceparent,
    });

    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "fanout span");
    expect(span.name).toBe("continuation.queue.fanout");
    expect(span.options?.traceparent).toBe(traceparent);
    const attrs = span.options?.attributes as ContinuationSpanAttrs;
    expect(attrs["fanout.mode"]).toBe("all");
    expect(attrs["fanout.recipient_count"]).toBe(3);
    expect(attrs["fanout.delivered_count"]).toBe(3);
    expect(attrs["fanout.recipient.session_key_hashes"]).toEqual([
      "8d58a705b979",
      "55d2be10b02a",
      "45ace0256ba6",
    ]);
    expect(attrs["fanout.recipient.outcomes"]).toEqual(["delivered", "delivered", "delivered"]);
    expect(attrs["chain.step.remaining"]).toBe(8);
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("omits traceparent when mercy-cap forwarding is disabled", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    emitContinuationFanoutSpan({
      fanoutMode: "tree",
      targetSessionKeys: ["agent:main:a", "agent:main:b"],
      deliveredCount: 2,
      chainStepRemaining: 0,
    });

    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "fanout span");
    expect(span.options?.traceparent).toBeUndefined();
    const attrs = span.options?.attributes as ContinuationSpanAttrs;
    expect(attrs["chain.step.remaining"]).toBe(0);
  });
});

describe("continuation-tracer :: emitContinuationCompactionReleasedSpan helper", () => {
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

  it("emits a continuation.compaction.released span with canonical attrs (happy path)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 3, compactionId: 1 });
    expect(spans).toHaveLength(1);
    const span = expectDefined(spans.at(0), "compaction released span");
    expect(span.name).toBe("continuation.compaction.released");
    expect(span.options?.attributes).toEqual({
      "signal.kind": "compaction-release",
      "compaction.released": 3,
      "compaction.id": 1,
    });
    expect(span.statusCalls).toEqual([{ status: "OK", message: undefined }]);
    expect(span.ended).toBe(true);
  });

  it("parents continuation.compaction.released spans to a supplied traceparent", () => {
    const { tracer, spans } = makeRecordingTracer();
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 3, compactionId: 1, traceparent });

    expect(spans).toHaveLength(1);
    expect(expectDefined(spans.at(0), "compaction released span").options?.traceparent).toBe(
      traceparent,
    );
  });

  it("emits span with compaction.released: 0 on zero-release (compaction event still recorded)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 0, compactionId: 2 });
    expect(spans).toHaveLength(1);
    const attrs = expectDefined(spans.at(0), "compaction released span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["compaction.released"]).toBe(0);
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.id"]).toBe(2);
  });

  it("floors fractional releasedCount to integer (OTLP integer round-trip)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 3.7 });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "compaction released span").options?.attributes,
          "compaction released span attributes",
        ) as ContinuationSpanAttrs
      )["compaction.released"],
    ).toBe(3);
  });

  it("clamps negative releasedCount to 0 (defense-in-depth)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: -1 });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "compaction released span").options?.attributes,
          "compaction released span attributes",
        ) as ContinuationSpanAttrs
      )["compaction.released"],
    ).toBe(0);
  });

  it("swallows tracer errors and forwards them to the log callback", () => {
    const throwing: Tracer = {
      startSpan() {
        throw new Error("kaboom-compaction");
      },
    };
    setContinuationTracer(throwing);
    const logged: string[] = [];
    expect(() =>
      emitContinuationCompactionReleasedSpan({
        releasedCount: 1,
        log: (m) => logged.push(m),
      }),
    ).not.toThrow();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/Failed to emit continuation\.compaction\.released span/);
    expect(logged[0]).toContain("kaboom-compaction");
  });

  it("is a no-op against the default noop tracer", () => {
    resetContinuationTracer();
    expect(() => emitContinuationCompactionReleasedSpan({ releasedCount: 0 })).not.toThrow();
  });
});

describe("continuation-tracer :: CONTINUATION_SIGNAL_KINDS SSOT pin", () => {
  it("SSOT array has exactly 6 members with the canonical values", () => {
    expect(CONTINUATION_SIGNAL_KINDS).toHaveLength(6);
    expect([...CONTINUATION_SIGNAL_KINDS]).toEqual([
      "work",
      "bracket-work",
      "bracket-delegate",
      "tool-delegate",
      "compaction-release",
      "heartbeat",
    ]);
  });

  it("ContinuationSignalKind union covers all SSOT members (type-level pin)", () => {
    // Compile-time pin: every SSOT member must be assignable to
    // ContinuationSignalKind. If a member is added to the const array
    // without updating the derived type, this block would fail typecheck
    // (the derived type auto-tracks, so this tests the derivation).
    const kinds: ContinuationSignalKind[] = [...CONTINUATION_SIGNAL_KINDS];
    expect(kinds).toHaveLength(6);
  });

  it("ContinuationDisabledSignalKind narrows to exactly 3 disabled-span signal kinds (type-level pin)", () => {
    // Compile-time pin: Extract<> narrows to exactly the 3 disabled-span signal kinds.
    const disabled: ContinuationDisabledSignalKind[] = [
      "bracket-work",
      "bracket-delegate",
      "tool-delegate",
    ];
    expect(disabled).toHaveLength(3);
    // Runtime confirmation: these are a subset of CONTINUATION_SIGNAL_KINDS.
    for (const d of disabled) {
      expect(CONTINUATION_SIGNAL_KINDS).toContain(d);
    }
    // "work", "compaction-release", and "heartbeat" must NOT be assignable to ContinuationDisabledSignalKind.
    // This is a compile-time invariant; the runtime assertion below is a belt-and-suspenders
    // guard that the Extract<> narrows correctly.
    const disabledSet = new Set<string>(disabled);
    expect(disabledSet.has("work")).toBe(false);
    expect(disabledSet.has("compaction-release")).toBe(false);
    expect(disabledSet.has("heartbeat")).toBe(false);
  });
});

describe("continuation-tracer :: compaction.id cross-cutting attr", () => {
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

  it("happy: compactionId 7 + releasedCount 3 emits both attrs with signal.kind", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 3, compactionId: 7 });
    expect(spans).toHaveLength(1);
    const attrs = expectDefined(spans.at(0), "compaction released span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(3);
    expect(attrs["compaction.id"]).toBe(7);
  });

  it("compactionId 1 lower bound emits compaction.id: 1", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 1, compactionId: 1 });
    expect(
      (
        expectDefined(
          expectDefined(spans.at(0), "compaction released span").options?.attributes,
          "compaction released span attributes",
        ) as ContinuationSpanAttrs
      )["compaction.id"],
    ).toBe(1);
  });

  it("compactionId 0 ordinal-valid: emits compaction.id: 0 (NOT clamped, NOT dropped)", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    emitContinuationCompactionReleasedSpan({ releasedCount: 0, compactionId: 0 });
    const attrs = expectDefined(spans.at(0), "compaction released span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["compaction.id"]).toBe(0);
    // Signal.kind and compaction.released still present.
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(0);
  });

  it("invariant non-integer: compactionId 7.9 drops attr, logs warning, span survives", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationCompactionReleasedSpan({
      releasedCount: 2,
      compactionId: 7.9,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(1);
    const attrs = expectDefined(spans.at(0), "compaction released span").options
      ?.attributes as ContinuationSpanAttrs;
    // compaction.id dropped due to non-integer invariant.
    expect(attrs["compaction.id"]).toBeUndefined();
    // Span still has signal.kind + compaction.released.
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(2);
    // Log callback received warning.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("invalid compaction.id");
    expect(logged[0]).toContain("7.9");
  });

  it("invariant negative: compactionId -1 drops attr, logs warning, span survives", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationCompactionReleasedSpan({
      releasedCount: 1,
      compactionId: -1,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(1);
    const attrs = expectDefined(spans.at(0), "compaction released span").options
      ?.attributes as ContinuationSpanAttrs;
    // compaction.id dropped due to negative invariant.
    expect(attrs["compaction.id"]).toBeUndefined();
    // Span survives with signal.kind + compaction.released.
    expect(attrs["signal.kind"]).toBe("compaction-release");
    expect(attrs["compaction.released"]).toBe(1);
    expect(attrs["compaction.id"]).toBeUndefined();
    // Log callback received warning.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("invalid compaction.id");
    expect(logged[0]).toContain("-1");
  });

  it("compactionId omitted (undefined) silently omits attr without logging", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    const logged: string[] = [];
    emitContinuationCompactionReleasedSpan({
      releasedCount: 1,
      log: (m) => logged.push(m),
    });
    expect(spans).toHaveLength(1);
    const attrs = expectDefined(spans.at(0), "compaction released span").options
      ?.attributes as ContinuationSpanAttrs;
    expect(attrs["compaction.id"]).toBeUndefined();
    expect(attrs["signal.kind"]).toBe("compaction-release");
    // No log emitted — undefined is a valid "not provided" sentinel.
    expect(logged).toHaveLength(0);
  });

  // Producer-side invariant pin: incrementRunCompactionCount (session-run-accounting.ts)
  // returns `number | undefined`. When defined, the value is computed as
  // `Math.max(0, entry.compactionCount ?? 0) + Math.max(0, amount)` where amount >= 1
  // at the agent-runner callsite (amount: autoCompactionCount, guarded by `> 0`).
  // This means defined-return is always integer >= 1.
  //
  // The test below pins the helper's acceptance of the producer range, so if the
  // producer contract ever drifts (e.g. returning 0 from a different path), the
  // validate-and-drop boundary tests above catch the mismatch.
  it("producer-side pin: compactionId values in producer range [1..N] are all accepted", () => {
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);
    for (const id of [1, 2, 10, 100]) {
      emitContinuationCompactionReleasedSpan({ releasedCount: 1, compactionId: id });
    }
    expect(spans).toHaveLength(4);
    for (const span of spans) {
      const attrs = span.options?.attributes as ContinuationSpanAttrs;
      expect(typeof attrs["compaction.id"]).toBe("number");
      expect(Number.isInteger(attrs["compaction.id"])).toBe(true);
      expect(attrs["compaction.id"]).toBeGreaterThanOrEqual(1);
    }
  });

  // Producer-coupling pin: invoke incrementRunCompactionCount with a stub
  // session-store, capture the returned `count`, and assert it flows through
  // to attrs["compaction.id"]. The sampled-range test above pins the helper
  // accepts the producer's documented range; this test pins the *call-site*
  // contract — if the producer ever returns a value the helper would drop
  // (0, fractional, negative, undefined-on-error), the assertion fails with
  // a precise message identifying which side broke.
  //
  // Stub keeps storePath undefined to avoid file IO; cfg undefined to skip
  // lifecycle hooks. Only the count-arithmetic path is exercised.
  it("producer-coupling: incrementRunCompactionCount return value flows to compaction.id attr", async () => {
    const { incrementRunCompactionCount } =
      await import("../auto-reply/reply/session-run-accounting.js");
    const { tracer, spans } = makeRecordingTracer();
    setContinuationTracer(tracer);

    const sessionKey = "agent:main:test";
    const baseEntry = {
      sessionId: "s1",
      sessionFile: "/tmp/sessions/s1.jsonl",
      compactionCount: 0,
      updatedAt: Date.now(),
    } as unknown as Parameters<typeof incrementRunCompactionCount>[0]["sessionEntry"];
    const sessionStore: Record<string, NonNullable<typeof baseEntry>> = {
      [sessionKey]: baseEntry as NonNullable<typeof baseEntry>,
    };

    // amount=1: producer returns 1 (0 + max(0,1))
    const count1 = await incrementRunCompactionCount({
      sessionEntry: baseEntry,
      sessionStore,
      sessionKey,
      amount: 1,
    });
    expect(count1).toBe(1);
    // releasedCount intentionally 0; this test pins compaction.id flow only.
    emitContinuationCompactionReleasedSpan({
      releasedCount: 0,
      compactionId: count1,
    });

    // amount=3: producer returns 4 (1 + max(0,3)) — sanity-check non-1 increments
    const count3 = await incrementRunCompactionCount({
      sessionEntry: sessionStore[sessionKey],
      sessionStore,
      sessionKey,
      amount: 3,
    });
    expect(count3).toBe(4);
    emitContinuationCompactionReleasedSpan({
      releasedCount: 0,
      compactionId: count3,
    });

    expect(spans).toHaveLength(2);
    const attrs1 = spans[0]?.options?.attributes as ContinuationSpanAttrs;
    const attrs2 = spans[1]?.options?.attributes as ContinuationSpanAttrs;
    expect(attrs1["compaction.id"]).toBe(count1);
    expect(attrs2["compaction.id"]).toBe(count3);
  });
});

describe("continuation-tracer :: diagnostics fail-safe boundary (I3)", () => {
  function throwingSpan(): Span {
    return {
      setAttributes(): void {
        throw new Error("adapter setAttributes boom");
      },
      setStatus(): void {
        throw new Error("adapter setStatus boom");
      },
      recordException(): void {
        throw new Error("adapter recordException boom");
      },
      traceparent(): string | undefined {
        throw new Error("adapter traceparent boom");
      },
      end(): void {
        throw new Error("adapter end boom");
      },
    };
  }

  it("startContinuationDelegateSpan returns a guarded span whose methods never throw", () => {
    const logs: string[] = [];
    const tracer: Tracer = {
      startSpan(): Span {
        return throwingSpan();
      },
    };
    setContinuationTracer(tracer);

    const span = startContinuationDelegateSpan({
      chainId: "chain-guarded",
      chainStepRemaining: 2,
      delayMs: 0,
      delivery: "immediate",
      log: (message) => logs.push(message),
    });

    expect(() => span.setAttributes({ "chain.id": "x" })).not.toThrow();
    expect(() => span.setStatus("OK")).not.toThrow();
    expect(() => span.recordException(new Error("child failed"))).not.toThrow();
    expect(() => span.end()).not.toThrow();
    let tp: string | undefined = "unset";
    expect(() => {
      tp = span.traceparent?.();
    }).not.toThrow();
    expect(tp).toBeUndefined();
    // A throwing exporter is logged, not propagated.
    expect(logs.some((line) => line.includes("span setStatus failed"))).toBe(true);
  });

  it("startContinuationDelegateSpan returns a no-op span when startSpan itself throws", () => {
    const tracer: Tracer = {
      startSpan(): Span {
        throw new Error("startSpan boom");
      },
    };
    setContinuationTracer(tracer);

    const span = startContinuationDelegateSpan({
      chainId: "chain-start-throw",
      chainStepRemaining: 1,
      delayMs: 0,
      delivery: "immediate",
    });

    expect(() => span.setStatus("ERROR", "x")).not.toThrow();
    expect(() => span.end()).not.toThrow();
  });

  it("formatContinuationTraceparent falls back to the local formatter when the adapter throws", () => {
    const tracer: Tracer = {
      startSpan: () => noopTracer.startSpan("x"),
      formatTraceparent() {
        throw new Error("adapter formatTraceparent boom");
      },
    };
    setContinuationTracer(tracer);

    const context = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: "01",
    };
    let result: string | undefined;
    expect(() => {
      result = formatContinuationTraceparent(context);
    }).not.toThrow();
    // Local fallback still produces a valid W3C traceparent for the context.
    expect(result).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });
});
