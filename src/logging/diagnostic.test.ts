// Diagnostic logger tests cover event emission, metrics, and support output.
import fs from "node:fs";
import { createRequireRecord, importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessageSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { emitCoreModelRequestStartedDiagnosticEvent } from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { DEFAULT_UNDICI_STREAM_TIMEOUT_MS } from "../infra/net/undici-global-dispatcher.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withDiagnosticPhase } from "./diagnostic-phase.js";
import {
  getDiagnosticSessionActivitySnapshot,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import {
  markDiagnosticModelStartedForTest,
  markDiagnosticToolStartedForTest,
} from "./diagnostic-run-activity.test-support.js";
import type { SessionAttentionClassification } from "./diagnostic-session-attention.js";
import {
  requestStuckSessionRecovery,
  resetDiagnosticSessionRecoveryCoordinatorForTest,
} from "./diagnostic-session-recovery-coordinator.js";
import type { StuckSessionRecoveryOutcome } from "./diagnostic-session-recovery.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionState,
  peekDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
  stopDiagnosticStabilityRecorder,
} from "./diagnostic-stability.js";
import {
  diagnosticLogger,
  logMessageQueued,
  logSessionStateChange,
  markDiagnosticSessionProgress,
  startDiagnosticHeartbeat as startDiagnosticHeartbeatImpl,
} from "./diagnostic.js";
import {
  resetDiagnosticStateForTest,
  resolveStuckSessionAbortMs,
  resolveStuckSessionWarnMs,
} from "./diagnostic.test-support.js";

function startDiagnosticHeartbeat(
  config?: Parameters<typeof startDiagnosticHeartbeatImpl>[0],
  opts?: Parameters<typeof startDiagnosticHeartbeatImpl>[1],
) {
  return startDiagnosticHeartbeatImpl(config, {
    testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    ...opts,
  });
}

function startEnabledDiagnosticHeartbeat(
  opts?: Parameters<typeof startDiagnosticHeartbeatImpl>[1],
) {
  return startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, opts);
}

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
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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

/** Drives a lane that keeps receiving inbound, the traffic that refreshes lastActivity. */
function advanceLaneWithInbound(params: {
  sessionId: string;
  sessionKey: string;
  totalMs: number;
  inboundEveryMs: number;
  onInbound?: () => void;
}) {
  const ticks = Math.floor(params.totalMs / params.inboundEveryMs);
  for (let i = 0; i < ticks; i += 1) {
    vi.advanceTimersByTime(params.inboundEveryMs);
    logMessageQueued({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      source: "dispatch",
    });
    params.onInbound?.();
  }
}

const requireRecord = createRequireRecord("object", "label-not-object");

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
  expect(loggerMessages(spy).join("\n")).toContain(text);
}

