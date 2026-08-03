// Unit tests for shared run-staleness threshold policy.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  clearDiagnosticEmbeddedRunActivityForSession,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resolveRunStaleThresholdMs,
  RUN_STALE_TAKEOVER_MS,
  startDiagnosticRunActivityTracking,
  stopDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";

afterEach(() => {
  vi.useRealTimers();
  stopDiagnosticRunActivityTracking();
  resetDiagnosticEventsForTest();
});

describe("diagnostic run activity listener lifecycle", () => {
  it("does not register a listener when the module is imported", async () => {
    stopDiagnosticRunActivityTracking();
    resetDiagnosticEventsForTest();

    await importFreshModule<typeof import("./diagnostic-run-activity.js")>(
      import.meta.url,
      "./diagnostic-run-activity.js?scope=no-import-listener",
    );

    expect(hasInternalDiagnosticEventListeners()).toBe(false);
  });

  it("registers and unregisters through the explicit lifecycle", () => {
    resetDiagnosticEventsForTest();

    startDiagnosticRunActivityTracking();
    expect(hasInternalDiagnosticEventListeners()).toBe(true);
    markDiagnosticEmbeddedRunStarted({ sessionId: "run-before-stop" });
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "run-before-stop" })).toMatchObject({
      activeWorkKind: "embedded_run",
    });

    stopDiagnosticRunActivityTracking();
    expect(hasInternalDiagnosticEventListeners()).toBe(false);
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "run-before-stop" })).toEqual({});
  });

  it("ignores diagnostic events queued before tracking restarts", async () => {
    resetDiagnosticEventsForTest();
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "stale-run",
      toolName: "stale-tool",
    });

    startDiagnosticRunActivityTracking();
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "stale-run" })).toEqual({});

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      sessionId: "current-run",
      toolName: "current-tool",
    });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot({ sessionId: "current-run" })).toMatchObject({
      activeWorkKind: "tool_call",
      activeToolName: "current-tool",
    });
  });

  it("releases embedded run-id indexes without diagnostic event tracking", () => {
    const ref = { sessionId: "reused-session", sessionKey: "agent:main:reused" };

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "first-run" });
    markDiagnosticEmbeddedRunEnded(ref);
    markDiagnosticRunProgress({ runId: "first-run", reason: "stale-first-run" });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "embedded_run:ended",
    });

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-old-run" });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-new-run" });
    markDiagnosticRunProgress({ runId: "replacement-old-run", reason: "stale-replaced-run" });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressReason: "embedded_run:started",
    });

    markDiagnosticEmbeddedRunEnded(ref);
    markDiagnosticRunProgress({ runId: "replacement-new-run", reason: "stale-final-run" });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "embedded_run:ended",
    });
  });
});

