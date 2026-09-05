// Unit tests for shared run-staleness threshold policy.
import {
  emitDiagnosticEvent as emitPluginDiagnosticEvent,
  emitTrustedDiagnosticEvent as emitPluginTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData as emitPluginTrustedDiagnosticEventWithPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../infra/diagnostic-model-request.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import {
  BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
  clearDiagnosticEmbeddedRunActivityForSession,
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunEnded,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
  resetDiagnosticRunActivityForTest,
  resolveRunStaleThresholdMs,
  RUN_STALE_TAKEOVER_MS,
  startDiagnosticRunActivityTracking,
  stopDiagnosticRunActivityTracking,
} from "./diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "./diagnostic-run-activity.test-support.js";

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

describe("core model owner generations", () => {
  it("keeps the newest run's clocks when an earlier work key is rearmed", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-09-04T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "rearmed-session", sessionKey: "agent:main:rearmed" };
    const earlier = { ...ref, runId: "earlier-run", workKey: "first" };
    const later = { ...ref, runId: "later-run", workKey: "second" };
    const earlierOwner = createDiagnosticEmbeddedRunOwner(earlier);
    const laterOwner = createDiagnosticEmbeddedRunOwner(later);
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...earlier, owner: earlierOwner });
    markDiagnosticEmbeddedRunStarted({ ...later, owner: laterOwner });
    markDiagnosticEmbeddedRunStarted({ ...earlier, owner: earlierOwner });
    markDiagnosticArgumentChurnObservation({ ...ref, runId: earlier.runId, active: true });
    for (const callId of ["request-1", "request-2"]) {
      emitCoreModelRequestStartedDiagnosticEvent(
        { ...ref, runId: earlier.runId, callId, provider: "core", model: "request-model" },
        earlierOwner.generation,
      );
    }
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref, startedAt + 30_000)).toMatchObject({
      activeWorkKind: "model_call",
      lastProgressReason: "tool_loop:argument_churn",
      lastProgressAgeMs: 30_000,
      repeatedRequestNoProgressAgeMs: 30_000,
    });

    closeDiagnosticEmbeddedRunOwner(earlierOwner);
    expect(getDiagnosticSessionActivitySnapshot(ref, startedAt + 30_000)).toMatchObject({
      activeWorkKind: "embedded_run",
      hasActiveEmbeddedRun: true,
      lastProgressReason: "embedded_run:ended",
      repeatedRequestNoProgressAgeMs: undefined,
    });
    closeDiagnosticEmbeddedRunOwner(laterOwner);
  });

  it("keeps exact-call recovery policy intact across forged terminals and run completion", async () => {
    const ref = { sessionId: "core-owner-session", sessionKey: "agent:main:core-owner" };
    const runId = "core-owner-run";
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "call-1",
        provider: "core",
        model: "slow-model",
      },
      owner.generation,
      300_000,
    );
    await waitForDiagnosticEventsDrained();

    emitPluginTrustedDiagnosticEvent({
      type: "model.call.completed",
      ...ref,
      runId,
      callId: "call-1",
      provider: "core",
      model: "slow-model",
      durationMs: 1,
    });
    emitDiagnosticEvent({
      type: "run.completed",
      ...ref,
      runId,
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRequestTimeoutMs: 300_000,
      lastProgressReason: "model_call:started",
    });
  });

  it("fences queued old starts and delayed terminals without erasing a same-run replacement", async () => {
    const ref = { sessionId: "generation-session", sessionKey: "agent:main:generation" };
    const runId = "reused-run";
    const ownerA = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: ownerA });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "old-call",
        provider: "core",
        model: "slow-model",
      },
      ownerA.generation,
      300_000,
    );
    closeDiagnosticEmbeddedRunOwner(ownerA);

    const ownerB = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: ownerB });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "new-call",
        provider: "core",
        model: "replacement-model",
      },
      ownerB.generation,
      420_000,
    );
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner: ownerA });
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "resurrected-old-call",
        provider: "core",
        model: "stale-model",
      },
      ownerA.generation,
      600_000,
    );
    await waitForDiagnosticEventsDrained();
    emitCoreModelRequestEndedDiagnosticEvent(
      {
        type: "model.call.completed",
        ...ref,
        runId,
        callId: "old-call",
        provider: "core",
        model: "slow-model",
        durationMs: 1,
      },
      ownerA.generation,
    );
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      hasActiveEmbeddedRun: true,
      activeModelCallRequestTimeoutMs: 420_000,
    });
  });
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