function expectNoLoggerMessageContaining(spy: unknown, text: string): void {
  expect(loggerMessages(spy).join("\n")).not.toContain(text);
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
    expect(diagnosticSessionStates.size).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(diagnosticSessionStates.size).toBe(1);
  });

  it.each(["session-0", ""])(
    "caps tracked session states when the oldest key is %j",
    (oldestKey) => {
      const now = Date.now();
      for (let i = 0; i < 2001; i += 1) {
        vi.setSystemTime(now + i);
        getDiagnosticSessionState({
          sessionKey: i === 0 ? oldestKey : `session-${i}`,
        }).queueDepth = 1;
      }

      expect(diagnosticSessionStates.size).toBe(2000);
      expect(diagnosticSessionStates.has(oldestKey)).toBe(false);
    },
  );

  it("reuses keyed session state when later looked up by sessionId", () => {
    const keyed = getDiagnosticSessionState({
      sessionId: "s1",
      sessionKey: "agent:main:demo-channel:channel:c1",
    });
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });

    expect(bySessionId).toBe(keyed);
    expect(bySessionId.sessionKey).toBe("agent:main:demo-channel:channel:c1");
    expect(diagnosticSessionStates.size).toBe(1);
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
    expect(diagnosticSessionStates.size).toBe(1);
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
    expect(diagnosticSessionStates.size).toBe(1);

    logSessionStateChange({ sessionId: "s1", sessionKey, state: "idle", reason: "run_completed" });
    logSessionStateChange({ sessionKey, state: "idle", reason: "message_completed" });

    expect(getDiagnosticSessionState({ sessionKey }).queueDepth).toBe(0);
    expect(diagnosticSessionStates.size).toBe(1);
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

  it("keeps embedded diagnostic work active until every owner ends", () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    markDiagnosticEmbeddedRunStarted({
      sessionId: "s1",
      sessionKey: "main",
      workKey: "reply:main",
    });

    markDiagnosticEmbeddedRunEnded({
      sessionId: "s1",
      sessionKey: "main",
      workKey: "reply:main",
      clearRunActivity: false,
    });

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" })).toEqual(
      expect.objectContaining({ activeWorkKind: "embedded_run" }),
    );

    markDiagnosticEmbeddedRunEnded({ sessionId: "s1", sessionKey: "main" });

    expect(
      getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" }).activeWorkKind,
    ).toBeUndefined();
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

  it("uses the heartbeat test timing without runtime config tuning", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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

  it("does not count a single in-flight turn as queued work without an active run", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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
      reason: "stale_session_state",
      queueDepth: 0,
    });
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0 },
      ["ageMs", "stateGeneration"],
    );
  });

  it("includes the current app-agent SQLite assistant reply in heartbeat diagnostics", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-heartbeat-app-agent-",
    });
    const sessionKey = "agent:oauth-agent:main";
    const sessionId = "oauth-session";
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    try {
      await replaceSessionEntry(
        { agentId: "oauth-agent", sessionKey },
        { sessionId, updatedAt: 1 },
      );
      appendTranscriptMessageSync(
        { agentId: "oauth-agent", sessionId, sessionKey },
        { message: { role: "assistant", content: "the reimbursement was approved" } },
      );

      startEnabledDiagnosticHeartbeat({ recoverStuckSession: vi.fn() });
      logSessionStateChange({ sessionId, sessionKey, state: "processing" });
      vi.advanceTimersByTime(61_000);

      expectLoggerMessageContaining(warnSpy, 'lastAssistant="the reimbursement was approved"');
    } finally {
      await openClawState.cleanup();
    }
  });

  it("never copies an incognito assistant reply into durable heartbeat diagnostics", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-heartbeat-incognito-",
    });
    const sessionKey = "agent:main:dashboard:incognito-private";
    const sessionId = "incognito-private-session";
    const privateReply = "memory-only personal reimbursement details";
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    try {
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1, incognito: true },
      );
      appendTranscriptMessageSync(
        { agentId: "main", sessionId, sessionKey },
        { message: { role: "assistant", content: privateReply } },
      );

      startEnabledDiagnosticHeartbeat({ recoverStuckSession: vi.fn() });
      logSessionStateChange({ sessionId, sessionKey, state: "processing" });
      vi.advanceTimersByTime(61_000);

      expectLoggerMessageContaining(warnSpy, `sessionKey=${sessionKey}`);
      expectNoLoggerMessageContaining(warnSpy, privateReply);
      expectNoLoggerMessageContaining(warnSpy, "lastAssistant=");
    } finally {
      await openClawState.cleanup();
    }
  });

  it("threads session files from heartbeat state into stuck-session recovery", () => {
    const recoverStuckSession = vi.fn();
    const sessionFile = "/tmp/openclaw-heartbeat-session.jsonl";

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({
      sessionId: "s1",
      sessionKey: "main",
      sessionFile,
      state: "processing",
    });
    vi.advanceTimersByTime(61_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", sessionFile, queueDepth: 0 },
      ["ageMs", "stateGeneration"],
    );
  });

  it("defers recovery on delayed heartbeat ticks and recovers on the next on-time tick", () => {
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });

    vi.setSystemTime(120_001);
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    const delayedHeartbeat = loggerMessages(warnSpy).find((message) =>
      message.includes("liveness heartbeat delayed"),
    );
    expect(delayedHeartbeat).toMatch(/overdue=\d+ms elapsed=\d+ms/u);
    const timing = delayedHeartbeat?.match(/overdue=(\d+)ms elapsed=(\d+)ms/u);
    expect(Number(timing?.[2]) - Number(timing?.[1])).toBe(30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0 },
      ["ageMs", "stateGeneration"],
    );
  });

  it("defers a material heartbeat stall even when elapsed time is below the abort threshold", () => {
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });

    vi.advanceTimersByTime(20_000);
    markDiagnosticSessionProgress({ sessionId: "s1", sessionKey: "main" });
    markDiagnosticRunProgress({
      sessionId: "s1",
      sessionKey: "main",
      reason: "embedded_run:progress",
    });
    vi.advanceTimersByTime(10_000);

    vi.setSystemTime(35_000);
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not let ordinary heartbeat jitter consume the remaining abort budget", () => {
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    vi.setSystemTime(0);
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });

    vi.advanceTimersByTime(15_500);
    markDiagnosticSessionProgress({ sessionId: "s1", sessionKey: "main" });
    markDiagnosticRunProgress({
      sessionId: "s1",
      sessionKey: "main",
      reason: "embedded_run:progress",
    });
    vi.advanceTimersByTime(14_500);

    vi.setSystemTime(30_999);
    vi.advanceTimersByTime(30_000);

    expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not warn while a processing session continues reporting progress", () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat();
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
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(91_000);
      // One warning emitted (60s); the 90s tick is throttled but still recovers.
      expect(events).toHaveLength(1);
      expect(recoverStuckSession).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(31_000);
    } finally {
      unsubscribe();
    }

    expect(events.map((event) => event.ageMs)).toEqual([60_000, 120_000]);
    // Recovery is requested on every heartbeat tick the session stays stuck,
    // including the throttled tick at 90s, so it must outpace the warn backoff.
    expect(recoverStuckSession).toHaveBeenCalledTimes(3);
  });

  it("keeps scheduling recovery for a recovery-eligible stuck session while warnings are throttled", () => {
    const stuckEvents: Array<{ ageMs?: number }> = [];
    const recoveryRequests: Array<{ ageMs?: number }> = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "session.stuck") {
        stuckEvents.push(event);
      } else if (event.type === "session.recovery.requested") {
        recoveryRequests.push(event);
      }
    });
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });

      // First warn tick (60s): emit the stuck warning and request recovery once.
      vi.advanceTimersByTime(61_000);
      expect(stuckEvents).toHaveLength(1);
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);

      // Backoff tick (90s): the next warn age is 120s, so the warning is
      // throttled. Recovery must still be scheduled because the session is
      // recovery-eligible — the warning backoff must not gate recovery.
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    // Warning stays throttled: still only the single 60s warning.
    expect(stuckEvents.map((event) => event.ageMs)).toEqual([60_000]);
    // Recovery was not suppressed by the warning backoff on the 90s tick.
    expect(recoverStuckSession).toHaveBeenCalledTimes(2);
    expect(recoveryRequests.map((event) => event.ageMs)).toEqual([60_000, 90_000]);
  });

  it("reports active sessions as stalled instead of stuck when active work stops progressing", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 5 * 60_000 },
      });
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
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticRunProgress({
        sessionId: "s1",
        sessionKey: "main",
        reason: "codex_app_server:notification:rawResponseItem/completed",
      });
      startEnabledDiagnosticHeartbeat();

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
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = resolveStuckSessionAbortMs(stuckSessionWarnMs);
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });

      vi.advanceTimersByTime(stuckSessionAbortMs - 30_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
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

  it("aborts stale embedded runs when queued work refreshes session activity", () => {
    const recoverStuckSession = vi.fn();

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    vi.advanceTimersByTime(507_000);
    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
    vi.advanceTimersByTime(122_000);

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });

    vi.advanceTimersByTime(30_000);

    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 1, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not abort embedded runs with recent progress just because session activity is old", () => {
    const recoverStuckSession = vi.fn();

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    vi.advanceTimersByTime(120_000);
    markDiagnosticRunProgress({
      sessionId: "s1",
      sessionKey: "main",
      reason: "embedded_run:progress",
    });

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });

    vi.advanceTimersByTime(30_000);

    expect(recoverStuckSession).not.toHaveBeenCalled();
    expectRecordFields(
      getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" }),
      {
        activeWorkKind: "embedded_run",
        hasActiveEmbeddedRun: true,
        lastProgressAgeMs: 30_000,
        lastProgressReason: "embedded_run:progress",
      },
    );
  });

  it("recovers stale native tool calls through the active-run abort path", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      vi.advanceTimersByTime(stuckSessionAbortMs);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(15 * 60_000 - stuckSessionAbortMs);
    } finally {
      unsubscribe();
    }

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
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not classify active tool calls stalled while real progress frames arrive", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      for (let i = 0; i < 20; i += 1) {
        vi.advanceTimersByTime(29_000);
        markDiagnosticRunProgress({
          sessionId: "s1",
          sessionKey: "main",
          runId: "run-1",
          reason: "cli_live:stream_progress",
        });
        vi.advanceTimersByTime(1_000);
      }
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("reports blocked tool calls on a lane whose inbound keeps refreshing the session clock", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      advanceLaneWithInbound({
        sessionId: "s1",
        sessionKey: "main",
        totalMs: 20 * 60_000,
        inboundEveryMs: 25_000,
      });
    } finally {
      unsubscribe();
    }

    const stalled = requireRecord(
      events.findLast((event) => event.type === "session.stalled"),
      "stalled event",
    );
    expectRecordFields(stalled, {
      classification: "blocked_tool_call",
      reason: "blocked_tool_call",
      activeWorkKind: "tool_call",
      activeToolName: "bash",
    });
    // Both the report and the recovery request carry the progress clock, not the
    // 25s-old session touch: the ownerless-lane release window measures staleness.
    expect(stalled.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
    const recovery = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expect(recovery.ageMs).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("keeps a lane with fresh owned progress quiet while inbound keeps arriving", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });

      advanceLaneWithInbound({
        sessionId: "s1",
        sessionKey: "main",
        totalMs: 20 * 60_000,
        inboundEveryMs: 25_000,
        onInbound: () => {
          markDiagnosticRunProgress({
            sessionId: "s1",
            sessionKey: "main",
            runId: "run-1",
            reason: "cli_live:stream_progress",
          });
        },
      });
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("leaves a busy lane with no owned work on the session clock", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push(event);
    });
    try {
      startDiagnosticHeartbeat({ diagnostics: { enabled: true } }, { recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "bash",
        toolCallId: "cmd-1",
      });
      // Terminal-but-unreleased state: the owner is gone, the activity row is not.
      // Recording that fact belongs to the run lifecycle, not to this gate.
      markDiagnosticEmbeddedRunEnded({ sessionId: "s1", sessionKey: "main" });
      expect(
        getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" })
          .activeWorkKind,
      ).toBeUndefined();

      advanceLaneWithInbound({
        sessionId: "s1",
        sessionKey: "main",
        totalMs: 20 * 60_000,
        inboundEveryMs: 25_000,
      });
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("recovers stale model calls through the active embedded-run abort path", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5",
      });

      vi.advanceTimersByTime(stuckSessionAbortMs - 30_000);
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("recovers repeated request attempts despite fresh mechanical activity", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn(() => new Promise<never>(() => {}));
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 90_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main", runId: "run-1" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "mock",
        model: "retrying-model",
        observationUnit: "request",
      });

      for (let attempt = 2; attempt <= 6; attempt += 1) {
        vi.advanceTimersByTime(30_000);
        logSessionStateChange({
          sessionId: "s1",
          sessionKey: "main",
          state: "processing",
          reason: "run_started",
        });
        markDiagnosticModelStartedForTest({
          sessionId: "s1",
          sessionKey: "main",
          runId: "run-1",
          provider: "mock",
          model: "retrying-model",
          observationUnit: "request",
        });
      }
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.find((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "stalled_agent_run",
        reason: "repeated_model_requests_without_progress",
        repeatedRequestNoProgressAgeMs: stuckSessionAbortMs,
      },
    );
    expect(recoverStuckSession).toHaveBeenCalledTimes(1);
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not recover repeated requests after semantic output resets the clock", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 90_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs },
      });
      const ref = { sessionId: "s1", sessionKey: "main", runId: "run-1" };
      logSessionStateChange({ ...ref, state: "processing" });
      markDiagnosticEmbeddedRunStarted(ref);
      markDiagnosticModelStartedForTest({
        ...ref,
        provider: "mock",
        model: "retrying-model",
        observationUnit: "request",
      });
      vi.advanceTimersByTime(30_000);
      markDiagnosticModelStartedForTest({
        ...ref,
        provider: "mock",
        model: "retrying-model",
        observationUnit: "request",
      });
      emitCoreSemanticRunProgressDiagnosticEvent({
        ...ref,
        reason: "assistant:progress",
      });
      await vi.advanceTimersByTimeAsync(0);

      for (let elapsedMs = 0; elapsedMs < stuckSessionAbortMs; elapsedMs += 30_000) {
        vi.advanceTimersByTime(30_000);
        markDiagnosticRunProgress({
          ...ref,
          reason: "model_call:stream_progress",
        });
      }
    } finally {
      unsubscribe();
    }

    expect(
      events.some(
        (event) =>
          event.type === "session.stalled" &&
          event.reason === "repeated_model_requests_without_progress",
      ),
    ).toBe(false);
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("reports silent model calls as long-running before the abort threshold", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 90_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs, stuckSessionAbortMs },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5",
      });

      vi.advanceTimersByTime(60_000);
    } finally {
      unsubscribe();
    }

    expect(events.some((event) => event.type === "session.stalled")).toBe(false);
    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.long_running"),
        "long-running event",
      ),
      {
        classification: "long_running",
        reason: "active_model_call_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("does not actively abort model calls with recent stream progress", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "lmstudio",
        model: "gemma-4-e4b-it",
      });

      vi.advanceTimersByTime(stuckSessionAbortMs - 15_000);
      markDiagnosticRunProgress({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        reason: "model_call:stream_progress",
      });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events.findLast((event) => event.type === "session.recovery.requested")).toBeUndefined();
    expectRecordFields(
      getDiagnosticSessionActivitySnapshot({ sessionId: "s1", sessionKey: "main" }),
      {
        activeWorkKind: "model_call",
        hasActiveEmbeddedRun: true,
        lastProgressAgeMs: 30_000,
        lastProgressReason: "model_call:stream_progress",
      },
    );
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("actively aborts silent local model calls after the stuck timeout", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "vllm",
        model: "qwen/qwen3.5-9b",
      });

      vi.advanceTimersByTime(stuckSessionAbortMs);
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("defers direct and repeated recovery until the latest model request allowance expires", async () => {
    const recoverStuckSession = vi.fn(() => new Promise<never>(() => {}));
    const ref = { sessionId: "allowance-session", sessionKey: "agent:main:allowance" };
    const runId = "allowance-run";
    const requestTimeoutMs = 150_000;
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startEnabledDiagnosticHeartbeat({
      recoverStuckSession,
      testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
    });
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "mock",
        model: "slow-model",
      },
      owner.generation,
      requestTimeoutMs,
    );
    await vi.advanceTimersByTimeAsync(0);

    vi.advanceTimersByTime(120_000);
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-2",
        provider: "mock",
        model: "slow-model",
      },
      owner.generation,
      requestTimeoutMs,
    );
    await vi.advanceTimersByTimeAsync(0);

    // The first request has exceeded the provider allowance, but the active
    // retry has not. Recovery must honor the exact request currently in flight.
    vi.advanceTimersByTime(30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120_000);

    expectRecoveryCall(recoverStuckSession, { ...ref, queueDepth: 0, allowActiveAbort: true }, [
      "ageMs",
      "stateGeneration",
    ]);
  });

  it("does not abort a silent local model call whose no-gap stream policy was propagated to diagnostic recovery (#125147)", async () => {
    // Regression for the subagent-spawn parity bug: a genuinely local model
    // (e.g. Ollama over loopback) resolves `resolveLlmIdleTimeoutMs` to `0`
    // (no stream-gap watchdog) because it can legitimately stay silent for
    // many minutes during prompt evaluation. `attempt-stream.ts` now carries
    // that resolved policy into the diagnostic model-call-started event as a
    // generous but finite request-timeout ceiling
    // (`LOCAL_MODEL_NO_GAP_DIAGNOSTIC_CEILING_MS`, see
    // attempt.model-diagnostic-events.ts). Diagnostic recovery must honor
    // that ceiling instead of falling back to the generic stuck-session
    // threshold and aborting a still-progressing local model call.
    const recoverStuckSession = vi.fn();
    const ref = { sessionId: "local-no-gap-session", sessionKey: "agent:jin:subagent:local" };
    const runId = "local-no-gap-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      },
    );
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "ollama",
        model: "qwen3.5:9b-q8_0",
      },
      owner.generation,
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Well past the generic stuck-session abort threshold (60s) and past the
    // previously observed real-world stall (~6.5 minutes, #125147), but
    // comfortably short of the finite no-gap ceiling — the local no-gap
    // policy must keep this recovery-ineligible.
    vi.advanceTimersByTime(15 * 60_000);

    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("still recovers a local model call that stays silent past the finite no-gap diagnostic ceiling (regression for #125388 review)", async () => {
    // ClawSweeper's review of the original #125147 fix caught that mapping
    // the local no-gap policy straight to MAX_TIMER_TIMEOUT_MS (~24.8 days)
    // made a genuinely wedged local call unrecoverable by the normal
    // stuck-session path. This proves the other half of the invariant: once a
    // silent local call's age exceeds the finite ceiling, normal recovery
    // still fires.
    const recoverStuckSession = vi.fn();
    const ref = {
      sessionId: "local-no-gap-wedged-session",
      sessionKey: "agent:jin:subagent:local",
    };
    const runId = "local-no-gap-wedged-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 60_000 },
      },
    );
    logSessionStateChange({ ...ref, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "ollama",
        model: "qwen3.5:9b-q8_0",
      },
      owner.generation,
      DEFAULT_UNDICI_STREAM_TIMEOUT_MS,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Past both the generic stuck-session abort threshold and the finite
    // no-gap ceiling — a genuinely wedged local call must be recoverable.
    vi.advanceTimersByTime(DEFAULT_UNDICI_STREAM_TIMEOUT_MS + 60_000);

    expect(recoverStuckSession).toHaveBeenCalled();
  });

  it("recovers stale model calls without active embedded-run ownership", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 60_000;
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5",
      });

      vi.advanceTimersByTime(stuckSessionAbortMs);
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stalled"),
        "stalled event",
      ),
      {
        classification: "stalled_agent_run",
        reason: "active_work_without_progress",
        activeWorkKind: "model_call",
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("does not recover a recent native tool call just because the session is old", async () => {
    const recoverStuckSession = vi.fn();
    const stuckSessionAbortMs = 90_000;

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).lastActivity =
      Date.now() - 120_000;
    markDiagnosticToolStartedForTest({
      sessionId: "s1",
      sessionKey: "main",
      runId: "run-1",
      toolName: "bash",
      toolCallId: "cmd-1",
    });

    vi.advanceTimersByTime(60_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(recoverStuckSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15 * 60_000 - stuckSessionAbortMs);
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("uses the built-in abort threshold for stalled active-work recovery", () => {
    const recoverStuckSession = vi.fn();

    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({
      sessionId: "s1",
      sessionKey: "main",
      sessionFile: "/tmp/openclaw-active-abort-session.jsonl",
      state: "processing",
    });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });

    vi.advanceTimersByTime(61_000);

    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        sessionFile: "/tmp/openclaw-active-abort-session.jsonl",
        queueDepth: 0,
        allowActiveAbort: true,
      },
      ["ageMs", "stateGeneration"],
    );
  });

  it("recovers idle queued embedded-run stalls after stale progress", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "aborted",
      action: "abort_embedded_run",
      sessionId: "s1",
      sessionKey: "main",
      activeSessionId: "s1",
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 0,
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

      vi.advanceTimersByTime(59_000);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        queueDepth: 1,
        allowActiveAbort: true,
        expectedState: "idle",
      },
      ["ageMs", "stateGeneration"],
    );
    requireMatchingRecord(
      events,
      {
        type: "session.recovery.completed",
        state: "idle",
        status: "aborted",
        action: "abort_embedded_run",
      },
      "idle abort recovery event",
    );
    expect(getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).queueDepth).toBe(0);
  });

  it("recovers idle queued work when embedded ownership is surfaced as a model call", async () => {
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "aborted",
      action: "abort_embedded_run",
      sessionId: "s1",
      sessionKey: "main",
      activeSessionId: "s1",
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 0,
    });
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
    markDiagnosticModelStartedForTest({
      sessionId: "s1",
      sessionKey: "main",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
    });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

    vi.advanceTimersByTime(59_000);
    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        queueDepth: 1,
        allowActiveAbort: true,
        expectedState: "idle",
      },
      ["ageMs", "stateGeneration"],
    );
  });

  it("recovers idle queued work blocked by stale model activity without active ownership", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      sessionId: "s1",
      sessionKey: "main",
      released: 0,
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticModelStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5",
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

      vi.advanceTimersByTime(59_000);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stuck"),
        "idle stale model activity event",
      ),
      {
        type: "session.stuck",
        state: "idle",
        classification: "stale_session_state",
        reason: "queued_work_without_active_run",
        queueDepth: 1,
        lastProgressReason: "model_call:started",
      },
    );
    expectRecoveryCall(
      recoverStuckSession,
      {
        sessionId: "s1",
        sessionKey: "main",
        queueDepth: 1,
        expectedState: "idle",
      },
      ["ageMs", "stateGeneration"],
    );
    const recoveryParams = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expect(recoveryParams.allowActiveAbort).toBeUndefined();
  });

  it("recovers idle queued work blocked by stale orphaned tool_call activity", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      sessionId: "s1",
      sessionKey: "main",
      released: 0,
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticToolStartedForTest({
        sessionId: "s1",
        sessionKey: "main",
        runId: "run-1",
        toolName: "shell",
        toolCallId: "tc-1",
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

      vi.advanceTimersByTime(59_000);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    } finally {
      unsubscribe();
    }

    expectRecordFields(
      requireRecord(
        events.findLast((event) => event.type === "session.stuck"),
        "idle stale tool activity event",
      ),
      {
        type: "session.stuck",
        state: "idle",
        classification: "stale_session_state",
        reason: "queued_work_without_active_run",
        queueDepth: 1,
      },
    );
    const recoveryParams = requireFirstMockCallArg(recoverStuckSession, "recoverStuckSession");
    expect(recoveryParams.expectedState).toBe("idle");
    expect(recoveryParams.allowActiveAbort).toBeUndefined();
  });

  it("recovers multiple stalled sessions independently without cross-session interference", async () => {
    const recoverStuckSession = vi.fn().mockImplementation((params: { sessionId: string }) =>
      Promise.resolve({
        status: "released",
        action: "release_lane",
        sessionId: params.sessionId,
        sessionKey: params.sessionId === "s1" ? "agent-a" : "agent-b",
        released: 0,
      }),
    );
    startEnabledDiagnosticHeartbeat({ recoverStuckSession });

    // Set up two independent sessions that both stall with orphaned model activity.
    logSessionStateChange({ sessionId: "s1", sessionKey: "agent-a", state: "processing" });
    markDiagnosticModelStartedForTest({
      sessionId: "s1",
      sessionKey: "agent-a",
      runId: "run-a",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    logSessionStateChange({ sessionId: "s1", sessionKey: "agent-a", state: "idle" });

    logSessionStateChange({ sessionId: "s2", sessionKey: "agent-b", state: "processing" });
    markDiagnosticModelStartedForTest({
      sessionId: "s2",
      sessionKey: "agent-b",
      runId: "run-b",
      provider: "openai",
      model: "gpt-5.5",
    });
    logSessionStateChange({ sessionId: "s2", sessionKey: "agent-b", state: "idle" });

    // Queue work on both sessions.
    vi.advanceTimersByTime(59_000);
    logMessageQueued({ sessionId: "s1", sessionKey: "agent-a", source: "user-a" });
    logMessageQueued({ sessionId: "s2", sessionKey: "agent-b", source: "user-b" });
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();

    // Both sessions should get independent recovery calls.
    expect(recoverStuckSession).toHaveBeenCalledTimes(2);
    const calls = recoverStuckSession.mock.calls.map(
      (c: unknown[]) => c[0] as Record<string, unknown>,
    );
    const s1Call = calls.find((c) => c.sessionId === "s1");
    const s2Call = calls.find((c) => c.sessionId === "s2");
    expect(s1Call).toBeDefined();
    expect(s2Call).toBeDefined();
    expect(s1Call!.sessionKey).toBe("agent-a");
    expect(s2Call!.sessionKey).toBe("agent-b");
    expect(s1Call!.expectedState).toBe("idle");
    expect(s2Call!.expectedState).toBe("idle");
    expect(s1Call!.allowActiveAbort).toBeUndefined();
    expect(s2Call!.allowActiveAbort).toBeUndefined();
  });

  it.each([
    {
      status: "aborted",
      action: "abort_embedded_run",
      aborted: true,
      drained: false,
      forceCleared: true,
    },
    { status: "released", action: "release_lane", reason: "stale_lane_task" },
  ] as const)(
    "preserves queued idle work when $status recovery releases active lane work",
    async (outcome) => {
      const events: DiagnosticEventPayload[] = [];
      const recoverStuckSession = vi.fn().mockResolvedValue({
        sessionId: "s1",
        sessionKey: "main",
        activeSessionId: "s1",
        activeWorkKind: "embedded_run",
        released: 1,
        queuedCount: 1,
        ...outcome,
      });
      const unsubscribe = onDiagnosticEvent((event) => events.push(event));
      try {
        startEnabledDiagnosticHeartbeat({ recoverStuckSession });
        logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
        markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
        logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

        vi.advanceTimersByTime(59_000);
        logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test-followup" });
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
      } finally {
        unsubscribe();
      }

      requireMatchingRecord(
        events,
        {
          type: "session.state",
          state: "idle",
          reason: `stuck_recovery:${outcome.status}`,
          queueDepth: 1,
        },
        `idle ${outcome.status} preserves queued work`,
      );
      expect(getDiagnosticSessionState({ sessionId: "s1", sessionKey: "main" }).queueDepth).toBe(1);
    },
  );

  it("marks diagnostic session state idle only after a mutating recovery outcome", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      released: 1,
      sessionId: "s1",
      sessionKey: "main",
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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

  it("clears queued diagnostic state after no-active-work recovery", async () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn().mockResolvedValue({
      status: "released",
      action: "release_lane",
      reason: "no_active_work",
      released: 0,
      sessionId: "s1",
      sessionKey: "main",
    });
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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
      { type: "session.state", state: "idle", reason: "stuck_recovery:released", queueDepth: 0 },
      "released state clear event",
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
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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
          status: "released";
          action: "release_lane";
          reason: "no_active_work";
          released: number;
          sessionId: string;
          sessionKey: string;
        }) => void)
      | undefined;
    const recoverStuckSession = vi.fn(
      () =>
        new Promise<{
          status: "released";
          action: "release_lane";
          reason: "no_active_work";
          released: number;
          sessionId: string;
          sessionKey: string;
        }>((resolve) => {
          resolveRecovery = resolve;
        }),
    );
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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
        status: "released",
        action: "release_lane",
        reason: "no_active_work",
        released: 0,
        sessionId: "s1",
        sessionKey: "main",
      });
      await Promise.resolve();
    } finally {
      unsubscribe();
    }
  });

  it("does not re-emit session.recovery.requested when generation bumps mid-flight (idle-queued stall)", async () => {
    const events: DiagnosticEventPayload[] = [];
    // Pin recover() to an unresolved Promise so the in-flight window spans two
    // heartbeat ticks (production awaits abort/drain, settleMs up to 15s). Same
    // seam as the already_in_flight dedup test above.
    let resolveRecovery:
      | ((outcome: {
          status: "skipped";
          action: "observe_only";
          reason: "already_in_flight";
          sessionId: string;
          sessionKey: string;
        }) => void)
      | undefined;
    const recoverStuckSession = vi.fn(
      () =>
        new Promise<{
          status: "skipped";
          action: "observe_only";
          reason: "already_in_flight";
          sessionId: string;
          sessionKey: string;
        }>((resolve) => {
          resolveRecovery = resolve;
        }),
    );
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      // idle-queued-recoverable-stall setup: embedded run ownership + idle + queued.
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "idle" });

      // T1 tick: lastProgressAgeMs > staleMs -> recoveryEligible -> coordinator key
      // add, requested #1 emitted, recover() in-flight (pending).
      vi.advanceTimersByTime(59_000);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "t1" });
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      expect(recoverStuckSession).toHaveBeenCalledTimes(1);

      // New message queued during the in-flight window -> state.generation +1 (but
      // lastProgressAt not refreshed). Next tick the coordinator key becomes S:G+1.
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "t2-followup" });

      // T2 tick (30s later): same session still idle-queued-stall -> re-classified.
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    } finally {
      resolveRecovery?.({
        status: "skipped",
        action: "observe_only",
        reason: "already_in_flight",
        sessionId: "s1",
        sessionKey: "main",
      });
      await Promise.resolve();
      unsubscribe();
    }

    const requestedEvents = events.filter((event) => event.type === "session.recovery.requested");
    // Before the fix (RED): coordinator key = `${ref}:${generation}`, so S:G and
    //   S:G+1 are distinct -> a second requested event is emitted ->
    //   requestedEvents.length === 2. The runtime sees the same ref and skips the
    //   actual recovery as already_in_flight, leaving only a duplicate event.
    // After the fix (GREEN): coordinator key is ref-only -> S:G+1 collides with the
    //   in-flight S -> the coordinator also absorbs it as already_in_flight ->
    //   requestedEvents.length === 1 (both dedup layers share granularity).
    expect(requestedEvents).toHaveLength(1);
  });

  it("reports long-running sessions separately when active work is making progress", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
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
      reason: "active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 0,
    });
    expect(recoverStuckSession).not.toHaveBeenCalled();
  });

  it("recovers queued sessions behind terminal embedded progress after the abort threshold", () => {
    const events: DiagnosticEventPayload[] = [];
    const recoverStuckSession = vi.fn();
    const stuckSessionWarnMs = 30_000;
    const stuckSessionAbortMs = 60_000;
    const terminalReason = "codex_app_server:notification:rawResponseItem/completed";
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    try {
      startEnabledDiagnosticHeartbeat({ recoverStuckSession });
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      markDiagnosticRunProgress({
        sessionId: "s1",
        sessionKey: "main",
        reason: terminalReason,
      });
      vi.advanceTimersByTime(stuckSessionAbortMs - stuckSessionWarnMs - 1);
      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      vi.advanceTimersByTime(stuckSessionWarnMs + 1);
    } finally {
      unsubscribe();
    }

    const attentionEvents = events.filter(
      (event) =>
        event.type === "session.long_running" ||
        event.type === "session.stalled" ||
        event.type === "session.stuck",
    );
    expectRecordFields(requireRecord(attentionEvents.at(-1), "final attention event"), {
      type: "session.stalled",
      classification: "stalled_agent_run",
      reason: "queued_behind_terminal_active_work",
      activeWorkKind: "embedded_run",
      queueDepth: 1,
      terminalProgressStale: true,
      lastProgressReason: terminalReason,
    });
    expectRecoveryCall(
      recoverStuckSession,
      { sessionId: "s1", sessionKey: "main", queueDepth: 1, allowActiveAbort: true },
      ["ageMs", "stateGeneration"],
    );
  });

  it("starts and stops the stability recorder with the heartbeat lifecycle", () => {
    startEnabledDiagnosticHeartbeat();
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
    expect(diagnosticSessionStates.size).toBe(0);
  });

  it("checks memory pressure every tick without recording idle samples", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startEnabledDiagnosticHeartbeat({ emitMemorySample, sampleLiveness: () => null });

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
      startEnabledDiagnosticHeartbeat({
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
      });

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

  it("warns and records the full duration for persistent idle event-loop degradation", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          degradedSinceMs: 60_000,
          eventLoopDelayP99Ms: 1_200,
          eventLoopDelayMaxMs: 1_500,
        }),
      });

      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expectLoggerMessageContaining(warnSpy, "degradedFor=60s");
    expect(events.findLast((event) => event.type === "diagnostic.liveness.warning")).toMatchObject({
      degradedSinceMs: 60_000,
    });
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        durationMs: 60_000,
      },
      "persistent liveness stability event",
    );
  });

  it("suppresses liveness warnings during startupGraceMs while still sampling", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: string[] = [];
    const recoverStuckSession = vi.fn();
    const sampleLiveness = vi.fn(() => ({
      reasons: ["event_loop_delay" as const],
      intervalMs: 30_000,
      eventLoopDelayP99Ms: 1_500,
      eventLoopDelayMaxMs: 2_000,
    }));
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));

    try {
      vi.setSystemTime(0);
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        recoverStuckSession,
        sampleLiveness,
        startupGraceMs: 60_000,
        testTimings: { stuckSessionWarnMs: 1_000, stuckSessionAbortMs: 1_000 },
      });

      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      markDiagnosticEmbeddedRunStarted({ sessionId: "s1", sessionKey: "main" });
      vi.setSystemTime(1_001);
      vi.advanceTimersByTime(30_000);

      expect(sampleLiveness).toHaveBeenCalledTimes(1);
      expectNoLoggerMessageContaining(warnSpy, "liveness heartbeat delayed");
      expectNoLoggerMessageContaining(warnSpy, "liveness warning:");
      expect(events).not.toContain("diagnostic.liveness.warning");
      expect(recoverStuckSession).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30_000);

      expect(sampleLiveness).toHaveBeenCalledTimes(2);
      expectLoggerMessageContaining(warnSpy, "liveness warning:");
      expect(events).toContain("diagnostic.liveness.warning");
      expectRecoveryCall(
        recoverStuckSession,
        { sessionId: "s1", sessionKey: "main", queueDepth: 0, allowActiveAbort: true },
        ["ageMs", "stateGeneration"],
      );
    } finally {
      unsubscribe();
    }
  });

  it("warns for liveness samples when diagnostic work is open", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 1_500,
        eventLoopDelayMaxMs: 2_000,
      }),
    });

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
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 1_500,
          eventLoopDelayMaxMs: 2_000,
        }),
      });

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

  it("attributes only phases completed during the measured liveness interval", async () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));

    await withDiagnosticPhase("stale.phase", () => undefined);
    vi.advanceTimersByTime(60_000);
    await withDiagnosticPhase("recent.phase", () => undefined);

    try {
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          eventLoopDelayP99Ms: 1_500,
          eventLoopDelayMaxMs: 2_000,
        }),
      });

      logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "test" });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expectLoggerMessageContaining(warnSpy, "recentPhases=recent.phase:");
    expectNoLoggerMessageContaining(warnSpy, "stale.phase");
    const warning = requireRecord(
      events.findLast((event) => event.type === "diagnostic.liveness.warning"),
      "liveness warning event",
    );
    expect(warning.recentPhases).toEqual([
      expect.objectContaining({
        name: "recent.phase",
      }),
    ]);
  });

  it("keeps transient event-loop max spikes debug-only when only background work is active", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 21,
        eventLoopDelayMaxMs: 1_500,
      }),
    });

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

  it("does not count the active processing message as queued liveness backlog", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 53.6,
        eventLoopDelayMaxMs: 2_761.9,
        eventLoopUtilization: 0.785,
        cpuCoreRatio: 0.378,
      }),
    });

    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "discord" });
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
      "active processing liveness stability event",
    );
  });

  it("counts messages queued behind already active work as liveness backlog", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 53.6,
        eventLoopDelayMaxMs: 2_761.9,
        eventLoopUtilization: 0.785,
        cpuCoreRatio: 0.378,
      }),
    });

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    logMessageQueued({ sessionId: "s1", sessionKey: "main", source: "discord" });
    vi.advanceTimersByTime(30_000);

    expectLoggerMessageContaining(warnSpy, "liveness warning:");
    requireMatchingRecord(
      getDiagnosticStabilitySnapshot({ limit: 10 }).events,
      {
        type: "diagnostic.liveness.warning",
        level: "warning",
        active: 1,
        waiting: 0,
        queued: 1,
      },
      "queued backlog liveness stability event",
    );
  });

  it("does not let idle liveness samples suppress later active-work warnings", () => {
    const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);

    startEnabledDiagnosticHeartbeat({
      emitMemorySample: createEmitMemorySampleMock(),
      sampleLiveness: () => ({
        reasons: ["event_loop_delay"],
        intervalMs: 30_000,
        eventLoopDelayP99Ms: 1_500,
        eventLoopDelayMaxMs: 2_000,
      }),
    });

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
      startEnabledDiagnosticHeartbeat({
        emitMemorySample: createEmitMemorySampleMock(),
        sampleLiveness: () => ({
          reasons: ["event_loop_delay"],
          intervalMs: 30_000,
          degradedSinceMs: 60_000,
          eventLoopDelayP99Ms: 1_500,
          eventLoopDelayMaxMs: 2_000,
        }),
      });

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

  it("uses fixed session attention thresholds", () => {
    expect(resolveStuckSessionWarnMs()).toBe(120_000);
    expect(resolveStuckSessionAbortMs(30_000)).toBe(5 * 60_000);
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

describe("stuck session recovery activity reconciliation", () => {
  const sessionKey = "agent:main:whatsapp:direct:demo";
  const sessionId = "wa-run-1";

  const stalledClassification: SessionAttentionClassification = {
    eventType: "session.stalled",
    reason: "active_work_without_progress",
    classification: "stalled_agent_run",
    activeWorkKind: "embedded_run",
    recoveryEligible: false,
  };

  function abortedOutcome(): StuckSessionRecoveryOutcome {
    return {
      status: "aborted",
      action: "abort_embedded_run",
      sessionId,
      sessionKey,
      activeSessionId: sessionId,
      activeWorkKind: "embedded_run",
      aborted: true,
      drained: false,
      forceCleared: false,
      released: 0,
    };
  }

  async function recoverStalledSession(params: {
    stateGeneration: number | undefined;
    sessionId?: string;
    recover?: () => Promise<StuckSessionRecoveryOutcome>;
  }): Promise<void> {
    const recoverySessionId = params.sessionId ?? sessionId;
    requestStuckSessionRecovery({
      recover: params.recover ?? (() => Promise.resolve(abortedOutcome())),
      classification: stalledClassification,
      request: {
        sessionId: recoverySessionId,
        sessionKey,
        ageMs: 139_014,
        queueDepth: 2,
        allowActiveAbort: true,
        expectedState: "processing",
        stateGeneration: params.stateGeneration,
      },
    });
    await flushDiagnosticEvents();
    await flushDiagnosticEvents();
  }

  beforeEach(() => {
    setDiagnosticsEnabledForProcess(true);
    resetDiagnosticSessionStateForTest();
    resetDiagnosticRunActivityForTest();
    startDiagnosticRunActivityTracking();
    resetDiagnosticSessionRecoveryCoordinatorForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticRunActivityForTest();
    resetDiagnosticSessionRecoveryCoordinatorForTest();
  });

  it("clears the embedded-run activity flag when recovery declares the lane idle", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.queueDepth = 2;

    // The aborted run was removed without markDiagnosticEmbeddedRunEnded, so the
    // activity flag survives the idle transition and otherwise resurfaces as
    // idle/embedded_run on every later liveness sweep.
    await recoverStalledSession({ stateGeneration: state.generation });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("idle");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.hasActiveEmbeddedRun).toBeUndefined();
  });

  it("clears a stale tool marker left by the aborted run so a queued idle lane converges", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    // The aborted run left a stale tool marker. If recovery clears only the
    // embedded owner, the lane becomes idle + orphaned tool_call, which
    // isIdleQueuedRecoverableSessionStall still treats as recoverable while work
    // is queued — so the idle declaration must clear the tool marker too.
    markDiagnosticToolStartedForTest({ sessionId, sessionKey, toolName: "Bash", toolCallId: "t1" });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.queueDepth = 2;

    await recoverStalledSession({ stateGeneration: state.generation });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("idle");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.hasActiveEmbeddedRun).toBeUndefined();
    expect(activity.activeToolName).toBeUndefined();
  });

  it("clears a stale model marker left by the aborted run so a queued idle lane converges", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    // Same hazard via a stale model-call marker: owner-only clearing would leave
    // idle + orphaned model_call, which the idle-queued classifier still recovers.
    markDiagnosticModelStartedForTest({
      sessionId,
      sessionKey,
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.5",
    });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.queueDepth = 2;

    await recoverStalledSession({ stateGeneration: state.generation });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("idle");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.hasActiveEmbeddedRun).toBeUndefined();
  });

  it("ignores stale async tool and model starts that drain after recovery clearing", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.queueDepth = 2;

    emitDiagnosticEvent({
      type: "tool.execution.started",
      sessionId,
      sessionKey,
      toolName: "Bash",
      toolCallId: "late-tool",
    });
    emitDiagnosticEvent({
      type: "model.call.started",
      sessionId,
      sessionKey,
      runId: sessionId,
      callId: "late-model",
      provider: "openai",
      model: "gpt-5.5",
    });

    await recoverStalledSession({ stateGeneration: state.generation });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("idle");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.hasActiveEmbeddedRun).toBeUndefined();
    expect(activity.activeToolName).toBeUndefined();
  });

  it("remembers stale async start cutoffs even when activity was already empty", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    markDiagnosticEmbeddedRunEnded({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.queueDepth = 2;

    emitDiagnosticEvent({
      type: "tool.execution.started",
      runId: sessionId,
      sessionId,
      sessionKey,
      toolName: "Bash",
      toolCallId: "late-tool",
    });
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: sessionId,
      sessionId,
      sessionKey,
      callId: "late-model",
      provider: "openai",
      model: "gpt-5.5",
    });

    await recoverStalledSession({ stateGeneration: state.generation });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("idle");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.activeToolName).toBeUndefined();
  });

  it("preserves an active flag for a newer run that re-armed work mid-recovery", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    const staleGeneration = state.generation;

    await recoverStalledSession({
      stateGeneration: staleGeneration,
      recover: () => {
        // A requeued run started before the coordinator applied the outcome,
        // advancing the generation past the captured one.
        logSessionStateChange({
          sessionId: "wa-run-2",
          sessionKey,
          state: "processing",
          reason: "run_started",
        });
        markDiagnosticEmbeddedRunStarted({ sessionId: "wa-run-2", sessionKey });
        return Promise.resolve(abortedOutcome());
      },
    });

    // Generation guard bails: the live run keeps processing and its activity flag.
    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("processing");
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).activeWorkKind).toBe(
      "embedded_run",
    );
  });

  it("preserves reply work that re-armed activity without a session generation bump", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    const staleGeneration = state.generation;

    await recoverStalledSession({
      stateGeneration: staleGeneration,
      recover: () => {
        markDiagnosticEmbeddedRunStarted({
          sessionId: "reply-run-1",
          sessionKey,
          workKey: `reply:${sessionKey}`,
        });
        return Promise.resolve(abortedOutcome());
      },
    });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("processing");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBe("embedded_run");
    expect(activity.hasActiveEmbeddedRun).toBe(true);
  });

  it("clears stale tool and model markers while preserving a fresh embedded owner", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    markDiagnosticToolStartedForTest({ sessionId, sessionKey, toolName: "Bash", toolCallId: "t1" });
    markDiagnosticModelStartedForTest({
      sessionId,
      sessionKey,
      runId: sessionId,
      provider: "openai",
      model: "gpt-5.5",
    });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    const staleGeneration = state.generation;

    await recoverStalledSession({
      stateGeneration: staleGeneration,
      recover: () => {
        markDiagnosticEmbeddedRunStarted({
          sessionId: "reply-run-1",
          sessionKey,
          workKey: `reply:${sessionKey}`,
        });
        return Promise.resolve(abortedOutcome());
      },
    });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("processing");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBe("embedded_run");
    expect(activity.hasActiveEmbeddedRun).toBe(true);
    expect(activity.activeToolName).toBeUndefined();
  });

  it("clears recovered reply work stored under a custom embedded work key", async () => {
    const replySessionId = "reply-run-1";
    logSessionStateChange({
      sessionId: replySessionId,
      sessionKey,
      state: "processing",
      reason: "run_started",
    });
    markDiagnosticEmbeddedRunStarted({
      sessionId: replySessionId,
      sessionKey,
      workKey: `reply:${sessionKey}`,
    });
    const state = getDiagnosticSessionState({ sessionId: replySessionId, sessionKey });
    state.queueDepth = 2;

    await recoverStalledSession({
      sessionId: replySessionId,
      stateGeneration: state.generation,
      recover: () =>
        Promise.resolve({
          ...abortedOutcome(),
          sessionId: replySessionId,
          activeSessionId: replySessionId,
        }),
    });

    expect(peekDiagnosticSessionState({ sessionId: replySessionId, sessionKey })?.state).toBe(
      "idle",
    );
    const activity = getDiagnosticSessionActivitySnapshot({
      sessionId: replySessionId,
      sessionKey,
    });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.hasActiveEmbeddedRun).toBeUndefined();
  });

  it("does not block recovery behind older same-key embedded owners", async () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: "older-run-1", sessionKey });
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    state.queueDepth = 2;

    await recoverStalledSession({ stateGeneration: state.generation });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("idle");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.hasActiveEmbeddedRun).toBeUndefined();
  });

  it("preserves same-session work rearmed after recovery starts", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    const staleGeneration = state.generation;

    await recoverStalledSession({
      stateGeneration: staleGeneration,
      recover: () => {
        markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
        return Promise.resolve(abortedOutcome());
      },
    });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("processing");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBe("embedded_run");
    expect(activity.hasActiveEmbeddedRun).toBe(true);
  });

  it("prunes older same-key activity when a fresh owner blocks recovery clearing", async () => {
    markDiagnosticEmbeddedRunStarted({ sessionId: "older-run-1", sessionKey });
    markDiagnosticToolStartedForTest({
      sessionId: "older-run-1",
      sessionKey,
      toolName: "OldTool",
      toolCallId: "old-tool",
    });
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    const staleGeneration = state.generation;

    await recoverStalledSession({
      stateGeneration: staleGeneration,
      recover: () => {
        markDiagnosticEmbeddedRunStarted({ sessionId: "reply-run-1", sessionKey });
        return Promise.resolve(abortedOutcome());
      },
    });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("processing");
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).activeWorkKind).toBe(
      "embedded_run",
    );

    markDiagnosticEmbeddedRunEnded({
      sessionId: "reply-run-1",
      sessionKey,
      clearRunActivity: false,
    });
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBeUndefined();
    expect(activity.activeToolName).toBeUndefined();
  });

  it("preserves fresh same-session tool activity rearmed after recovery starts", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    const staleGeneration = state.generation;

    await recoverStalledSession({
      stateGeneration: staleGeneration,
      recover: () => {
        markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
        emitDiagnosticEvent({
          type: "tool.execution.started",
          runId: sessionId,
          sessionId,
          sessionKey,
          toolName: "FreshTool",
          toolCallId: "fresh-tool",
        });
        return Promise.resolve(abortedOutcome());
      },
    });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("processing");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBe("tool_call");
    expect(activity.hasActiveEmbeddedRun).toBe(true);
    expect(activity.activeToolName).toBe("FreshTool");
  });

  it("keeps fresh tool markers when a different embedded owner blocks recovery clearing", async () => {
    logSessionStateChange({ sessionId, sessionKey, state: "processing", reason: "run_started" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    markDiagnosticToolStartedForTest({ sessionId, sessionKey, toolName: "Bash", toolCallId: "t1" });
    const state = getDiagnosticSessionState({ sessionId, sessionKey });
    const staleGeneration = state.generation;

    await recoverStalledSession({
      stateGeneration: staleGeneration,
      recover: () => {
        markDiagnosticEmbeddedRunStarted({ sessionId: "reply-run-1", sessionKey });
        emitDiagnosticEvent({
          type: "tool.execution.started",
          sessionId: "reply-run-1",
          sessionKey,
          toolName: "ReplyTool",
          toolCallId: "fresh-tool",
        });
        return Promise.resolve(abortedOutcome());
      },
    });

    expect(peekDiagnosticSessionState({ sessionId, sessionKey })?.state).toBe("processing");
    const activity = getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey });
    expect(activity.activeWorkKind).toBe("tool_call");
    expect(activity.hasActiveEmbeddedRun).toBe(true);
    expect(activity.activeToolName).toBe("ReplyTool");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
