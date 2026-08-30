// Lifecycle retry-grace e2e tests cover completion delivery retry behavior when
// lifecycle events race gateway waits or transient announce failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDeliveryState } from "../../../config/sessions/types.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { createSessionsYieldTool } from "../../tools/sessions-yield-tool.js";
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import { testing as subagentAnnounceTesting } from "../announce/subagent-announce.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  hasDescendantRunAwaitingSettle,
  listAncestorSessionKeys,
} from "./subagent-registry-read.js";
import * as mod from "./subagent-registry.test-helpers.js";

const noop = () => {};
const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";
const MAIN_REQUESTER_DISPLAY_KEY = "main";

type LifecycleData = {
  phase?: string;
  startedAt?: number;
  endedAt?: number;
  aborted?: boolean;
  error?: string;
  stopReason?: string;
  terminalReply?: AgentRunTerminalReplySnapshot;
  status?: string;
  timeoutPhase?: string;
  providerStarted?: boolean;
};
type LifecycleEvent = {
  stream?: string;
  runId: string;
  sessionKey?: string;
  data?: LifecycleData;
};

type SessionStoreEntry = {
  sessionId: string;
  updatedAt: number;
  delivery?: SessionDeliveryState;
};

type GatewayRequest = {
  method?: string;
  params?: {
    sessionKey?: string;
    inputProvenance?: { sourceSessionKey?: string };
    internalEvents?: Array<{ status?: string; statusLabel?: string; result?: string }>;
  };
  timeoutMs?: number;
  expectFinal?: boolean;
};

let lifecycleHandler: ((evt: LifecycleEvent) => void) | undefined;
let agentCallPlan: Array<"ok" | "throw"> = [];
let agentCallGates = new Map<string, Promise<void>>();
let chatHistoryBySessionKey = new Map<string, Array<Record<string, unknown>>>();
let sessionStore: Record<string, SessionStoreEntry> = {};

const callGatewayMock = vi.fn(async (request: GatewayRequest) => {
  const method = request.method;
  if (method === "agent.wait") {
    // Keep wait unresolved from the RPC path so lifecycle fallback logic is exercised.
    return { status: "pending" };
  }
  if (method === "chat.history") {
    const sessionKey =
      typeof request.params?.sessionKey === "string" ? request.params.sessionKey : "";
    return {
      messages: chatHistoryBySessionKey.get(sessionKey) ?? [],
    };
  }
  if (method === "agent") {
    const sourceSessionKey = request.params?.inputProvenance?.sourceSessionKey;
    const gate = sourceSessionKey ? agentCallGates.get(sourceSessionKey) : undefined;
    if (gate) {
      await gate;
    }
    const next = agentCallPlan.shift() ?? "ok";
    if (next === "throw") {
      throw new Error("announce delivery failed");
    }
    return { result: { payloads: [{ text: "completion delivered" }] } };
  }
  return {};
});
const onAgentEventMock = vi.fn((handler: typeof lifecycleHandler) => {
  lifecycleHandler = handler;
  return noop;
});
const loadConfigMock = vi.fn(() => ({
  agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
  session: { mainKey: "main", scope: "per-sender" },
}));
vi.mock("../../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveSessionStorePathCore: () => "/tmp/test-store",
  resolveMainSessionKey: () => "agent:main:main",
  updateSessionStore: vi.fn(),
}));

