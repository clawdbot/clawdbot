// Covers the private event-loop sample stream and its bounded async queue.
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

  it("drops sample windows under queue pressure while preserving lifecycle terminals", async () => {
    const events: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => events.push(event));
    for (let index = 0; index < 10_001; index += 1) {
      emitInternalDiagnosticEvent({
        type: "gateway.event_loop.sample",
        intervalMs: 1_000,
        delayMaxMs: 1_500,
      });
    }
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      toolName: "exec",
      durationMs: 1,
    });
    expect(events).toHaveLength(0);
    await waitForDiagnosticEventsDrained();
    expect(events.filter((event) => event.type === "gateway.event_loop.sample")).toHaveLength(
      9_999,
    );
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
  });

  it("keeps log records and sample windows off the public diagnostic event stream", async () => {
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

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(publicEvents).toStrictEqual([]);
    expect(internalEvents).toEqual(["log.record", "gateway.event_loop.sample"]);
  });
});
