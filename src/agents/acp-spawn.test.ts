import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpInitializeSessionInput } from "../acp/control-plane/manager.types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import {
  __testing as sessionBindingServiceTesting,
  registerSessionBindingAdapter,
  type SessionBindingAdapterCapabilities,
  type SessionBindingPlacement,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";

function createDefaultSpawnConfig(): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex"],
    },
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    channels: {
      discord: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
    },
  };
}

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const closeSessionMock = vi.fn();
  const initializeSessionMock = vi.fn();
  const getAcpSessionManagerMock = vi.fn();
  const startAcpSpawnParentStreamRelayMock = vi.fn();
  const resolveAcpSpawnStreamLogPathMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  const resolveStorePathMock = vi.fn();
  const resolveSessionTranscriptFileMock = vi.fn();
  const areHeartbeatsEnabledMock = vi.fn();
  const getChannelPluginMock = vi.fn();
  const getLoadedChannelPluginMock = vi.fn();
  const normalizeChannelIdMock = vi.fn((channelId: string) => {
    const normalized = channelId.trim().toLowerCase();
    return normalized || null;
  });
  const cleanupFailedAcpSpawnMock = vi.fn();
  const createRunningTaskRunMock = vi.fn();
  const state = {
    cfg: createDefaultSpawnConfig(),
  };
  return {
    callGatewayMock,
    sessionBindingBindMock,
    sessionBindingUnbindMock,
    sessionBindingResolveByConversationMock,
    sessionBindingListBySessionMock,
    closeSessionMock,
    initializeSessionMock,
    getAcpSessionManagerMock,
    startAcpSpawnParentStreamRelayMock,
    resolveAcpSpawnStreamLogPathMock,
    loadSessionStoreMock,
    resolveStorePathMock,
    resolveSessionTranscriptFileMock,
    areHeartbeatsEnabledMock,
    getChannelPluginMock,
    getLoadedChannelPluginMock,
    normalizeChannelIdMock,
    cleanupFailedAcpSpawnMock,
    createRunningTaskRunMock,
    state,
  };
});

vi.mock("../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: hoisted.getAcpSessionManagerMock,
}));

vi.mock("../acp/control-plane/spawn.js", () => ({
  cleanupFailedAcpSpawn: hoisted.cleanupFailedAcpSpawnMock,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: hoisted.getChannelPluginMock,
  getLoadedChannelPlugin: hoisted.getLoadedChannelPluginMock,
  normalizeChannelId: hoisted.normalizeChannelIdMock,
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: hoisted.resolveStorePathMock,
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: hoisted.loadSessionStoreMock,
}));

vi.mock("../config/sessions/transcript.js", () => ({
  resolveSessionTranscriptFile: hoisted.resolveSessionTranscriptFileMock,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  areHeartbeatsEnabled: hoisted.areHeartbeatsEnabledMock,
}));

vi.mock("../tasks/detached-task-runtime.js", () => ({
  createRunningTaskRun: hoisted.createRunningTaskRunMock,
}));

vi.mock("./acp-spawn-parent-stream.js", () => ({
  resolveAcpSpawnStreamLogPath: hoisted.resolveAcpSpawnStreamLogPathMock,
  startAcpSpawnParentStreamRelay: hoisted.startAcpSpawnParentStreamRelayMock,
}));

const { isSpawnAcpAcceptedResult, spawnAcpDirect } = await import("./acp-spawn.js");
type SpawnRequest = Parameters<typeof spawnAcpDirect>[0];
type SpawnContext = Parameters<typeof spawnAcpDirect>[1];
type SpawnResult = Awaited<ReturnType<typeof spawnAcpDirect>>;
type AgentCallParams = {
  deliver?: boolean;
  channel?: string;
  to?: string;
  threadId?: string;
};
type CrossAgentWorkspaceFixture = {
  workspaceRoot: string;
  mainWorkspace: string;
  targetWorkspace: string;
};

function replaceSpawnConfig(next: OpenClawConfig): void {
  const current = hoisted.state.cfg as Record<string, unknown>;
  for (const key of Object.keys(current)) {
    delete current[key];
  }
  Object.assign(current, next);
  setRuntimeConfigSnapshot(hoisted.state.cfg);
}

function createSessionBindingCapabilities(): SessionBindingAdapterCapabilities {
  return {
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] satisfies SessionBindingPlacement[],
  };
}

function createSessionBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:child-thread",
    targetSessionKey: "agent:codex:acp:s1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "child-thread",
      parentConversationId: "parent-channel",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      agentId: "codex",
      boundBy: "system",
    },
    ...overrides,
  };
}

function createRelayHandle(overrides?: {
  dispose?: ReturnType<typeof vi.fn>;
  notifyStarted?: ReturnType<typeof vi.fn>;
}) {
  return {
    dispose: overrides?.dispose ?? vi.fn(),
    notifyStarted: overrides?.notifyStarted ?? vi.fn(),
  };
}

function expectResolvedIntroTextInBindMetadata(): void {
  const callWithMetadata = hoisted.sessionBindingBindMock.mock.calls.find(
    (call: unknown[]) =>
      typeof (call[0] as { metadata?: { introText?: unknown } } | undefined)?.metadata
        ?.introText === "string",
  );
  const introText =
    (callWithMetadata?.[0] as { metadata?: { introText?: string } } | undefined)?.metadata
      ?.introText ?? "";
  expect(introText.includes("session ids: pending (available after the first reply)")).toBe(false);
}

function createSpawnRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    task: "Investigate flaky tests",
    agentId: "codex",
    mode: "run",
    ...overrides,
  };
}

