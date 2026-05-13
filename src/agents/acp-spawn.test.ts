import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpInitializeSessionInput } from "../acp/control-plane/manager.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
    agents: {
      defaults: {
        subagents: {
          allowAgents: ["codex"],
          maxSpawnDepth: 2,
        },
      },
    },
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
    channels: {
      discord: {
        threadBindings: {
          enabled: true,
          spawnSessions: true,
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
  const countActiveRunsForSessionMock = vi.fn();
  const getSubagentRunByChildSessionKeyMock = vi.fn();
  const listTasksForOwnerKeyMock = vi.fn();
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
    countActiveRunsForSessionMock,
    getSubagentRunByChildSessionKeyMock,
    listTasksForOwnerKeyMock,
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

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: hoisted.loadSessionStoreMock,
  resolveStorePath: hoisted.resolveStorePathMock,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => hoisted.state.cfg,
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

vi.mock("./subagent-registry.js", () => ({
  countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
  getSubagentRunByChildSessionKey: hoisted.getSubagentRunByChildSessionKeyMock,
}));

vi.mock("../tasks/runtime-internal.js", () => ({
  listTasksForOwnerKey: hoisted.listTasksForOwnerKeyMock,
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
  lane?: string;
  timeout?: number;
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

function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

function latestMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls[mock.mock.calls.length - 1];
  if (!call) {
    throw new Error(`Expected ${label} to be called`);
  }
  return call;
}

function latestBindingInput(): Record<string, unknown> {
  return expectRecordFields(latestMockCall(hoisted.sessionBindingBindMock, "session bind")[0], {});
}

function gatewayRequests(): Array<{ method?: string; params?: Record<string, unknown> }> {
  return hoisted.callGatewayMock.mock.calls.map(
    (call: unknown[]) => call[0] as { method?: string; params?: Record<string, unknown> },
  );
}

function gatewayRequest(method: string): { method?: string; params?: Record<string, unknown> } {
  const request = gatewayRequests().find((candidate) => candidate.method === method);
  if (!request) {
    throw new Error(`Expected gateway request for ${method}`);
  }
  return request;
}

function expectGatewayMethodNotCalled(method: string): void {
  expect(gatewayRequests().some((request) => request.method === method)).toBe(false);
}

function expectSessionPatchFields(expected: Record<string, unknown>): void {
  expectRecordFields(gatewayRequest("sessions.patch").params, expected);
}

function expectInitializeSessionFields(expected: Record<string, unknown>): Record<string, unknown> {
  return expectRecordFields(
    firstMockCall(hoisted.initializeSessionMock, "session initialization")[0],
    expected,
  );
}

function expectBindingCallFields(expected: {
  conversation?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  placement?: string;
  targetKind?: string;
}): Record<string, unknown> {
  const input = expectRecordFields(latestBindingInput(), {
    ...(expected.placement ? { placement: expected.placement } : {}),
    ...(expected.targetKind ? { targetKind: expected.targetKind } : {}),
  });
  if (expected.conversation) {
    expectRecordFields(input.conversation, expected.conversation);
  }
  if (expected.metadata) {
    expectRecordFields(input.metadata, expected.metadata);
  }
  return input;
}

function expectRelayCallFields(expected: Record<string, unknown>, callIndex = 0): void {
  expectRecordFields(
    hoisted.startAcpSpawnParentStreamRelayMock.mock.calls[callIndex]?.[0],
    expected,
  );
}

function expectAgentGatewayCall(overrides: AgentCallParams): void {
  const agentCall = gatewayRequest("agent");
  expect(agentCall?.params?.deliver).toBe(overrides.deliver);
  expect(agentCall?.params?.channel).toBe(overrides.channel);
  expect(agentCall?.params?.to).toBe(overrides.to);
  expect(agentCall?.params?.threadId).toBe(overrides.threadId);
  if (Object.hasOwn(overrides, "lane")) {
    expect(agentCall?.params?.lane).toBe(overrides.lane);
  }
  if (Object.hasOwn(overrides, "timeout")) {
    expect(agentCall?.params?.timeout).toBe(overrides.timeout);
  }
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
          spawnSessions: true,
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
          spawnSessions: true,
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
    hoisted.countActiveRunsForSessionMock.mockReset().mockReturnValue(0);
    hoisted.getSubagentRunByChildSessionKeyMock.mockReset().mockReturnValue(null);
    hoisted.listTasksForOwnerKeyMock.mockReset().mockReturnValue([]);

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
    expect(accepted.inlineDelivery).toBe(true);
    expectSessionPatchFields({
      key: accepted.childSessionKey,
      spawnedBy: "agent:main:main",
    });
    expectBindingCallFields({
      targetKind: "session",
      placement: "child",
    });
    expectResolvedIntroTextInBindMetadata();

    const agentCall = gatewayRequest("agent");
    expect(agentCall?.params?.sessionKey).toMatch(/^agent:codex:acp:/);
    expect(agentCall?.params?.to).toBe("channel:child-thread");
    expect(agentCall?.params?.threadId).toBe("child-thread");
    expect(agentCall?.params?.deliver).toBe(true);
    expect(agentCall?.params?.lane).toBe("subagent");
    expect(agentCall?.params?.acpTurnSource).toBe("manual_spawn");
    const initInput = expectInitializeSessionFields({
      agent: "codex",
      mode: "persistent",
    });
    expect(initInput.sessionKey).toMatch(/^agent:codex:acp:/);
    const transcriptCalls = hoisted.resolveSessionTranscriptFileMock.mock.calls.map(
      (call: unknown[]) => call[0] as { threadId?: string },
    );
    expect(transcriptCalls).toHaveLength(2);
    expect(transcriptCalls[0]?.threadId).toBeUndefined();
    expect(transcriptCalls[1]?.threadId).toBe("child-thread");
  });

  it("allows ACP resume IDs recorded for the requester session", async () => {
    const resumeSessionId = "codex-inner-resume";
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:codex:acp:owned": {
        sessionId: "sess-owned",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex",
          identity: {
            state: "resolved",
            source: "ensure",
            agentSessionId: resumeSessionId,
            acpxSessionId: "acpx-owned",
            lastUpdatedAt: Date.now(),
          },
          mode: "oneshot",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } satisfies SessionEntry,
    });

    const result = await spawnAcpDirect(
      {
        task: "Resume owned ACP session",
        agentId: "codex",
        resumeSessionId,
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expectAcceptedSpawn(result);
    expectInitializeSessionFields({ resumeSessionId });
  });

  it("rejects ACP resume IDs not recorded for the requester session", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:codex:acp:other": {
        sessionId: "sess-other",
        updatedAt: Date.now(),
        spawnedBy: "agent:other:main",
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex",
          identity: {
            state: "resolved",
            source: "ensure",
            agentSessionId: "codex-inner-other",
            acpxSessionId: "acpx-other",
            lastUpdatedAt: Date.now(),
          },
          mode: "oneshot",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      } satisfies SessionEntry,
    });

    const result = await spawnAcpDirect(
      {
        task: "Resume other ACP session",
        agentId: "codex",
        resumeSessionId: "codex-inner-other",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expectRecordFields(result, {
      status: "forbidden",
      errorCode: "resume_forbidden",
    });
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes model and thinking overrides into ACP session initialization", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        model: "openai-codex/gpt-5.4",
        thinking: "high",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expectAcceptedSpawn(result);
    const initInput = expectInitializeSessionFields({
      agent: "codex",
      runtimeOptions: {
        model: "openai-codex/gpt-5.4",
        thinking: "high",
      },
    });
    expect(initInput.sessionKey).toMatch(/^agent:codex:acp:/);
  });

  it("applies ACP spawn run timeout to runtime options and dispatch", async () => {
    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "codex",
        runTimeoutSeconds: 45,
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expectAcceptedSpawn(result);
    const initInput = expectInitializeSessionFields({
      agent: "codex",
      runtimeOptions: {
        timeoutSeconds: 45,
      },
    });
    expect(initInput.sessionKey).toMatch(/^agent:codex:acp:/);
    const agentCall = findAgentGatewayCall();
    expect(agentCall?.params?.lane).toBe("subagent");
    expect(agentCall?.params?.timeout).toBe(45);
  });

  it("rejects OpenClaw config agent ids when runtime=acp targets a native agent", async () => {
    replaceSpawnConfig({
      ...createDefaultSpawnConfig(),
      acp: {
        enabled: true,
        backend: "acpx",
        allowedAgents: ["codex"],
      },
      agents: {
        list: [{ id: "pleres" }],
        defaults: {
          subagents: {
            allowAgents: ["*"],
            maxSpawnDepth: 2,
          },
        },
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "pleres",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expectRecordFields(result, {
      status: "error",
      errorCode: "runtime_agent_mismatch",
    });
    expect(result).toHaveProperty(
      "error",
      'agentId "pleres" is an OpenClaw config agent, not an ACP harness. Use runtime="subagent" or omit runtime for OpenClaw config agents. Use runtime="acp" only with external ACP harness ids such as codex, claude, droid, gemini, or opencode, or configure agents.list[].runtime.type="acp" with runtime.acp.agent.',
    );
    expect(hoisted.initializeSessionMock).not.toHaveBeenCalled();
    expectGatewayMethodNotCalled("agent");
  });

  it("maps OpenClaw ACP runtime agent aliases to their configured harness id", async () => {
    replaceSpawnConfig({
      ...createDefaultSpawnConfig(),
      agents: {
        list: [
          {
            id: "reviewer",
            runtime: {
              type: "acp",
              acp: {
                agent: "codex",
              },
            },
          },
        ],
        defaults: {
          subagents: {
            allowAgents: ["codex"],
            maxSpawnDepth: 2,
          },
        },
      },
    });

    const result = await spawnAcpDirect(
      {
        task: "Investigate flaky tests",
        agentId: "reviewer",
      },
      {
        agentSessionKey: "agent:main:main",
      },
    );

    expectAcceptedSpawn(result);
    const initInput = expectInitializeSessionFields({ agent: "codex" });
    expect(initInput.sessionKey).toMatch(/^agent:codex:acp:/);
  });

  it("inherits subagent envelope fields onto ACP children", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
          subagents: {
            ...hoisted.state.cfg.agents?.defaults?.subagents,
            maxSpawnDepth: 2,
          },
        },
      },
    });

    const result = await spawnAcpDirect(createSpawnRequest(), {
      ...createRequesterContext(),
      agentSessionKey: "agent:main:subagent:parent",
    });

    const accepted = expectAcceptedSpawn(result);
    expectSessionPatchFields({
      key: accepted.childSessionKey,
      spawnedBy: "agent:main:subagent:parent",
      spawnDepth: 2,
      subagentRole: "leaf",
      subagentControlScope: "none",
    });
  });

  it("rejects ACP spawns that exceed subagent max depth", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
          subagents: {
            ...hoisted.state.cfg.agents?.defaults?.subagents,
            maxSpawnDepth: 2,
          },
        },
      },
    });

    const result = await spawnAcpDirect(createSpawnRequest(), {
      ...createRequesterContext(),
      agentSessionKey: "agent:main:subagent:parent:subagent:leaf",
    });

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("current depth: 2, max: 2");
  });

  it("rejects ACP spawns that exceed subagent child caps", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
          subagents: {
            ...hoisted.state.cfg.agents?.defaults?.subagents,
            maxChildrenPerAgent: 1,
          },
        },
      },
    });
    hoisted.countActiveRunsForSessionMock.mockReturnValueOnce(1);

    const result = await spawnAcpDirect(createSpawnRequest(), {
      ...createRequesterContext(),
      agentSessionKey: "agent:main:subagent:parent",
    });

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("max active children");
  });

  it('counts streamTo="parent" ACP runs toward subagent child caps', async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
          subagents: {
            ...hoisted.state.cfg.agents?.defaults?.subagents,
            maxChildrenPerAgent: 1,
          },
        },
      },
    });
    hoisted.listTasksForOwnerKeyMock.mockReturnValueOnce([
      {
        runtime: "acp",
        status: "running",
        childSessionKey: "agent:codex:acp:existing-parent-stream",
      },
    ]);

    const result = await spawnAcpDirect(
      createSpawnRequest({
        streamTo: "parent",
      }),
      {
        ...createRequesterContext(),
        agentSessionKey: "agent:main:subagent:parent",
      },
    );

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("max active children");
  });

  it("does not double-count duplicate ACP task rows for the same child session", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
          subagents: {
            ...hoisted.state.cfg.agents?.defaults?.subagents,
            maxChildrenPerAgent: 2,
          },
        },
      },
    });
    hoisted.listTasksForOwnerKeyMock.mockReturnValueOnce([
      {
        runtime: "acp",
        status: "running",
        childSessionKey: "agent:codex:acp:existing-parent-stream",
      },
      {
        runtime: "acp",
        status: "queued",
        childSessionKey: "agent:codex:acp:existing-parent-stream",
      },
    ]);

    const result = await spawnAcpDirect(
      createSpawnRequest({
        streamTo: "parent",
      }),
      {
        ...createRequesterContext(),
        agentSessionKey: "agent:main:subagent:parent",
      },
    );

    expectAcceptedSpawn(result);
  });

  it("does not double-count ACP task rows for active registry-tracked ACP children", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
          subagents: {
            ...hoisted.state.cfg.agents?.defaults?.subagents,
            maxChildrenPerAgent: 2,
          },
        },
      },
    });
    hoisted.countActiveRunsForSessionMock.mockReturnValueOnce(1);
    hoisted.getSubagentRunByChildSessionKeyMock.mockImplementationOnce((childSessionKey: string) =>
      childSessionKey === "agent:codex:acp:existing-parent-stream"
        ? {
            childSessionKey,
            createdAt: Date.now(),
          }
        : null,
    );
    hoisted.listTasksForOwnerKeyMock.mockReturnValueOnce([
      {
        runtime: "acp",
        status: "running",
        childSessionKey: "agent:codex:acp:existing-parent-stream",
      },
    ]);

    const result = await spawnAcpDirect(
      createSpawnRequest({
        streamTo: "parent",
      }),
      {
        ...createRequesterContext(),
        agentSessionKey: "agent:main:subagent:parent",
      },
    );

    expectAcceptedSpawn(result);
  });

  it("rejects ACP spawns to agents outside the subagent allowlist", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      acp: {
        ...hoisted.state.cfg.acp,
        allowedAgents: ["codex", "writer"],
      },
      agents: {
        ...hoisted.state.cfg.agents,
        list: [
          {
            id: "main",
            default: true,
            subagents: {
              allowAgents: ["codex"],
            },
          },
          {
            id: "writer",
          },
        ],
      },
    });

    const result = await spawnAcpDirect(
      createSpawnRequest({
        agentId: "writer",
      }),
      {
        ...createRequesterContext(),
        agentSessionKey: "agent:main:subagent:parent",
      },
    );

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("agentId is not allowed");
  });

  it("rejects explicit ACP self-targets when the subagent allowlist excludes the requester", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      acp: {
        ...hoisted.state.cfg.acp,
        allowedAgents: ["codex", "writer"],
      },
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["writer"],
            maxSpawnDepth: 2,
          },
        },
      },
    });

    const result = await spawnAcpDirect(
      createSpawnRequest({
        agentId: "codex",
      }),
      {
        ...createRequesterContext(),
        agentSessionKey: "agent:codex:subagent:parent",
      },
    );

    const failed = expectFailedSpawn(result, "forbidden");
    expect(failed.errorCode).toBe("subagent_policy");
    expect(failed.error).toContain("agentId is not allowed");
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
    expectBindingCallFields({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "!room:example",
      },
    });
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
    expectBindingCallFields({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "!Room:Example.org",
      },
    });
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
    expectBindingCallFields({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "$thread-root",
        parentConversationId: "!Room:Example.org",
      },
    });
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
      const initInput = expectInitializeSessionFields({
        agent: "claude-code",
        cwd: fixture.targetWorkspace,
      });
      expect(initInput.sessionKey).toMatch(/^agent:claude-code:acp:/);
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
      const initInput = expectInitializeSessionFields({
        agent: "claude-code",
        cwd: undefined,
      });
      expect(initInput.sessionKey).toMatch(/^agent:claude-code:acp:/);
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
    expectBindingCallFields({
      placement: "current",
      conversation: {
        channel: "line",
        accountId: "default",
        conversationId: "U1234567890abcdef1234567890abcdef",
      },
    });
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
            spawnSessions: true,
          },
          accounts: {
            work: {
              threadBindings: {
                enabled: true,
                spawnSessions: true,
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
    expectBindingCallFields({
      placement: "current",
      conversation: {
        channel: "custom",
        accountId: "work",
        conversationId: "123456",
      },
    });
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
            spawnSessions: true,
          },
          accounts: {
            "bot-alpha": {
              threadBindings: {
                enabled: true,
                spawnSessions: true,
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
    expectBindingCallFields({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "bot-alpha",
        conversationId: boundRoom,
      },
    });
    expectRecordFields(gatewayRequest("agent").params, {
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
      expectBindingCallFields({
        placement: "current",
        conversation: {
          channel: "line",
          accountId: "default",
          conversationId: expectedConversationId,
        },
      });
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
    expectBindingCallFields({
      placement: "current",
      conversation: {
        channel: "line",
        accountId: "default",
        conversationId: "R1234567890abcdef1234567890abcdef",
      },
    });
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
      expectRecordFields(
        firstMockCall(hoisted.resolveSessionTranscriptFileMock, "transcript file resolution")[0],
        {
          sessionId: "sess-123",
          storePath: "/tmp/codex-sessions.json",
          agentId: "codex",
        },
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
    const bindInput = expectBindingCallFields({});
    const metadata = expectRecordFields(bindInput.metadata, {});
    expect(typeof metadata.introText).toBe("string");
    expect(metadata.introText).toContain("cwd: /home/bob/clawd");
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

    expectRecordFields(result, {
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
            spawnSessions: false,
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

    expect(expectFailedSpawn(result, "error").error).toContain("spawnSessions=true");
  });

  it("forbids ACP spawn from sandboxed requester sessions", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
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
    expectRelayCallFields({
      parentSessionKey: "agent:main:main",
      agentId: "codex",
      logPath: "/tmp/sess-main.acp-stream.jsonl",
      emitStartNotice: false,
    });
    const relayRuns = hoisted.startAcpSpawnParentStreamRelayMock.mock.calls.map(
      (call: unknown[]) => (call[0] as { runId?: string }).runId,
    );
    expect(relayRuns).toContain(agentCall?.params?.idempotencyKey);
    expect(relayRuns).toContain(accepted.runId);
    const streamPathInput = expectRecordFields(
      firstMockCall(hoisted.resolveAcpSpawnStreamLogPathMock, "stream log path resolution")[0],
      {},
    );
    expect(streamPathInput.childSessionKey).toMatch(/^agent:codex:acp:/);
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(firstHandle.notifyStarted).not.toHaveBeenCalled();
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
  });

  it("implicitly streams mode=run ACP spawns for subagent requester sessions", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
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
    expectRelayCallFields({
      parentSessionKey: "agent:main:subagent:parent",
      agentId: "codex",
      logPath: "/tmp/sess-main.acp-stream.jsonl",
      deliveryContext: {
        channel: "discord",
        to: "channel:parent-channel",
        accountId: "default",
      },
      emitStartNotice: false,
    });
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    expect(secondHandle.notifyStarted).toHaveBeenCalledTimes(1);
  });

  it("does not implicitly stream for ACP requester sessions inside a subagent envelope", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
          heartbeat: {
            every: "30m",
            target: "last",
          },
        },
      },
    });
    hoisted.loadSessionStoreMock.mockReset().mockImplementation(() => {
      const store: Record<
        string,
        {
          sessionId: string;
          updatedAt: number;
          deliveryContext?: unknown;
          spawnedBy?: string;
          spawnDepth?: number;
          subagentRole?: string;
          subagentControlScope?: string;
        }
      > = {
        "agent:main:acp:child": {
          sessionId: "parent-sess-1",
          updatedAt: Date.now(),
          deliveryContext: {
            channel: "discord",
            to: "channel:parent-channel",
            accountId: "default",
          },
          spawnedBy: "agent:main:subagent:parent",
          spawnDepth: 2,
          subagentRole: "leaf",
          subagentControlScope: "none",
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
        agentSessionKey: "agent:main:acp:child",
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

  it("does not implicitly stream when heartbeat target is not session-local", async () => {
    replaceSpawnConfig({
      ...hoisted.state.cfg,
      agents: {
        defaults: {
          ...hoisted.state.cfg.agents?.defaults,
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
          ...hoisted.state.cfg.agents?.defaults,
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
        ...hoisted.state.cfg.agents,
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
        ...hoisted.state.cfg.agents,
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
    expectBindingCallFields({
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "2",
        parentConversationId: "-1003342490704",
      },
    });
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
    expectBindingCallFields({
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "6098642967",
      },
    });
    const bindCall = latestBindingInput();
    const conversation = expectRecordFields(bindCall.conversation, {});
    expect(conversation.parentConversationId).toBeUndefined();
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
    expectBindingCallFields({
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003342490704:topic:2",
      },
    });
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
