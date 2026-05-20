import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  formatDiagnosticTraceparentForPropagation,
  hasPendingInternalDiagnosticEvent,
  isDiagnosticsEnabled,
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticTraceContextForTest();
    vi.restoreAllMocks();
  });

  function expectConsoleErrorPrefix(errorSpy: { mock: { calls: unknown[][] } }, prefix: string) {
    expect(errorSpy.mock.calls).toHaveLength(1);
    const [call] = errorSpy.mock.calls;
    if (!call) {
      throw new Error("expected console error call");
    }
    const [message] = call;
    expect(typeof message).toBe("string");
    expect((message as string).startsWith(prefix)).toBe(true);
  }

  it("emits monotonic seq and timestamps to subscribers", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(111).mockReturnValueOnce(222);
    const events: Array<{ seq: number; ts: number; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ seq: event.seq, ts: event.ts, type: event.type });
    });

    emitDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
    });
    emitDiagnosticEvent({
      type: "session.state",
      state: "processing",
    });
    stop();

    expect(events).toEqual([
      { seq: 1, ts: 111, type: "model.usage" },
      { seq: 2, ts: 222, type: "session.state" },
    ]);
  });

  it("isolates listener failures and logs them", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: string[] = [];
    onDiagnosticEvent(() => {
      throw new Error("boom");
    });
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
    });

    expect(seen).toEqual(["message.queued"]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=message.queued seq=1: Error: boom",
    );
  });

  it("supports unsubscribe and full reset", () => {
    const seen: string[] = [];
    const stop = onDiagnosticEvent((event) => {
      seen.push(event.type);
    });

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });
    stop();
    emitDiagnosticEvent({
      type: "webhook.processed",
      channel: "telegram",
    });

    expect(seen).toEqual(["webhook.received"]);

    resetDiagnosticEventsForTest();
    emitDiagnosticEvent({
      type: "webhook.error",
      channel: "telegram",
      error: "failed",
    });
    expect(seen).toEqual(["webhook.received"]);
  });

  it("carries explicit trace context without creating retained trace state", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const events: Array<{ trace: typeof trace | undefined; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
      trace,
    });
    stop();
    emitDiagnosticEvent({
      type: "message.queued",
      source: "telegram",
      trace,
    });

    expect(events).toEqual([{ trace, type: "message.queued" }]);
  });

  it("uses active request trace context when events omit explicit trace", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const explicitTrace = createDiagnosticTraceContext({
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
    });
    const events: Array<{ trace: typeof trace | undefined; type: string }> = [];
    const stop = onDiagnosticEvent((event) => {
      events.push({ trace: event.trace, type: event.type });
    });

    runWithDiagnosticTraceContext(trace, () => {
      emitDiagnosticEvent({
        type: "message.queued",
        source: "telegram",
      });
      emitDiagnosticEvent({
        type: "message.queued",
        source: "telegram",
        trace: explicitTrace,
      });
    });
    stop();

    expect(events).toEqual([
      { trace, type: "message.queued" },
      { trace: explicitTrace, type: "message.queued" },
    ]);
  });

  it("marks only internal trusted diagnostic emissions as trusted", async () => {
    const events: Array<{
      metadataTrusted: boolean;
      type: string;
    }> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      events.push({
        metadataTrusted: metadata.trusted,
        type: event.type,
      });
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([
      { metadataTrusted: false, type: "message.queued" },
      { metadataTrusted: true, type: "model.call.started" },
    ]);
  });

  it("formats traceparent for propagation only from dispatcher-trusted metadata", () => {
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    });
    const traceparents: Array<string | undefined> = [];
    onInternalDiagnosticEvent((event, metadata) => {
      traceparents.push(formatDiagnosticTraceparentForPropagation(event, metadata));
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
      trace,
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { total: 1 },
      trace,
    });

    expect(traceparents).toEqual([undefined, `00-${trace.traceId}-${trace.spanId}-01`]);
    expect(formatDiagnosticTraceparentForPropagation({ trace }, { trusted: true })).toBeUndefined();
  });

  it("shares diagnostic state across duplicate module instances", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    vi.resetModules();
    const duplicateModule = (await import(
      /* @vite-ignore */ new URL("./diagnostic-events.ts?duplicate", import.meta.url).href
    )) as typeof import("./diagnostic-events.js");
    duplicateModule.emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });

    expect(events).toEqual(["message.queued"]);
  });

  it("does not expose mutable diagnostic state on the obsolete global symbol", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const events: boolean[] = [];
    globalStore[Symbol.for("openclaw.diagnosticEventsState")] = {
      listeners: new Set([() => events.push(true)]),
    };
    onInternalDiagnosticEvent((eventValue, metadata) => {
      events.push(metadata.trusted);
    });

    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual([false]);
    delete globalStore[Symbol.for("openclaw.diagnosticEventsState")];
  });

  it("keeps trusted internal events off the public diagnostic stream", async () => {
    const publicEvents: string[] = [];
    const internalEvents: Array<{ trusted: boolean; type: string }> = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event, metadata) => {
      internalEvents.push({ trusted: metadata.trusted, type: event.type });
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual([{ trusted: true, type: "model.call.started" }]);
  });

  it("isolates diagnostic metadata from listener mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: boolean[] = [];
    onInternalDiagnosticEvent((eventValue, metadata) => {
      (metadata as { trusted: boolean }).trusted = true;
    });
    onInternalDiagnosticEvent((eventValue, metadata) => {
      seen.push(metadata.trusted);
    });

    emitDiagnosticEvent({
      type: "message.queued",
      source: "plugin",
    });

    expect(seen).toEqual([false]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=message.queued seq=1: TypeError",
    );
  });

  it("isolates trusted event trace context from listener mutation", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const trace = createDiagnosticTraceContext({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    });
    const seen: Array<{ traceId: string | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event) => {
      (event.trace as { traceId: string }).traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    });
    onInternalDiagnosticEvent((event, metadata) => {
      seen.push({ traceId: event.trace?.traceId, trusted: metadata.trusted });
    });

    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      trace,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual([{ traceId: trace.traceId, trusted: true }]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.call.started seq=1: TypeError",
    );
  });

  it("isolates nested diagnostic payloads from listener mutation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: Array<{ total: number | undefined; trusted: boolean }> = [];
    onInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage") {
        event.usage.total = 0;
      }
    });
    onInternalDiagnosticEvent((event, metadata) => {
      if (event.type === "model.usage") {
        seen.push({ total: event.usage.total, trusted: metadata.trusted });
      }
    });

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      usage: { total: 42 },
    });

    expect(seen).toEqual([{ total: 42, trusted: true }]);
    expectConsoleErrorPrefix(
      errorSpy,
      "[diagnostic-events] listener error type=model.usage seq=1: TypeError",
    );
  });

  it("drops prototype-pollution keys during event enrichment", () => {
    const eventInput = Object.assign(Object.create(null), {
      type: "message.queued",
      source: "plugin",
      constructor: "blocked",
      prototype: "blocked",
    }) as Parameters<typeof emitDiagnosticEvent>[0] & Record<string, unknown>;
    Object.defineProperty(eventInput, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const events: Array<Parameters<Parameters<typeof onInternalDiagnosticEvent>[0]>[0]> = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitDiagnosticEvent(eventInput);

    expect(events).toHaveLength(1);
    expect(Object.hasOwn(events[0] ?? {}, "__proto__")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "constructor")).toBe(false);
    expect(Object.hasOwn(events[0] ?? {}, "prototype")).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("dispatches high-frequency tool and model lifecycle events asynchronously", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    emitDiagnosticEvent({
      type: "tool.execution.started",
      toolName: "read",
    });
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(events).toStrictEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toEqual(["tool.execution.started", "model.call.started"]);
  });

  it("yields between large high-frequency diagnostic event bursts", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `run-${index}`,
        callId: `call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    expect(events).toStrictEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(250);
  });

  it("waits for all queued high-frequency diagnostic events to drain", async () => {
    const events: string[] = [];
    onDiagnosticEvent((event) => {
      events.push(event.type);
    });

    for (let index = 0; index < 250; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `run-${index}`,
        callId: `call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    await waitForDiagnosticEventsDrained();

    expect(events).toHaveLength(250);
  });

  it("reports pending async diagnostic events before they drain", async () => {
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-pending",
      toolName: "exec",
      toolCallId: "call-pending",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-pending",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();

    expect(
      hasPendingInternalDiagnosticEvent((event) => event.type === "tool.execution.error"),
    ).toBe(false);
  });

  it("passes immutable pending diagnostic copies to queue inspectors", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-immutable",
      toolName: "exec",
      toolCallId: "call-immutable",
      durationMs: 1,
      errorCategory: "test",
    });

    let mutationErrors = 0;
    expect(
      hasPendingInternalDiagnosticEvent((event, metadata) => {
        try {
          (event as { type: string }).type = "model.usage";
        } catch {
          mutationErrors += 1;
        }
        try {
          (metadata as { trusted: boolean }).trusted = false;
        } catch {
          mutationErrors += 1;
        }
        return (
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-immutable"
        );
      }),
    ).toBe(true);
    expect(mutationErrors).toBe(2);

    await waitForDiagnosticEventsDrained();

    expect(events).toMatchObject([
      {
        type: "tool.execution.error",
        toolCallId: "call-immutable",
      },
    ]);
  });

  it("skips uncloneable pending diagnostics during queue inspection", async () => {
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-uncloneable",
      callId: "call-uncloneable",
      provider: "openai",
      model: "gpt-5.4",
      badValue: () => undefined,
    } as never);
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-cloneable",
      toolName: "exec",
      toolCallId: "call-cloneable",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-cloneable",
      ),
    ).toBe(true);
  });

  it("preserves trusted terminal tool diagnostics when the async queue is full", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      events.push(event);
    });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-saturation-first",
      toolName: "exec",
      toolCallId: "call-saturation-first",
      durationMs: 1,
    });

    for (let index = 0; index < 9_999; index += 1) {
      emitDiagnosticEvent({
        type: "model.call.started",
        runId: `saturation-run-${index}`,
        callId: `saturation-call-${index}`,
        provider: "openai",
        model: "gpt-5.4",
      });
    }

    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-saturation-second",
      toolName: "exec",
      toolCallId: "call-saturation-second",
      durationMs: 1,
      errorCategory: "test",
    });

    expect(
      hasPendingInternalDiagnosticEvent(
        (event, metadata) =>
          metadata.trusted &&
          event.type === "tool.execution.error" &&
          event.toolCallId === "call-saturation-second",
      ),
    ).toBe(true);

    await waitForDiagnosticEventsDrained();

    expect(
      events
        .filter(
          (
            event,
          ): event is Extract<
            DiagnosticEventPayload,
            { type: "tool.execution.completed" | "tool.execution.error" }
          > => event.type === "tool.execution.completed" || event.type === "tool.execution.error",
        )
        .map((event) => ({
          type: event.type,
          toolCallId: event.toolCallId,
        })),
    ).toEqual([
      {
        type: "tool.execution.completed",
        toolCallId: "call-saturation-first",
      },
      {
        type: "tool.execution.error",
        toolCallId: "call-saturation-second",
      },
    ]);
    expect(events.filter((event) => event.type === "model.call.started")).toHaveLength(9_998);
  });

  it("keeps log records off the public diagnostic event stream", async () => {
    const publicEvents: string[] = [];
    const internalEvents: string[] = [];
    onDiagnosticEvent((event) => {
      publicEvents.push(event.type);
    });
    onInternalDiagnosticEvent((event) => {
      internalEvents.push(event.type);
    });

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "private log",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual(["log.record"]);
  });

  it("skips event enrichment and subscribers when diagnostics are disabled", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const seen: string[] = [];
    onDiagnosticEvent((event) => {
      seen.push(event.type);
    });
    setDiagnosticsEnabledForProcess(false);

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
    });

    expect(seen).toStrictEqual([]);
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it("drops recursive emissions after the guard threshold", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    onDiagnosticEvent(() => {
      calls += 1;
      emitDiagnosticEvent({
        type: "queue.lane.enqueue",
        lane: "main",
        queueSize: calls,
      });
    });

    emitDiagnosticEvent({
      type: "queue.lane.enqueue",
      lane: "main",
      queueSize: 0,
    });

    expect(calls).toBe(101);
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      "[diagnostic-events] recursion guard tripped at depth=101, dropping type=queue.lane.enqueue",
    );
  });

  it("enables diagnostics unless explicitly disabled", () => {
    expect(isDiagnosticsEnabled()).toBe(true);
    expect(isDiagnosticsEnabled({} as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: {} } as never)).toBe(true);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: false } } as never)).toBe(false);
    expect(isDiagnosticsEnabled({ diagnostics: { enabled: true } } as never)).toBe(true);
  });
});
