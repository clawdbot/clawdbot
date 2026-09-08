// Covers private runtime measurements and their bounded async queue.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  emitInternalDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";

describe("diagnostic-events", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    vi.restoreAllMocks();
  });

  it.each([
    { type: "gateway.event_loop.sample", intervalMs: 1_000, delayMaxMs: 1_500 },
    { type: "diagnostic.gc", durationMs: 1_500 },
  ] as const)(
    "drops $type under queue pressure while preserving lifecycle terminals",
    async (sample) => {
      const events: DiagnosticEventPayload[] = [];
      onInternalDiagnosticEvent((event) => events.push(event));
      for (let index = 0; index < 10_001; index += 1) {
        emitInternalDiagnosticEvent(sample);
      }
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        toolName: "exec",
        durationMs: 1,
      });
      expect(events).toHaveLength(0);
      await waitForDiagnosticEventsDrained();
      expect(events.filter((event) => event.type === sample.type)).toHaveLength(9_999);
      expect(events).toContainEqual(expect.objectContaining({ type: "tool.execution.completed" }));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "diagnostic.async_queue.dropped",
          droppedEvents: 2,
          droppedUntrustedEvents: 2,
          maxQueueLength: 10_000,
          drainBatchSize: 100,
        }),
      );
    },
  );

  it("keeps log records and runtime measurements off the public diagnostic event stream", async () => {
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
    emitInternalDiagnosticEvent({
      type: "gateway.event_loop.sample",
      intervalMs: 1_000,
      delayMaxMs: 1_500,
    });
    emitInternalDiagnosticEvent({ type: "diagnostic.gc", durationMs: 25 });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual(["log.record", "gateway.event_loop.sample", "diagnostic.gc"]);
  });
});
