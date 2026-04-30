import fs from "node:fs";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionStateCountForTest,
  getDiagnosticSessionState,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import {
  logSessionStateChange,
  resetDiagnosticStateForTest,
  resolveStuckSessionWarnMs,
  startDiagnosticHeartbeat,
} from "./diagnostic.js";

function createEmitMemorySampleMock() {
  return vi.fn(() => ({
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
  }));
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    vi.useRealTimers();
  });

  it("evicts stale idle session states", () => {
    getDiagnosticSessionState({ sessionId: "stale-1" });
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });

  it("caps tracked session states to a bounded max", () => {
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      diagnosticSessionStates.set(`session-${i}`, {
        sessionId: `session-${i}`,
        lastActivity: now + i,
        state: "idle",
        queueDepth: 1,
      });
    }
    pruneDiagnosticSessionStates(now + 2002, true);

    expect(getDiagnosticSessionStateCountForTest()).toBe(2000);
  });

  it("reuses keyed session state when later looked up by sessionId", () => {
    const keyed = getDiagnosticSessionState({
      sessionId: "s1",
      sessionKey: "agent:main:demo-channel:channel:c1",
    });
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });

    expect(bySessionId).toBe(keyed);
    expect(bySessionId.sessionKey).toBe("agent:main:demo-channel:channel:c1");
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });
});

describe("logger import side effects", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not mkdir at import time", async () => {
    vi.useRealTimers();

    const mkdirSpy = vi.spyOn(fs, "mkdirSync");

    await importFreshModule<typeof import("./logger.js")>(
      import.meta.url,
      "./logger.js?scope=diagnostic-mkdir",
    );

    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});

describe("stuck session diagnostics threshold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  });

  it("uses the configured diagnostics.stuckSessionWarnMs threshold", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat(
        {
          diagnostics: {
            enabled: true,
            stuckSessionWarnMs: 30_000,
          },
        },
        { recoverStuckSession },
      );
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    const stuckEvents = events.filter((event) => event.type === "session.stuck");
    expect(stuckEvents).toHaveLength(1);
    expect(stuckEvents[0]).toMatchObject({
      reason: "processing_without_queue",
      queueDepth: 0,
    });
    expect(recoverStuckSession).toHaveBeenCalledWith({
      sessionId: "s1",
      sessionKey: "main",
      ageMs: expect.any(Number),
      queueDepth: 0,
    });
  });

  it("starts and stops the stability recorder with the heartbeat lifecycle", () => {
    startDiagnosticHeartbeat({
      diagnostics: {
        enabled: true,
      },
    });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toContainEqual(
      expect.objectContaining({
        type: "session.state",
        outcome: "processing",
      }),
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionId");
    expect(event).not.toHaveProperty("sessionKey");

    resetDiagnosticStateForTest();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toEqual([]);
  });

  it("does not track session state when diagnostics are disabled", () => {
    const events: string[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
    try {
      setDiagnosticsEnabledForProcess(false);
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([]);
    expect(getDiagnosticSessionStateCountForTest()).toBe(0);
  });

  it("checks memory pressure every tick without recording idle samples", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startDiagnosticHeartbeat(
      {
        diagnostics: {
          enabled: true,
        },
      },
      { emitMemorySample, sampleLiveness: () => null },
    );

    vi.advanceTimersByTime(30_000);
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: false });

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
  });

  it("emits idle liveness warnings into the stability recorder", () => {
    const emitMemorySample = createEmitMemorySampleMock();
    const events: string[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));

    try {
      startDiagnosticHeartbeat(
        {
          diagnostics: {
            enabled: true,
          },
        },
        {
          emitMemorySample,
          sampleLiveness: () => ({
            reasons: ["cpu"],
            intervalMs: 30_000,
            eventLoopDelayP99Ms: 12,
            eventLoopDelayMaxMs: 22,
            eventLoopUtilization: 0.99,
            cpuUserMs: 29_000,
            cpuSystemMs: 1_000,
            cpuTotalMs: 30_000,
            cpuCoreRatio: 1,
          }),
        },
      );

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events).toContain("diagnostic.liveness.warning");
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.liveness.warning",
        level: "warning",
        reason: "cpu",
        durationMs: 30_000,
        count: 1,
        eventLoopDelayP99Ms: 12,
        eventLoopDelayMaxMs: 22,
        eventLoopUtilization: 0.99,
        cpuCoreRatio: 1,
        active: 0,
        waiting: 0,
        queued: 0,
      }),
    );
  });

  it("throttles repeated liveness warnings", () => {
    const events: string[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));

    try {
      startDiagnosticHeartbeat(
        {
          diagnostics: {
            enabled: true,
          },
        },
        {
          emitMemorySample: createEmitMemorySampleMock(),
          sampleLiveness: () => ({
            reasons: ["event_loop_delay"],
            intervalMs: 30_000,
            eventLoopDelayP99Ms: 1_500,
            eventLoopDelayMaxMs: 2_000,
          }),
        },
      );

      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(90_000);
      expect(events.filter((event) => event === "diagnostic.liveness.warning")).toHaveLength(1);

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event === "diagnostic.liveness.warning")).toHaveLength(2);
  });

  it("does not start the heartbeat when diagnostics are disabled by config", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startDiagnosticHeartbeat(
      {
        diagnostics: {
          enabled: false,
        },
      },
      { emitMemorySample },
    );
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).not.toHaveBeenCalled();
  });

  it("falls back to default threshold when config is absent", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat();
      logSessionStateChange({ sessionId: "s2", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(31_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
  });

  it("uses default threshold for invalid values", () => {
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: -1 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: 0 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs()).toBe(120_000);
  });
});

describe("diagnostic stability snapshots", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
  });

  afterEach(() => {
    stopDiagnosticStabilityRecorder();
    resetDiagnosticStabilityRecorderForTest();
    resetDiagnosticEventsForTest();
  });

  it("records bounded outbound delivery diagnostics without session identifiers", async () => {
    startDiagnosticStabilityRecorder();

    emitDiagnosticEvent({
      type: "message.delivery.error",
      channel: "matrix",
      deliveryKind: "text",
      durationMs: 12,
      errorCategory: "TypeError",
      sessionKey: "session-secret",
    });
    await flushDiagnosticEvents();

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toContainEqual(
      expect.objectContaining({
        type: "message.delivery.error",
        channel: "matrix",
        deliveryKind: "text",
        durationMs: 12,
        outcome: "error",
        reason: "TypeError",
      }),
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionKey");
    expect(event).not.toHaveProperty("sessionId");
  });
});
