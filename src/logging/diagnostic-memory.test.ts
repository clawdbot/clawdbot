// Diagnostic memory tests cover memory snapshot capture and diagnostic log output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { emitDiagnosticMemorySample, resetDiagnosticMemoryForTest } from "./diagnostic-memory.js";
import {
  readLatestDiagnosticStabilityBundleSync,
  resetDiagnosticStabilityBundleForTest,
} from "./diagnostic-stability-bundle.js";
import {
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import { resetLogger, setLoggerOverride } from "./logger.js";

function flushDiagnosticEvents() {
  return vi.runAllTimersAsync();
}

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    resetDiagnosticStabilityBundleForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetLogger();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    vi.useRealTimers();
    resetDiagnosticEventsForTest();
    resetDiagnosticMemoryForTest();
    resetDiagnosticStabilityBundleForTest();
    resetDiagnosticStabilityRecorderForTest();
    setLoggerOverride(null);
    resetLogger();
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

    expect(events).toEqual([
      {
        seq: 1,
        ts: 1_776_859_200_000,
        trace: undefined,
        type: "diagnostic.memory.sample",
        uptimeMs: 123,
        memory: {
          arrayBuffersBytes: 5,
          externalBytes: 10,
          heapTotalBytes: 80,
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
      uptimeMs: 0,
      isBunRuntime: true,
      heapSizeLimitBytes: 280_657_920,
      processMemoryLimitBytes: 512 * 1024 ** 3,
      memoryUsage: memoryUsage({ rss: 2000 }),
      thresholds: {
        rssWarningBytes: 1000,
        rssCriticalBytes: 3000,
        pressureRepeatMs: 60_000,
      },
    });
    stop();

    expect(events).toEqual([
      {
        seq: 1,
        ts: 1_776_859_200_000,
        trace: undefined,
        type: "diagnostic.memory.sample",
        uptimeMs: 0,
        memory: {
          arrayBuffersBytes: 5,
          externalBytes: 10,
          heapTotalBytes: 80,
          heapUsedBytes: 40,
          rssBytes: 2000,
        },
      },
      {
        seq: 2,
        ts: 1_776_859_200_000,
        trace: undefined,
        type: "diagnostic.memory.pressure",
        level: "warning",
        reason: "rss_threshold",
        thresholdBytes: 1000,
        memory: {
          arrayBuffersBytes: 5,
          externalBytes: 10,
          heapTotalBytes: 80,
          heapUsedBytes: 40,
          rssBytes: 2000,
        },
      },
    ]);
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

  it.each([1, 8, 16, 32])(
    "scales default heap pressure thresholds with a %i GiB V8 limit",
    (heapGiB) => {
      const events: DiagnosticEventPayload[] = [];
      const stop = onDiagnosticEvent((event) => events.push(event));
      const gb = 1024 ** 3;

      emitDiagnosticMemorySample({
        now: 1000,
        isBunRuntime: false,
        heapSizeLimitBytes: heapGiB * gb,
        memoryUsage: memoryUsage({ heapUsed: heapGiB * 0.25 * gb }),
      });
      expect(events.filter((event) => event.type === "diagnostic.memory.pressure")).toEqual([]);

      emitDiagnosticMemorySample({
        now: 2000,
        isBunRuntime: false,
        heapSizeLimitBytes: heapGiB * gb,
        memoryUsage: memoryUsage({ heapUsed: heapGiB * 0.51 * gb }),
      });
      emitDiagnosticMemorySample({
        now: 3000,
        isBunRuntime: false,
        heapSizeLimitBytes: heapGiB * gb,
        memoryUsage: memoryUsage({ heapUsed: heapGiB * 0.76 * gb }),
      });
      stop();

      expect(
        events
          .filter((event) => event.type === "diagnostic.memory.pressure")
          .map((event) => ({
            level: event.level,
            reason: event.reason,
            threshold: event.thresholdBytes,
          })),
      ).toEqual([
        { level: "warning", reason: "heap_threshold", threshold: heapGiB * 0.5 * gb },
        { level: "critical", reason: "heap_threshold", threshold: heapGiB * 0.75 * gb },
      ]);
    },
  );

  it.each([
    {
      name: "a 768 MiB default Node heap",
      isBunRuntime: false,
      heapSizeLimitBytes: 432 * 1024 ** 2,
      processMemoryLimitBytes: 768 * 1024 ** 2,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 330 / 1024 }, { rssGiB: 385 / 1024 }, { rssGiB: 577 / 1024 }],
      expectedThresholdsGiB: { warning: 384 / 1024, critical: 576 / 1024 },
    },
    {
      name: "a 768 MiB managed Node heap",
      isBunRuntime: false,
      heapSizeLimitBytes: 624 * 1024 ** 2,
      processMemoryLimitBytes: 768 * 1024 ** 2,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 330 / 1024 }, { rssGiB: 385 / 1024 }, { rssGiB: 577 / 1024 }],
      expectedThresholdsGiB: { warning: 384 / 1024, critical: 576 / 1024 },
    },
    {
      name: "a 1 GiB default Node heap",
      isBunRuntime: false,
      heapSizeLimitBytes: 560 * 1024 ** 2,
      processMemoryLimitBytes: 1024 ** 3,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 421 / 1024 }, { rssGiB: 513 / 1024 }, { rssGiB: 769 / 1024 }],
      expectedThresholdsGiB: { warning: 0.5, critical: 0.75 },
    },
    {
      name: "a 1 GiB managed Node heap",
      isBunRuntime: false,
      heapSizeLimitBytes: 816 * 1024 ** 2,
      processMemoryLimitBytes: 1024 ** 3,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 424 / 1024 }, { rssGiB: 513 / 1024 }, { rssGiB: 769 / 1024 }],
      expectedThresholdsGiB: { warning: 0.5, critical: 0.75 },
    },
    {
      name: "a 2 GiB managed Node heap",
      isBunRuntime: false,
      heapSizeLimitBytes: 1584 * 1024 ** 2,
      processMemoryLimitBytes: 2 * 1024 ** 3,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 833 / 1024 }, { rssGiB: 1025 / 1024 }, { rssGiB: 1537 / 1024 }],
      expectedThresholdsGiB: { warning: 1, critical: 1.5 },
    },
    {
      name: "unknown capacity with a small V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 432 * 1024 ** 2,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 0,
      samples: [{ rssGiB: 330 / 1024 }, { rssGiB: 1537 / 1024 }, { rssGiB: 3073 / 1024 }],
      expectedThresholdsGiB: { warning: 1.5, critical: 3 },
    },
    {
      name: "an enlarged V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 8 * 1024 ** 3,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 1.77, heapUsedMiB: 789.3 }, { rssGiB: 4.1 }, { rssGiB: 6.1 }],
      expectedThresholdsGiB: { warning: 4, critical: 6 },
    },
    {
      name: "a 16 GiB V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 6.1 }, { rssGiB: 8.1 }, { rssGiB: 12.1 }],
      expectedThresholdsGiB: { warning: 8, critical: 12 },
    },
    {
      name: "a 32 GiB V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 32 * 1024 ** 3,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 128 * 1024 ** 3,
      samples: [{ rssGiB: 12.1 }, { rssGiB: 16.1 }, { rssGiB: 24.1 }],
      expectedThresholdsGiB: { warning: 16, critical: 24 },
    },
    {
      name: "a constrained process limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 4 * 1024 ** 3,
      physicalMemoryBytes: 64 * 1024 ** 3,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((processMemoryLimitBytes) => ({
      name: `physical RAM with a ${processMemoryLimitBytes} reported constraint`,
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes,
      physicalMemoryBytes: 4 * 1024 ** 3,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    })),
    {
      name: "unknown physical RAM with a valid reported constraint",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 4 * 1024 ** 3,
      physicalMemoryBytes: Number.NaN,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    },
    {
      name: "unknown capacity with a valid V8 limit",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 0,
      samples: [{ rssGiB: 6.1 }, { rssGiB: 8.1 }, { rssGiB: 12.1 }],
      expectedThresholdsGiB: { warning: 8, critical: 12 },
    },
    {
      name: "an unlimited process sentinel",
      isBunRuntime: false,
      heapSizeLimitBytes: 16 * 1024 ** 3,
      processMemoryLimitBytes: Number.MAX_SAFE_INTEGER,
      physicalMemoryBytes: 4 * 1024 ** 3,
      samples: [{ rssGiB: 1.9 }, { rssGiB: 2.1 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 2, critical: 3 },
    },
    ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((heapSizeLimitBytes) => ({
      name: `unknown capacity with a ${heapSizeLimitBytes} V8 limit`,
      isBunRuntime: false,
      heapSizeLimitBytes,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 0,
      samples: [{ rssGiB: 1.4 }, { rssGiB: 1.6 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 1.5, critical: 3 },
    })),
    {
      name: "Bun compatibility heap statistics",
      isBunRuntime: true,
      heapSizeLimitBytes: 280_657_920,
      processMemoryLimitBytes: 512 * 1024 ** 3,
      physicalMemoryBytes: 512 * 1024 ** 3,
      samples: [{ rssGiB: 500 / 1024, heapUsedMiB: 80 }, { rssGiB: 4.1 }, { rssGiB: 6.1 }],
      expectedThresholdsGiB: { warning: 4, critical: 6 },
    },
    {
      name: "Bun without a process limit",
      isBunRuntime: true,
      heapSizeLimitBytes: 280_657_920,
      processMemoryLimitBytes: 0,
      physicalMemoryBytes: 512 * 1024 ** 3,
      samples: [{ rssGiB: 1.4 }, { rssGiB: 1.6 }, { rssGiB: 3.1 }],
      expectedThresholdsGiB: { warning: 1.5, critical: 3 },
    },
  ])("scales default RSS pressure thresholds with $name", (testCase) => {
    const events: DiagnosticEventPayload[] = [];
    const stop = onDiagnosticEvent((event) => events.push(event));
    const gb = 1024 ** 3;

    for (const [index, sample] of testCase.samples.entries()) {
      const heapUsedMiB =
        "heapUsedMiB" in sample && typeof sample.heapUsedMiB === "number"
          ? sample.heapUsedMiB
          : undefined;
      emitDiagnosticMemorySample({
        now: (index + 1) * 11 * 60 * 1000,
        heapSizeLimitBytes: testCase.heapSizeLimitBytes,
        processMemoryLimitBytes: testCase.processMemoryLimitBytes,
        physicalMemoryBytes: testCase.physicalMemoryBytes,
        isBunRuntime: testCase.isBunRuntime,
        memoryUsage: memoryUsage({
          rss: Math.round(sample.rssGiB * gb),
          ...(heapUsedMiB === undefined ? {} : { heapUsed: Math.round(heapUsedMiB * 1024 ** 2) }),
        }),
      });
    }
    stop();

    expect(
      events
        .filter((event) => event.type === "diagnostic.memory.pressure")
        .map((event) => ({
          level: event.level,
          reason: event.reason,
          threshold: event.thresholdBytes,
        })),
    ).toEqual([
      {
        level: "warning",
        reason: "rss_threshold",
        threshold: testCase.expectedThresholdsGiB.warning * gb,
      },
      {
        level: "critical",
        reason: "rss_threshold",
        threshold: testCase.expectedThresholdsGiB.critical * gb,
      },
    ]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "keeps default heap pressure thresholds with an invalid V8 limit of %s",
    (heapSizeLimitBytes) => {
      const events: DiagnosticEventPayload[] = [];
      const stop = onDiagnosticEvent((event) => events.push(event));
      const gb = 1024 ** 3;

      emitDiagnosticMemorySample({
        now: 11 * 60 * 1000,
        isBunRuntime: false,
        heapSizeLimitBytes,
        processMemoryLimitBytes: 0,
        physicalMemoryBytes: 0,
        memoryUsage: memoryUsage({ rss: 100, heapUsed: 1.1 * gb }),
      });
      emitDiagnosticMemorySample({
        now: 22 * 60 * 1000,
        isBunRuntime: false,
        heapSizeLimitBytes,
        processMemoryLimitBytes: 0,
        physicalMemoryBytes: 0,
        memoryUsage: memoryUsage({ rss: 100, heapUsed: 2.1 * gb }),
      });
      stop();

      expect(
        events
          .filter((event) => event.type === "diagnostic.memory.pressure")
          .map((event) => ({
            level: event.level,
            reason: event.reason,
            threshold: event.thresholdBytes,
          })),
      ).toEqual([
        { level: "warning", reason: "heap_threshold", threshold: gb },
        { level: "critical", reason: "heap_threshold", threshold: 2 * gb },
      ]);
    },
  );

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

    expect(events.at(-1)).toEqual({
      seq: 3,
      ts: 1_776_859_200_000,
      trace: undefined,
      type: "diagnostic.memory.pressure",
      level: "warning",
      reason: "rss_growth",
      thresholdBytes: 500,
      rssGrowthBytes: 700,
      windowMs: 1000,
      memory: {
        arrayBuffersBytes: 5,
        externalBytes: 10,
        heapTotalBytes: 80,
        heapUsedBytes: 40,
        rssBytes: 1700,
      },
    });
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

  it("does not write bundles when critical pressure is emitted", async () => {
    const state = await createOpenClawTestState({ label: "memory-pressure" });
    try {
      startDiagnosticStabilityRecorder();
      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });
      expect(readLatestDiagnosticStabilityBundleSync({ stateDir: state.stateDir }).status).toBe(
        "missing",
      );
    } finally {
      await state.cleanup();
    }
  });

  it("logs memory pressure events through the gateway subsystem", async () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    const records: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "log.record") {
        records.push(event);
      }
    });
    try {
      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });
      await flushDiagnosticEvents();
    } finally {
      stop();
    }

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "WARN",
          message: expect.stringContaining("memory pressure: level=critical reason=rss_threshold"),
          attributes: expect.objectContaining({
            subsystem: "gateway/diagnostics/memory",
          }),
        }),
        expect.objectContaining({
          level: "WARN",
          message: "critical memory pressure snapshot disabled",
          attributes: expect.objectContaining({
            subsystem: "gateway/diagnostics/memory",
          }),
        }),
      ]),
    );
  });

  it("logs warning pressure with readable units and operator guidance", async () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    const records: Array<Extract<DiagnosticEventPayload, { type: "log.record" }>> = [];
    const stop = onInternalDiagnosticEvent((event) => {
      if (event.type === "log.record") {
        records.push(event);
      }
    });
    try {
      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        memoryUsage: memoryUsage({ rss: 2_012_905_472, heapUsed: 1_307_038_712 }),
        thresholds: {
          rssWarningBytes: 1_610_612_736,
          rssCriticalBytes: 3_221_225_472,
          pressureRepeatMs: 60_000,
        },
      });
      await flushDiagnosticEvents();
    } finally {
      stop();
    }

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "WARN",
          message: expect.stringContaining(
            "memory pressure: level=warning reason=rss_threshold rss=1.87 GiB heap=1.22 GiB threshold=1.5 GiB thresholdRatio=125%",
          ),
          attributes: expect.objectContaining({
            subsystem: "gateway/diagnostics/memory",
          }),
        }),
      ]),
    );
    expect(records.at(-1)?.message).toContain("rssBytes=2012905472");
    expect(records.at(-1)?.message).toContain("heapUsedBytes=1307038712");
    expect(records.at(-1)?.message).toContain(
      "nextStep=run openclaw gateway status --deep and openclaw gateway diagnostics export; restart gateway if pressure persists",
    );
  });
});
