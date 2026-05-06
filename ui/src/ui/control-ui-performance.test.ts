import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "./app-events.ts";
import {
  recordControlUiPerformanceEvent,
  recordControlUiRenderTiming,
  startControlUiResponsivenessObserver,
} from "./control-ui-performance.ts";

const originalPerformanceObserver = globalThis.PerformanceObserver;

type ObserverCallback = ConstructorParameters<typeof PerformanceObserver>[0];

function installPerformanceObserverMock(options: {
  supportedEntryTypes: string[];
  observe?: (options: PerformanceObserverInit) => void;
}) {
  let callback: ObserverCallback | null = null;
  const disconnect = vi.fn();
  class MockPerformanceObserver {
    static supportedEntryTypes = options.supportedEntryTypes;
    constructor(nextCallback: ObserverCallback) {
      callback = nextCallback;
    }
    observe(observeOptions: PerformanceObserverInit) {
      options.observe?.(observeOptions);
    }
    disconnect() {
      disconnect();
    }
  }
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: MockPerformanceObserver,
  });
  return {
    disconnect,
    emit(entries: PerformanceEntry[]) {
      callback?.(
        {
          getEntries: () => entries,
        } as PerformanceObserverEntryList,
        {} as PerformanceObserver,
      );
    },
  };
}

function createHost() {
  return {
    tab: "chat" as const,
    eventLog: [] as EventLogEntry[],
    eventLogBuffer: [] as EventLogEntry[],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "PerformanceObserver", {
    configurable: true,
    value: originalPerformanceObserver,
  });
});

describe("recordControlUiPerformanceEvent", () => {
  it("keeps the performance event buffer bounded", () => {
    const host = createHost();

    for (let i = 0; i < 260; i += 1) {
      recordControlUiPerformanceEvent(host, "control-ui.test", { i }, { console: false });
    }

    expect(host.eventLogBuffer).toHaveLength(250);
    expect(host.eventLogBuffer[0]?.payload).toEqual({ i: 259 });
    expect(host.eventLogBuffer.at(-1)?.payload).toEqual({ i: 10 });
  });
});

describe("recordControlUiRenderTiming", () => {
  it("records slow render timings after the current render turn", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const host = createHost();

    recordControlUiRenderTiming(host, "chat", { durationMs: 20, messageCount: 150 });

    expect(host.eventLogBuffer).toHaveLength(0);
    await Promise.resolve();

    expect(host.eventLogBuffer).toEqual([
      expect.objectContaining({
        event: "control-ui.render",
        payload: expect.objectContaining({
          surface: "chat",
          durationMs: 20,
          messageCount: 150,
          slow: true,
        }),
      }),
    ]);
  });

  it("skips render timings that stay within budget", async () => {
    const host = createHost();

    recordControlUiRenderTiming(host, "config", { durationMs: 4 });
    await Promise.resolve();

    expect(host.eventLogBuffer).toHaveLength(0);
  });
});

describe("startControlUiResponsivenessObserver", () => {
  it("records long animation frames with script attribution", () => {
    const observe = vi.fn();
    const mock = installPerformanceObserverMock({
      supportedEntryTypes: ["longtask", "long-animation-frame"],
      observe,
    });
    const host = createHost();

    const observer = startControlUiResponsivenessObserver(host);
    mock.emit([
      {
        name: "long-frame",
        startTime: 12.4,
        duration: 83.6,
        blockingDuration: 42.2,
        scripts: [
          {
            duration: 12.1,
            sourceURL: "http://localhost/assets/a.js?token=redacted",
          },
          {
            duration: 50.8,
            invoker: "event-listener",
            sourceURL: "http://localhost/assets/app.js?token=redacted#hash",
            sourceFunctionName: "renderApp",
          },
        ],
      } as unknown as PerformanceEntry,
    ]);
    observer?.disconnect();

    expect(observe).toHaveBeenCalledWith({ type: "long-animation-frame", buffered: true });
    expect(mock.disconnect).toHaveBeenCalledOnce();
    expect(host.eventLogBuffer).toEqual([
      expect.objectContaining({
        event: "control-ui.long-animation-frame",
        payload: expect.objectContaining({
          tab: "chat",
          name: "long-frame",
          startTimeMs: 12,
          durationMs: 84,
          blockingDurationMs: 42,
          scriptCount: 2,
          topScript: {
            durationMs: 51,
            invoker: "event-listener",
            sourceUrl: "/assets/app.js",
            sourceFunctionName: "renderApp",
          },
        }),
      }),
    ]);
  });

  it("falls back to long task entries when long animation frames are unavailable", () => {
    const observe = vi.fn();
    const mock = installPerformanceObserverMock({
      supportedEntryTypes: ["longtask"],
      observe,
    });
    const host = createHost();

    startControlUiResponsivenessObserver(host);
    mock.emit([
      {
        name: "self",
        startTime: 5,
        duration: 51,
      } as unknown as PerformanceEntry,
      {
        name: "small",
        startTime: 10,
        duration: 49,
      } as unknown as PerformanceEntry,
    ]);

    expect(observe).toHaveBeenCalledWith({ type: "longtask", buffered: true });
    expect(host.eventLogBuffer).toEqual([
      expect.objectContaining({
        event: "control-ui.longtask",
        payload: expect.objectContaining({
          name: "self",
          durationMs: 51,
        }),
      }),
    ]);
  });

  it("caps responsiveness events so gateway events stay visible", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mock = installPerformanceObserverMock({
      supportedEntryTypes: ["longtask"],
    });
    const host = createHost();

    for (let i = 0; i < 225; i += 1) {
      recordControlUiPerformanceEvent(host, "gateway.event", { i }, { console: false });
    }

    startControlUiResponsivenessObserver(host);
    for (let i = 0; i < 80; i += 1) {
      mock.emit([
        {
          name: "self",
          startTime: i,
          duration: 51,
        } as unknown as PerformanceEntry,
      ]);
    }

    expect(host.eventLogBuffer).toHaveLength(250);
    expect(
      host.eventLogBuffer.filter((entry) => entry.event === "control-ui.longtask"),
    ).toHaveLength(50);
    expect(host.eventLogBuffer.some((entry) => entry.event === "gateway.event")).toBe(true);
  });

  it("returns null when responsiveness entries are unsupported or observe fails", () => {
    installPerformanceObserverMock({ supportedEntryTypes: [] });
    expect(startControlUiResponsivenessObserver(createHost())).toBeNull();

    installPerformanceObserverMock({
      supportedEntryTypes: ["longtask"],
      observe: () => {
        throw new Error("unsupported");
      },
    });
    expect(startControlUiResponsivenessObserver(createHost())).toBeNull();
  });
});
