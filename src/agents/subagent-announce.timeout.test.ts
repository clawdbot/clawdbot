import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentAnnounceDeliveryRuntimeMock } from "./subagent-announce.test-support.js";

type GatewayCall = {
  method?: string;
  timeoutMs?: number;
  expectFinal?: boolean;
  params?: Record<string, unknown>;
};

const gatewayCalls: GatewayCall[] = [];
let callGatewayImpl: (request: GatewayCall) => Promise<unknown> = async (request) => {
  if (request.method === "chat.history") {
    return { messages: [] };
  }
  return {};
};
let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};
let requesterDepthResolver: (sessionKey?: string) => number = () => 0;
let subagentSessionRunActive = true;
let shouldIgnorePostCompletion = false;
let pendingDescendantRuns = 0;
const isEmbeddedPiRunActiveMock = vi.fn((_sessionId: string) => false);
const waitForEmbeddedPiRunEndMock = vi.fn(async (_sessionId: string, _timeoutMs?: number) => true);
let fallbackRequesterResolution: {
  requesterSessionKey: string;
  requesterOrigin?: { channel?: string; to?: string; accountId?: string };
} | null = null;
let chatHistoryMessages: Array<Record<string, unknown>> = [];

function createGatewayCallModuleMock() {
  return {
    callGateway: vi.fn(async (request: GatewayCall) => {
      gatewayCalls.push(request);
      if (request.method === "chat.history") {
        return { messages: chatHistoryMessages };
      }
      return await callGatewayImpl(request);
    }),
  };
}

function createSubagentDepthModuleMock() {
  return {
    getSubagentDepthFromSessionStore: (sessionKey?: string) => requesterDepthResolver(sessionKey),
  };
}

function createTimeoutHistoryWithNoReply() {
  return [
    { role: "user", content: "do something" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Still working through the files." },
        { type: "toolCall", id: "call1", name: "read", arguments: {} },
      ],
    },
    { role: "toolResult", toolCallId: "call1", content: [{ type: "text", text: "data" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
    },
  ];
}

vi.mock("../gateway/call.js", createGatewayCallModuleMock);
vi.mock("./subagent-depth.js", createSubagentDepthModuleMock);
vi.mock("./subagent-announce-delivery.runtime.js", () =>
  createSubagentAnnounceDeliveryRuntimeMock({
    callGateway: async (request: unknown) => {
      const typed = request as GatewayCall;
      gatewayCalls.push(typed);
      if (typed.method === "chat.history") {
        return { messages: chatHistoryMessages };
      }
      return await callGatewayImpl(typed);
    },
    loadConfig: () => configOverride,
    loadSessionStore: () => sessionStore,
    resolveAgentIdFromSessionKey: () => "main",
    resolveMainSessionKey: () => "agent:main:main",
    resolveStorePath: () => "/tmp/sessions-main.json",
    isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
    queueEmbeddedPiMessage: () => false,
  }),
);
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: async (params: {
    targetRequesterSessionKey: string;
    triggerMessage: string;
    requesterIsSubagent?: boolean;
    requesterOrigin?: { channel?: string; to?: string; accountId?: string; threadId?: string };
    requesterSessionOrigin?: { provider?: string; channel?: string };
    bestEffortDeliver?: boolean;
    directIdempotencyKey?: string;
    internalEvents?: unknown;
  }) => {
    const buildRequest = () => ({
      method: "agent",
      expectFinal: true,
      timeoutMs,
      params: {
        sessionKey: params.targetRequesterSessionKey,
        message: params.triggerMessage,
        deliver: !params.requesterIsSubagent,
        bestEffortDeliver: params.bestEffortDeliver,
        internalEvents: params.internalEvents,
        ...(params.requesterIsSubagent
          ? {}
          : {
              channel: params.requesterOrigin?.channel,
              to: params.requesterOrigin?.to,
              accountId: params.requesterOrigin?.accountId,
              threadId: params.requesterOrigin?.threadId,
            }),
      },
    });
    const timeoutMs =
      typeof configOverride.agents?.defaults?.subagents?.announceTimeoutMs === "number" &&
      Number.isFinite(configOverride.agents.defaults.subagents.announceTimeoutMs)
        ? Math.min(
            Math.max(1, Math.floor(configOverride.agents.defaults.subagents.announceTimeoutMs)),
            2_147_000_000,
          )
        : 120_000;
    const retryDelaysMs =
      process.env.OPENCLAW_TEST_FAST === "1" ? [8, 16, 32] : [5_000, 10_000, 20_000];
    let retryIndex = 0;
    for (;;) {
      const request = buildRequest();
      gatewayCalls.push(request);
      try {
        await callGatewayImpl(request);
        return { delivered: true, path: "direct" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const delayMs = retryDelaysMs[retryIndex];
        if (!/gateway timeout/i.test(message) || delayMs == null) {
          return { delivered: false, path: "direct", error: message };
        }
        retryIndex += 1;
      }
    }
  },
  loadRequesterSessionEntry: (sessionKey: string) => ({
    cfg: configOverride,
    canonicalKey: sessionKey,
    entry: sessionStore[sessionKey],
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
  resolveAnnounceOrigin: (entry: { origin?: unknown } | undefined, requesterOrigin?: unknown) =>
    requesterOrigin ?? entry?.origin,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
  resolveSubagentAnnounceTimeoutMs: (cfg: typeof configOverride) => {
    const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return 120_000;
    }
    return Math.min(Math.max(1, Math.floor(configured)), 2_147_000_000);
  },
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
}));
vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: createGatewayCallModuleMock().callGateway,
  loadConfig: () => configOverride,
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions-main.json",
  resolveMainSessionKey: () => "agent:main:main",
  isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActiveMock(sessionId),
  queueEmbeddedPiMessage: (_sessionId: string, _text: string) => false,
  waitForEmbeddedPiRunEnd: (sessionId: string, timeoutMs?: number) =>
    waitForEmbeddedPiRunEndMock(sessionId, timeoutMs),
}));
vi.mock("./subagent-announce.registry.runtime.js", () => ({
  countActiveDescendantRuns: () => 0,
  countPendingDescendantRuns: () => pendingDescendantRuns,
  countPendingDescendantRunsExcludingRun: () => 0,
  listSubagentRunsForRequester: () => [],
  isSubagentSessionRunActive: () => subagentSessionRunActive,
  shouldIgnorePostCompletionAnnounceForSession: () => shouldIgnorePostCompletion,
  replaceSubagentRunAfterSteer: () => true,
  resolveRequesterForChildSession: () => fallbackRequesterResolution,
}));
import { runSubagentAnnounceFlow } from "./subagent-announce.js";
type AnnounceFlowParams = Parameters<
  typeof import("./subagent-announce.js").runSubagentAnnounceFlow