describe("argument-churn liveness", () => {
  it("keeps frequently observed churn stale across mechanical model progress", () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "churn-session", sessionKey: "agent:main:churn" };

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "churn-run" });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "churn-run",
      active: true,
    });

    for (let step = 1; step <= 12; step += 1) {
      vi.setSystemTime(startedAt + step * 30_000);
      markDiagnosticRunProgress({
        ...ref,
        runId: "churn-run",
        reason: "model_call:stream",
      });
      markDiagnosticArgumentChurnObservation({
        ...ref,
        runId: "churn-run",
        active: true,
      });
    }

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressAgeMs: 6 * 60_000,
      lastProgressReason: "tool_loop:argument_churn",
    });

    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "churn-run",
      active: false,
    });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 0,
      lastProgressReason: "model_call:stream",
    });
  });

  it("lets later model progress supersede churn after tool activity stops", () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "churn-stop-session", sessionKey: "agent:main:churn-stop" };

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "churn-stop-run" });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "churn-stop-run",
      active: true,
    });

    vi.setSystemTime(startedAt + 2 * 60_000);
    markDiagnosticRunProgress({
      ...ref,
      runId: "churn-stop-run",
      reason: "model_call:stream",
    });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 0,
      lastProgressReason: "model_call:stream",
    });

    // If churn later resumes, its clock restarts instead of inheriting the old age.
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "churn-stop-run",
      active: true,
    });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 0,
      lastProgressReason: "tool_loop:argument_churn",
    });
  });

  it("orders later progress after churn when both share a timestamp", () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "same-time-session", sessionKey: "agent:main:same-time" };
    const runId = "same-time-run";

    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    markDiagnosticArgumentChurnObservation({ ...ref, runId, active: true });
    markDiagnosticRunProgress({ ...ref, runId, reason: "model_call:stream" });

    vi.setSystemTime(startedAt + 60_000);
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 60_000,
      lastProgressReason: "model_call:stream",
    });
  });

  it("preserves same-timestamp progress ordering when session refs merge", () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const sessionId = "same-time-merge-session";
    const sessionKey = "agent:main:same-time-merge";
    const runId = "same-time-merge-run";

    markDiagnosticEmbeddedRunStarted({ sessionId, runId });
    markDiagnosticArgumentChurnObservation({ sessionId, runId, active: true });
    markDiagnosticRunProgress({ sessionKey, reason: "model_call:stream" });

    vi.setSystemTime(startedAt + 60_000);
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
      lastProgressAgeMs: 60_000,
      lastProgressReason: "model_call:stream",
    });
  });

  it("keeps overlapping policy waits suspended until every call releases its token", () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "policy-overlap-session", sessionKey: "agent:main:policy-overlap" };
    const runId = "policy-overlap-run";
    const firstWait = Symbol("first-policy-wait");
    const secondWait = Symbol("second-policy-wait");

    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId,
      active: true,
    });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId,
      policyWait: "enter",
      policyWaitToken: firstWait,
    });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId,
      policyWait: "enter",
      policyWaitToken: secondWait,
    });

    vi.setSystemTime(startedAt + 6 * 60_000);
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId,
      policyWait: "exit",
      policyWaitToken: firstWait,
    });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId,
      active: true,
    });

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 0,
      lastProgressReason: "tool_policy:pending",
    });

    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId,
      policyWait: "exit",
      policyWaitToken: secondWait,
    });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressAgeMs: 6 * 60_000,
      lastProgressReason: "tool_loop:argument_churn",
    });
  });

  it("clears churn evidence when recovery terminates the owning run", () => {
    const ref = {
      sessionId: "recovered-churn-session",
      sessionKey: "agent:main:recovered-churn",
    };
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "recovered-churn-run" });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "recovered-churn-run",
      active: true,
      now: Date.now() - 6 * 60_000,
    });

    expect(
      clearDiagnosticEmbeddedRunActivityForSession({
        ...ref,
        activeSessionId: ref.sessionId,
      }),
    ).toEqual({
      cleared: true,
      blockedByActiveEmbeddedRun: false,
    });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: undefined,
      lastProgressReason: "embedded_run:ended",
    });
  });

  it("does not carry an old churn clock into a replacement run", () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "shared-session", sessionKey: "agent:main:replacement" };

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "old-run" });
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "old-run",
      active: true,
    });

    vi.setSystemTime(startedAt + 6 * 60_000);
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-run" });
    markDiagnosticRunProgress({
      ...ref,
      runId: "replacement-run",
      reason: "model_call:stream",
    });

    // A delayed observation from the replaced owner must not make the new owner stale.
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "old-run",
      active: true,
      now: startedAt,
    });

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressAgeMs: 0,
      lastProgressReason: "model_call:stream",
    });

    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "replacement-run",
      active: true,
    });
    vi.setSystemTime(startedAt + 12 * 60_000);

    // A delayed escape from the replaced owner must not clear the new clock.
    markDiagnosticArgumentChurnObservation({
      ...ref,
      runId: "old-run",
      active: false,
    });

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressAgeMs: 6 * 60_000,
      lastProgressReason: "tool_loop:argument_churn",
    });
  });
});

describe("resolveRunStaleThresholdMs", () => {
  it.each([
    {
      name: "default window when no active work",
      activity: {},
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "default window for model_call",
      activity: { activeWorkKind: "model_call" as const },
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "default window for embedded_run",
      activity: { activeWorkKind: "embedded_run" as const },
      expected: RUN_STALE_TAKEOVER_MS,
    },
    {
      name: "blocked-tool floor for tool_call",
      activity: { activeWorkKind: "tool_call" as const },
      expected: Math.max(RUN_STALE_TAKEOVER_MS, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS),
    },
  ])("$name", ({ activity, expected }) => {
    expect(resolveRunStaleThresholdMs(activity)).toBe(expected);
  });
});