function createRequesterContext(overrides?: Partial<SpawnContext>): SpawnContext {
  return {
    agentSessionKey: "agent:main:telegram:direct:6098642967",
    agentChannel: "telegram",
    agentAccountId: "default",
    agentTo: "telegram:6098642967",
    agentThreadId: "1",
    ...overrides,
  };
}

async function createCrossAgentWorkspaceFixture(options?: {
  targetDirName?: string;
  createTargetWorkspace?: boolean;
}): Promise<CrossAgentWorkspaceFixture> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-spawn-"));
  const mainWorkspace = path.join(workspaceRoot, "main");
  const targetWorkspace = path.join(workspaceRoot, options?.targetDirName?.trim() || "claude-code");
  await fs.mkdir(mainWorkspace, { recursive: true });
  if (options?.createTargetWorkspace !== false) {
    await fs.mkdir(targetWorkspace, { recursive: true });
  }
  return {
    workspaceRoot,
    mainWorkspace,
    targetWorkspace,
  };
}

function configureCrossAgentWorkspaceSpawn(fixture: CrossAgentWorkspaceFixture): void {
  replaceSpawnConfig({
    ...hoisted.state.cfg,
    acp: {
      ...hoisted.state.cfg.acp,
      allowedAgents: ["codex", "claude-code"],
    },
    agents: {
      list: [
        {
          id: "main",
          default: true,
          workspace: fixture.mainWorkspace,
        },
        {
          id: "claude-code",
          workspace: fixture.targetWorkspace,
        },
      ],
    },
  });
}

function findAgentGatewayCall(): { method?: string; params?: Record<string, unknown> } | undefined {
  return hoisted.callGatewayMock.mock.calls
    .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
    .find((request) => request.method === "agent");
}

function expectFailedSpawn(
  result: SpawnResult,
  status?: "error" | "forbidden",
): Extract<SpawnResult, { status: "error" | "forbidden" }> {
  if (status) {
    expect(result.status).toBe(status);
  } else {
    expect(result.status).not.toBe("accepted");
  }
  if (result.status === "accepted") {
    throw new Error("Expected ACP spawn to fail");
  }
  return result;
}

function expectAcceptedSpawn(result: SpawnResult): Extract<SpawnResult, { status: "accepted" }> {
  expect(result.status).toBe("accepted");
  if (!isSpawnAcpAcceptedResult(result)) {
    throw new Error("Expected ACP spawn to be accepted");
  }
  return result;
}

function expectAgentGatewayCall(overrides: AgentCallParams): void {
  const agentCall = findAgentGatewayCall();
  expect(agentCall?.params?.deliver).toBe(overrides.deliver);
  expect(agentCall?.params?.channel).toBe(overrides.channel);
  expect(agentCall?.params?.to).toBe(overrides.to);
  expect(agentCall?.params?.threadId).toBe(overrides.threadId);
}

function resolveMatrixRoomTargetForTest(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^(?:matrix:)?(?:channel:|room:)/iu, "").trim();
  return normalized || undefined;
}

function enableMatrixAcpThreadBindings(): void {
  replaceSpawnConfig({
    ...hoisted.state.cfg,
    channels: {
      ...hoisted.state.cfg.channels,
      matrix: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
    },
  });
  const matrixPlugin = {
    messaging: {
      resolveDeliveryTarget: ({
        conversationId,
        parentConversationId,
      }: {
        conversationId: string;
        parentConversationId?: string;
      }) => {
        const parent = resolveMatrixRoomTargetForTest(parentConversationId);
        const child = conversationId.trim();
        return parent ? { to: `room:${parent}`, threadId: child } : { to: `room:${child}` };
      },
      resolveInboundConversation: ({
        to,
        threadId,
      }: {
        to?: string;
        threadId?: string | number;
      }) => {
        const parent = resolveMatrixRoomTargetForTest(to);
        const thread = threadId != null ? String(threadId).trim() : "";
        return thread && parent
          ? { conversationId: thread, parentConversationId: parent }
          : parent
            ? { conversationId: parent }
            : undefined;
      },
    },
  };
  hoisted.getChannelPluginMock.mockImplementation((channelId: string) =>
    channelId === "matrix" ? matrixPlugin : undefined,
  );
  hoisted.getLoadedChannelPluginMock.mockImplementation((channelId: string) =>
    channelId === "matrix" ? matrixPlugin : undefined,
  );
  registerSessionBindingAdapter({
    channel: "matrix",
    accountId: "default",
    capabilities: createSessionBindingCapabilities(),
    bind: async (input) => await hoisted.sessionBindingBindMock(input),
    listBySession: (targetSessionKey) => hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref) => hoisted.sessionBindingResolveByConversationMock(ref),
    unbind: async (input) => await hoisted.sessionBindingUnbindMock(input),
  });
}

function enableLineCurrentConversationBindings(): void {
  replaceSpawnConfig({
    ...hoisted.state.cfg,
    channels: {
      ...hoisted.state.cfg.channels,
      line: {
        threadBindings: {
          enabled: true,
          spawnAcpSessions: true,
        },
      },
    },
  });
  const linePlugin = {
    messaging: {
      resolveInboundConversation: ({
        conversationId,
        to,
      }: {
        conversationId?: string;
        to?: string;
      }) => {
        const source = (conversationId ?? to ?? "").trim();
        const normalized =
          source.match(/^line:(?:(?:user|group|room):)?(.+)$/i)?.[1]?.trim() ?? source;
        return normalized ? { conversationId: normalized } : undefined;
      },
    },
  };
  hoisted.getChannelPluginMock.mockImplementation((channelId: string) =>
    channelId === "line" ? linePlugin : undefined,
  );
  hoisted.getLoadedChannelPluginMock.mockImplementation((channelId: string) =>
    channelId === "line" ? linePlugin : undefined,
  );
  registerSessionBindingAdapter({
    channel: "line",
    accountId: "default",
    capabilities: {
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"] satisfies SessionBindingPlacement[],
    },
    bind: async (input) => await hoisted.sessionBindingBindMock(input),
    listBySession: (targetSessionKey) => hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref) => hoisted.sessionBindingResolveByConversationMock(ref),
    unbind: async (input) => await hoisted.sessionBindingUnbindMock(input),
  });
}

