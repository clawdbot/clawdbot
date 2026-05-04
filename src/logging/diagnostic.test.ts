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
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
} from "./diagnostic-run-activity.js";
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
  logMessageQueued,
  diagnosticLogger,
  markDiagnosticSessionProgress,
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

  it("canonicalizes sessionId-only state when the sessionKey becomes known", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const pending = getDiagnosticSessionState({ sessionId: "s1" });
    pending.queueDepth = 1;

    const keyed = getDiagnosticSessionState({ sessionId: "s1", sessionKey });

    expect(keyed).toBe(pending);
    expect(keyed.queueDepth).toBe(1);
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(diagnosticSessionStates.get(sessionKey)).toBe(keyed);
    expect(getDiagnosticSessionState({ sessionKey })).toBe(keyed);
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });

  it("merges split sessionId and sessionKey state without leaving stale queued work", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";
    const keyed = getDiagnosticSessionState({ sessionKey });
    keyed.queueDepth = 1;
    keyed.lastActivity = 1;
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });
    bySessionId.queueDepth = 1;
    bySessionId.state = "processing";
    bySessionId.lastActivity = 2;

    const merged = getDiagnosticSessionState({ sessionId: "s1", sessionKey });

    expect(merged).toBe(keyed);
    expect(merged.queueDepth).toBe(2);
    expect(merged.state).toBe("processing");
    expect(diagnosticSessionStates.has("s1")).toBe(false);
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);

    logSessionStateChange({ sessionId: "s1", sessionKey, state: "idle", reason: "run_completed" });
    logSessionStateChange({ sessionKey, state: "idle", reason: "message_completed" });

    expect(getDiagnosticSessionState({ sessionKey }).queueDepth).toBe(0);
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });
});

describe("diagnostic session activity aliases", () => {
  beforeEach(() => {
    resetDiagnosticStateForTest();
  });

  afterEach(() => {
    resetDiagnosticStateForTest();
  });

  it("registers the sessionKey alias when activity first arrives with only a sessionId", () => {
    const sessionKey = "agent:main:demo-channel:channel:c1";

    markDiagnosticEmbeddedRunStarted({ sessionId: "s1" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey });

    expect(getDiagnosticSessionActivitySnapshot({ sessionKey }).activeWorkKind).toBe(
      "embedded_run",
    );
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "s1" }).activeWorkKind).toBe(
      "embedded_run",
    );
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
    vi.restoreAllMocks();
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
      classification: "stale_session_state",
      reason: "stale_session_state",
      queueDepth: 0,
    });
    expect(recoverStuckSession).toHaveBeenCalledWith({
      sessionId: "s1",
      sessionKey: "main",
      ageMs: expect.any(Number),
      queueDepth: 0,
    });
  });

  it("keeps queued stale sessions eligible for lane recovery", () => {
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
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.long_running")).toHaveLength(0);
    const stuckEvents = events.filter((event) => event.type === "session.stuck");
    expect(stuckEvents).toHaveLength(1);
    expect(stuckEvents[0]).toMatchObject({
      classification: "stale_session_state",
      reason: "queued_work_without_active_run",
      queueDepth: 1,
    });
    expect(recoverStuckSession).toHaveBeenCalledWith({
      sessionId: "s1",
      sessionKey: "main",
      ageMs: expect.any(Number),
      queueDepth: 1,
    });
  });

  it("does not warn while a processing session continues reporting progress", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(45_000);
      markDiagnosticSessionProgress({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(16_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session.stalled")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session.long_running")).toHaveLength(0);
  });

  it("backs off repeated stuck warnings while a session remains unchanged", () => {
    const events: Array<{ ageMs?: number }> = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "session.stuck") {
        events.push({ ageMs: event.ageMs });
      }
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
      vi.advanceTimersByTime(91_000);
      expect(events).toHaveLength(1);
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.ageMs)).toEqual([60_000, 120_000]);
    expect(recoverStuckSession).toHaveBeenCalledTimes(2);
  });

  it("reports active sessions as stalled instead of stuck when active work stops progressing", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
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
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
    const stalledEvents = events.filter((event) => event.type === "session.stalled");
    expect(stalledEvents).toHaveLength(1);
    expect(stalledEvents[0]).toMatchObject({
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "embedded_run",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("lastProgress=embedded_run:started"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lastProgressAge=60s"));
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("aborts and drains embedded runs after an extended no-progress stall", () => {
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
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });

      vi.advanceTimersByTime(9 * 60_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2 * 60_000);
    } finally {
      unsubscribe();
    }

    const stalledEvents = events.filter((event) => event.type === "session.stalled");
    expect(stalledEvents.length).toBeGreaterThan(0);
    expect(stalledEvents.at(-1)).toMatchObject({
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "embedded_run",
    });
    expect(recoverStuckSession).toHaveBeenCalledWith({
      sessionId: "s1",
      sessionKey: "main",
      ageMs: expect.any(Number),
      queueDepth: 0,
      allowActiveAbort: true,
    });
  });

  it("reports long-running sessions separately when active work is making progress", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
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
      vi.advanceTimersByTime(45_000);
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(16_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session.stalled")).toHaveLength(0);
    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expect(longRunningEvents[0]).toMatchObject({
      classification: "long_running",
      reason: "active_work",
      activeWorkKind: "embedded_run",
    });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("long-running session:"));
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("throttles repeated long-running active-work warnings", () => {
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
      vi.advanceTimersByTime(45_000);
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(16_000);

      expect(events.filter((event) => event.type === "session.long_running")).toHaveLength(1);

      vi.advanceTimersByTime(28_000);
      emitDiagnosticEvent({
        type: "run.progress",
        sessionId: "s1",
        sessionKey: "main",
        reason: "stream",
      });
      vi.advanceTimersByTime(2_000);

      expect(events.filter((event) => event.type === "session.long_running")).toHaveLength(1);
    } finally {
      unsubscribe();
    }

    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("keeps queued sessions non-recoverable while active work is making progress", () => {
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
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(45_000);
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.advanceTimersByTime(16_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
    expect(events.filter((event) => event.type === "session.stalled")).toHaveLength(0);
    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expect(longRunningEvents[0]).toMatchObject({
      classification: "long_running",
      reason: "queued_behind_active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 1,
    });
    expect(recoverStuckSession).not.toHaveBeenCalled();
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

  it("records idle liveness samples without warning in the gateway log", () => {
    const emitMemorySample = createEmitMemorySampleMock();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
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
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("liveness warning:"));
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.liveness.warning",
        level: "info",
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

  it("warns for liveness samples when diagnostic work is open", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

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

    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
    vi.advanceTimersByTime(30_000);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("liveness warning:"));
    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.liveness.warning",
        level: "warning",
        active: 0,
        waiting: 0,
        queued: 1,
      }),
    );
  });

  it("keeps transient event-loop max spikes debug-only when only background work is active", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

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
          eventLoopDelayP99Ms: 21,
          eventLoopDelayMaxMs: 1_500,
        }),
      },
    );

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    vi.advanceTimersByTime(30_000);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("liveness warning:"));
    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toContainEqual(
      expect.objectContaining({
        type: "diagnostic.liveness.warning",
        level: "warning",
        active: 1,
        waiting: 0,
        queued: 0,
      }),
    );
  });

  it("does not let idle liveness samples suppress later active-work warnings", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

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
    expect(warnSpy).not.toHaveBeenCalled();

    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
    vi.advanceTimersByTime(30_000);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("liveness warning:"));
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
