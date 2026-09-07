import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { prepareEmbeddedAttemptTimeout } from "../../embedded-agent-runner/run/attempt-timeout-prepare.js";
import { createEmbeddedRunLaneController } from "../../embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../../embedded-agent-runner/run/params.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";

const startTurn = vi.hoisted(() => vi.fn());
const deliver = vi.hoisted(() => vi.fn());
const registryRead = vi.hoisted(() => ({
  hasDescendantRunAwaitingSettle: vi.fn(() => false),
  listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
  getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
}));

vi.mock("../../../gateway/server-methods.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));

vi.mock("../../../gateway/agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));

vi.mock("../../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

vi.mock("../registry/subagent-registry-read.js", () => registryRead);
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));
vi.mock("./subagent-announce.js", () => ({ hasUsableSessionEntry: () => true }));
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (...args: unknown[]) => deliver(...args),
  loadRequesterSessionEntry: () => ({
    canonicalKey: "agent:main:main",
    entry: { sessionId: "requester-session" },
  }),
}));

import {
  maybeWakeRequesterAfterAllChildrenSettled,
  type RequesterSettleWakeBatchState,
} from "./subagent-announce.requester-settle-wake.js";

const REQUESTER_KEY = "agent:main:main";
const SESSION_LANE = `session:${REQUESTER_KEY}`;
const GLOBAL_LANE = "subagent-settle-dispatch-proof";

function settledChild(): SubagentRunRecord {
  return {
    runId: "settled-child",
    childSessionKey: "agent:main:subagent:settled-child",
    requesterSessionKey: REQUESTER_KEY,
    requesterDisplayKey: "main",
    requesterAgentId: "main",
    task: "finish child work",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000, outcome: { status: "ok" } },
    expectsCompletionMessage: true,
    completion: { required: true, resultText: "child result", capturedAt: 3_000 },
    delivery: { status: "delivered" },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    },
  };
}