function enableTelegramCurrentConversationBindings(): void {
  replaceSpawnConfig({
    ...hoisted.state.cfg,
    channels: {
      ...hoisted.state.cfg.channels,
      telegram: {
        threadBindings: {
          enabled: true,
        },
      },
    },
  });
  const telegramPlugin = {
    messaging: {
      resolveInboundConversation: ({
        conversationId,
        to,
        threadId,
      }: {
        conversationId?: string;
        to?: string;
        threadId?: string | number;
      }) => {
        const source = (conversationId ?? to ?? "").trim();
        const normalized = source.replace(/^telegram:(?:group:|channel:|direct:)?/i, "");
        const explicitThreadId = threadId == null ? "" : String(threadId).trim();
        if (/^-?\d+$/.test(normalized) && /^\d+$/.test(explicitThreadId)) {
          return { conversationId: `${normalized}:topic:${explicitThreadId}` };
        }
        const topicMatch = /^(-?\d+):topic:(\d+)$/i.exec(normalized);
        if (topicMatch?.[1] && topicMatch[2]) {
          return { conversationId: `${topicMatch[1]}:topic:${topicMatch[2]}` };
        }
        return /^-?\d+$/.test(normalized) ? { conversationId: normalized } : undefined;
      },
    },
  };
  hoisted.getChannelPluginMock.mockImplementation((channelId: string) =>
    channelId === "telegram" ? telegramPlugin : undefined,
  );
  hoisted.getLoadedChannelPluginMock.mockImplementation((channelId: string) =>
    channelId === "telegram" ? telegramPlugin : undefined,
  );
  registerSessionBindingAdapter({
    channel: "telegram",
    accountId: "default",
    capabilities: {
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"] satisfies SessionBindingPlacement[],
    },
    bind: async (input) => await hoisted.sessionBindingBindMock(input),
    listBySession: (targetSessionKey) => hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref) => hoisted.sessionBindingResolveByConversationMock(ref),
    unbind: async (input) => await hoisted.sessionBindingUnbindMock(input),
  });
}

