import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventInterest } from "../infra/diagnostic-event-listener-presence.js";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "./diagnostic.js";
import { resetDiagnosticStateForTest } from "./diagnostic.test-support.js";

const native = vi.hoisted(() => {
  type Entry = { startTime: number; duration: number };
  const observers: Observer[] = [];
  class Observer {
    static supportedEntryTypes = ["gc"];
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(private callback: (list: { getEntries: () => Entry[] }) => void) {
      observers.push(this);
    }
    deliver(entries: Entry[]) {
      this.callback({ getEntries: () => entries });
    }
  }
  return { Observer, observers };
});

vi.mock("node:perf_hooks", async (original) => ({
  ...(await original<typeof import("node:perf_hooks")>()),
  PerformanceObserver: native.Observer,
}));

afterEach(() => {
  resetDiagnosticStateForTest();
  resetDiagnosticEventsForTest();
  native.observers.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("owns demand, queued GC batches, and disable/re-enable through the existing heartbeat", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const durations: number[] = [];
  const start = () => startDiagnosticHeartbeat({}, { sampleLiveness: () => null });
  const publicUnsubscribe = onDiagnosticEvent(() => {});
  let unsubscribe = () => {};
  try {
    setDiagnosticsEnabledForProcess(false);
    start();
    expect(native.observers).toHaveLength(0);
    setDiagnosticsEnabledForProcess(true);
    start();
    expect(hasInternalDiagnosticEventInterest("diagnostic.gc")).toBe(false);
    expect(native.observers).toHaveLength(0);

    unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "diagnostic.gc") {
          durations.push(event.durationMs);
        }
      },
      { include: ["diagnostic.gc"] },
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(native.observers).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const first = native.observers[0]!;
    expect(first.observe).toHaveBeenCalledExactlyOnceWith({ entryTypes: ["gc"] });
    start();
    expect(native.observers).toHaveLength(1);
    first.deliver([
      { startTime: 99, duration: 99 },
      { startTime: 100, duration: 10 },
      { startTime: 101, duration: 20 },
    ]);
    await waitForDiagnosticEventsDrained();
    expect(durations).toEqual([10, 20]);

    setDiagnosticsEnabledForProcess(false);
    first.deliver([{ startTime: 150, duration: 99 }]);
    stopDiagnosticHeartbeat();
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    now.mockReturnValue(200);
    setDiagnosticsEnabledForProcess(true);
    start();
    first.deliver([{ startTime: 201, duration: 99 }]);
    native.observers[1]!.deliver([
      { startTime: 199, duration: 99 },
      { startTime: 200, duration: 30 },
    ]);
    await waitForDiagnosticEventsDrained();
    expect(durations).toEqual([10, 20, 30]);

    unsubscribe();
    expect(hasInternalDiagnosticEventInterest("diagnostic.gc")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(native.observers[1]!.disconnect).toHaveBeenCalledTimes(1);
    stopDiagnosticHeartbeat();
    expect(native.observers[1]!.disconnect).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    publicUnsubscribe();
  }
});
