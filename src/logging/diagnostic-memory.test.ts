import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";

function memoryUsage(overrides: Partial<NodeJS.MemoryUsage>): NodeJS.MemoryUsage {
  return {
    rss: 100,
    heapTotal: 80,
    heapUsed: 40,
    external: 10,
    arrayBuffers: 5,
    ...overrides,
  };
}

describe("diagnostic memory", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
  });

  it("emits memory samples with byte counts", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      uptimeMs: 123,
      memoryUsage: memoryUsage({ rss: 4096, heapUsed: 1024 }),
    });
    stop();

    expect(events).toMatchObject([
      {
        type: "diagnostic.memory.sample",
        uptimeMs: 123,
        memory: {
          rssBytes: 4096,
          heapUsedBytes: 1024,
        },
      },
    ]);
  });

  it("emits pressure when RSS crosses a threshold", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      memoryUsage: memoryUsage({ rss: 2000 }),
      thresholds: {
        rssWarningBytes: 1000,
        rssCriticalBytes: 3000,
        pressureRepeatMs: 60_000,
      },
    });
    stop();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.memory.pressure",
        level: "warning",
        reason: "rss_threshold",
        thresholdBytes: 1000,
      }),
    );
  });

  it("can check pressure without recording an idle memory sample", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      emitSample: false,
      memoryUsage: memoryUsage({ rss: 2000 }),
      thresholds: {
        rssWarningBytes: 1000,
        rssCriticalBytes: 3000,
        pressureRepeatMs: 60_000,
      },
    });
    stop();

    expect(events.map((event) => event.type)).toEqual(["diagnostic.memory.pressure"]);
  });

  it("emits pressure when RSS grows quickly", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    emitDiagnosticMemorySample({
      now: 1000,
      memoryUsage: memoryUsage({ rss: 1000 }),
      thresholds: {
        rssWarningBytes: 10_000,
        heapUsedWarningBytes: 10_000,
        rssGrowthWarningBytes: 500,
        growthWindowMs: 10_000,
      },
    });
    emitDiagnosticMemorySample({
      now: 2000,
      memoryUsage: memoryUsage({ rss: 1700 }),
      thresholds: {
        rssWarningBytes: 10_000,
        heapUsedWarningBytes: 10_000,
        rssGrowthWarningBytes: 500,
        growthWindowMs: 10_000,
      },
    });
    stop();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.memory.pressure",
        level: "warning",
        reason: "rss_growth",
        rssGrowthBytes: 700,
        windowMs: 1000,
      }),
    );
  });

  it("throttles repeated pressure events by reason and level", () => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));

    for (const now of [1000, 2000]) {
      emitDiagnosticMemorySample({
        now,
        memoryUsage: memoryUsage({ rss: 2000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });
    }
    stop();

    expect(
      events.reduce(
        (count, event) => count + (event.type === "diagnostic.memory.pressure" ? 1 : 0),
        0,
      ),
    ).toBe(1);
  });
});