// The sqlite session accessor bypasses loadSessionStore, so serve session
// entries (requester lookups included) from the same in-memory fixture.
vi.mock("../../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: () =>
    Object.entries(sessionStore).map(([sessionKey, entry]) => ({ sessionKey, entry })),

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
    countActiveDescendantRuns: mod.countActiveDescendantRuns,
    countPendingDescendantRuns: mod.countPendingDescendantRuns,
    hasDescendantRunAwaitingSettle,
    getLatestSubagentRunByChildSessionKey: mod.getLatestSubagentRunByChildSessionKey,
    getLazySubagentRunByRunId: async (runId: string) => mod.getSubagentRunByRunId(runId),
    isSubagentSessionRunActive: mod.isSubagentSessionRunActive,
    listAncestorSessionKeys,
    listSubagentRunsForRequester: mod.listSubagentRunsForRequester,
    recordLazySubagentSteerDispatch: async (
      params: Parameters<typeof mod.recordAcceptedSubagentSteerDispatch>[0],
    ) => mod.recordAcceptedSubagentSteerDispatch(params),
    replaceSubagentRunAfterSteer: async (
      params: Parameters<typeof mod.replaceSubagentRunAfterSteerCore>[0],
    ) => mod.replaceSubagentRunAfterSteerCore(params),
    clearLazySubagentSteerRestart: async (
      ...args: Parameters<typeof mod.clearSubagentRunSteerRestart>
    ) => mod.clearSubagentRunSteerRestart(...args),
    resolveRequesterForChildSession: mod.resolveRequesterForChildSession,
    shouldIgnorePostCompletionAnnounceForSession: mod.shouldIgnorePostCompletionAnnounceForSession,
  }) as unknown as typeof import("./subagent-registry-runtime.js");

