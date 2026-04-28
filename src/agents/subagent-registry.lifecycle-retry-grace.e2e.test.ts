import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as subagentAnnounceDeliveryTesting } from "./subagent-announce-delivery.js";
import { __testing as subagentAnnounceOutputTesting } from "./subagent-announce-output.js";
import { __testing as subagentAnnounceTesting } from "./subagent-announce.js";
import * as mod from "./subagent-registry.js";

const noop = () => {};
const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";
const MAIN_REQUESTER_DISPLAY_KEY = "main";

type LifecycleData = {
  phase?: string;
  startedAt?: number;
  endedAt?: number;
  aborted?: boolean;
  error?: string;
};
type LifecycleEvent = {
  stream?: string;
  runId: string;
  sessionKey?: string;
  data?: LifecycleData;
};

type SessionStoreEntry = {
  sessionId?: string;
  updatedAt?: number;
  channel?: string;
  lastChannel?: string;
  to?: string;
  accountId?: string;
};

type GatewayAgentInternalEvent = {
  status?: string;
  statusLabel?: string;
  result?: string;
};

type GatewayAgentRequestParams = {
  sessionKey?: string;
  inputProvenance?: {
    sourceSessionKey?: string;
  };
  internalEvents?: GatewayAgentInternalEvent[];
};

type GatewayRequest = {
  method?: string;
  params?: GatewayAgentRequestParams;
  timeoutMs?: number;
  expectFinal?: boolean;
};