>[0];

const defaultSessionConfig = {
  mainKey: "main",
  scope: "per-sender",
} as const;

const baseAnnounceFlowParams = {
  childSessionKey: "agent:main:subagent:worker",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "do thing",
  timeoutMs: 1_000,
  cleanup: "keep",
  roundOneReply: "done",
  waitForCompletion: false,
  outcome: { status: "ok" as const },
} satisfies Omit<AnnounceFlowParams, "childRunId">;

function setConfiguredAnnounceTimeout(timeoutMs: number): void {
  configOverride = {
    session: defaultSessionConfig,
    agents: {
      defaults: {
        subagents: {
          announceTimeoutMs: timeoutMs,
        },
      },
    },
  };
}

async function runAnnounceFlowForTest(
  childRunId: string,
  overrides: Partial<AnnounceFlowParams> = {},
): Promise<boolean> {
  return await runSubagentAnnounceFlow({
    ...baseAnnounceFlowParams,
    childRunId,
    ...overrides,
  });
}

function findGatewayCall(predicate: (call: GatewayCall) => boolean): GatewayCall | undefined {
  return gatewayCalls.find(predicate);
}

function findFinalDirectAgentCall(): GatewayCall | undefined {
  return findGatewayCall((call) => call.method === "agent" && call.expectFinal === true);
}

function setupParentSessionFallback(parentSessionKey: string): void {
  requesterDepthResolver = (sessionKey?: string) =>
    sessionKey === parentSessionKey ? 1 : sessionKey?.includes(":subagent:") ? 1 : 0;
  subagentSessionRunActive = false;
  shouldIgnorePostCompletion = false;
  fallbackRequesterResolution = {
    requesterSessionKey: "agent:main:main",
    requesterOrigin: { channel: "discord", to: "chan-main", accountId: "acct-main" },
  };
}