describe("subagent registry lifecycle error grace", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(async () => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    // Other e2e files can start the process-global registry listener with the
    // default event dependency before this file runs in the same worker.
    // Reset first so the test override below owns the listener deterministically.
    mod.resetSubagentRegistryForTests({ persist: false });
    lifecycleHandler = undefined;
    // The assembly announce path lazy-loads continuation coordination even
    // when continuation is disabled. Warm that module before fake timers so
    // this lifecycle test does not strand the detached announce on ESM I/O.
    await import("../../subagent-announce.continuation.runtime.js");
    vi.useFakeTimers();
    callGatewayMock.mockClear();
    onAgentEventMock.mockClear();
    loadConfigMock.mockClear().mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" },
    });
    agentCallPlan = [];
    agentCallGates = new Map();
    chatHistoryBySessionKey = new Map();
    sessionStore = new Proxy<Record<string, SessionStoreEntry>>(
      {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: 1,
          delivery: {
            kind: "external",
            route: { channel: "discord", accountId: "default", target: { to: "user-1" } },
            context: { channel: "discord", to: "user-1", accountId: "default" },
            origin: { provider: "discord", to: "user-1", accountId: "default" },
          },
        },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop !== "string" || prop in target) {
            return Reflect.get(target, prop, receiver);
          }
          return {
            sessionId: `sess-${prop.replace(/[^a-z0-9]+/gi, "-")}`,
            updatedAt: 1,
          };
        },
      },
    );
    mod.testing.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig:
        loadConfigMock as typeof import("../../../config/config.js").getRuntimeConfig,
      loadAgentRuntimePluginRegistryHandle: () => undefined,
      onAgentEvent:
        onAgentEventMock as unknown as typeof import("../../../infra/agent-events.js").onAgentEvent,
      persistSubagentRunsToDisk: noop,
      persistSubagentRunsToDiskOrThrow: noop,
      restoreSubagentRunsFromDisk: () => 0,
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
      getRequesterSessionActivity: (requesterSessionKey: string) => {
        const entry = sessionStore[requesterSessionKey];
        return {
          sessionId: entry?.sessionId,
          isActive: false,
        };
      },
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
    mod.testing.setDepsForTest();
    mod.resetSubagentRegistryForTests({ persist: false });
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

  const waitForCleanupHandledFalse = async (runId: string) => {
    // Cleanup can be released asynchronously after announce failure; poll fake
    // time until the retry-grace state is observable.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const run = mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === runId);
      if (
        run?.cleanupHandled === false &&
        run.delivery?.status === "pending" &&
        run.delivery.payload
      ) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} did not reach cleanupHandled=false in time`);
  };

  const waitForDeliveredCleanup = async (runId: string) => {
    let lastRun: ReturnType<typeof mod.listSubagentRunsForRequester>[number] | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === runId);
      lastRun = run;
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
    throw new Error(
      `run ${runId} did not finish delivered cleanup in time: ${JSON.stringify({
        cleanupCompletedAt: lastRun?.cleanupCompletedAt,
        delivery: lastRun?.delivery,
        requesterSettleWake: lastRun?.requesterSettleWake,
      })}`,
    );
  };

  const waitForAgentCallCount = async (expectedCount: number) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (getAgentCalls().length >= expectedCount) {
        return;
      }
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync();
    }
    throw new Error(`expected ${expectedCount} agent call(s), got ${getAgentCalls().length}`);
  };

  const waitForFrozenResult = async (runId: string, matches: (resultText: string) => boolean) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === runId);
      const resultText = run?.completion?.resultText;
      if (run && typeof resultText === "string" && matches(resultText)) {
        return run;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} frozen result did not refresh`);
  };

  const waitForFrozenResultText = async (runId: string, expectedText: string) =>
    waitForFrozenResult(runId, (resultText) => resultText === expectedText);

  function registerCompletionRun(
    runId: string,
    childSuffix: string,
    task: string,
    requesterTurnRunId?: string,
    expectsCompletionMessage = true,
  ) {
    mod.registerSubagentRun({
      runId,
      requesterTurnRunId,
      childSessionKey: `agent:main:subagent:${childSuffix}`,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterAgentId: "main",
      requesterDisplayKey: MAIN_REQUESTER_DISPLAY_KEY,
      task,
      cleanup: "keep",
      expectsCompletionMessage,
    });
    expect(lifecycleHandler).toBeTypeOf("function");
  }

  function emitLifecycleEvent(
    runId: string,
    data: LifecycleData,
    options?: { sessionKey?: string },
  ) {
    lifecycleHandler?.({
      stream: "lifecycle",
      runId,
      sessionKey: options?.sessionKey,
      data,
    });
  }

  function readFirstAnnounceOutcome() {
    const first = getAgentCalls()[0];
    const internalEvents = first?.params?.internalEvents;
    const event =
      Array.isArray(internalEvents) && internalEvents[0] && typeof internalEvents[0] === "object"
        ? (internalEvents[0] as { status?: string; statusLabel?: string })
        : undefined;
    return {
      status: event?.status,
      error: event?.statusLabel,
    };
  }

  function setAssistantOutput(sessionKey: string, text: string) {
    chatHistoryBySessionKey.set(sessionKey, [
      {
        role: "assistant",
        content: text,
      },
    ]);
  }

  function getAgentCalls() {
    return (callGatewayMock.mock.calls as [GatewayRequest][])
      .map(([request]) => request)
      .filter((request): request is GatewayRequest => request.method === "agent");
  }

  function getRequesterWakeCalls() {
    return getAgentCalls().filter((request) => {
      const idempotencyKey = (request.params as Record<string, unknown> | undefined)
        ?.idempotencyKey;
      return (
        typeof idempotencyKey === "string" &&
        idempotencyKey.startsWith("announce:requester-settle:")
      );
    });
  }

  function getAgentResultsForChildSession(childSessionKey: string): string[] {
    return getAgentCalls()
      .filter((request) => {
        const inputProvenance = request.params?.inputProvenance;
        if (!inputProvenance || typeof inputProvenance !== "object") {
          return false;
        }
        return (
          (inputProvenance as { sourceSessionKey?: unknown }).sourceSessionKey === childSessionKey
        );
      })
      .map((request) => {
        const internalEvents = request.params?.internalEvents;
        const event =
          Array.isArray(internalEvents) &&
          internalEvents[0] &&
          typeof internalEvents[0] === "object"
            ? (internalEvents[0] as { result?: string })
            : undefined;
        return event?.result;
      })
      .filter((result): result is string => typeof result === "string");
  }

  it("yields an owned visible child and delivers its requester final exactly once", async () => {
    const requesterTurnRunId = "run-requester-visible-yield";
    const runId = "run-visible-yield";
    const childSessionKey = "agent:main:dashboard:visible-yield";
    const spawnResult = await maybeSpawnVisibleSession({
      raw: { visible: true },
      task: "finish visible dashboard work",
      label: "Visible child",
      runtime: "subagent",
      sandbox: "inherit",
      options: {
        agentSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
        requesterAgentIdOverride: "main",
        config: {
          agents: { list: [{ id: "main" }] },
          session: { mainKey: "main", scope: "per-sender" },
        },
        callGateway: vi.fn(async () => ({
          key: childSessionKey,
          runStarted: true,
          runId,
        })) as never,
        registerRun: mod.registerSubagentRun,
        countActiveRuns: () => 0,
      },
    });
    expect(spawnResult).toMatchObject({ status: "accepted", runId, childSessionKey });
    setAssistantOutput(childSessionKey, "visible dashboard child complete");

    const onYield = vi.fn();
    const yieldTool = createSessionsYieldTool({
      sessionId: "sess-main",
      claimYield: () =>
        mod.markRequesterTurnYielded({
          requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
          requesterAgentId: "main",
          requesterTurnRunId,
        }) > 0,
      onYield,
    });
    const yieldResult = await yieldTool.execute("yield-visible-child", {
      message: "Wait for the visible dashboard child",
    });
    expect(yieldResult.details).toEqual({
      status: "yielded",
      message: "Wait for the visible dashboard child",
    });
    expect(onYield).toHaveBeenCalledOnce();

    expect(
      mod.settleRequesterAfterSessionSpawns({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterAgentId: "main",
        requesterTurnRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [{ runId, childSessionKey }],
      }),
    ).toBe(true);
    expect(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((run) => run.runId === runId)?.execution.status,
    ).toBe("running");
    expect(getAgentCalls()).toHaveLength(0);

    const endedAt = Date.now();
    const terminalResult = {
      phase: "end",
      endedAt,
      terminalReply: {
        disposition: "visible" as const,
        text: "visible dashboard child complete",
      },
    };
    emitLifecycleEvent(runId, terminalResult, { sessionKey: childSessionKey });
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup(runId);
    expect(getAgentCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()[0]?.params).toMatchObject({
      sessionKey: MAIN_REQUESTER_SESSION_KEY,
      message: expect.stringContaining("visible final answer"),
    });

    emitLifecycleEvent(runId, terminalResult, { sessionKey: childSessionKey });
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()).toHaveLength(1);
  });

  it("does not replay a requester-owned final already delivered before its turn yields", async () => {
    const requesterTurnRunId = "run-requester-already-delivered";
    const runId = "run-completed-before-yield";
    const childSessionKey = "agent:main:subagent:completed-before-yield";
    registerCompletionRun(runId, "completed-before-yield", "finish once", requesterTurnRunId);
    setAssistantOutput(childSessionKey, "child complete");

    emitLifecycleEvent(runId, {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "child complete" },
    });
    await waitForDeliveredCleanup(runId);

    const completed = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((run) => run.runId === runId);
    expect(completed?.delivery?.requesterVisibleFinal).toEqual({
      requesterTurnRunId,
      batchRunIds: [runId],
    });
    expect(getAgentCalls()).toHaveLength(1);
    expect(
      mod.markRequesterTurnYielded({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
      }),
    ).toBe(1);
    expect(
      mod.settleRequesterAfterSessionSpawns({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [{ runId, childSessionKey }],
      }),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()).toHaveLength(0);
    expect(completed?.delivery?.requesterVisibleFinal).toBeUndefined();
  });

  it("lets requester settlement own a yielded batch after sibling deliveries race", async () => {
    const requesterTurnRunId = "run-requester-yield-race";
    const alphaSessionKey = "agent:main:subagent:yield-alpha";
    const betaSessionKey = "agent:main:subagent:yield-beta";
    registerCompletionRun("run-yield-alpha", "yield-alpha", "yield alpha", requesterTurnRunId);
    registerCompletionRun("run-yield-beta", "yield-beta", "yield beta", requesterTurnRunId);
    setAssistantOutput(alphaSessionKey, "alpha complete");
    setAssistantOutput(betaSessionKey, "beta complete");

    let releaseBetaDelivery: (() => void) | undefined;
    agentCallGates.set(
      betaSessionKey,
      new Promise<void>((resolve) => {
        releaseBetaDelivery = resolve;
      }),
    );

    emitLifecycleEvent("run-yield-alpha", {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: "alpha complete" },
    });
    await waitForAgentCallCount(1);

    emitLifecycleEvent("run-yield-beta", {
      phase: "end",
      endedAt: Date.now() + 1,
      terminalReply: { disposition: "visible", text: "beta complete" },
    });
    await waitForAgentCallCount(2);
    const betaBeforeYield = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((run) => run.runId === "run-yield-beta");
    if (!betaBeforeYield) {
      throw new Error("expected beta run before requester yield");
    }
    betaBeforeYield.delivery = { ...betaBeforeYield.delivery, status: "in_progress" };

    expect(
      mod.markRequesterTurnYielded({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
      }),
    ).toBe(2);
    expect(
      mod.settleRequesterAfterSessionSpawns({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [
          { runId: "run-yield-alpha", childSessionKey: alphaSessionKey },
          { runId: "run-yield-beta", childSessionKey: betaSessionKey },
        ],
      }),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    await flushAsync();

    const yieldedBatch = mod.listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY);
    expect(
      yieldedBatch.map((run) => ({
        runId: run.runId,
        delivery: run.delivery?.status,
        disposition: run.delivery?.disposition,
        nextAttemptAt: run.requesterSettleWake?.nextAttemptAt,
        rearmGeneration: run.requesterSettleWake?.rearmGeneration,
      })),
    ).toEqual([
      {
        runId: "run-yield-alpha",
        delivery: "delivered",
        disposition: "delivered",
        nextAttemptAt: undefined,
        rearmGeneration: undefined,
      },
      {
        runId: "run-yield-beta",
        delivery: "delivered",
        disposition: "delivered",
        nextAttemptAt: undefined,
        rearmGeneration: undefined,
      },
    ]);
    await waitForAgentCallCount(3);
    expect(getRequesterWakeCalls()).toHaveLength(1);

    agentCallGates.delete(betaSessionKey);
    releaseBetaDelivery?.();
    await waitForDeliveredCleanup("run-yield-alpha");
    await waitForDeliveredCleanup("run-yield-beta");

    expect(getRequesterWakeCalls()).toHaveLength(1);
    const requesterWakeParams = getRequesterWakeCalls()[0]?.params as
      | Record<string, unknown>
      | undefined;
    expect(requesterWakeParams?.idempotencyKey).toContain(":yield-1");
    expect(requesterWakeParams?.message).toContain("visible final answer");
    expect(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .filter((run) => run.runId === "run-yield-alpha" || run.runId === "run-yield-beta")
        .every((run) => run.requesterSettleWake === undefined),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    expect(getRequesterWakeCalls()).toHaveLength(1);
  });

  it("keeps a frozen live child asleep until its real registry row becomes terminal", async () => {
    const requesterTurnRunId = "run-requester-live-child";
    const liveChildSessionKey = "agent:main:subagent:frozen-live-child";
    registerCompletionRun(
      "run-frozen-live-child",
      "frozen-live-child",
      "live child",
      requesterTurnRunId,
    );
    setAssistantOutput(liveChildSessionKey, "live child complete");

    expect(
      mod.markRequesterTurnYielded({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
      }),
    ).toBe(1);
    expect(
      mod.settleRequesterAfterSessionSpawns({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        requesterTurnRunId,
        requesterYielded: true,
        acceptedSessionSpawns: [
          { runId: "run-frozen-live-child", childSessionKey: liveChildSessionKey },
        ],
      }),
    ).toBe(true);

    const liveChild = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((run) => run.runId === "run-frozen-live-child");
    if (!liveChild) {
      throw new Error("expected frozen live child");
    }
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
        settledEntry: liveChild,
        transitionBatch: noop,
        completeBatch: noop,
      }),
    ).toBe(false);
    await flushAsync();

    expect(getRequesterWakeCalls()).toHaveLength(0);
    expect(liveChild.execution.status).toBe("running");

    emitLifecycleEvent("run-frozen-live-child", {
      phase: "end",
      endedAt: Date.now() + 1,
      terminalReply: { disposition: "visible", text: "live child complete" },
    });
    await waitForAgentCallCount(1);
    await waitForDeliveredCleanup("run-frozen-live-child");

    expect(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((run) => run.runId === "run-frozen-live-child")?.execution,
    ).toMatchObject({ status: "terminal", endedAt: expect.any(Number) });
    expect(getRequesterWakeCalls()).toHaveLength(1);
  });

  it("ignores transient lifecycle errors when run retries and then ends successfully", async () => {
    registerCompletionRun("run-transient-error", "transient-error", "transient error test");
    setAssistantOutput("agent:main:subagent:transient-error", "Final answer transient");

    emitLifecycleEvent("run-transient-error", {
      phase: "error",
      error: "rate limit",
      endedAt: 1_000,
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(getAgentCalls()).toHaveLength(0);

    emitLifecycleEvent("run-transient-error", { phase: "start", startedAt: 1_050 });
    await flushAsync();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(getAgentCalls()).toHaveLength(0);

    emitLifecycleEvent("run-transient-error", {
      phase: "end",
      endedAt: 1_250,
      terminalReply: { disposition: "visible", text: "Final answer transient" },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(readFirstAnnounceOutcome()?.status).toBe("ok");
  });

  it("announces error when lifecycle error remains terminal after grace window", async () => {
    registerCompletionRun("run-terminal-error", "terminal-error", "terminal error test");
    setAssistantOutput("agent:main:subagent:terminal-error", "fatal summary");

    emitLifecycleEvent("run-terminal-error", {
      phase: "error",
      error: "fatal failure",
      endedAt: 2_000,
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(readFirstAnnounceOutcome()?.status).toBe("error");
    expect(readFirstAnnounceOutcome()?.error).toContain("fatal failure");
  });

  it("freezes completion result at run termination across deferred announce retries", async () => {
    // Regression guard: late lifecycle noise must never overwrite the frozen completion reply.
    registerCompletionRun("run-freeze", "freeze", "freeze test");
    setAssistantOutput("agent:main:subagent:freeze", "Final answer X");
    agentCallPlan = ["throw", "ok"];

    const endedAt = Date.now();
    emitLifecycleEvent("run-freeze", {
      phase: "end",
      endedAt,
      terminalReply: { disposition: "visible", text: "Final answer X" },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(getAgentResultsForChildSession("agent:main:subagent:freeze")).toEqual([
      "Final answer X",
    ]);

    await waitForCleanupHandledFalse("run-freeze");

    setAssistantOutput("agent:main:subagent:freeze", "Late reply Y");
    emitLifecycleEvent("run-freeze", {
      phase: "end",
      endedAt: endedAt + 100,
      terminalReply: { disposition: "visible", text: "Final answer X" },
    });
    await flushAsync();

    await waitForAgentCallCount(2);
    expect(getAgentResultsForChildSession("agent:main:subagent:freeze")).toEqual([
      "Final answer X",
      "Final answer X",
    ]);
  });

  it("refreshes frozen completion output from later turns in the same session", async () => {
    registerCompletionRun("run-refresh", "refresh", "refresh frozen output test");
    setAssistantOutput(
      "agent:main:subagent:refresh",
      "Both spawned. Waiting for completion events...",
    );
    agentCallPlan = ["throw", "ok"];

    const endedAt = Date.now();
    emitLifecycleEvent("run-refresh", {
      phase: "end",
      endedAt,
      terminalReply: {
        disposition: "visible",
        text: "Both spawned. Waiting for completion events...",
      },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(getAgentResultsForChildSession("agent:main:subagent:refresh")).toEqual([
      "Both spawned. Waiting for completion events...",
    ]);

    await waitForCleanupHandledFalse("run-refresh");

    const runBeforeRefresh = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-refresh");
    const firstCapturedAt = runBeforeRefresh?.completion?.capturedAt ?? 0;

    setAssistantOutput(
      "agent:main:subagent:refresh",
      "All 3 subagents complete. Here's the final summary.",
    );
    emitLifecycleEvent(
      "run-refresh-followup-turn",
      { phase: "end", endedAt: endedAt + 200 },
      { sessionKey: "agent:main:subagent:refresh" },
    );
    const runAfterRefresh = await waitForFrozenResultText(
      "run-refresh",
      "All 3 subagents complete. Here's the final summary.",
    );
    expect(runAfterRefresh?.completion?.resultText).toBe(
      "All 3 subagents complete. Here's the final summary.",
    );
    expect((runAfterRefresh?.completion?.capturedAt ?? 0) >= firstCapturedAt).toBe(true);

    emitLifecycleEvent("run-refresh", {
      phase: "end",
      endedAt: endedAt + 300,
      terminalReply: {
        disposition: "visible",
        text: "All 3 subagents complete. Here's the final summary.",
      },
    });
    await flushAsync();

    await waitForAgentCallCount(2);
    expect(getAgentResultsForChildSession("agent:main:subagent:refresh")).toEqual([
      "Both spawned. Waiting for completion events...",
      "All 3 subagents complete. Here's the final summary.",
    ]);
  });

  it("ignores silent follow-up turns when refreshing frozen completion output", async () => {
    registerCompletionRun("run-refresh-silent", "refresh-silent", "refresh silent test");
    setAssistantOutput("agent:main:subagent:refresh-silent", "All work complete, final summary");
    agentCallPlan = ["throw", "ok"];

    const endedAt = Date.now();
    emitLifecycleEvent("run-refresh-silent", {
      phase: "end",
      endedAt,
      terminalReply: {
        disposition: "visible",
        text: "All work complete, final summary",
      },
    });
    await flushAsync();
    await waitForCleanupHandledFalse("run-refresh-silent");
    await waitForFrozenResultText("run-refresh-silent", "All work complete, final summary");

    setAssistantOutput("agent:main:subagent:refresh-silent", "NO_REPLY");
    emitLifecycleEvent(
      "run-refresh-silent-followup-turn",
      { phase: "end", endedAt: endedAt + 200 },
      { sessionKey: "agent:main:subagent:refresh-silent" },
    );
    await flushAsync();

    const runAfterSilent = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-refresh-silent");
    expect(runAfterSilent?.completion?.resultText).toBe("All work complete, final summary");

    emitLifecycleEvent("run-refresh-silent", {
      phase: "end",
      endedAt: endedAt + 300,
      terminalReply: {
        disposition: "visible",
        text: "All work complete, final summary",
      },
    });
    await flushAsync();

    await waitForAgentCallCount(2);
    expect(getAgentResultsForChildSession("agent:main:subagent:refresh-silent")).toEqual([
      "All work complete, final summary",
      "All work complete, final summary",
    ]);
  });

  it("regression, captures frozen completion output with 100KB cap and retains it for keep-mode cleanup", async () => {
    registerCompletionRun("run-capped", "capped", "capped result test", undefined, false);
    setAssistantOutput("agent:main:subagent:capped", "x".repeat(120 * 1024));

    emitLifecycleEvent("run-capped", { phase: "end", endedAt: Date.now() });
    await flushAsync();

    const run = await waitForFrozenResult("run-capped", (resultText) =>
      resultText.includes("[truncated: frozen completion output exceeded 100KB"),
    );
    expect(getAgentCalls()).toHaveLength(0);
    expect(run.runId).toBe("run-capped");
    expect(typeof run.completion?.resultText).toBe("string");
    expect(run.completion?.resultText).toContain(
      "[truncated: frozen completion output exceeded 100KB",
    );
    expect(Buffer.byteLength(run.completion?.resultText ?? "", "utf8")).toBeLessThanOrEqual(
      100 * 1024,
    );
    expect(run.completion?.capturedAt).toBeTypeOf("number");
  });

  it("records a bare aborted end event as cancellation after retry grace", async () => {
    registerCompletionRun("run-aborted", "aborted", "aborted test");
    setAssistantOutput("agent:main:subagent:aborted", "Partial output before cancellation");

    emitLifecycleEvent("run-aborted", {
      phase: "end",
      aborted: true,
      endedAt: 3_000,
    });
    await flushAsync();

    expect(getAgentCalls()).toHaveLength(0);
    expect(
      mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === "run-aborted")?.execution.status,
    ).toBe("running");

    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    const run = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-aborted");
    expect(run).toMatchObject({
      endedReason: "subagent-killed",
      execution: { outcome: { status: "error", error: "subagent run terminated" } },
    });
    expect(getAgentCalls()).toHaveLength(0);
  });

  it("announces a provider hard timeout from its canonical lifecycle metadata", async () => {
    registerCompletionRun("run-provider-timeout", "provider-timeout", "provider timeout test");
    setAssistantOutput(
      "agent:main:subagent:provider-timeout",
      "Partial output before provider timeout",
    );

    emitLifecycleEvent("run-provider-timeout", {
      phase: "end",
      aborted: true,
      stopReason: "restart",
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      endedAt: 3_000,
      error: "provider timed out",
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    await waitForAgentCallCount(1);

    expect(readFirstAnnounceOutcome()?.status).toBe("timeout");
    const run = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-provider-timeout");
    expect(run?.execution.outcome?.status).toBe("timeout");
  });

  it("cancels timeout grace when a successful end event arrives before the grace window expires", async () => {
    registerCompletionRun("run-timeout-cancel", "timeout-cancel", "timeout cancel test");
    setAssistantOutput("agent:main:subagent:timeout-cancel", "Final answer after recovery");

    // Emit a structured timeout terminal (starts timeout grace).
    emitLifecycleEvent("run-timeout-cancel", {
      phase: "end",
      aborted: true,
      status: "timeout",
      timeoutPhase: "provider",
      providerStarted: true,
      endedAt: 4_000,
    });
    await flushAsync();
    expect(getAgentCalls()).toHaveLength(0);

    // Before the grace window, the run successfully ends (non-aborted)
    emitLifecycleEvent("run-timeout-cancel", {
      phase: "end",
      endedAt: 4_500,
      terminalReply: { disposition: "visible", text: "Final answer after recovery" },
    });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(readFirstAnnounceOutcome()?.status).toBe("ok");

    // Advance past the original grace window; no timeout completion or
    // requester-settle wake should be emitted after successful delivery.
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();
    const readIdempotencyKey = (request: GatewayRequest) => {
      const key = (request.params as Record<string, unknown> | undefined)?.idempotencyKey;
      return typeof key === "string" ? key : "";
    };
    expect(
      getAgentCalls().filter((request) => readIdempotencyKey(request).startsWith("announce:v1:")),
    ).toHaveLength(1);
    expect(
      getAgentCalls()
        .map(readIdempotencyKey)
        .filter((key) => key.startsWith("announce:requester-settle:")),
    ).toHaveLength(0);
  });

  it("keeps parallel child completion results frozen even when late traffic arrives", async () => {
    // Regression guard: fan-out retries must preserve each child's first frozen result text.
    registerCompletionRun("run-parallel-a", "parallel-a", "parallel a");
    registerCompletionRun("run-parallel-b", "parallel-b", "parallel b");
    setAssistantOutput("agent:main:subagent:parallel-a", "Final answer A");
    setAssistantOutput("agent:main:subagent:parallel-b", "Final answer B");
    agentCallPlan = ["throw", "throw", "ok", "ok"];

    const parallelEndedAt = Date.now();
    emitLifecycleEvent("run-parallel-a", {
      phase: "end",
      endedAt: parallelEndedAt,
      terminalReply: { disposition: "visible", text: "Final answer A" },
    });
    emitLifecycleEvent("run-parallel-b", {
      phase: "end",
      endedAt: parallelEndedAt + 1,
      terminalReply: { disposition: "visible", text: "Final answer B" },
    });
    await flushAsync();

    await waitForAgentCallCount(2);
    await waitForCleanupHandledFalse("run-parallel-a");
    await waitForCleanupHandledFalse("run-parallel-b");

    setAssistantOutput("agent:main:subagent:parallel-a", "Late overwrite");
    setAssistantOutput("agent:main:subagent:parallel-b", "Late overwrite");

    emitLifecycleEvent("run-parallel-a", {
      phase: "end",
      endedAt: parallelEndedAt + 100,
      terminalReply: { disposition: "visible", text: "Final answer A" },
    });
    emitLifecycleEvent("run-parallel-b", {
      phase: "end",
      endedAt: parallelEndedAt + 101,
      terminalReply: { disposition: "visible", text: "Final answer B" },
    });
    await flushAsync();

    await waitForAgentCallCount(4);

    expect(getAgentResultsForChildSession("agent:main:subagent:parallel-a")).toEqual([
      "Final answer A",
      "Final answer A",
    ]);
    expect(getAgentResultsForChildSession("agent:main:subagent:parallel-b")).toEqual([
      "Final answer B",
      "Final answer B",
    ]);
  });
});