let lifecycleHandler: ((evt: LifecycleEvent) => void) | undefined;
let agentCallPlan: Array<"ok" | "throw"> = [];
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
    const next = agentCallPlan.shift() ?? "ok";
    if (next === "throw") {
      throw new Error("announce delivery failed");
    }
    return {};
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
const registryStoreMocks = vi.hoisted(() => ({
  loadRegistryMock: vi.fn(() => new Map()),
  saveRegistryMock: vi.fn(() => {}),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveStorePath: () => "/tmp/test-store",
  resolveMainSessionKey: () => "agent:main:main",
  updateSessionStore: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("./subagent-registry.store.js", () => ({
  loadSubagentRegistryFromDisk: registryStoreMocks.loadRegistryMock,
  saveSubagentRegistryToDisk: registryStoreMocks.saveRegistryMock,
}));

describe("subagent registry lifecycle error grace", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(async () => {
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    vi.useFakeTimers();
    callGatewayMock.mockClear();
    onAgentEventMock.mockClear();
    registryStoreMocks.loadRegistryMock.mockClear().mockReturnValue(new Map());
    registryStoreMocks.saveRegistryMock.mockClear();
    loadConfigMock.mockClear().mockReturnValue({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      session: { mainKey: "main", scope: "per-sender" },
    });
    agentCallPlan = [];
    chatHistoryBySessionKey = new Map();
    sessionStore = new Proxy<Record<string, SessionStoreEntry>>(
      {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: 1,
          channel: "discord",
          lastChannel: "discord",
          to: "user-1",
          accountId: "default",
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
    mod.__testing.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock as typeof import("../config/config.js").getRuntimeConfig,
      onAgentEvent:
        onAgentEventMock as unknown as typeof import("../infra/agent-events.js").onAgentEvent,
    });
    subagentAnnounceTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock as typeof import("../config/config.js").getRuntimeConfig,
      loadSubagentRegistryRuntime: async () => ({
        countActiveDescendantRuns: mod.countActiveDescendantRuns,
        countPendingDescendantRuns: mod.countPendingDescendantRuns,
        countPendingDescendantRunsExcludingRun: mod.countPendingDescendantRunsExcludingRun,
        getLatestSubagentRunByChildSessionKey: mod.getLatestSubagentRunByChildSessionKey,
        isSubagentSessionRunActive: mod.isSubagentSessionRunActive,
        listSubagentRunsForRequester: mod.listSubagentRunsForRequester,
        replaceSubagentRunAfterSteer: mod.replaceSubagentRunAfterSteer,
        resolveRequesterForChildSession: mod.resolveRequesterForChildSession,
        shouldIgnorePostCompletionAnnounceForSession:
          mod.shouldIgnorePostCompletionAnnounceForSession,
      }),
    });
    subagentAnnounceDeliveryTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock as typeof import("../config/config.js").getRuntimeConfig,
      getRequesterSessionActivity: (requesterSessionKey: string) => {
        const entry = sessionStore[requesterSessionKey];
        return {
          sessionId: entry?.sessionId,
          isActive: false,
        };
      },
    });
    subagentAnnounceOutputTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock as typeof import("../config/config.js").getRuntimeConfig,
    });
  });

  afterEach(() => {
    lifecycleHandler = undefined;
    subagentAnnounceDeliveryTesting.setDepsForTest();
    subagentAnnounceOutputTesting.setDepsForTest();
    subagentAnnounceTesting.setDepsForTest();
    mod.__testing.setDepsForTest();
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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const run = mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === runId);
      if (run?.cleanupHandled === false) {
        return;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} did not reach cleanupHandled=false in time`);
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

  const waitForFrozenResultText = async (runId: string, expectedText: string) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const run = mod
        .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
        .find((candidate) => candidate.runId === runId);
      if (run?.frozenResultText === expectedText) {
        return run;
      }
      await vi.advanceTimersByTimeAsync(1);
      await flushAsync();
    }
    throw new Error(`run ${runId} frozen result did not refresh`);
  };

  function registerCompletionRun(runId: string, childSuffix: string, task: string) {
    mod.registerSubagentRun({
      runId,
      childSessionKey: `agent:main:subagent:${childSuffix}`,
      requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
      requesterDisplayKey: MAIN_REQUESTER_DISPLAY_KEY,
      task,
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
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
        return event?.result ?? "";
      });
  }

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

    emitLifecycleEvent("run-transient-error", { phase: "end", endedAt: 1_250 });
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
    emitLifecycleEvent("run-freeze", { phase: "end", endedAt });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(getAgentResultsForChildSession("agent:main:subagent:freeze")).toEqual([
      "Final answer X",
    ]);

    await waitForCleanupHandledFalse("run-freeze");

    setAssistantOutput("agent:main:subagent:freeze", "Late reply Y");
    emitLifecycleEvent("run-freeze", { phase: "end", endedAt: endedAt + 100 });
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
    emitLifecycleEvent("run-refresh", { phase: "end", endedAt });
    await flushAsync();

    await waitForAgentCallCount(1);
    expect(getAgentResultsForChildSession("agent:main:subagent:refresh")).toEqual([
      "Both spawned. Waiting for completion events...",
    ]);

    await waitForCleanupHandledFalse("run-refresh");

    const runBeforeRefresh = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-refresh");
    const firstCapturedAt = runBeforeRefresh?.frozenResultCapturedAt ?? 0;

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
    expect(runAfterRefresh?.frozenResultText).toBe(
      "All 3 subagents complete. Here's the final summary.",
    );
    expect((runAfterRefresh?.frozenResultCapturedAt ?? 0) >= firstCapturedAt).toBe(true);

    emitLifecycleEvent("run-refresh", { phase: "end", endedAt: endedAt + 300 });
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
    emitLifecycleEvent("run-refresh-silent", { phase: "end", endedAt });
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
    expect(runAfterSilent?.frozenResultText).toBe("All work complete, final summary");

    emitLifecycleEvent("run-refresh-silent", { phase: "end", endedAt: endedAt + 300 });
    await flushAsync();

    await waitForAgentCallCount(2);
    expect(getAgentResultsForChildSession("agent:main:subagent:refresh-silent")).toEqual([
      "All work complete, final summary",
      "All work complete, final summary",
    ]);
  });

  it("regression, captures frozen completion output with 100KB cap and retains it for keep-mode cleanup", async () => {
    registerCompletionRun("run-capped", "capped", "capped result test");
    setAssistantOutput("agent:main:subagent:capped", "x".repeat(120 * 1024));

    emitLifecycleEvent("run-capped", { phase: "end", endedAt: Date.now() });
    await flushAsync();

    await waitForAgentCallCount(1);
    const cappedResults = getAgentResultsForChildSession("agent:main:subagent:capped");
    expect(cappedResults).toHaveLength(1);
    expect(cappedResults[0]).toContain("[truncated: frozen completion output exceeded 100KB");
    expect(Buffer.byteLength(cappedResults[0] ?? "", "utf8")).toBeLessThanOrEqual(100 * 1024);

    const run = mod
      .listSubagentRunsForRequester(MAIN_REQUESTER_SESSION_KEY)
      .find((candidate) => candidate.runId === "run-capped");
    expect(run).toBeDefined();
    if (!run) {
      throw new Error("expected capped run to exist");
    }
    expect(typeof run.frozenResultText).toBe("string");
    expect(run.frozenResultText).toContain("[truncated: frozen completion output exceeded 100KB");
    expect(run.frozenResultCapturedAt).toBeTypeOf("number");
  });

  it("keeps parallel child completion results frozen even when late traffic arrives", async () => {
    // Regression guard: fan-out retries must preserve each child's first frozen result text.
    registerCompletionRun("run-parallel-a", "parallel-a", "parallel a");
    registerCompletionRun("run-parallel-b", "parallel-b", "parallel b");
    setAssistantOutput("agent:main:subagent:parallel-a", "Final answer A");
    setAssistantOutput("agent:main:subagent:parallel-b", "Final answer B");
    agentCallPlan = ["throw", "throw", "ok", "ok"];

    const parallelEndedAt = Date.now();
    emitLifecycleEvent("run-parallel-a", { phase: "end", endedAt: parallelEndedAt });
    emitLifecycleEvent("run-parallel-b", { phase: "end", endedAt: parallelEndedAt + 1 });
    await flushAsync();

    await waitForAgentCallCount(2);
    await waitForCleanupHandledFalse("run-parallel-a");
    await waitForCleanupHandledFalse("run-parallel-b");

    setAssistantOutput("agent:main:subagent:parallel-a", "Late overwrite");
    setAssistantOutput("agent:main:subagent:parallel-b", "Late overwrite");

    emitLifecycleEvent("run-parallel-a", { phase: "end", endedAt: parallelEndedAt + 100 });
    emitLifecycleEvent("run-parallel-b", { phase: "end", endedAt: parallelEndedAt + 101 });
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
