import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDeliveryState } from "../../../config/sessions/types.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import { testing as subagentAnnounceTesting } from "../announce/subagent-announce.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import * as registry from "./subagent-registry.test-helpers.js";

const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";

type LifecycleData = {
  phase?: string;
  endedAt?: number;
  terminalReply?: AgentRunTerminalReplySnapshot;
};
type LifecycleEvent = Pick<AgentEventPayload, "runId"> &
  Partial<Omit<AgentEventPayload, "runId" | "data">> & { data?: LifecycleData };
type SessionStoreEntry = {
  sessionId: string;
  updatedAt: number;
  delivery?: SessionDeliveryState;
};
type GatewayRequest = Omit<CallGatewayOptions, "params"> & {
  params?: {
    sessionKey?: string;
    inputProvenance?: { sourceSessionKey?: string };
    idempotencyKey?: string;
    message?: string;
  };
};

let lifecycleHandler: ((event: LifecycleEvent) => void) | undefined;
let agentCallGates = new Map<string, Promise<void>>();
let chatHistoryBySessionKey = new Map<string, Array<Record<string, unknown>>>();
let sessionStore: Record<string, SessionStoreEntry> = {};
let rejectNextRequesterWake = false;

const callGatewayMock = vi.fn(async (request: GatewayRequest) => {
  if (request.method === "agent.wait") {
    return { status: "pending" };
  }
  if (request.method === "chat.history") {
    return { messages: chatHistoryBySessionKey.get(request.params?.sessionKey ?? "") ?? [] };
  }
  if (request.method === "agent") {
    const sourceSessionKey = request.params?.inputProvenance?.sourceSessionKey;
    const gate = sourceSessionKey ? agentCallGates.get(sourceSessionKey) : undefined;
    if (gate) {
      await gate;
    }
    return { result: { payloads: [{ text: "completion delivered" }] } };
  }
  return {};
});

const loadConfigMock = vi.fn(() => ({
  agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  session: { mainKey: "main", scope: "per-sender" },
}));

vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveSessionStorePathCore: () => "/tmp/test-store",
  resolveMainSessionKey: () => MAIN_REQUESTER_SESSION_KEY,
  updateSessionStore: vi.fn(),
}));

vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  loadSessionEntry: (scope: { sessionKey: string }) => sessionStore[scope.sessionKey],
  listSessionEntriesReadOnly: () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

const loadSubagentRegistryRuntimeForTest = async () =>
  ({
    replaceSubagentRunAfterSteer: registry.replaceSubagentRunAfterSteerCore,
  }) as unknown as typeof import("./subagent-registry-runtime.js");