describe("spawnAcpDirect", () => {
  beforeEach(() => {
    replaceSpawnConfig(createDefaultSpawnConfig());
    hoisted.areHeartbeatsEnabledMock.mockReset().mockReturnValue(true);
    hoisted.getChannelPluginMock.mockReset().mockReturnValue(undefined);
    hoisted.getLoadedChannelPluginMock.mockReset().mockReturnValue(undefined);
    hoisted.cleanupFailedAcpSpawnMock.mockReset().mockResolvedValue(undefined);
    hoisted.createRunningTaskRunMock.mockReset().mockReturnValue(undefined);

    hoisted.callGatewayMock.mockReset();
    hoisted.callGatewayMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "sessions.patch") {
        return { ok: true };
      }
      if (args.method === "agent") {
        return { runId: "run-1" };
      }
      if (args.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    hoisted.closeSessionMock.mockReset().mockResolvedValue({
      runtimeClosed: true,
      metaCleared: false,
    });
    hoisted.getAcpSessionManagerMock.mockReset().mockReturnValue({
      initializeSession: async (params: AcpInitializeSessionInput) =>
        await hoisted.initializeSessionMock(params),
      closeSession: async (params: unknown) => await hoisted.closeSessionMock(params),
    });
    hoisted.initializeSessionMock.mockReset().mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as AcpInitializeSessionInput;
      const runtimeSessionName = `${args.sessionKey}:runtime`;
      const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
      return {
        runtime: {
          close: vi.fn().mockResolvedValue(undefined),
        },
        handle: {
          sessionKey: args.sessionKey,
          backend: "acpx",
          runtimeSessionName,
          ...(cwd ? { cwd } : {}),
          agentSessionId: "codex-inner-1",
          backendSessionId: "acpx-1",
        },
        meta: {
          backend: "acpx",
          agent: args.agent,
          runtimeSessionName,
          ...(cwd ? { runtimeOptions: { cwd }, cwd } : {}),
          identity: {
            state: "pending",
            source: "ensure",
            acpxSessionId: "acpx-1",
            agentSessionId: "codex-inner-1",
            lastUpdatedAt: Date.now(),
          },
          mode: args.mode,
          state: "idle",
          lastActivityAt: Date.now(),
        },
      };
    });

    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(
        async (input: {
          targetSessionKey: string;
          conversation: { accountId: string };
          metadata?: Record<string, unknown>;
        }) =>
          createSessionBinding({
            targetSessionKey: input.targetSessionKey,
            conversation: {
              channel: "discord",
              accountId: input.conversation.accountId,
              conversationId: "child-thread",
              parentConversationId: "parent-channel",
            },
            metadata: {
              boundBy:
                typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
              agentId: "codex",
              webhookId: "wh-1",
            },
          }),
      );
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "default",
      capabilities: createSessionBindingCapabilities(),
      bind: async (input) => await hoisted.sessionBindingBindMock(input),
      listBySession: (targetSessionKey) =>
        hoisted.sessionBindingListBySessionMock(targetSessionKey),
      resolveByConversation: (ref) => hoisted.sessionBindingResolveByConversationMock(ref),
      unbind: async (input) => await hoisted.sessionBindingUnbindMock(input),
    });
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockImplementation(() => createRelayHandle());
    hoisted.resolveAcpSpawnStreamLogPathMock
      .mockReset()
      .mockReturnValue("/tmp/sess-main.acp-stream.jsonl");
    hoisted.resolveStorePathMock.mockReset().mockReturnValue("/tmp/codex-sessions.json");
    hoisted.loadSessionStoreMock.mockReset().mockImplementation(() => {
      const store: Record<string, { sessionId: string; updatedAt: number }> = {};
      return new Proxy(store, {
        get(_target, prop) {
          if (typeof prop === "string" && prop.startsWith("agent:codex:acp:")) {
            return { sessionId: "sess-123", updatedAt: Date.now() };
          }
          return undefined;
        },
      });
    });
    hoisted.resolveSessionTranscriptFileMock
      .mockReset()
      .mockImplementation(async (params: unknown) => {
        const typed = params as { threadId?: string };
        const sessionFile = typed.threadId
          ? `/tmp/agents/codex/sessions/sess-123-topic-${typed.threadId}.jsonl`
          : "/tmp/agents/codex/sessions/sess-123.jsonl";
        return {
          sessionFile,
          sessionEntry: {
            sessionId: "sess-123",
            updatedAt: Date.now(),
            sessionFile,
          },
        };
      });
  });

  afterEach(() => {
    sessionBindingServiceTesting.resetSessionBindingAdaptersForTests();
    clearRuntimeConfigSnapshot();
  });

  it("spawns ACP session, binds a new thread, and dispatches initial task", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
        agentThreadId: "requester-thread",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.childSessionKey).toMatch(/^agent:codex:acp:/);
    expect(accepted.runId).toBe("run-1");
    expect(accepted.mode).toBe("session");
    const patchCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "sessions.patch");
    expect(patchCall?.params).toMatchObject({
      key: accepted.childSessionKey,
      spawnedBy: "agent:main:main",
    });
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "session",
        placement: "child",
      }),
    );
    expectResolvedIntroTextInBindMetadata();

    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.sessionKey).toMatch(/^agent:codex:acp:/);
    expect(agentCall?.params?.to).toBe("channel:child-thread");
    expect(agentCall?.params?.threadId).toBe("child-thread");
    expect(agentCall?.params?.deliver).toBe(true);
    expect(hoisted.initializeSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringMatching(/^agent:codex:acp:/),
        agent: "codex",
        mode: "persistent",
      }),
    );
    const transcriptCalls = hoisted.resolveSessionTranscriptFileMock.mock.calls.map(
      (call: unknown[]) => call[0] as { threadId?: string },
    );
    expect(transcriptCalls).toHaveLength(2);
    expect(transcriptCalls[0]?.threadId).toBeUndefined();
    expect(transcriptCalls[1]?.threadId).toBe("child-thread");
  });

  it("spawns Matrix thread-bound ACP sessions from top-level room targets", async () => {
    enableMatrixAcpThreadBindings();
    hoisted.sessionBindingBindMock.mockImplementationOnce(
      async (input: {
        targetSessionKey: string;
        conversation: { accountId: string; conversationId: string; parentConversationId?: string };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBinding({
          targetSessionKey: input.targetSessionKey,
          conversation: {
            channel: "matrix",
            accountId: input.conversation.accountId,
            conversationId: "child-thread",
            parentConversationId: input.conversation.parentConversationId ?? "!room:example",
          },
          metadata: {
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
            agentId: "codex",
            webhookId: "wh-1",
          },
        }),
    );

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:matrix:channel:!room:example",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: "channel:!room:example",
      },
    );
    expect(result.status, JSON.stringify(result)).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "child",
        conversation: expect.objectContaining({
          channel: "matrix",
          accountId: "default",
          conversationId: "!room:example",
        }),
      }),
    );
    expectAgentGatewayCall({
      deliver: true,
      channel: "matrix",
      to: "room:!room:example",
      threadId: "child-thread",
    });
  });

  it("keeps canonical Matrix room casing for ACP thread bindings", async () => {
    enableMatrixAcpThreadBindings();
    hoisted.sessionBindingBindMock.mockImplementationOnce(
      async (input: {
        targetSessionKey: string;
        conversation: { accountId: string; conversationId: string; parentConversationId?: string };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBinding({
          targetSessionKey: input.targetSessionKey,
          conversation: {
            channel: "matrix",
            accountId: input.conversation.accountId,
            conversationId: "child-thread",
            parentConversationId: input.conversation.parentConversationId ?? "!Room:Example.org",
          },
          metadata: {
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
            agentId: "codex",
            webhookId: "wh-1",
          },
        }),
    );

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:matrix:channel:!room:example.org",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: "room:!Room:Example.org",
        agentGroupId: "!room:example.org",
      },
    );

    expect(result.status, JSON.stringify(result)).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "child",
        conversation: expect.objectContaining({
          channel: "matrix",
          accountId: "default",
          conversationId: "!Room:Example.org",
        }),
      }),
    );
    expectAgentGatewayCall({
      deliver: true,
      channel: "matrix",
      to: "room:!Room:Example.org",
      threadId: "child-thread",
    });
  });

  it("preserves Matrix parent room casing when binding from an existing thread", async () => {
    enableMatrixAcpThreadBindings();
    hoisted.sessionBindingBindMock.mockImplementationOnce(
      async (input: {
        targetSessionKey: string;
        conversation: { accountId: string; conversationId: string; parentConversationId?: string };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBinding({
          targetSessionKey: input.targetSessionKey,
          conversation: {
            channel: "matrix",
            accountId: input.conversation.accountId,
            conversationId: "child-thread",
            parentConversationId: input.conversation.parentConversationId ?? "!Room:Example.org",
          },
          metadata: {
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
            agentId: "codex",
            webhookId: "wh-1",
          },
        }),
    );

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:matrix:channel:!room:example.org:thread:$thread-root",
        agentChannel: "matrix",
        agentAccountId: "default",
        agentTo: "room:!Room:Example.org",
        agentThreadId: "$thread-root",
        agentGroupId: "!room:example.org",
      },
    );

    expect(result.status, JSON.stringify(result)).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "child",
        conversation: expect.objectContaining({
          channel: "matrix",
          accountId: "default",
          conversationId: "$thread-root",
          parentConversationId: "!Room:Example.org",
        }),
      }),
    );
    expectAgentGatewayCall({
      deliver: true,
      channel: "matrix",
      to: "room:!Room:Example.org",
      threadId: "child-thread",
    });
  });

  it("uses the target agent workspace for cross-agent ACP spawns when cwd is omitted", async () => {
    const fixture = await createCrossAgentWorkspaceFixture();
    try {
      configureCrossAgentWorkspaceSpawn(fixture);

      const result = await spawnAcpDirect(
        {
          task: "Inspect the queue owner state",
          agentId: "claude-code",
          mode: "run",
        },
        {
          agentSessionKey: "agent:main:main",
        },
      );

      expect(result.status).toBe("accepted");
      expect(hoisted.initializeSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: expect.stringMatching(/^agent:claude-code:acp:/),
          agent: "claude-code",
          cwd: fixture.targetWorkspace,
        }),
      );
    } finally {
      await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it("falls back to backend default cwd when the inherited target workspace does not exist", async () => {
    const fixture = await createCrossAgentWorkspaceFixture({
      targetDirName: "claude-code-missing",
      createTargetWorkspace: false,
    });
    try {
      configureCrossAgentWorkspaceSpawn(fixture);

      const result = await spawnAcpDirect(
        {
          task: "Inspect the queue owner state",
          agentId: "claude-code",
          mode: "run",
        },
        {
          agentSessionKey: "agent:main:main",
        },
      );

      expect(result.status).toBe("accepted");
      expect(hoisted.initializeSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: expect.stringMatching(/^agent:claude-code:acp:/),
          agent: "claude-code",
          cwd: undefined,
        }),
      );
    } finally {
      await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it("surfaces non-missing target workspace access failures instead of silently dropping cwd", async () => {
    const fixture = await createCrossAgentWorkspaceFixture();
    const accessSpy = vi.spyOn(fs, "access");
    try {
      configureCrossAgentWorkspaceSpawn(fixture);

      accessSpy.mockRejectedValueOnce(
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      );

      const result = await spawnAcpDirect(
        {
          task: "Inspect the queue owner state",
          agentId: "claude-code",
          mode: "run",
        },
        {
          agentSessionKey: "agent:main:main",
        },
      );

      expect(result).toEqual({
        status: "error",
        errorCode: "cwd_resolution_failed",
        error: "permission denied",
      });
      expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
    } finally {
      accessSpy.mockRestore();
      await fs.rm(fixture.workspaceRoot, { recursive: true, force: true });
    }
  });

  it("binds LINE ACP sessions to the current conversation when the channel has no native threads", async () => {
    enableLineCurrentConversationBindings();
    hoisted.sessionBindingBindMock.mockImplementationOnce(
      async (input: {
        targetSessionKey: string;
        conversation: { accountId: string; conversationId: string };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBinding({
          targetSessionKey: input.targetSessionKey,
          conversation: {
            channel: "line",
            accountId: input.conversation.accountId,
            conversationId: input.conversation.conversationId,
          },
          metadata: {
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
            agentId: "codex",
          },
        }),
    );

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:line:direct:U1234567890abcdef1234567890abcdef",
        agentChannel: "line",
        agentAccountId: "default",
        agentTo: "U1234567890abcdef1234567890abcdef",
      },
    );

    expect(result.status, JSON.stringify(result)).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "line",
          accountId: "default",
          conversationId: "U1234567890abcdef1234567890abcdef",
        }),
      }),
    );
    expectAgentGatewayCall({
      deliver: true,
      channel: "line",
      to: "U1234567890abcdef1234567890abcdef",
      threadId: undefined,
    });
    const transcriptCalls = hoisted.resolveSessionTranscriptFileMock.mock.calls.map(
      (call: unknown[]) => call[0] as { threadId?: string },
    );
    expect(transcriptCalls).toHaveLength(1);
    expect(transcriptCalls[0]?.threadId).toBeUndefined();
  });

  it("binds ACP sessions through the configured default account when accountId is omitted", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      channels: {
        ...hoisted.state.cfg.channels,
        custom: {
          defaultAccount: "work",
          threadBindings: {
            enabled: true,
            spawnAcpSessions: true,
          },
          accounts: {
            work: {
              threadBindings: {
                enabled: true,
                spawnAcpSessions: true,
              },
            },
          },
        },
      },
    });
    registerSessionBindingAdapter({
      channel: "custom",
      accountId: "work",
      capabilities: {
        bindSupported: true,
        unbindSupported: true,
        placements: ["current"] satisfies SessionBindingPlacement[],
      },
      bind: async (input) => await hoisted.sessionBindingBindMock(input),
      listBySession: (targetSessionKey) =>
        hoisted.sessionBindingListBySessionMock(targetSessionKey),
      resolveByConversation: (ref) => hoisted.sessionBindingResolveByConversationMock(ref),
      unbind: async (input) => await hoisted.sessionBindingUnbindMock(input),
    });
    hoisted.sessionBindingBindMock.mockImplementationOnce(
      async (input: {
        targetSessionKey: string;
        conversation: { accountId: string; conversationId: string };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBinding({
          targetSessionKey: input.targetSessionKey,
          conversation: {
            channel: "custom",
            accountId: input.conversation.accountId,
            conversationId: input.conversation.conversationId,
          },
          metadata: {
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
            agentId: "codex",
          },
        }),
    );

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:custom:channel:123456",
        agentChannel: "custom",
        agentTo: "channel:123456",
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "custom",
          accountId: "work",
          conversationId: "123456",
        }),
      }),
    );
    expectAgentGatewayCall({
      deliver: true,
      channel: "custom",
      to: "channel:123456",
      threadId: undefined,
    });
    expect(findAgentGatewayCall()?.params?.accountId).toBe("work");
  });

  it("uses the target agent's bound account for cross-agent ACP thread spawns", async () => {
    const boundRoom = "!room:example.org";
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      acp: {
        ...hoisted.state.cfg.acp,
        allowedAgents: ["codex", "bot-alpha"],
      },
      channels: {
        ...hoisted.state.cfg.channels,
        matrix: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: true,
          },
          accounts: {
            "bot-alpha": {
              threadBindings: {
                enabled: true,
                spawnAcpSessions: true,
              },
            },
          },
        },
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
    });
    registerSessionBindingAdapter({
      channel: "matrix",
      accountId: "bot-alpha",
      capabilities: createSessionBindingCapabilities(),
      bind: async (input) => await hoisted.sessionBindingBindMock(input),
      listBySession: (targetSessionKey) =>
        hoisted.sessionBindingListBySessionMock(targetSessionKey),
      resolveByConversation: (ref) => hoisted.sessionBindingResolveByConversationMock(ref),
      unbind: async (input) => await hoisted.sessionBindingUnbindMock(input),
    });
    hoisted.sessionBindingBindMock.mockImplementationOnce(
      async (input: {
        targetSessionKey: string;
        conversation: {
          accountId: string;
          conversationId: string;
          parentConversationId?: string;
        };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBinding({
          targetSessionKey: input.targetSessionKey,
          conversation: {
            channel: "matrix",
            accountId: input.conversation.accountId,
            conversationId: input.conversation.conversationId,
            parentConversationId: input.conversation.parentConversationId,
          },
          metadata: {
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
            agentId: "bot-alpha",
          },
        }),
    );

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "bot-alpha",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:matrix:room:requester",
        agentChannel: "matrix",
        agentAccountId: "bot-beta",
        agentTo: `room:${boundRoom}`,
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "child",
        conversation: expect.objectContaining({
          channel: "matrix",
          accountId: "bot-alpha",
          conversationId: boundRoom,
        }),
      }),
    );
    expect(findAgentGatewayCall()?.params).toMatchObject({
      deliver: true,
      channel: "matrix",
      accountId: "bot-alpha",
      to: `room:${boundRoom}`,
    });
  });

  it.each([
    {
      name: "canonical line target",
      agentTo: "line:U1234567890abcdef1234567890abcdef",
      expectedConversationId: "U1234567890abcdef1234567890abcdef",
    },
    {
      name: "typed line user target",
      agentTo: "line:user:U1234567890abcdef1234567890abcdef",
      expectedConversationId: "U1234567890abcdef1234567890abcdef",
    },
    {
      name: "typed line group target",
      agentTo: "line:group:C1234567890abcdef1234567890abcdef",
      expectedConversationId: "C1234567890abcdef1234567890abcdef",
    },
    {
      name: "typed line room target",
      agentTo: "line:room:R1234567890abcdef1234567890abcdef",
      expectedConversationId: "R1234567890abcdef1234567890abcdef",
    },
  ])(
    "resolves LINE ACP conversation ids from $name",
    async ({ agentTo, expectedConversationId }) => {
      enableLineCurrentConversationBindings();
      hoisted.sessionBindingBindMock.mockImplementationOnce(
        async (input: {
          targetSessionKey: string;
          conversation: { accountId: string; conversationId: string };
          metadata?: Record<string, unknown>;
        }) =>
          createSessionBinding({
            targetSessionKey: input.targetSessionKey,
            conversation: {
              channel: "line",
              accountId: input.conversation.accountId,
              conversationId: input.conversation.conversationId,
            },
            metadata: {
              boundBy:
                typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
              agentId: "codex",
            },
          }),
      );

      const result = await spawnAcpDirect(
        {
          task: "Investigate flaky tests",
          agentId: "codex",
          mode: "session",
          thread: true,
        },
        {
          agentSessionKey: `agent:main:line:direct:${expectedConversationId}`,
          agentChannel: "line",
          agentAccountId: "default",
          agentTo,
        },
      );

      expect(result.status).toBe("accepted");
      expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
        expect.objectContaining({
          placement: "current",
          conversation: expect.objectContaining({
            channel: "line",
            accountId: "default",
            conversationId: expectedConversationId,
          }),
        }),
      );
    },
  );

  it("preserves LINE fallback conversation precedence when groupId is present", async () => {
    enableLineCurrentConversationBindings();
    hoisted.sessionBindingBindMock.mockImplementationOnce(
      async (input: {
        targetSessionKey: string;
        conversation: { accountId: string; conversationId: string };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBinding({
          targetSessionKey: input.targetSessionKey,
          conversation: {
            channel: "line",
            accountId: input.conversation.accountId,
            conversationId: input.conversation.conversationId,
          },
          metadata: {
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "system",
            agentId: "codex",
          },
        }),
    );

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:line:direct:R1234567890abcdef1234567890abcdef",
        agentChannel: "line",
        agentAccountId: "default",
        agentTo: "line:user:U1234567890abcdef1234567890abcdef",
        agentGroupId: "line:room:R1234567890abcdef1234567890abcdef",
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "line",
          accountId: "default",
          conversationId: "R1234567890abcdef1234567890abcdef",
        }),
      }),
    );
  });

  it.each([
    {
      name: "does not inline delivery for run-mode spawns from non-subagent requester sessions",
      ctx: createRequesterContext(),
      expectedAgentCall: {
        deliver: false,
        channel: undefined,
        to: undefined,
        threadId: undefined,
      } satisfies AgentCallParams,
      expectTranscriptPersistence: false,
    },
    {
      name: "does not inline delivery for run-mode spawns from subagent requester sessions",
      ctx: createRequesterContext({
        agentSessionKey: "agent:main:subagent:orchestrator",
        agentThreadId: undefined,
      }),
      expectedAgentCall: {
        deliver: false,
        channel: undefined,
        to: undefined,
        threadId: undefined,
      } satisfies AgentCallParams,
      expectTranscriptPersistence: false,
    },
  ])("$name", async ({ ctx, expectedAgentCall, expectTranscriptPersistence }) => {
    const result = await spawnAcpDirect(createSpawnRequest(), ctx);

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
    if (expectTranscriptPersistence) {
      expect(hoisted.resolveSessionTranscriptFileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "sess-123",
          storePath: "/tmp/codex-sessions.json",
          agentId: "codex",
        }),
      );
    }
    expectAgentGatewayCall(expectedAgentCall);
  });

  it("keeps ACP spawn running when session-file persistence fails", async () => {
    hoisted.resolveSessionTranscriptFileMock.mockRejectedValueOnce(new Error("disk full"));

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "run",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:6098642967",
        agentThreadId: "1",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:codex:acp:/);
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.sessionKey).toBe(result.childSessionKey);
  });

  it("includes cwd in ACP thread intro banner when provided at spawn time", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Check workspace",
        agentId: "codex",
        cwd: "/home/bob/clawd",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("cwd: /home/bob/clawd"),
        }),
      }),
    );
  });

  it("rejects disallowed ACP agents", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      acp: {
        enabled: true,
        backend: "acpx",
        allowedAgents: ["claudecode"],
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result).toMatchObject({
      status: "forbidden",
    });
  });

  it("requires an explicit ACP agent when no config default exists", async () => {
    const result = await spawnAcpDirect(
      {
        task: "hello",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(expectFailedSpawn(result, "error").error).toContain("set `acp.defaultAgent`");
  });

  it("fails fast when Discord ACP thread spawn is disabled", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnAcpSessions: false,
          },
        },
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
        thread: true,
        mode: "session",
      },
      {
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    expect(expectFailedSpawn(result, "error").error).toContain("spawnAcpSessions=true");
  });

  it("forbids ACP spawn from sandboxed requester sessions", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:parent",
      },
    );

    expect(expectFailedSpawn(result, "forbidden").error).toContain(
      "Sandboxed sessions cannot spawn ACP sessions",
    );
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
  });

  it('forbids sandbox="require" for runtime=acp', async () => {
    const result = await spawnAcpDirect(
      {
        task: "hello",
        agentId: "codex",
        sandbox: "require",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(expectFailedSpawn(result, "forbidden").error).toContain('sandbox="require"');
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
  });

  it('streams ACP progress to parent when streamTo="parent"', async () => {
    const firstHandle = createRelayHandle();
    const secondHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.streamLogPath).toBe("/tmp/sess-main.acp-stream.jsonl");
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    const agentCallIndex = hoisted.callGatewayMock.mock.calls.findIndex(
      (call: unknown[]) => (call[0] as { method?: string }).method === "agent",
    );
    const relayCallOrder = hoisted.startAcpSpawnParentStreamRelayMock.mock.invocationCallOrder[0];
    const agentCallOrder = hoisted.callGatewayMock.mock.invocationCallOrder[agentCallIndex];
    expect(agentCall?.params?.deliver).toBe(false);
    expect(typeof relayCallOrder).toBe("number");
    expect(typeof agentCallOrder).toBe("number");
    expect(relayCallOrder < agentCallOrder).toBe(true);
    expect(hoisted.startAcpSpawnParentStreamRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:main",
        agentId: "codex",
        logPath: "/tmp/sess-main.acp-stream.jsonl",
        emitStartNotice: false,
      }),
    );
    const relayRuns = hoisted.startAcpSpawnParentStreamRelayMock.mock.calls.map(
      (call: unknown[]) => (call[0] as { runId?: string }).runId,
    );
    expect(relayRuns).toContain(agentCall?.params?.idempotencyKey);
    expect(relayRuns).toContain(accepted.runId);
    expect(hoisted.resolveAcpSpawnStreamLogPathMock).toHaveBeenCalledWith({
      childSessionKey: expect.stringMatching(/^agent:codex:acp:/),
    });
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(firstHandle.notifyStarted).not.toHaveBeenCalled();
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
  });

  it("implicitly streams mode=run ACP spawns for subagent requester sessions", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    });
    const firstHandle = createRelayHandle();
    const secondHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);
    hoisted.loadSessionStoreMock.mockReset().mockImplementation(() => {
      const store: Record<
        string,
        { sessionId: string; updatedAt: number; deliveryContext?: unknown }
      > = {
        "agent:main:subagent:parent": {
          sessionId: "parent-sess-1",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "discord",
            to: "channel:parent-channel",
            accountId: "default",
          },
        },
      };
      return new Proxy(store, {
        get(target, prop) {
          if (typeof prop === "string" && prop.startsWith("agent:codex:acp:")) {
            return { sessionId: "sess-123", updatedAt: Date.now() };
          }
          return target[prop as keyof typeof target];
        },
      });
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:parent",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBe("/tmp/sess-main.acp-stream.jsonl");
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.deliver).toBe(false);
    expect(agentCall?.params?.channel).toBeUndefined();
    expect(agentCall?.params?.to).toBeUndefined();
    expect(agentCall?.params?.threadId).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:subagent:parent",
        agentId: "codex",
        logPath: "/tmp/sess-main.acp-stream.jsonl",
        deliveryContext: {
          channel: "discord",
          to: "channel:parent-channel",
          accountId: "default",
        },
        emitStartNotice: false,
      }),
    );
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
  });

  it("does not implicitly stream when heartbeat target is not session-local", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "discord",
            to: "channel:ops-room",
          },
        },
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:fixed-target",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("does not implicitly stream when session scope is global", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      session: {
        ...hoisted.state.cfg.session,
        scope: "global",
      },
      agents: {
        defaults: {
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:global-scope",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("does not implicitly stream for subagent requester sessions when heartbeat is disabled", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        list: [{ id: "main", heartbeat: { every: "30m" } }, { id: "research" }],
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:research:subagent:orchestrator",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("does not implicitly stream for subagent requester sessions when heartbeat cadence is invalid", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        list: [
          {
            id: "research",
            heartbeat: { every: "0m" },
          },
        ],
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:research:subagent:invalid-heartbeat",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("does not implicitly stream when heartbeats are runtime-disabled", async () => {
    hoisted.areHeartbeatsEnabledMock.mockReturnValue(false);

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:runtime-disabled",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("does not implicitly stream for legacy subagent requester session keys", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "subagent:legacy-worker",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("does not implicitly stream for subagent requester sessions with thread context", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:thread-context",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
        agentThreadId: "requester-thread",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("does not implicitly stream for thread-bound subagent requester sessions", async () => {
    hoisted.sessionBindingListBySessionMock.mockImplementation((targetSessionKey: string) => {
      if (targetSessionKey === "agent:main:subagent:thread-bound") {
        return [
          createSessionBinding({
            targetSessionKey,
            targetKind: "subagent",
            status: "active",
          }),
        ];
      }
      return [];
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
      },
      {
        agentSessionKey: "agent:main:subagent:thread-bound",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("run");
    expect(accepted.streamLogPath).toBeUndefined();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });

  it("announces parent relay start only after successful child dispatch", async () => {
    const firstHandle = createRelayHandle();
    const secondHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock
      .mockReset()
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(firstHandle.notifyStarted).not.toHaveBeenCalled();
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
    const notifyOrder = secondHandle.notifyStarted.mock.invocationCallOrder;
    const agentCallIndex = hoisted.callGatewayMock.mock.calls.findIndex(
      (call: unknown[]) => (call[0] as { method?: string }).method === "agent",
    );
    const agentCallOrder = hoisted.callGatewayMock.mock.invocationCallOrder[agentCallIndex];
    expect(typeof agentCallOrder).toBe("number");
    expect(typeof notifyOrder[0]).toBe("number");
    expect(notifyOrder[0] > agentCallOrder).toBe(true);
  });

  it("binds Telegram forum-topic ACP sessions to the current topic", async () => {
    enableTelegramCurrentConversationBindings();

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:telegram:group:-1003342490704:topic:2",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:-1003342490704",
        agentThreadId: "2",
        agentGroupId: "-1003342490704",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("session");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "telegram",
          accountId: "default",
          conversationId: "-1003342490704:topic:2",
        }),
      }),
    );
    const agentCall = hoisted.callGatewayMock.mock.calls
      .map((call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> })
      .find((request) => request.method === "agent");
    expect(agentCall?.params?.deliver).toBe(true);
    expect(agentCall?.params?.channel).toBe("telegram");
  });

  it("drops self-parent Telegram current-conversation refs before binding", async () => {
    enableTelegramCurrentConversationBindings();

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:telegram:direct:6098642967",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:6098642967",
      },
    );

    const accepted = expectAcceptedSpawn(result);
    expect(accepted.mode).toBe("session");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "telegram",
          accountId: "default",
          conversationId: "6098642967",
        }),
      }),
    );
    const bindCall = hoisted.sessionBindingBindMock.mock.calls.at(-1)?.[0] as
      | { conversation?: { parentConversationId?: string } }
      | undefined;
    expect(bindCall?.conversation?.parentConversationId).toBeUndefined();
  });

  it("preserves topic-qualified Telegram targets without a separate threadId", async () => {
    enableTelegramCurrentConversationBindings();

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:telegram:group:-1003342490704:topic:2",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "telegram:group:-1003342490704:topic:2",
      },
    );

    expect(result.status).toBe("accepted");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "telegram",
          accountId: "default",
          conversationId: "-1003342490704:topic:2",
        }),
      }),
    );
  });

  it("disposes pre-registered parent relay when initial ACP dispatch fails", async () => {
    const relayHandle = createRelayHandle();
    hoisted.startAcpSpawnParentStreamRelayMock.mockReturnValueOnce(relayHandle);
    hoisted.callGatewayMock.mockImplementation(async (argsUnknown: unknown) => {
      const args = argsUnknown as { method?: string };
      if (args.method === "sessions.patch") {
        return { ok: true };
      }
      if (args.method === "agent") {
        throw new Error("agent dispatch failed");
      }
      if (args.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expect(expectFailedSpawn(result, "error").error).toContain("agent dispatch failed");
    expect(relayHandle.dispose).toHaveBeenCalledTimes(1);
    expect(relayHandle.notifyStarted).not.toHaveBeenCalled();
  });

  it('rejects streamTo="parent" without requester session context', async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        streamTo: "parent",
      },
      {
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:parent-channel",
      },
    );

    expect(expectFailedSpawn(result, "error").error).toContain('streamTo="parent"');
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.startAcpSpawnParentStreamRelayMock).not.toHaveBeenCalled();
  });
});
