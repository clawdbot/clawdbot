import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunEvidenceStale,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { startDiagnosticHeartbeat } from "../../logging/diagnostic.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.test-support.js";
import {
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { resolveActiveEmbeddedRunRecoveryBlocker } from "./run-state.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

const sessionId = "runtime-liveness-session";
const sessionKey = "agent:main:runtime-liveness";
const runId = "runtime-liveness-run";
let admission: PreparedAgentRunAdmission;
let operation: ReplyOperation;
let handle: EmbeddedAgentQueueHandle;
let runtimeOwnsLiveness: boolean;
const abort = vi.fn();
const queueMessage = vi.fn(async () => {});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-08-20T12:00:00Z"));
  setDiagnosticsEnabledForProcess(true);
  runtimeOwnsLiveness = true;
  admission = prepareSystemAgentRunAdmission({}, runId, "main", "runtime-liveness-test");
  const admitted = await admission.admit("embedded");
  operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
  abort.mockReset().mockImplementation(() => {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    operation.complete();
  });
  queueMessage.mockClear();
  const backend = {
    kind: "embedded" as const,
    runId,
    queueMessage,
    isStreaming: () => true,
    isCompacting: () => false,
    ownsLiveness: () => runtimeOwnsLiveness,
    abort,
    cancel: abort,
  };
  handle = backend;
  operation.attachBackend(backend);
  operation.setPhase("running");
  await withGatewayToolCallerIdentity(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey,
    }),
    () => setActiveEmbeddedRun(sessionId, handle, sessionKey),
  );
});

afterEach(() => {
  resetDiagnosticStateForTest();
  admission.close();
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runtime-owned embedded liveness", () => {
  it("preserves steering and the exact reply owner past the stale takeover window", async () => {
    await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 1);

    expect(isReplyRunEvidenceStale(operation)).toBe(false);
    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "continue"),
    ).resolves.toMatchObject({
      queued: true,
      target: "embedded_run",
    });
    expect(queueMessage).toHaveBeenCalledOnce();
    await expect(
      recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: RUN_STALE_TAKEOVER_MS + 1,
        queueDepth: 1,
        allowActiveAbort: true,
      }),
    ).resolves.toMatchObject({ status: "skipped", reason: "runtime_owned_wait" });
    expect(abort).not.toHaveBeenCalled();
  });

  it("reports a quiet runtime wait as long-running without scheduling an abort", async () => {
    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    const recover = vi.fn(recoverStuckDiagnosticSession);
    try {
      startDiagnosticHeartbeat(
        { diagnostics: { enabled: true } },
        { recoverStuckSession: recover },
      );
      await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 60_000);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.long_running",
          reason: "runtime_owned_wait",
          sessionId,
        }),
      );
      expect(recover).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();

      runtimeOwnsLiveness = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recover).toHaveBeenCalled();
      expect(abort).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("waits in bounded slices, then reclaims host-owned work without a millisecond spin", async () => {
    await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 1);
    const waitForIdle = vi.spyOn(replyRunRegistry, "waitForIdle");
    const callerAbort = new AbortController();
    let settled = false;
    const waiting = admitReplyTurn({
      sessionId,
      sessionKey,
      kind: "visible",
      resetTriggered: false,
      upstreamAbortSignal: callerAbort.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.advanceTimersByTimeAsync(2 * REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(abort).not.toHaveBeenCalled();
      expect(waitForIdle.mock.calls.length).toBeGreaterThan(0);
      expect(
        waitForIdle.mock.calls.every(
          ([, timeoutMs]) => timeoutMs === REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
        ),
      ).toBe(true);

      runtimeOwnsLiveness = false;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      const result = await waiting;
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
      expect(result.status).toBe("owned");
    } finally {
      callerAbort.abort();
      const result = await waiting;
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  });

  it.each([
    "host-work",
    "aborted",
    "stopped",
    "closed",
    "ownerless",
    "restart",
    "probe-error",
  ] as const)("does not protect %s work", (state) => {
    switch (state) {
      case "host-work":
        runtimeOwnsLiveness = false;
        break;
      case "aborted":
        handle.isAborted = () => true;
        break;
      case "stopped":
        handle.isStopped = () => true;
        break;
      case "closed":
        admission.close();
        break;
      case "ownerless":
        setActiveEmbeddedRun(sessionId, { ...handle }, sessionKey);
        break;
      case "restart":
        rotateAgentEventLifecycleGeneration();
        break;
      case "probe-error":
        handle.ownsLiveness = () => {
          throw new Error("runtime probe failed");
        };
        break;
    }
    expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
  });

  it("rechecks ownership after a runtime probe synchronously replaces the handle", async () => {
    handle.ownsLiveness = () => {
      setActiveEmbeddedRun(sessionId, { ...handle, ownsLiveness: undefined }, sessionKey);
      return true;
    };
    await vi.advanceTimersByTimeAsync(RUN_STALE_TAKEOVER_MS + 1);
    await expect(
      queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "continue"),
    ).resolves.toMatchObject({
      queued: false,
      reason: "no_active_run",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("does not let a successful probe resurrect closed admission", () => {
    handle.ownsLiveness = () => {
      admission.close();
      return true;
    };
    expect(resolveActiveEmbeddedRunRecoveryBlocker(sessionId)).toBeUndefined();
  });
});
