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
import { withDiagnosticPhase } from "./diagnostic-phase.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticRunProgressForTest,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticToolStartedForTest,
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
  resolveStuckSessionAbortMs,
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

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean) {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectNumberField(record: Record<string, unknown>, key: string) {
  expect(typeof record[key]).toBe("number");
}

function requireMatchingRecord(
  items: readonly unknown[],
  fields: Record<string, unknown>,
  label: string,
) {
  const found = items.find((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    const record = item as Record<string, unknown>;
    return Object.entries(fields).every(([key, value]) => Object.is(record[key], value));
  });
  if (!found) {
    throw new Error(`missing ${label}`);
  }
  return requireRecord(found, label);
}

function requireFirstMockCallArg(mock: unknown, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  const call = calls?.[0];
  if (!call) {
    throw new Error(`missing ${label} call`);
  }
  return requireRecord(call[0], `${label} argument`);
}

function loggerMessages(spy: unknown): string[] {
  const calls = (spy as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
  return calls
    .map((call) => call[0])
    .filter((message): message is string => typeof message === "string");
}

function expectLoggerMessageContaining(spy: unknown, text: string): void {
  expect(loggerMessages(spy).some((message) => message.includes(text))).toBe(true);
}

function expectNoLoggerMessageContaining(spy: unknown, text: string): void {
  expect(loggerMessages(spy).some((message) => message.includes(text))).toBe(false);
}

function expectRecoveryCall(
  recoverStuckSession: unknown,
  fields: Record<string, unknown>,
  numberFields: readonly string[],
) {
  const params = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
  expectRecordFields(params, fields);
  for (const key of numberFields) {
    expectNumberField(params, key);
  }
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
        generation: 0,
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
    expectRecordFields(requireRecord(stuckEvents[0], "stuck event"), {
      classification: "stale_session_state",
      reason: "stale_session_state",
      queueDepth: 0,
    });
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0 },
      ["ageMs", "stateGeneration"],
    );
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

    expect(events.some((event) => event.type === "session.long_running")).toBe(false);
    const stuckEvents = events.filter((event) => event.type === "session.stuck");
    expect(stuckEvents).toHaveLength(1);
    expectRecordFields(requireRecord(stuckEvents[0], "stuck event"), {
      classification: "stale_session_state",
      reason: "queued_work_without_active_run",
      queueDepth: 1,
    });
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 1 },
      ["ageMs", "stateGeneration"],
    );
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

    expect(events.some((event) => event.type === "session.stuck")).toBe(false);
    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(events.some((event) => event.type === "session.long_running")).toBe(false);
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

    expect(events.some((event) => event.type === "session.stuck")).toBe(false);
    const stalledEvents = events.filter((event) => event.type === "session.stalled");
    expect(stalledEvents).toHaveLength(1);
    expectRecordFields(requireRecord(stalledEvents[0], "stalled event"), {
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "embedded_run",
    });
    expectLoggerMessageContaining(warnSpy, "lastProgress=embedded_run:started");
    expectLoggerMessageContaining(warnSpy, "lastProgressAge=60s");
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("flags stale terminal bridge progress in stalled session diagnostics", () => {
    const events: DiagnosticEventPayload[] = [];
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticRunProgressForTest({
        sessionId: "s1",
        sessionKey: "main",
        reason: "codex_app_server:notification:rawResponseItem/completed",
      });
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });

      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    expectLoggerMessageContaining(warnSpy, "terminalProgressStale=true");
    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        terminalProgressStale: true,
        lastProgressReason: "codex_app_server:notification:rawResponseItem/completed",
      },
    );
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
    expectRecordFields(requireRecord(stalledEvents.at(-1), "stalled event"), {
      classification: "stalled_agent_run",
      reason: "active_work_without_progress",
      activeWorkKind: "embedded_run",
    });
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not abort embedded runs while a native tool call is active", async () => {
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
            stuckSessionAbortMs: 60_000,
          },
        },
        { recoverStuckSession },
      );
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      vi.advanceTimersByTime(2 * 60_000);
    } finally {
      unsubscribe();
    }

    expect(recoverStuckSession).not.toHaveBeenCalled();
    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "blocked_tool_call",
        reason: "blocked_tool_call",
        activeWorkKind: "tool_call",
        activeToolName: "bash",
        activeToolCallId: "cmd-1",
      },
    );
  });

  it("uses diagnostics.stuckSessionAbortMs for stalled active-work recovery", () => {
    const recoverStuckSession = vi.fn();

    startDiagnosticHeartbeat(
      {
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
          stuckSessionAbortMs: 60_000,
        },
      },
      { recoverStuckSession },
    );
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });

    vi.advanceTimersByTime(61_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("marks diagnostic session state idle only after a mutating recovery outcome", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      released: 1,
      sessionId: "s1",
      sessionKey: "main",
    });
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
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    const state = getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" });
    expect(state.state).toBe("idle");
    expect(state.queueDepth).toBe(0);
    requireMatchingRecord(
      events,
      { type: "session.recovery.completed", status: "released", action: "release_lane" },
      "released recovery event",
    );
  });

  it("does not mark a newer processing generation idle after a late recovery outcome", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockImplementation(async () => {
      markDiagnosticSessionProgress({ sessionId: "s1", sessionKey: "main" });
      return {
        status: "released",
        action: "release_lane",
        released: 1,
        sessionId: "s1",
        sessionKey: "main",
      };
    });
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
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expect(getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).state).toBe(
      "processing",
    );
    requireMatchingRecord(
      events,
      { type: "session.recovery.completed", status: "released", stale: true },
      "stale recovery event",
    );
  });

  it("does not start duplicate recovery for the same processing generation", async () => {
    const events: DiagnosticEventPayload[] = [];
    let resolveRecovery:
      | ((outcome: {
          status: "noop";
          action: "none";
          reason: "no_active_work";
          sessionId: string;
          sessionKey: string;
        }) => void)
      | undefined;
    const recoverStuckSession = vi.fn(
      () =>
        new Promise<{
          status: "noop";
          action: "none";
          reason: "no_active_work";
          sessionId: string;
          sessionKey: string;
        }>((resolve) => {
          resolveRecovery = resolve;
        }),
    );
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
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);
      requireMatchingRecord(
        events,
        {
          type: "session.recovery.completed",
          status: "skipped",
          outcomeReason: "already_in_flight",
        },
        "skipped recovery event",
      );

      resolveRecovery?.({
        status: "noop",
        action: "none",
        reason: "no_active_work",
        sessionId: "s1",
        sessionKey: "main",
      });
      await Promise.resolve();
    } finally {
      unsubscribe();
    }
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

    expect(events.some((event) => event.type === "session.stuck")).toBe(false);
    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expectRecordFields(requireRecord(longRunningEvents[0], "long-running event"), {
      classification: "long_running",
      reason: "active_work",
      activeWorkKind: "embedded_run",
    });
    expectNoLoggerMessageContaining(warnSpy, "long-running session:");
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

      expect(countMatching(events, (event) => event.type === "session.long_running")).toBe(1);

      vi.advanceTimersByTime(28_000);
      emitDiagnosticEvent({
        type: "run.progress",
        sessionId: "s1",
        sessionKey: "main",
        reason: "stream",
      });
      vi.advanceTimersByTime(2_000);

      expect(countMatching(events, (event) => event.type === "session.long_running")).toBe(1);
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

    expect(events.some((event) => event.type === "session.stuck")).toBe(false);
    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    const longRunningEvents = events.filter((event) => event.type === "session.long_running");
    expect(longRunningEvents).toHaveLength(1);
    expectRecordFields(requireRecord(longRunningEvents[0], "long-running event"), {
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

    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      { type: "session.state", outcome: "processing" },
      "session state stability event",
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionId");
    expect(event).not.toHaveProperty("sessionKey");

    resetDiagnosticStateForTest();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toStrictEqual([]);
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

    expect(events).toStrictEqual([]);
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
    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
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
      },
      "idle liveness stability event",
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

    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        active: 0,
        waiting: 0,
        queued: 1,
      },
      "queued liveness stability event",
    );
  });

  it("adds phase and work labels to liveness warnings", async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    let finishPhase: (() => void) | undefined;
    const phase = withDiagnosticPhase(
      "startup.plugins.load",
      () =>
        new Promise<void>((resolve) => {
          finishPhase = resolve;
        }),
    );
    if (!finishPhase) {
      throw new Error("Expected diagnostic phase finish callback to be initialized");
    }
    const completePhase = finishPhase;

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

      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "telegram" });
      vi.advanceTimersByTime(30_000);
    } finally {
      completePhase();
      await phase;
      unsubscribe();
    }

    expectLoggerMessageContaining(warnSpy, "phase=startup.plugins.load");
    expectLoggerMessageContaining(warnSpy, "work=[queued=main(");
    const warning = requireRecord(
      events.findLast((event) => event.type === "diagnostic.liveness.warning"),
      "liveness warning event",
    );
    expect(warning.phase).toBe("startup.plugins.load");
    const queuedWorkLabels = warning.queuedWorkLabels;
    expect(Array.isArray(queuedWorkLabels)).toBe(true);
    if (!Array.isArray(queuedWorkLabels)) {
      throw new Error("liveness warning queuedWorkLabels was not an array");
    }
    expect(
      queuedWorkLabels.some((label) => typeof label === "string" && label.includes("main(")),
    ).toBe(true);
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

    expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "info",
        active: 1,
        waiting: 0,
        queued: 0,
      },
      "active liveness stability event",
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

    expectLoggerMessageContaining(warnSpy, "liveness warning:");
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
      expect(countMatching(events, (event) => event === "diagnostic.liveness.warning")).toBe(1);

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(countMatching(events, (event) => event === "diagnostic.liveness.warning")).toBe(2);
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

    expect(events.some((event) => event.type === "session.stuck")).toBe(false);
  });

  it("uses default threshold for invalid values", () => {
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: -1 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: 0 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs()).toBe(120_000);
    expect(
      resolveStuckSessionAbortMs({ diagnostics: { stuckSessionAbortMs: 5_000 } }, 30_000),
    ).toBe(30_000);
    expect(
      resolveStuckSessionAbortMs(
        { diagnostics: { stuckSessionAbortMs: 48 * 60 * 60_000 } },
        30_000,
      ),
    ).toBe(48 * 60 * 60_000);
    expect(resolveStuckSessionAbortMs(undefined, 30_000)).toBe(10 * 60_000);
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

    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "message.delivery.error",
        channel: "matrix",
        deliveryKind: "text",
        durationMs: 12,
        outcome: "error",
        reason: "TypeError",
      },
      "bounded outbound delivery stability event",
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionKey");
    expect(event).not.toHaveProperty("sessionId");
  });
});