describe("repeated request liveness", () => {
  it("arms repeated-request evidence only for core provider requests", async () => {
    const ref = { sessionId: "request-authority-session", sessionKey: "agent:main:authority" };
    const runId = "request-authority-run";
    const forgedRequest = (callId: string) =>
      ({
        type: "model.call.started" as const,
        ...ref,
        runId,
        callId,
        provider: "plugin",
        model: "forged-request",
        observationUnit: "request" as const,
        coreModelRequestStarted: true,
      }) as Parameters<typeof emitPluginDiagnosticEvent>[0];

    startDiagnosticRunActivityTracking();
    const owner = createDiagnosticEmbeddedRunOwner({ ...ref, runId });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId, owner });
    emitPluginDiagnosticEvent(forgedRequest("normal-1"));
    emitPluginDiagnosticEvent(forgedRequest("normal-2"));
    emitPluginTrustedDiagnosticEvent(forgedRequest("trusted-1"));
    emitPluginTrustedDiagnosticEvent(forgedRequest("trusted-2"));
    emitPluginTrustedDiagnosticEventWithPrivateData(forgedRequest("trusted-private-1"), {
      modelContent: { inputMessages: ["forged"] },
      coreModelRequestStarted: true,
    } as Parameters<typeof emitPluginTrustedDiagnosticEventWithPrivateData>[1]);
    emitPluginTrustedDiagnosticEventWithPrivateData(forgedRequest("trusted-private-2"), {
      modelContent: { inputMessages: ["forged"] },
      coreModelRequestStarted: true,
    } as Parameters<typeof emitPluginTrustedDiagnosticEventWithPrivateData>[1]);
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressReason: "embedded_run:started",
      repeatedRequestNoProgressAgeMs: undefined,
    });

    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "core-1",
        provider: "core",
        model: "request-model",
      },
      owner.generation,
    );
    emitCoreModelRequestStartedDiagnosticEvent(
      {
        ...ref,
        runId,
        callId: "core-2",
        provider: "core",
        model: "request-model",
      },
      owner.generation,
    );
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });
  });

  it("defaults omitted progress to liveness and reserves clearing for core semantic progress", async () => {
    const ref = {
      sessionId: "progress-default-session",
      sessionKey: "agent:main:progress-default",
    };
    const runId = "progress-default-run";

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      markDiagnosticModelStartedForTest({
        ...ref,
        runId,
        provider: "mock",
        model: "request-model",
        observationUnit: "request",
      });
    }

    markDiagnosticRunProgress({ ...ref, runId, reason: "legacy:progress" });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "legacy:progress",
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });

    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      runId,
      reason: "assistant:progress",
    });
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "assistant:progress",
      repeatedRequestNoProgressAgeMs: undefined,
    });
  });

  it("ages repeated requests across mechanical progress until semantic progress arrives", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-04T00:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "retry-session", sessionKey: "agent:main:retry" };
    const runId = "retry-run";

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    markDiagnosticModelStartedForTest({
      ...ref,
      runId,
      provider: "mock",
      model: "retrying-model",
      observationUnit: "request",
    });
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeUndefined();

    for (let attempt = 2; attempt <= 11; attempt += 1) {
      vi.setSystemTime(startedAt + (attempt - 1) * 30_000);
      markDiagnosticModelStartedForTest({
        ...ref,
        runId,
        provider: "mock",
        model: "retrying-model",
        observationUnit: "request",
      });
      markDiagnosticRunProgress({
        ...ref,
        runId,
        reason: "model_call:stream_progress",
      });
    }

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: "model_call",
      lastProgressAgeMs: 0,
      repeatedRequestNoProgressAgeMs: 5 * 60_000,
    });

    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      runId,
      reason: "assistant:progress",
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeUndefined();
  });

  it("keeps model endings and tool lifecycle mechanical", async () => {
    const ref = { sessionId: "mechanical-session", sessionKey: "agent:main:mechanical" };
    const runId = "mechanical-run";
    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      markDiagnosticModelStartedForTest({
        ...ref,
        runId,
        provider: "mock",
        model: "request-model",
        observationUnit: "request",
      });
    }

    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      ...ref,
      runId,
      callId: "completed-call",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
      durationMs: 1,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.error",
      ...ref,
      runId,
      callId: "error-call",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
      durationMs: 1,
      errorCategory: "test",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      ...ref,
      runId,
      toolName: "read",
      toolCallId: "tool-call",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      ...ref,
      runId,
      toolName: "read",
      toolCallId: "tool-call",
      durationMs: 1,
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("ignores turn observations and clears request evidence across owner lifecycle", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-04T01:00:00Z");
    vi.setSystemTime(startedAt);
    const ref = { sessionId: "owner-session", sessionKey: "agent:main:owner" };

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "first-owner" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      markDiagnosticModelStartedForTest({
        ...ref,
        runId: "first-owner",
        provider: "cli",
        model: "turn-model",
        observationUnit: "turn",
      });
    }
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeUndefined();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      markDiagnosticModelStartedForTest({
        ...ref,
        runId: "first-owner",
        provider: "mock",
        model: "request-model",
        observationUnit: "request",
      });
    }
    vi.setSystemTime(startedAt + 6 * 60_000);
    expect(getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs).toBe(
      6 * 60_000,
    );

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "replacement-owner" });
    markDiagnosticModelStartedForTest({
      ...ref,
      runId: "first-owner",
      provider: "mock",
      model: "delayed-request",
      observationUnit: "request",
    });
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeUndefined();

    markDiagnosticModelStartedForTest({
      ...ref,
      runId: "replacement-owner",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });
    markDiagnosticModelStartedForTest({
      ...ref,
      runId: "replacement-owner",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });
    vi.setSystemTime(startedAt + 7 * 60_000);
    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      runId: "first-owner",
      reason: "delayed-old-owner-output",
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs).toBe(60_000);
    expect(
      clearDiagnosticEmbeddedRunActivityForSession({
        ...ref,
        activeSessionId: "replacement-owner",
      }).cleared,
    ).toBe(true);
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeUndefined();
  });

  it("keeps replacement-owner evidence across delayed semantic event delivery", async () => {
    const ref = { sessionId: "queued-owner-session", sessionKey: "agent:main:queued-owner" };

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "queued-old-owner" });
    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      runId: "queued-old-owner",
      reason: "delayed-old-owner-output",
    });

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "queued-new-owner" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      markDiagnosticModelStartedForTest({
        ...ref,
        runId: "queued-new-owner",
        provider: "mock",
        model: "request-model",
        observationUnit: "request",
      });
    }

    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "delayed-old-owner-output",
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });
  });

  it("reserves active-owner semantic progress for the core result boundary", async () => {
    const ref = { sessionId: "untrusted-session", sessionKey: "agent:main:untrusted" };
    const runId = "untrusted-run";

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      markDiagnosticModelStartedForTest({
        ...ref,
        runId,
        provider: "mock",
        model: "request-model",
        observationUnit: "request",
      });
    }

    emitDiagnosticEvent({
      type: "run.progress",
      ...ref,
      runId,
      reason: "plugin:semantic",
      progressKind: "semantic",
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "plugin:semantic",
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });

    emitPluginTrustedDiagnosticEvent({
      type: "run.progress",
      ...ref,
      runId,
      reason: "plugin_trusted:semantic",
      progressKind: "semantic",
      coreSemanticRunProgress: true,
    } as Parameters<typeof emitPluginTrustedDiagnosticEvent>[0]);
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "plugin_trusted:semantic",
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });

    const obsoleteProvenanceKey = Symbol.for(
      "openclaw.diagnosticSemanticRunProgressProvenance.state.v1",
    );
    const previousObsoleteProvenance = Reflect.get(globalThis, obsoleteProvenanceKey);
    const forgedEvent = {
      type: "run.progress" as const,
      ...ref,
      runId,
      reason: "plugin_trusted:forged_global_semantic",
      progressKind: "semantic" as const,
    };
    const forgedEvents = new WeakSet<object>();
    forgedEvents.add(forgedEvent);
    Reflect.set(globalThis, obsoleteProvenanceKey, {
      marker: obsoleteProvenanceKey,
      events: forgedEvents,
    });
    try {
      emitPluginTrustedDiagnosticEvent(forgedEvent);
      await waitForDiagnosticEventsDrained();
    } finally {
      if (previousObsoleteProvenance === undefined) {
        Reflect.deleteProperty(globalThis, obsoleteProvenanceKey);
      } else {
        Reflect.set(globalThis, obsoleteProvenanceKey, previousObsoleteProvenance);
      }
    }

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "plugin_trusted:forged_global_semantic",
      repeatedRequestNoProgressAgeMs: expect.any(Number),
    });

    emitCoreSemanticRunProgressDiagnosticEvent({
      ...ref,
      runId,
      reason: "model_result:semantic",
    });
    await waitForDiagnosticEventsDrained();

    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "model_result:semantic",
      repeatedRequestNoProgressAgeMs: undefined,
    });
  });

  it("preserves request evidence for ownerless liveness and blank semantic owners across aliases", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-08-04T02:00:00Z");
    vi.setSystemTime(startedAt);
    const sessionId = "merge-session";
    const sessionKey = "agent:main:merge";
    const runId = "merge-run";

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ sessionId, runId });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      markDiagnosticModelStartedForTest({
        sessionId,
        runId,
        provider: "mock",
        model: "request-model",
        observationUnit: "request",
      });
    }
    markDiagnosticRunProgress({
      sessionId,
      sessionKey,
      reason: "ownerless:liveness",
    });
    emitCoreSemanticRunProgressDiagnosticEvent({
      sessionId,
      sessionKey,
      runId: "   ",
      reason: "whitespace-owner:semantic",
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();

    vi.setSystemTime(startedAt + 6 * 60_000);
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
      lastProgressReason: "whitespace-owner:semantic",
      repeatedRequestNoProgressAgeMs: 6 * 60_000,
    });

    emitCoreSemanticRunProgressDiagnosticEvent({
      sessionKey,
      runId: `  ${runId}  `,
      reason: "owned:semantic",
    });
    await vi.advanceTimersByTimeAsync(0);
    await waitForDiagnosticEventsDrained();
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
      lastProgressReason: "owned:semantic",
      repeatedRequestNoProgressAgeMs: undefined,
    });
  });

  it("keeps repeated request evidence across same-logical-owner attempt rearming", async () => {
    const ref = { sessionId: "completed-session", sessionKey: "agent:main:completed" };
    const runId = "completed-run";

    startDiagnosticRunActivityTracking();
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    markDiagnosticModelStartedForTest({
      ...ref,
      runId,
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });

    markDiagnosticEmbeddedRunEnded(ref);
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      activeWorkKind: undefined,
      repeatedRequestNoProgressAgeMs: undefined,
    });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...ref,
      runId,
      durationMs: 1,
      outcome: "completed",
    });
    await waitForDiagnosticEventsDrained();
    markDiagnosticRunProgress({ runId, reason: "stale-completed-attempt" });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      lastProgressReason: "run:attempt_completed",
    });
    markDiagnosticEmbeddedRunStarted({ ...ref, runId });
    markDiagnosticModelStartedForTest({
      ...ref,
      runId,
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });
    expect(getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
      hasActiveEmbeddedRun: true,
    });
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeGreaterThanOrEqual(0);

    markDiagnosticEmbeddedRunEnded(ref);
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeUndefined();

    markDiagnosticEmbeddedRunStarted({ ...ref, runId: "successor-run" });
    markDiagnosticModelStartedForTest({
      ...ref,
      runId: "successor-run",
      provider: "mock",
      model: "request-model",
      observationUnit: "request",
    });
    expect(
      getDiagnosticSessionActivitySnapshot(ref).repeatedRequestNoProgressAgeMs,
    ).toBeUndefined();

    stopDiagnosticRunActivityTracking();
    startDiagnosticRunActivityTracking();
    expect(getDiagnosticSessionActivitySnapshot(ref)).toEqual({});
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
