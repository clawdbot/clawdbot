import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnAnnounceFlowOverride,
  resetSessionsSpawnConfigOverride,
  resetSessionsSpawnHookRunnerOverride,
  setSessionsSpawnHookRunnerOverride,
  setSessionsSpawnAnnounceFlowOverride,
  setupSessionsSpawnGatewayMock,
  setSessionsSpawnConfigOverride,
  waitForSessionsSpawnEvent,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  __testing as bundleMcpRuntimeTesting,
  getOrCreateSessionMcpRuntime,
} from "./pi-bundle-mcp-tools.js";
import {
  getLatestSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

const fastModeEnv = vi.hoisted(() => {
  const previous = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  return { previous };
});

const hookRunnerMocks = vi.hoisted(() => ({
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
    };
    if (!input.threadRequested) {
      return undefined;
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: async () => "done",
}));

const callGatewayMock = getCallGatewayMock();
const RUN_TIMEOUT_SECONDS = 1;

function buildDiscordCleanupHooks(onDelete: (key: string | undefined) => void) {
  return {
    onAgentSubagentSpawn: (params: unknown) => {
      const rec = params as { channel?: string; timeout?: number } | undefined;
      expect(rec?.channel).toBe("discord");
      expect(rec?.timeout).toBe(1);
    },
    onSessionsDelete: (params: unknown) => {
      const rec = params as { key?: string } | undefined;
      onDelete(rec?.key);
    },
  };
}

async function getDiscordGroupSpawnTool() {
  return await getSessionsSpawnTool({
    agentSessionKey: "discord:group:req",
    agentChannel: "discord",
  });
}

async function executeSpawnAndExpectAccepted(params: {
  tool: Awaited<ReturnType<typeof getSessionsSpawnTool>>;
  callId: string;
  cleanup?: "delete" | "keep";
  label?: string;
  expectsCompletionMessage?: boolean;
}) {
  const result = await params.tool.execute(params.callId, {
    task: "do thing",
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    ...(params.cleanup ? { cleanup: params.cleanup } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.expectsCompletionMessage === false ? { expectsCompletionMessage: false } : {}),
  });
  expect(result.details).toMatchObject({
    status: "accepted",
    runId: expect.any(String),
  });
  return result;
}

async function executeBoundAccountSpawn(params: {
  bindings: AgentRouteBinding[];
  context: Parameters<typeof getSessionsSpawnTool>[0];
  callId: string;
  agentId?: string;
}): Promise<string | undefined> {
  let spawnAccountId: string | undefined;
  setSessionsSpawnConfigOverride({
    session: { mainKey: "main", scope: "per-sender" },
    messages: { queue: { debounceMs: 0 } },
    agents: { defaults: { subagents: { allowAgents: ["bot-alpha"] } } },
    bindings: params.bindings,
  });
  setupSessionsSpawnGatewayMock({
    onAgentSubagentSpawn: (hookParams) => {
      const rec = hookParams as { accountId?: string } | undefined;
      spawnAccountId = rec?.accountId;
    },
  });

  const tool = await getSessionsSpawnTool(params.context);
  const result = await tool.execute(params.callId, {
    task: "do thing",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    cleanup: "keep",
  });
  expect(result.details).toMatchObject({ status: "accepted", runId: expect.any(String) });
  return spawnAccountId;
}

async function emitLifecycleEndAndFlush(params: {
  runId: string;
  startedAt: number;
  endedAt: number;
}) {
  vi.useFakeTimers();
  try {
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      },
    });

    await vi.runAllTimersAsync();
  } finally {
    vi.useRealTimers();
  }
}

async function waitForRunCleanup(childSessionKey: string) {
  await waitForSessionsSpawnEvent("run cleanup bookkeeping", () => {
    const run = getLatestSubagentRunByChildSessionKey(childSessionKey);
    return run?.cleanupCompletedAt != null;
  });
}