function createContext(): GatewayRequestContext {
  const chatRunState = createChatRunState();
  const methodRegistry = createGatewayMethodRegistry([]);
  const context = Object.assign({} as GatewayRequestContext, {
    trackExecution: trackAsyncWork,
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    chatAbortControllers: new Map(),
    chatRunState,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    getGatewayMethodRegistry: () => methodRegistry,
    logGateway: { error: vi.fn(), warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      getMethodRegistry: () => methodRegistry,
    });
  return context;
}

describe("requester settle dispatch deadline", () => {
  beforeEach(() => {
    resetCommandQueueStateForTest();
    startTurn.mockReset();
    deliver.mockReset();
    registryRead.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
    registryRead.getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    resetCommandQueueStateForTest();
    setSubagentAnnounceDeliveryDepsForTest();
    vi.useRealTimers();
  });

  it("rejects a replaced anchor after requester wake runtime loading", async () => {
    const retired = settledChild();
    const current = structuredClone(retired);
    registryRead.listSubagentRunsForRequester.mockReturnValue([current]);
    deliver.mockResolvedValue({ delivered: true, path: "direct" });
    const transitionBatch = vi.fn();
    const completeBatch = vi.fn();

    await expect(
      maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: REQUESTER_KEY,
        settledEntry: retired,
        transitionBatch,
        completeBatch,
      }),
    ).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(transitionBatch).not.toHaveBeenCalled();
    expect(completeBatch).not.toHaveBeenCalled();
  });

  it("preserves the final attempt when its Gateway closes during runtime loading", async () => {
    const retired = settledChild();
    retired.requesterSettleWake!.attemptCount = 2;
    const pendingState = structuredClone(retired.requesterSettleWake);
    const firstContext = createContext();
    let firstOpen = true;
    bindGatewayContextResolver(retired, () => (firstOpen ? firstContext : undefined));
    registryRead.listSubagentRunsForRequester.mockReturnValue([retired]);
    deliver.mockResolvedValue({ delivered: true, path: "direct" });
    const transitionBatch = vi.fn();
    const completeBatch = vi.fn();
    const loaded = createDeferredCore();
    const pending = loaded.promise.then(() =>
      maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: REQUESTER_KEY,
        settledEntry: retired,
        transitionBatch,
        completeBatch,
      }),
    );
    firstOpen = false;
    loaded.resolve();
    await expect(pending).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(transitionBatch).not.toHaveBeenCalled();
    expect(completeBatch).not.toHaveBeenCalled();
    expect(retired.requesterSettleWake).toEqual(pendingState);

    const replacement = structuredClone(retired);
    const nextContext = createContext();
    bindGatewayContextResolver(replacement, () => nextContext);
    registryRead.listSubagentRunsForRequester.mockReturnValue([replacement]);
    await expect(
      maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: REQUESTER_KEY,
        settledEntry: replacement,
        transitionBatch,
        completeBatch,
      }),
    ).resolves.toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(transitionBatch).toHaveBeenCalledWith(
      [replacement],
      expect.objectContaining({ attemptCount: 3 }),
    );
    expect(completeBatch).toHaveBeenCalledOnce();
  });

  it.each(["bound", "throwing", "incompatible", "unbound"] as const)(
    "replaces a %s batch only after its owner closes",
    async (binding) => {
      const retired = settledChild();
      const sibling = { ...structuredClone(retired), runId: "settled-sibling" };
      const retiredBatch = [retired, sibling];
      const firstContext = createContext();
      const replacementContext = createContext();
      let firstOpen = true;
      if (binding !== "unbound") {
        retiredBatch.forEach((entry, index) =>
          bindGatewayContextResolver(entry, () => {
            if (!firstOpen && binding === "throwing") {
              throw new Error("old Gateway resolver closed");
            }
            return firstOpen
              ? firstContext
              : binding === "incompatible"
                ? index === 0
                  ? firstContext
                  : replacementContext
                : undefined;
          }),
        );
      }
      registryRead.listSubagentRunsForRequester.mockReturnValue(retiredBatch);
      const oldDone = createDeferredCore<{ delivered: true; path: "direct" }>();
      const replacementDone = createDeferredCore<{ delivered: true; path: "direct" }>();
      deliver
        .mockImplementationOnce(async () => await oldDone.promise)
        .mockImplementationOnce(async () => await replacementDone.promise);
      const wake = (entry: SubagentRunRecord) =>
        maybeWakeRequesterAfterAllChildrenSettled({
          requesterSessionKey: REQUESTER_KEY,
          settledEntry: entry,
          transitionBatch: (batch, state) => {
            batch.forEach((member) => {
              member.requesterSettleWake = state;
            });
          },
          completeBatch: (batch) => {
            batch.forEach((member) => {
              member.requesterSettleWake = undefined;
            });
          },
        });
      const oldWake = wake(retired);
      let replacementWake: Promise<boolean> | undefined;
      try {
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        await expect(wake(retired)).resolves.toBe(false);
        const replacementBatch = retiredBatch.map((entry) => structuredClone(entry));
        const replacement = replacementBatch[0]!;
        replacementBatch.forEach((entry) =>
          bindGatewayContextResolver(entry, () => replacementContext),
        );
        registryRead.listSubagentRunsForRequester.mockReturnValue(replacementBatch);
        // A fresh object or another open Gateway is not proof that the prior claim ended.
        await expect(wake(replacement)).resolves.toBe(false);
        expect(deliver).toHaveBeenCalledOnce();

        firstOpen = false;
        if (binding === "unbound") {
          await expect(wake(replacement)).resolves.toBe(false);
          expect(deliver).toHaveBeenCalledOnce();
          oldDone.resolve({ delivered: true, path: "direct" });
          await oldWake;
        }
        replacementWake = wake(replacement);
        void replacementWake.catch(() => {});
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
        expect(deliver.mock.calls[1]?.[0].directIdempotencyKey).toBe(
          deliver.mock.calls[0]?.[0].directIdempotencyKey,
        );
        expect(deliver.mock.calls[1]?.[0].resolveGatewayContext?.()).toBe(replacementContext);
        oldDone.resolve({ delivered: true, path: "direct" });
        await expect(oldWake).resolves.toBe(true);
        await expect(wake(replacement)).resolves.toBe(false);
        expect(deliver).toHaveBeenCalledTimes(2);
        replacementDone.resolve({ delivered: true, path: "direct" });
        await expect(replacementWake).resolves.toBe(true);
      } finally {
        oldDone.resolve({ delivered: true, path: "direct" });
        replacementDone.resolve({ delivered: true, path: "direct" });
        await oldWake;
        await replacementWake;
      }
    },
  );

  it.each(["final", "runtime timeout", "stop"] as const)(
    "keeps an executing completion under requester lifecycle ownership: %s",
    async (outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const context = createContext();
      const child = settledChild();
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      const cfg = {
        agents: { defaults: { timeoutSeconds: 1, subagents: { announceTimeoutMs: 20 } } },
      };
      const executionStarted = createDeferredCore();
      const workDone = createDeferredCore();
      const stop = new AbortController();
      const timeoutMs = resolveAgentTimeoutMs({ cfg });
      const timedOut = vi.fn();
      const completeBatch = vi.fn();
      const finalReceipts: string[] = [];
      let acceptedSignal: AbortSignal | undefined;
      startTurn.mockImplementation(async ({ preflight, io }) => {
        const request = preflight.request as { idempotencyKey: string; sessionKey: string };
        const registration = registerChatAbortController({
          chatAbortControllers: context.chatAbortControllers,
          runId: request.idempotencyKey,
          sessionId: "requester-session",
          sessionKey: request.sessionKey,
          timeoutMs,
          kind: "agent",
        });
        acceptedSignal = registration.controller.signal;
        io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }], {
          runId: request.idempotencyKey,
        });
        try {
          await enqueueCommandInLane(SESSION_LANE, async () => {
            io.emitExecutionStarted?.();
            const timeout = prepareEmbeddedAttemptTimeout({
              attempt: { runId: request.idempotencyKey, sessionId: "requester-session", timeoutMs },
              activeSession: { isCompacting: false, isStreaming: true },
              compactionState: { isCompacting: () => false },
              compactionTimeoutMs: 100,
              runAbortSignal: registration.controller.signal,
              isProbeSession: true,
              abortRun: () => registration.controller.abort(new Error("requester run timed out")),
              markTimedOutDuringCompaction: vi.fn(),
              markTimedOutByRunBudget: timedOut,
            });
            executionStarted.resolve();
            try {
              await waitForGatewayDispatch(
                "synthetic requester work",
                workDone.promise,
                undefined,
                registration.controller.signal,
              );
              finalReceipts.push("consolidated requester final");
            } finally {
              timeout.clearTimers();
            }
          });
          io.emitFinal([
            true,
            { status: "ok", result: { payloads: [{ text: finalReceipts[0] }] } },
          ]);
        } finally {
          registration.cleanup();
        }
      });
      setSubagentAnnounceDeliveryDepsForTest({
        getRuntimeConfig: () => cfg,
        loadRequesterSessionEntry: () => ({
          cfg,
          canonicalKey: REQUESTER_KEY,
          agentId: "main",
          entry: { sessionId: "requester-session", updatedAt: 1 },
        }),
        getRequesterSessionActivity: () => ({ sessionId: "requester-session", isActive: false }),
      });
      deliver.mockImplementation(sendSubagentAnnounceDirectly);
      const wake = withPluginRuntimeGatewayRequestScope(
        {
          context,
          client: createSyntheticPluginRuntimeClient(),
          isWebchatConnect: () => false,
        },
        () =>
          maybeWakeRequesterAfterAllChildrenSettled({
            requesterSessionKey: REQUESTER_KEY,
            settledEntry: child,
            signal: stop.signal,
            transitionBatch: (_batch, state) => {
              child.requesterSettleWake = state;
            },
            completeBatch,
          }),
      );
      try {
        await executionStarted.promise;
        await vi.advanceTimersByTimeAsync(21);
        expect(acceptedSignal?.aborted).toBe(false);
        expect(finalReceipts).toEqual([]);
        expect(completeBatch).not.toHaveBeenCalled();
        if (outcome === "final") {
          workDone.resolve();
        } else if (outcome === "runtime timeout") {
          await vi.advanceTimersByTimeAsync(timeoutMs);
        } else {
          stop.abort(new Error("requester stopped"));
        }
        await expect(wake).resolves.toBe(outcome === "final");
        expect(startTurn).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
        expect(timedOut).toHaveBeenCalledTimes(outcome === "runtime timeout" ? 1 : 0);
        expect(finalReceipts).toEqual(outcome === "final" ? ["consolidated requester final"] : []);
        if (outcome === "final") {
          expect(completeBatch).toHaveBeenCalledWith(
            [child],
            1,
            expect.objectContaining({ delivered: true, requesterVisibleFinalDelivered: true }),
          );
        } else {
          expect(acceptedSignal?.aborted).toBe(true);
          expect(completeBatch).not.toHaveBeenCalled();
          expect(child.requesterSettleWake).toMatchObject({ status: "pending", attemptCount: 1 });
        }
        const later = vi.fn();
        await enqueueCommandInLane(SESSION_LANE, async () => later());
        expect(later).toHaveBeenCalledOnce();
        expect(getCommandLaneSnapshot(SESSION_LANE)).toMatchObject({
          activeCount: 0,
          queuedCount: 0,
        });
        expect(context.chatAbortControllers.size).toBe(0);
        expect(child.execution.outcome).toEqual({ status: "ok" });
        expect(child.completion?.resultText).toBe("child result");
      } finally {
        workDone.resolve();
        stop.abort();
        await wake;
      }
    },
  );

  it("cancels timed-out wake runs before retry and later work enter the requester lane", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const context = createContext();
    const child = settledChild();
    registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
    const executions: string[] = [];
    const acceptedSignals: AbortSignal[] = [];
    let releaseGhost!: () => void;
    const ghostGate = new Promise<void>((resolve) => {
      releaseGhost = resolve;
    });

    startTurn.mockImplementation(async ({ preflight, io }) => {
      const request = preflight.request as { idempotencyKey: string; sessionKey: string };
      const registration = registerChatAbortController({
        chatAbortControllers: context.chatAbortControllers,
        runId: request.idempotencyKey,
        sessionId: "requester-session",
        sessionKey: request.sessionKey,
        timeoutMs: 60_000,
        kind: "agent",
      });
      let lifecycleGeneration = getAgentEventLifecycleGeneration();
      let params = {
        abortSignal: registration.controller.signal,
        lifecycleGeneration,
        prompt: "requester settle wake",
        runId: request.idempotencyKey,
        sessionFile: "/tmp/requester-settle-proof.jsonl",
        sessionId: "requester-session",
        sessionKey: request.sessionKey,
        timeoutMs: 60_000,
        workspaceDir: "/tmp",
      } as RunEmbeddedAgentParams & { sessionFile: string };
      const lane = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => lifecycleGeneration,
        getParams: () => params,
        globalLane: GLOBAL_LANE,
        initialQueuedLifecycleGeneration: lifecycleGeneration,
        sessionLane: SESSION_LANE,
        setLifecycleGeneration: (value) => {
          lifecycleGeneration = value;
        },
        setParams: (value) => {
          params = value;
        },
      });
      acceptedSignals.push(registration.controller.signal);
      io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }], {
        runId: request.idempotencyKey,
      });
      try {
        await lane.enqueueSession(() =>
          lane.enqueueGlobal(async () => {
            executions.push(request.idempotencyKey);
            await ghostGate;
            return { meta: { durationMs: 1 } };
          }),
        );
        io.emitFinal([true, { runId: request.idempotencyKey, status: "ok" }]);
      } finally {
        registration.cleanup();
      }
    });

    deliver.mockImplementation(async (params: { directIdempotencyKey: string }) => {
      try {
        await dispatchGatewayMethodInProcess(
          "agent",
          {
            idempotencyKey: params.directIdempotencyKey,
            message: "all children settled",
            sessionKey: REQUESTER_KEY,
          },
          {
            cancelOnDeadline: true,
            expectFinal: true,
            forceSyntheticClient: true,
            timeoutMs: 20,
          },
        );
        return { delivered: true, path: "direct" };
      } catch (error) {
        return {
          delivered: false,
          path: "direct",
          disposition: "retryable",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    let releaseBlocker!: () => void;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = enqueueCommandInLane(SESSION_LANE, async () => await blockerGate);
    await vi.advanceTimersByTimeAsync(0);
    expect(getCommandLaneSnapshot(SESSION_LANE)).toMatchObject({ activeCount: 1 });

    const transitionBatch = (
      _batch: readonly SubagentRunRecord[],
      state: RequesterSettleWakeBatchState,
    ) => {
      child.requesterSettleWake = state;
    };
    const wake = () =>
      withPluginRuntimeGatewayRequestScope(
        {
          context,
          client: createSyntheticPluginRuntimeClient(),
          isWebchatConnect: () => false,
        },
        () =>
          maybeWakeRequesterAfterAllChildrenSettled({
            requesterSessionKey: REQUESTER_KEY,
            settledEntry: child,
            transitionBatch,
            completeBatch: () => {},
          }),
      );

    let later: Promise<void> | undefined;
    try {
      const firstWake = wake();
      await vi.advanceTimersByTimeAsync(20);
      await expect(firstWake).resolves.toBe(false);
      expect(child.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 1,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      const replay = wake();
      await vi.advanceTimersByTimeAsync(20);
      await expect(replay).resolves.toBe(false);

      const deadlineCancelled = acceptedSignals.map((signal) => signal.aborted);
      releaseBlocker();
      await blocker;
      await vi.advanceTimersByTimeAsync(0);

      let laterRan = false;
      later = enqueueCommandInLane(SESSION_LANE, async () => {
        laterRan = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      const afterLaterDispatch = getCommandLaneSnapshot(SESSION_LANE);

      expect({
        afterLaterDispatch: {
          activeCount: afterLaterDispatch.activeCount,
          queuedCount: afterLaterDispatch.queuedCount,
        },
        deadlineCancelled,
        executions,
        laterRan,
      }).toEqual({
        afterLaterDispatch: { activeCount: 0, queuedCount: 0 },
        deadlineCancelled: [true, true],
        executions: [],
        laterRan: true,
      });
    } finally {
      releaseBlocker();
      releaseGhost();
      await Promise.allSettled([blocker, later]);
    }
  });
});
