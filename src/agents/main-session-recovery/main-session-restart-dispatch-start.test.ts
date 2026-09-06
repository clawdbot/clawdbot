import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentTurnIo } from "../../gateway/agent-turn/types.js";
import {
  registerChatAbortController,
  resolveAgentRunExpiresAtMs,
} from "../../gateway/chat-abort.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { getCommandLaneSnapshot, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createEmbeddedRunLaneController } from "../embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../embedded-agent-runner/run/params.js";
import { dispatchRestartRecoveryUntilStarted } from "./main-session-restart-dispatch-start.js";

const sessionKey = "agent:main:recovery-capacity";
const sessionId = "recovery-session";
const runId = "recovery-run";
const sessionLane = `session:${sessionKey}`;
const globalLane = "recovery-capacity-global";
const startTurn = vi.hoisted(() => vi.fn<(params: { io: AgentTurnIo }) => Promise<void>>());

vi.mock("../../gateway/server-methods.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
vi.mock("../../gateway/agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
vi.mock("../../gateway/agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

beforeEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  startTurn.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  resetAgentEventsForTest();
  resetCommandQueueStateForTest();
  vi.useRealTimers();
});

describe("restart recovery startup ownership", () => {
  it.each([
    "session queue",
    "global queue",
    "cached queue",
    "runtime preparation",
    "expired startup",
  ] as const)("uses the registered startup owner during %s", async (stage) => {
    const context = createDirectChatContext({ trackExecution: trackAsyncWork });
    const runtime = createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => createGatewayMethodRegistry([]),
      isDispatchAvailable: () => true,
    });
    const preparation = createDeferred();
    const registered = createDeferred();
    const finish = createDeferred();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const timeoutMs = 60_000;
    const registration = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      agentId: "main",
      sessionId,
      sessionKey,
      lifecycleGeneration,
      kind: "agent",
      timeoutMs,
      expiresAtMs: resolveAgentRunExpiresAtMs({ now: Date.now(), timeoutMs }),
    });
    registerAgentRunContext(runId, { sessionKey, sessionId, lifecycleGeneration });
    let params: RunEmbeddedAgentParams & { sessionFile: string } = {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      runId,
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
      lifecycleGeneration,
      abortSignal: registration.controller.signal,
      prompt: "continue after restart",
      timeoutMs,
      trigger: "user",
      inputProvenance: {
        kind: "internal_system",
        sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
      },
      workspaceDir: "/tmp",
    };
    const lanes = createEmbeddedRunLaneController({
      getLifecycleGeneration: () => lifecycleGeneration,
      getParams: () => params,
      globalLane,
      initialQueuedLifecycleGeneration: lifecycleGeneration,
      sessionLane,
      setLifecycleGeneration: () => {},
      setParams: (next) => {
        params = next;
      },
    });
    const blockedLane =
      stage === "session queue"
        ? sessionLane
        : stage === "global queue" || stage === "cached queue"
          ? globalLane
          : undefined;
    if (blockedLane) {
      setCommandLaneConcurrency(blockedLane, 0);
    }
    let execution: Promise<void> | undefined;
    startTurn.mockImplementation(({ io }) => {
      execution = (async () => {
        if (!registration.registered) {
          throw new Error("expected a registered recovery owner");
        }
        if (stage !== "cached queue") {
          io.emitStartOwner?.(runId, registration.entry);
        }
        registered.resolve();
        if (stage === "runtime preparation" || stage === "expired startup") {
          await preparation.promise;
          registration.controller.signal.throwIfAborted();
        }
        io.emitAcceptance(
          [true, { runId, status: stage === "cached queue" ? "in_flight" : "accepted" }, undefined],
          { runId, ...(stage === "cached queue" ? { cached: true } : {}) },
        );
        await lanes.enqueueSession(() =>
          lanes.enqueueGlobal(async () => {
            registration.markExecutionStarted();
            if (stage !== "cached queue") {
              io.emitExecutionStarted?.();
            }
            await finish.promise;
            return { meta: { durationMs: 0 } };
          }),
        );
        io.emitFinal([true, { runId, status: "ok" }, undefined], { runId });
      })();
      return execution;
    });
    const recovery = dispatchRestartRecoveryUntilStarted({
      agentParams: {
        agentId: "main",
        expectedExistingSessionId: sessionId,
        idempotencyKey: runId,
        message: "continue after restart",
        sessionKey,
      },
      gatewayRuntime: runtime.recovery,
    });
    try {
      await registered.promise;
      await vi.advanceTimersByTimeAsync(0);
      if (blockedLane) {
        expect(getCommandLaneSnapshot(blockedLane).queuedCount).toBe(1);
      }
      if (stage === "expired startup") {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(registration.controller.signal.aborted).toBe(true);
        await expect(recovery).resolves.toMatchObject({
          kind: "failed",
          observation: { executionStarted: false, preStartAbortConfirmed: true },
        });
        return;
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(registration.controller.signal.aborted).toBe(false);
      preparation.resolve();
      if (blockedLane) {
        setCommandLaneConcurrency(blockedLane, 1);
      }
      if (stage === "cached queue") {
        await vi.advanceTimersByTimeAsync(10_000);
      }
      await expect(recovery).resolves.toMatchObject({
        kind: "started",
        observation: { dispatchAccepted: true, executionStarted: true },
      });
    } finally {
      preparation.resolve();
      finish.resolve();
      if (blockedLane) {
        setCommandLaneConcurrency(blockedLane, 1);
      }
      await execution?.catch(() => {});
      await recovery;
      registration.cleanup();
      runtime.close();
    }
  });
});
