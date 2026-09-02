import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import { createEmbeddedRunLaneController } from "../../embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../../embedded-agent-runner/run/params.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

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
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
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
    vi.useRealTimers();
  });

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

    const transitionBatch = (_runIds: readonly string[], state: RequesterSettleWakeBatchState) => {
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
