// Tests session reset cleanup for stale files and persisted state.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../../agents/embedded-agent-runner/session-prompt-state.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  enqueueSystemEventRaw as enqueueSystemEvent,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../../infra/system-events.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import {
  finishFlow,
  listTaskFlowRecords,
  reloadTaskFlowRegistryFromStore,
} from "../../tasks/task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { consumePendingDelegates, enqueuePendingDelegate } from "../continuation/delegate-store.js";
import {
  hasLiveContinuationTimerRefs,
  registerContinuationTimerHandle,
  releaseContinuationTimerRef,
  retainContinuationTimerRef,
} from "../continuation/state.js";
import { consumePendingWork, enqueuePendingWork } from "../continuation/work-store.js";
import { createReplyOperation, replyRunRegistry } from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { clearSessionResetRuntimeState } from "./session-reset-cleanup.js";

afterEach(() => {
  clearEmbeddedSessionPromptStates(["old-session"]);
  replyRunTesting.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  resetSystemEventsForTest();
});

describe("clearSessionResetRuntimeState", () => {
  it("disposes prompt projections with the archived session", () => {
    const state = getEmbeddedSessionPromptState("old-session");
    state.sentUserTurnIds.add("sent-user-turn");

    clearSessionResetRuntimeState(["old-session"], { agentId: "main" });

    expect(getEmbeddedSessionPromptState("old-session")).not.toBe(state);
  });

  it("clears reset queues and drains system events for normalized keys", () => {
    enqueueSystemEvent("stale alpha", { sessionKey: "alpha" });
    enqueueSystemEvent("stale beta", { sessionKey: "beta" });
    enqueueSystemEvent("fresh gamma", { sessionKey: "gamma" });

    const result = clearSessionResetRuntimeState([" alpha ", undefined, " ", "alpha", "beta"], {
      agentId: "main",
    });

    expect(result.keys).toEqual(["alpha", "beta"]);
    expect(result.systemEventsCleared).toBe(2);
    expect(peekSystemEvents("alpha")).toStrictEqual([]);
    expect(peekSystemEvents("beta")).toStrictEqual([]);
    expect(peekSystemEvents("gamma")).toEqual(["fresh gamma"]);
  });

  it("preserves events owned by other agents during an agent-scoped reset", () => {
    enqueueSystemEvent("unowned", { sessionKey: "global" });
    enqueueSystemEvent("alpha", withSystemEventOwner({ sessionKey: "global" }, "alpha"));
    enqueueSystemEvent("beta", withSystemEventOwner({ sessionKey: "global" }, "beta"));

    const result = clearSessionResetRuntimeState(["global"], { agentId: " Alpha " });

    expect(result.systemEventsCleared).toBe(2);
    expect(peekSystemEvents("global")).toEqual(["beta"]);
  });

  it("releases active reply work owned by the archived reset session id", () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(cancel).toHaveBeenCalledWith("restart");
    expect(replyRunRegistry.isActive("agent:main:slack:room:1")).toBe(false);
    const nextOperation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    expect(nextOperation.sessionId).toBe("new-session");
  });

  it("does not clear a fresh active reply under the same key when only the archived id is reset", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "new-session",
      resetTriggered: false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(operation);
  });

  it("does not clear a replacement admitted while the archived run is cancelling", () => {
    let replacement: ReturnType<typeof createReplyOperation> | undefined;
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel() {
        operation.complete();
        replacement = createReplyOperation({
          sessionKey: "agent:main:slack:room:1",
          sessionId: "old-session",
          resetTriggered: false,
        });
        replacement.setPhase("running");
      },
      isStreaming: () => false,
    });
    operation.setPhase("running");

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(replacement).toBeDefined();
    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(replacement);
  });

  it("leaves queued reservations for the archived id so session init can rebind them", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:slack:room:1",
      sessionId: "old-session",
      resetTriggered: false,
    });

    clearSessionResetRuntimeState(["agent:main:slack:room:1", "old-session"], {
      agentId: "main",
      activeReplySessionId: "old-session",
    });

    expect(operation.phase).toBe("queued");
    expect(replyRunRegistry.get("agent:main:slack:room:1")).toBe(operation);
  });

  it("terminalizes only reset-session continuations and keeps them cancelled after restart", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-session-reset-continuation-" },
      async () => {
        vi.useFakeTimers();
        resetTaskFlowRegistryForTests();
        const sessionKey = "agent:main:slack:room:reset";
        const unrelatedSessionKey = "agent:main:slack:room:unrelated";
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const work = enqueuePendingWork({
            sessionKey,
            hop: 1,
            delayMs: 60_000,
            electedAt: Date.now(),
            dueAt: Date.now() + 60_000,
            maxChainLength: 8,
          });
          const delegate = enqueuePendingDelegate(sessionKey, {
            task: "continue after reset",
            delayMs: 60_000,
          });
          const unrelatedWork = enqueuePendingWork({
            sessionKey: unrelatedSessionKey,
            hop: 1,
            delayMs: 60_000,
            electedAt: Date.now(),
            dueAt: Date.now() + 60_000,
            maxChainLength: 8,
          });
          const terminalWork = enqueuePendingWork({
            sessionKey,
            hop: 1,
            delayMs: 0,
            electedAt: Date.now(),
            dueAt: Date.now(),
            maxChainLength: 8,
          });
          if (!work || !delegate || !unrelatedWork || !terminalWork) {
            throw new Error("expected durable continuation rows");
          }
          const terminalized = finishFlow({
            flowId: terminalWork.flowId!,
            expectedRevision: terminalWork.expectedRevision!,
            currentStep: "Already completed",
          });
          expect(terminalized.applied).toBe(true);

          retainContinuationTimerRef(sessionKey);
          timer = setTimeout(() => {}, 60_000);
          registerContinuationTimerHandle(sessionKey, timer);
          expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

          clearSessionResetRuntimeState([sessionKey], { agentId: "main" });
          await vi.advanceTimersByTimeAsync(0);

          const flows = new Map(listTaskFlowRecords().map((flow) => [flow.flowId, flow]));
          expect(flows.get(work.flowId!)?.status).toBe("cancelled");
          expect(flows.get(delegate.flowId!)?.status).toBe("cancelled");
          expect(flows.get(unrelatedWork.flowId!)?.status).toBe("queued");
          expect(flows.get(terminalWork.flowId!)?.status).toBe("succeeded");
          expect(consumePendingWork(sessionKey, { includeRunning: true })).toEqual([]);
          expect(consumePendingDelegates(sessionKey, { includeRunning: true })).toEqual([]);
          expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);

          reloadTaskFlowRegistryFromStore();
          expect(consumePendingWork(sessionKey, { includeRunning: true })).toEqual([]);
          expect(consumePendingDelegates(sessionKey, { includeRunning: true })).toEqual([]);
          expect(
            listTaskFlowRecords().find((flow) => flow.flowId === unrelatedWork.flowId)?.status,
          ).toBe("queued");
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
          releaseContinuationTimerRef(sessionKey);
          resetTaskFlowRegistryForTests();
          vi.useRealTimers();
        }
      },
    );
  });
});
