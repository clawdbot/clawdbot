import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
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

  it("resolves session store paths only for enabled critical bundle writes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-pressure-lazy-"));
    const resolveSessionStorePaths = vi.fn(() => []);
    try {
      emitDiagnosticMemorySample({
        now: 1000,
        stateDir,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 500 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
        },
      });
      emitDiagnosticMemorySample({
        now: 2000,
        stateDir,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 2000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
        },
      });

      expect(resolveSessionStorePaths).not.toHaveBeenCalled();

      emitDiagnosticMemorySample({
        now: 3000,
        stateDir,
        writeCriticalBundle: true,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 4000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
        },
      });

      expect(resolveSessionStorePaths).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("can disable critical pressure bundle writes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-pressure-disabled-"));
    const resolveSessionStorePaths = vi.fn(() => []);
    try {
      startDiagnosticStabilityRecorder();

      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        stateDir,
        writeCriticalBundle: false,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });

      expect(resolveSessionStorePaths).not.toHaveBeenCalled();
      expect(readLatestDiagnosticStabilityBundleSync({ stateDir }).status).toBe("missing");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("leaves critical pressure bundle writes off by default", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-memory-pressure-default-off-"),
    );
    const resolveSessionStorePaths = vi.fn(() => []);
    try {
      startDiagnosticStabilityRecorder();

      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        stateDir,
        resolveSessionStorePaths,
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });

      expect(resolveSessionStorePaths).not.toHaveBeenCalled();
      expect(readLatestDiagnosticStabilityBundleSync({ stateDir }).status).toBe("missing");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
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
          message:
            "critical memory pressure snapshot disabled: diagnostics.memoryPressureSnapshot=false",
          attributes: expect.objectContaining({
            subsystem: "gateway/diagnostics/memory",
          }),
        }),
      ]),
    );
  });

  it("writes a stability bundle when critical pressure is emitted", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-pressure-"));
    const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-custom-sessions-"));
    try {
      const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
      const customSessionsDir = path.join(customRoot, "custom-sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(customSessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "small.jsonl"), "small\n", "utf8");
      fs.writeFileSync(path.join(sessionsDir, "large.jsonl"), "x".repeat(4096), "utf8");
      fs.writeFileSync(path.join(customSessionsDir, "sessions.json"), "{}\n", "utf8");
      fs.writeFileSync(
        path.join(customSessionsDir, "custom-secret-session.jsonl"),
        "x".repeat(8192),
        "utf8",
      );
      startDiagnosticStabilityRecorder();

      emitDiagnosticMemorySample({
        now: Date.parse("2026-04-22T12:00:00.000Z"),
        uptimeMs: 0,
        stateDir,
        writeCriticalBundle: true,
        sessionStorePaths: [path.join(customSessionsDir, "sessions.json")],
        memoryUsage: memoryUsage({ rss: 4000, heapUsed: 3000 }),
        thresholds: {
          rssWarningBytes: 1000,
          rssCriticalBytes: 3000,
          pressureRepeatMs: 60_000,
        },
      });

      const latest = readLatestDiagnosticStabilityBundleSync({ stateDir });
      expect(latest.status).toBe("found");
      if (latest.status !== "found") {
        return;
      }
      expect(latest.bundle.reason).toBe("diagnostic.memory.pressure.critical");
      expect(latest.bundle.snapshot.summary.byType["diagnostic.memory.pressure"]).toBe(1);
      expect(latest.bundle.evidence?.memoryPressure).toMatchObject({
        level: "critical",
        reason: "rss_threshold",
        thresholdBytes: 3000,
        memory: expect.objectContaining({
          rssBytes: 4000,
          heapUsedBytes: 3000,
        }),
      });
      expect(latest.bundle.evidence?.memoryPressure?.heapStatistics?.heapSizeLimitBytes).toEqual(
        expect.any(Number),
      );
      expect(latest.bundle.evidence?.memoryPressure?.activeResources?.total).toEqual(
        expect.any(Number),
      );
      expect(latest.bundle.evidence?.memoryPressure?.topSessionFiles?.[0]).toMatchObject({
        relativePath: "sessions/<session>.jsonl",
        sizeBytes: 8192,
      });
      expect(JSON.stringify(latest.bundle)).not.toContain("custom-secret-session");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(customRoot, { recursive: true, force: true });
    }
  });
});