describe("subagent announce timeout config", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    chatHistoryMessages = [];
    callGatewayImpl = async (request) => {
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    };
    sessionStore = {};
    configOverride = {
      session: defaultSessionConfig,
    };
    requesterDepthResolver = () => 0;
    subagentSessionRunActive = true;
    shouldIgnorePostCompletion = false;
    pendingDescendantRuns = 0;
    isEmbeddedPiRunActiveMock.mockReset().mockReturnValue(false);
    waitForEmbeddedPiRunEndMock.mockReset().mockResolvedValue(true);
    fallbackRequesterResolution = null;
  });

  it("uses 120s timeout by default for direct announce agent call", async () => {
    await runAnnounceFlowForTest("run-default-timeout");

    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.timeoutMs).toBe(120_000);
  });

  it("honors configured announce timeout for direct announce agent call", async () => {
    setConfiguredAnnounceTimeout(120_000);
    await runAnnounceFlowForTest("run-config-timeout-agent");

    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(directAgentCall?.timeoutMs).toBe(120_000);
  });

  it("honors configured announce timeout for completion direct agent call", async () => {
    setConfiguredAnnounceTimeout(120_000);
    await runAnnounceFlowForTest("run-config-timeout-send", {
      requesterOrigin: {
        channel: "discord",
        to: "12345",
      },
      expectsCompletionMessage: true,
    });

    const completionDirectAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    expect(completionDirectAgentCall?.timeoutMs).toBe(120_000);
  });

  it("retries gateway timeout for externally delivered completion announces before giving up", async () => {
    try {
      vi.stubEnv("OPENCLAW_TEST_FAST", "1");
      callGatewayImpl = async (request) => {
        if (request.method === "chat.history") {
          return { messages: [] };
        }
        throw new Error("gateway timeout after 120000ms");
      };

      const announcePromise = runAnnounceFlowForTest("run-completion-timeout-retry", {
        requesterOrigin: {
          channel: "telegram",
          to: "12345",
        },
        expectsCompletionMessage: true,
      });
      await expect(announcePromise).resolves.toBe(false);

      const directAgentCalls = gatewayCalls.filter(
        (call) => call.method === "agent" && call.expectFinal === true,
      );
      expect(directAgentCalls).toHaveLength(4);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("regression, skips parent announce while descendants are still pending", async () => {
    requesterDepthResolver = () => 1;
    pendingDescendantRuns = 2;

    const didAnnounce = await runAnnounceFlowForTest("run-pending-descendants", {
      requesterSessionKey: "agent:main:subagent:parent",
      requesterDisplayKey: "agent:main:subagent:parent",
    });

    expect(didAnnounce).toBe(false);
    expect(
      findGatewayCall((call) => call.method === "agent" && call.expectFinal === true),
    ).toBeUndefined();
  });

  it("regression, supports cron announceType without declaration order errors", async () => {
    const didAnnounce = await runAnnounceFlowForTest("run-announce-type", {
      announceType: "cron job",
      expectsCompletionMessage: true,
      requesterOrigin: { channel: "discord", to: "channel:cron" },
    });

    expect(didAnnounce).toBe(true);
    const directAgentCall = findGatewayCall(
      (call) => call.method === "agent" && call.expectFinal === true,
    );
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ announceType?: string }>) ?? [];
    expect(internalEvents[0]?.announceType).toBe("cron job");
  });

  it("regression, keeps child announce internal when requester is a cron run session", async () => {
    const cronSessionKey = "agent:main:cron:daily-check:run:run-123";

    await runAnnounceFlowForTest("run-cron-internal", {
      requesterSessionKey: cronSessionKey,
      requesterDisplayKey: cronSessionKey,
      requesterOrigin: { channel: "discord", to: "channel:cron-results", accountId: "acct-1" },
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(directAgentCall?.params?.sessionKey).toBe(cronSessionKey);
    expect(directAgentCall?.params?.deliver).toBe(false);
    expect(directAgentCall?.params?.channel).toBeUndefined();
    expect(directAgentCall?.params?.to).toBeUndefined();
    expect(directAgentCall?.params?.accountId).toBeUndefined();
  });

  it("regression, routes child announce to parent session instead of grandparent when parent session still exists", async () => {
    const parentSessionKey = "agent:main:subagent:parent";
    setupParentSessionFallback(parentSessionKey);
    sessionStore[parentSessionKey] = { updatedAt: Date.now() };

    await runAnnounceFlowForTest("run-parent-route", {
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      childSessionKey: `${parentSessionKey}:subagent:child`,
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(directAgentCall?.params?.sessionKey).toBe(parentSessionKey);
    expect(directAgentCall?.params?.deliver).toBe(false);
  });

  it("regression, falls back to grandparent only when parent subagent session is missing", async () => {
    const parentSessionKey = "agent:main:subagent:parent-missing";
    setupParentSessionFallback(parentSessionKey);

    await runAnnounceFlowForTest("run-parent-fallback", {
      requesterSessionKey: parentSessionKey,
      requesterDisplayKey: parentSessionKey,
      childSessionKey: `${parentSessionKey}:subagent:child`,
    });

    const directAgentCall = findFinalDirectAgentCall();
    expect(directAgentCall?.params?.sessionKey).toBe("agent:main:main");
    expect(directAgentCall?.params?.deliver).toBe(true);
    expect(directAgentCall?.params?.channel).toBe("discord");
    expect(directAgentCall?.params?.to).toBe("chan-main");
    expect(directAgentCall?.params?.accountId).toBe("acct-main");
  });

  it("uses partial progress on timeout when the child only made tool calls", async () => {
    chatHistoryMessages = [
      { role: "user", content: "do a complex task" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "data" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "exec", arguments: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-3", name: "search", arguments: {} }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-partial-progress", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toContain("3 tool call(s)");
    expect(internalEvents[0]?.result).not.toContain("data");
  });

  it("does not announce cached reply text when the child run terminally failed", async () => {
    chatHistoryMessages = [
      { role: "assistant", content: [{ type: "text", text: "stale history output" }] },
      { role: "toolResult", content: [{ type: "text", text: "stale tool output" }] },
    ];

    await runAnnounceFlowForTest("run-terminal-error-no-stale-output", {
      outcome: { status: "error", error: "All models failed (2): timeout" },
      roundOneReply: "stale frozen output",
      fallbackReply: "older fallback output",
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{
        result?: string;
        status?: string;
        statusLabel?: string;
      }>) ?? [];
    expect(internalEvents[0]?.status).toBe("error");
    expect(internalEvents[0]?.statusLabel).toContain("All models failed");
    expect(internalEvents[0]?.result).toBe("(no output)");
    expect(directAgentCall?.params?.message).not.toContain("stale");
    expect(directAgentCall?.params?.message).not.toContain("older fallback");
  });

  it("preserves NO_REPLY when timeout history ends with silence after earlier progress", async () => {
    chatHistoryMessages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Still working through the files." },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-2", name: "exec", arguments: {} }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-no-reply", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    expect(findFinalDirectAgentCall()).toBeUndefined();
  });

  it("prefers visible assistant progress over a later raw tool result", async () => {
    chatHistoryMessages = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Read 12 files. Narrowing the search now." }],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "grep output" }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-visible-assistant", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toContain("Read 12 files");
    expect(internalEvents[0]?.result).not.toContain("grep output");
  });

  it("preserves NO_REPLY when timeout partial-progress history mixes prior text and later silence", async () => {
    chatHistoryMessages = [
      ...createTimeoutHistoryWithNoReply(),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call2", name: "exec", arguments: {} }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-mixed-no-reply", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    expect(
      findGatewayCall((call) => call.method === "agent" && call.expectFinal === true),
    ).toBeUndefined();
  });

  it("prefers later visible assistant progress over an earlier NO_REPLY marker", async () => {
    chatHistoryMessages = [
      ...createTimeoutHistoryWithNoReply(),
      {
        role: "assistant",
        content: [{ type: "text", text: "A longer partial summary that should stay silent." }],
      },
    ];

    await runAnnounceFlowForTest("run-timeout-no-reply-overrides-latest-text", {
      outcome: { status: "timeout" },
      roundOneReply: undefined,
    });

    const directAgentCall = findFinalDirectAgentCall();
    const internalEvents =
      (directAgentCall?.params?.internalEvents as Array<{ result?: string }>) ?? [];
    expect(internalEvents[0]?.result).toContain(
      "A longer partial summary that should stay silent.",
    );
  });
});