describe("openclaw-tools: subagents (sessions_spawn lifecycle)", () => {
  beforeEach(async () => {
    await bundleMcpRuntimeTesting.resetSessionMcpRuntimeManager();
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      messages: {
        queue: {
          debounceMs: 0,
        },
      },
    });
    resetSubagentRegistryForTests({ persist: false });
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setSessionsSpawnHookRunnerOverride({
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawning" ||
        hookName === "subagent_spawned" ||
        hookName === "subagent_ended",
      runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
    });
    callGatewayMock.mockClear();
  });

  afterEach(async () => {
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests({ persist: false });
    await bundleMcpRuntimeTesting.resetSessionMcpRuntimeManager();
  });

  afterAll(() => {
    if (fastModeEnv.previous === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = fastModeEnv.previous;
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
    const patchCalls: Array<{ key?: string; label?: string }> = [];

    const ctx = setupSessionsSpawnGatewayMock({
      includeSessionsList: true,
      includeChatHistory: true,
      onSessionsPatch: (params) => {
        const rec = params as { key?: string; label?: string } | undefined;
        patchCalls.push({ key: rec?.key, label: rec?.label });
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call2",
      label: "my-task",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitForSessionsSpawnEvent(
      "subagent wait, label patch, and main agent trigger",
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        patchCalls.some((call) => call.label === "my-task") &&
        ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    await waitForRunCleanup(child.sessionKey);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    const labelPatch = patchCalls.find((call) => call.label === "my-task");
    expect(labelPatch?.key).toBe(child.sessionKey);
    expect(labelPatch?.label).toBe("my-task");

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger (not "Sub-agent announce step." anymore)
    const second = agentCalls[1]?.params as { sessionKey?: string; message?: string } | undefined;
    expect(second?.sessionKey).toBe("agent:main:main");
    expect(second?.message).toContain("subagent task");

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("gives native child agent startup enough gateway request time", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      agentWaitResult: { status: "ok", startedAt: 1000, endedAt: 2000 },
    });
    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    const result = await tool.execute("call-start-timeout", {
      task: "do thing",
      runTimeoutSeconds: 120,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: expect.any(String),
    });
    const childAgentCall = ctx.calls.find((call) => {
      const params = call.params as { lane?: string } | undefined;
      return call.method === "agent" && params?.lane === "subagent";
    });
    expect(childAgentCall?.timeoutMs).toBe(125_000);
  });

  it("sessions_spawn retires bundle MCP runtime when run-mode cleanup completes", async () => {
    let resumeAnnounceFlow: ((value: boolean) => void) | undefined;
    let announceFlowStarted: (() => void) | undefined;
    const announceFlowStartedPromise = new Promise<void>((resolve) => {
      announceFlowStarted = resolve;
    });
    const announceFlowGate = new Promise<boolean>((resolve) => {
      resumeAnnounceFlow = resolve;
    });
    setSessionsSpawnAnnounceFlowOverride(async () => {
      announceFlowStarted?.();
      return await announceFlowGate;
    });
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      agentWaitResult: { status: "ok", startedAt: 3000, endedAt: 4000 },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-mcp-retire",
      cleanup: "keep",
    });

    await announceFlowStartedPromise;
    const child = ctx.getChild();
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    await getOrCreateSessionMcpRuntime({
      sessionId: "session:subagent:mcp-retire",
      sessionKey: child.sessionKey,
      workspaceDir: "/tmp/openclaw-subagent-mcp-retire",
      cfg: { mcp: { servers: {} } } as Parameters<typeof getOrCreateSessionMcpRuntime>[0]["cfg"],
    });
    expect(bundleMcpRuntimeTesting.getCachedSessionIds()).toContain("session:subagent:mcp-retire");

    resumeAnnounceFlow?.(true);
    await waitForRunCleanup(child.sessionKey);
    await waitForSessionsSpawnEvent(
      "bundle MCP runtime retirement",
      () => !bundleMcpRuntimeTesting.getCachedSessionIds().includes("session:subagent:mcp-retire"),
    );
  });

  it("sessions_spawn runs cleanup via lifecycle events", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1",
      cleanup: "delete",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await emitLifecycleEndAndFlush({
      runId: child.runId,
      startedAt: 1234,
      endedAt: 2345,
    });

    await waitForSessionsSpawnEvent(
      "lifecycle cleanup",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2 && Boolean(deletedKey),
    );

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    const first = agentCalls[0]?.params as
      | {
          lane?: string;
          deliver?: boolean;
          sessionKey?: string;
          channel?: string;
        }
      | undefined;
    expect(first?.lane).toBe("subagent");
    expect(first?.deliver).toBe(false);
    expect(first?.channel).toBe("discord");
    expect(first?.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    const second = agentCalls[1]?.params as
      | {
          sessionKey?: string;
          message?: string;
          deliver?: boolean;
        }
      | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);
    expect(second?.message).toContain("subagent task");

    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn deletes session when cleanup=delete via agent.wait", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
      agentWaitResult: { status: "ok", startedAt: 3000, endedAt: 4000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1b",
      cleanup: "delete",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitForSessionsSpawnEvent("agent.wait called for child run", () =>
      ctx.waitCalls.some((call) => call.runId === child.runId),
    );
    await waitForSessionsSpawnEvent(
      "main agent cleanup trigger",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    await waitForSessionsSpawnEvent("delete cleanup", () => Boolean(deletedKey));

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger
    const second = agentCalls[1]?.params as { sessionKey?: string; deliver?: boolean } | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    // Session should be deleted
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn records timeout when agent.wait returns timeout", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      chatHistoryText: "still working",
      agentWaitResult: { status: "timeout", startedAt: 6000, endedAt: 7000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-timeout",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    const childSessionKey = child.sessionKey;

    await waitForSessionsSpawnEvent(
      "timeout outcome",
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status === "timeout",
    );
    await waitForRunCleanup(childSessionKey);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status).toBe("timeout");
  });

  it("sessions_spawn uses the target agent's bound account for a Matrix room-bound route", async () => {
    const boundRoom = "!exampleRoomId:example.org";
    expect(
      await executeBoundAccountSpawn({
        callId: "call-bound-account",
        agentId: "bot-alpha",
        context: {
          agentSessionKey: "main",
          agentChannel: "matrix",
          agentAccountId: "bot-beta",
          agentTo: boundRoom,
        },
        bindings: [
          {
            type: "route",
            agentId: "bot-alpha",
            match: {
              channel: "matrix",
              peer: {
                kind: "channel",
                id: boundRoom,
              },
              accountId: "bot-alpha",
            },
          },
        ],
      }),
    ).toBe("bot-alpha");
  });

  it("sessions_spawn announces with requester accountId", async () => {
    const ctx = setupSessionsSpawnGatewayMock({});

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      agentAccountId: "kev",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-announce-account",
      cleanup: "keep",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    await emitLifecycleEndAndFlush({
      runId: child.runId,
      startedAt: 1000,
      endedAt: 2000,
    });

    await waitForSessionsSpawnEvent(
      "account-aware lifecycle announce",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    await waitForRunCleanup(child.sessionKey);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const announceParams = agentCalls[1]?.params as
      | { accountId?: string; channel?: string; deliver?: boolean }
      | undefined;
    expect(announceParams?.deliver).toBe(false);
    expect(announceParams?.channel).toBeUndefined();
    expect(announceParams?.accountId).toBeUndefined();
  });
});