describe("requester settle wake product flow", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    vi.useFakeTimers();
    callGatewayMock.mockClear();
    agentCallGates = new Map();
    chatHistoryBySessionKey = new Map();
    rejectNextRequesterWake = false;
    sessionStore = {
      [MAIN_REQUESTER_SESSION_KEY]: {
        sessionId: "sess-main",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "discord", accountId: "default", target: { to: "user-1" } },
          context: { channel: "discord", to: "user-1", accountId: "default" },
          origin: { provider: "discord", to: "user-1", accountId: "default" },
        },
      },
    };
    registry.testing.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      onAgentEvent: ((handler: typeof lifecycleHandler) => {
        lifecycleHandler = handler;
        return () => {};
      }) as unknown as typeof import("../../../infra/agent-events.js").onAgentEvent,
      persistSubagentRunsToDisk: () => {},
      persistSubagentRunsToDiskOrThrow: () => {},
      restoreSubagentRunsFromDisk: () => 0,
      maybeWakeRequesterAfterAllChildrenSettled: async (params) => {
        if (rejectNextRequesterWake) {
          rejectNextRequesterWake = false;
          throw new Error("requester wake rejected before attempt admission");
        }
        return await maybeWakeRequesterAfterAllChildrenSettled(params);
      },
    });
    subagentAnnounceTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      loadSubagentRegistryRuntime: loadSubagentRegistryRuntimeForTest,
    });
    subagentAnnounceDeliveryTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      loadSessionEntry: ({ sessionKey }) => sessionStore[sessionKey],
      getRequesterSessionActivity: (requesterSessionKey: string) => ({
        sessionId: sessionStore[requesterSessionKey]?.sessionId,
        isActive: false,
      }),
    });
    subagentAnnounceOutputTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
      resolveAgentIdFromSessionKey: (key) => key?.match(/^agent:([^:]+)/)?.[1] ?? "main",
      resolveSessionStorePathCore: () => "/tmp/test-store",
    });
  });

  afterEach(() => {
    lifecycleHandler = undefined;
    subagentAnnounceDeliveryTesting.setDepsForTest();
    subagentAnnounceOutputTesting.setDepsForTest();
    subagentAnnounceTesting.setDepsForTest();
    registry.testing.setDepsForTest();
    registry.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    if (previousFastTestEnv === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
    }
  });

  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const getAgentCalls = () =>
    (callGatewayMock.mock.calls as [GatewayRequest][])
      .map(([request]) => request)
      .filter((request) => request.method === "agent");

  const getRequesterWakeCalls = () =>
    getAgentCalls().filter((request) =>
      request.params?.idempotencyKey?.startsWith("announce:requester-settle:"),
    );

  const waitForAgentCallCount = async (expectedCount: number) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (getAgentCalls().length >= expectedCount) {
        return;
      }
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync();
    }
    throw new Error(`expected ${expectedCount} agent calls, got ${getAgentCalls().length}`);
  };

  const waitForDeliveredCleanup = async (runId: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = registry.getSubagentRunByRunId(runId);
      if (
        run?.delivery?.status === "delivered" &&
        typeof run.cleanupCompletedAt === "number" &&
        run.requesterSettleWake === undefined
      ) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} did not finish delivered cleanup`);
  };

  const spawnVisibleChild = async (params: {
    runId: string;
    childSessionKey: string;
    requesterTurnRunId: string;
  }) => {
    const result = await maybeSpawnVisibleSession({
      raw: { visible: true },
      task: `finish ${params.runId}`,
      label: params.runId,
      runtime: "subagent",
      sandbox: "inherit",
      expectsCompletionMessage: true,
      options: {
        agentSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId: params.requesterTurnRunId,
        requesterAgentIdOverride: "main",
        config: {
          agents: { list: [{ id: "main" }] },
          session: { mainKey: "main", scope: "per-sender" },
        },
        callGateway: vi.fn(async () => ({
          key: params.childSessionKey,
          runStarted: true,
          runId: params.runId,
        })) as never,
        registerRun: registry.registerSubagentRun,
        countActiveRuns: () => 0,
      },
    });
    expect(result).toMatchObject({ status: "accepted", runId: params.runId });
  };

  const emitCompleted = (
    runId: string,
    childSessionKey: string,
    text: string,
    modelRouteChange?: string,
  ) => {
    chatHistoryBySessionKey.set(childSessionKey, [{ role: "assistant", content: text }]);
    lifecycleHandler?.({
      stream: "lifecycle",
      runId,
      sessionKey: childSessionKey,
      data: {
        phase: "end",
        endedAt: Date.now(),
        terminalReply: {
          disposition: "visible",
          text,
          ...(modelRouteChange ? { modelRouteChange } : {}),
        },
      },
    });
  };

  it.each([
    { name: "delivers the visible requester final", rejectRequesterWake: false },
    { name: "settles the rejected delivered-row wake", rejectRequesterWake: true },
  ])("$name", async ({ rejectRequesterWake }) => {
    const requesterTurnRunId = "run-requester-yield";
    const alpha = {
      runId: "run-alpha",
      childSessionKey: "agent:main:subagent:alpha",
      expectsCompletionMessage: true,
    };
    const beta = {
      runId: "run-beta",
      childSessionKey: "agent:main:subagent:beta",
      expectsCompletionMessage: true,
    };
    await spawnVisibleChild({ ...alpha, requesterTurnRunId });
    await spawnVisibleChild({ ...beta, requesterTurnRunId });

    let releaseBetaDelivery: (() => void) | undefined;
    agentCallGates.set(
      beta.childSessionKey,
      new Promise<void>((resolve) => {
        releaseBetaDelivery = resolve;
      }),
    );
    emitCompleted(alpha.runId, alpha.childSessionKey, "alpha complete");
    await waitForAgentCallCount(1);
    const modelRouteChange = "Model route changed: requested/model → actual/model.";
    emitCompleted(beta.runId, beta.childSessionKey, "beta complete", modelRouteChange);
    await waitForAgentCallCount(2);

    const betaBeforeYield = registry.getSubagentRunByRunId(beta.runId);
    if (!betaBeforeYield) {
      throw new Error("expected beta run before requester yield");
    }
    betaBeforeYield.delivery = rejectRequesterWake
      ? {
          ...betaBeforeYield.delivery,
          status: "delivered",
          disposition: "delivered",
          deliveredAt: Date.now(),
        }
      : { ...betaBeforeYield.delivery, status: "in_progress" };

    const yieldTool = createSessionsYieldTool({
      sessionId: "sess-main",
      claimYield: () =>
        registry.markRequesterTurnYielded({
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
          requesterAgentId: "main",
          requesterTurnRunId,
        }) > 0,
      onYield: () => {},
    });
    await expect(
      yieldTool.execute("yield-requester-wake", { message: "Wait for visible children" }),
    ).resolves.toMatchObject({ details: { status: "yielded" } });

    rejectNextRequesterWake = rejectRequesterWake;
    const { withLocalSessionPlacementTurnSettlement } =
      await import("../../session-placement-admission.js");
    await withLocalSessionPlacementTurnSettlement(
      {
        sessionId: "sess-main",
        sessionKey: MAIN_REQUESTER_SESSION_KEY,
        agentId: "main",
        runId: requesterTurnRunId,
      },
      async () => ({
        acceptedSessionSpawns: [alpha, beta],
        meta: {
          durationMs: 1,
          yielded: true,
          executionTrace: { runner: "cli", attempts: [], fallbackUsed: false },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await flushAsync();

    await waitForAgentCallCount(rejectRequesterWake ? 2 : 3);
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
    if (!rejectRequesterWake) {
      const wakeMessage = getRequesterWakeCalls()[0]?.params?.message;
      expect(wakeMessage).toContain(modelRouteChange);
      expect(wakeMessage).toContain(
        "Keep this runtime-authored model-route change notice internal on this shared surface.",
      );
    }
    for (const child of [alpha, beta]) {
      expect(registry.getSubagentRunByRunId(child.runId)).toMatchObject({
        delivery: { status: "delivered" },
        requesterSettleWake: undefined,
      });
    }

    agentCallGates.delete(beta.childSessionKey);
    releaseBetaDelivery?.();
    await waitForDeliveredCleanup(alpha.runId);
    await waitForDeliveredCleanup(beta.runId);
    await registry.testing.sweepOnceForTests();
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
  });
});
