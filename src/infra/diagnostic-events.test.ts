import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  isDiagnosticsEnabled,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "./diagnostic-events.js";
import { createDiagnosticTraceContext } from "./diagnostic-trace-context.js";

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("listener error type=message.queued seq=1: Error: boom"),
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

    expect(seen).toEqual([]);
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "recursion guard tripped at depth=101, dropping type=queue.lane.enqueue",
      ),
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
