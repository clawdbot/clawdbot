import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDeliveryState } from "../../../config/sessions/types.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
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
let releaseAgentCallGate: (() => void) | undefined;
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
    return {
      result: {
        payloads: [{ text: "completion delivered" }],
        deliveryStatus: { status: "sent", resultCount: 1 },
      },
    };
  }
  return {};
});

const loadConfigMock = vi.fn(() => ({
  agents: {
    defaults: { subagents: { archiveAfterMinutes: 0 } },
    list: [{ id: "main" }, { id: "research" }],
  },
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
    loadConfigMock.mockReset().mockReturnValue({
      agents: {
        defaults: { subagents: { archiveAfterMinutes: 0 } },
        list: [{ id: "main" }, { id: "research" }],
      },
      session: { mainKey: "main", scope: "per-sender" },
    });
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

  afterEach(async () => {
    // Failed assertions must also release the delivery owned by this test.
    releaseAgentCallGate?.();
    releaseAgentCallGate = undefined;
    await vi.advanceTimersByTimeAsync(0);
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

  const waitForDeliveredCleanup = async (
    runId: string,
    options?: { allowPendingRequesterSettleWake?: boolean },
  ) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = registry.getSubagentRunByRunId(runId);
      if (
        run?.delivery?.status === "delivered" &&
        typeof run.cleanupCompletedAt === "number" &&
        (options?.allowPendingRequesterSettleWake === true || run.requesterSettleWake === undefined)
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

  it.each(
    ["alpha", "beta"].flatMap((firstCompleted) =>
      ["same", "distinct", "mixed-unbound", "yielded"].map((mode) => ({
        firstCompleted,
        binding: mode === "yielded" ? "same" : mode,
        yieldedParent: mode === "yielded" ? "alpha" : undefined,
      })),
    ),
  )(
    "settles overlapping caller turns with $firstCompleted first ($binding ownership, yielded=$yieldedParent)",
    async ({ firstCompleted, binding, yieldedParent }) => {
      vi.setSystemTime(100_000);
      const context = {} as GatewayRequestContext;
      context.resolveGatewayContext = () => context;
      const otherContext = {} as GatewayRequestContext;
      otherContext.resolveGatewayContext = () => otherContext;
      registry.initSubagentRegistry();
      const activate = () => {
        // Standalone registration can be wholly unbound, but cannot mix ambient
        // routing with a captured owner. Restored rows have a separate activation gate.
        if (binding !== "mixed-unbound") {
          registry.activateSubagentRegistry(() => context);
        }
      };
      activate();
      const children = ["alpha", "beta"].map((name) => ({
        name,
        runId: `run-${name}`,
        childSessionKey: `agent:main:subagent:${name}`,
      }));
      const resolvers: Array<GatewayRequestContext["resolveGatewayContext"]> = [];
      for (const child of children) {
        const requesterTurnRunId = `requester-${child.name}`;
        const admission = prepareSystemAgentRunAdmission(
          {},
          requesterTurnRunId,
          "main",
          "requester-wake-test",
        );
        try {
          const admitted = await admission.admit("embedded");
          bindGatewayContextResolver(
            admitted,
            binding !== "same" && child.name === "beta"
              ? binding === "distinct"
                ? otherContext.resolveGatewayContext
                : undefined
              : context.resolveGatewayContext,
          );
          await withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: MAIN_REQUESTER_SESSION_KEY,
            }),
            () => {
              const gatewayContextResolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
              resolvers.push(gatewayContextResolver);
              registry.registerSubagentRun(
                createSubagentRunParams({
                  ...child,
                  requesterTurnRunId,
                  requesterAgentId: "main",
                  expectsCompletionMessage: true,
                  gatewayContextResolver,
                }),
              );
            },
          );
          if (child.name === yieldedParent) {
            await createSessionsYieldTool({
              sessionId: "sess-main",
              claimYield: () =>
                registry.markRequesterTurnYielded({
                  requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
                  requesterAgentId: "main",
                  requesterTurnRunId,
                }) > 0,
              onYield: () => {},
            }).execute(`yield-${child.name}`, {});
          }
          registry.settleRequesterAfterSessionSpawns({
            requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
            requesterAgentId: "main",
            requesterTurnRunId,
            requesterYielded: child.name === yieldedParent,
            acceptedSessionSpawns: [child],
          });
        } finally {
          admission.close();
        }
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(resolvers[0]).not.toBe(resolvers[1]);
      expect(resolvers[0]?.()).toBe(context);
      expect(resolvers[1]?.()).toBe(
        binding === "same" ? context : binding === "distinct" ? otherContext : undefined,
      );
      const completionOrder = firstCompleted === "alpha" ? children : children.toReversed();
      const first = completionOrder[0]!;
      const second = completionOrder[1]!;
      emitCompleted(first.runId, first.childSessionKey, `${first.name} complete`);
      if (first.name === yieldedParent) {
        // Yielded completion stays owned by its frozen wake until every child settles.
        await vi.waitFor(() =>
          expect(registry.getSubagentRunByRunId(first.runId)).toMatchObject({
            execution: { status: "terminal" },
            cleanupCompletedAt: expect.any(Number),
            requesterSettleWake: { rearmGeneration: 1 },
          }),
        );
      } else {
        await waitForDeliveredCleanup(first.runId, { allowPendingRequesterSettleWake: true });
      }
      expect(getRequesterWakeCalls()).toHaveLength(0);
      activate();
      activate();
      children.forEach((child, index) => {
        const row = registry.getSubagentRunByRunId(child.runId)!;
        expect(getGatewayContextResolver(row)).toBe(resolvers[index]);
        expect(row.requesterTurnRunId).toBeUndefined();
      });
      emitCompleted(second.runId, second.childSessionKey, `${second.name} complete`);
      await waitForDeliveredCleanup(second.runId, { allowPendingRequesterSettleWake: true });
      activate();
      await registry.testing.sweepOnceForTests();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(getRequesterWakeCalls()).toHaveLength(binding === "same" ? 1 : 0);
      for (const child of children) {
        expect(registry.getSubagentRunByRunId(child.runId)).toMatchObject({
          delivery: { status: "delivered" },
          requesterSettleWake: undefined,
        });
      }
    },
  );

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

    agentCallGates.set(
      beta.childSessionKey,
      new Promise<void>((resolve) => {
        releaseAgentCallGate = resolve;
      }),
    );
    emitCompleted(alpha.runId, alpha.childSessionKey, "alpha complete");
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup(alpha.runId, { allowPendingRequesterSettleWake: true });
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
    await waitForAgentCallCount(rejectRequesterWake ? 2 : 3);
    await waitForDeliveredCleanup(alpha.runId);
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
    releaseAgentCallGate?.();
    await waitForDeliveredCleanup(alpha.runId);
    await waitForDeliveredCleanup(beta.runId);
    await registry.testing.sweepOnceForTests();
    expect(getRequesterWakeCalls()).toHaveLength(rejectRequesterWake ? 0 : 1);
  });

  it("caps a stale requester batch despite foreign active work in a global session", async () => {
    vi.setSystemTime(100_000);
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: { subagents: { archiveAfterMinutes: 0 } },
        list: [{ id: "main" }, { id: "research" }],
      },
      session: { mainKey: "main", scope: "global" },
    });
    registry.addSubagentRunForTests({
      runId: "run-main-batch",
      childSessionKey: "agent:main:subagent:batch",
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "main completed batch",
      cleanup: "keep",
      createdAt: 1_000,
      execution: { status: "terminal", startedAt: 1_100, endedAt: 1_200 },
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-main-batch"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
        deferralCount: 8,
      },
    });
    registry.addSubagentRunForTests({
      runId: "run-main-stale",
      childSessionKey: "agent:main:subagent:stale",
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      requesterAgentId: "main",
      task: "main stale settle blocker",
      cleanup: "keep",
      createdAt: 2_000,
      execution: { status: "terminal", startedAt: 2_100, endedAt: 2_200 },
      expectsCompletionMessage: true,
      delivery: { status: "pending" },
    });
    registry.addSubagentRunForTests({
      runId: "run-research-active",
      childSessionKey: "agent:research:subagent:active",
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: "main",
      requesterAgentId: "research",
      task: "unrelated research work",
      cleanup: "keep",
      createdAt: 3_000,
      execution: { status: "running", startedAt: 3_100 },
    });

    const batch = registry.getSubagentRunByRunId("run-main-batch");
    if (!batch) {
      throw new Error("expected main requester batch");
    }
    const transitions: Array<{ deferralCount?: number; nextAttemptAt?: number }> = [];
    const completions: Array<{ delivered: boolean; error?: string }> = [];
    const runWake = () =>
      maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        settledEntry: batch,
        transitionBatch: (_runIds, state) => {
          transitions.push({
            deferralCount: state.deferralCount,
            nextAttemptAt: state.nextAttemptAt,
          });
          batch.requesterSettleWake = { ...state };
        },
        completeBatch: (_runIds, _rearmGeneration, outcome) => {
          if (outcome) {
            completions.push({ delivered: outcome.delivered, error: outcome.error });
          }
          batch.requesterSettleWake = undefined;
        },
      });

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toEqual([{ deferralCount: 9, nextAttemptAt: 130_000 }]);
    expect(completions).toEqual([]);

    await expect(runWake()).resolves.toBe(false);
    expect(transitions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(runWake()).resolves.toBe(false);
    expect(completions).toEqual([
      {
        delivered: false,
        error: "requester settle wake deferred too many times",
      },
    ]);
    expect(batch.requesterSettleWake).toBeUndefined();
    expect(registry.countActiveDescendantRuns(MAIN_REQUESTER_SESSION_KEY)).toBe(1);
    expect(registry.countActiveDescendantRuns(MAIN_REQUESTER_SESSION_KEY, "main")).toBe(0);
  });
});
