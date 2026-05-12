import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const requireAcpRuntimeBackendMock = vi.fn();
  const getAcpRuntimeBackendMock = vi.fn();
  const listAcpSessionEntriesMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const upsertAcpSessionMetaMock = vi.fn();
  const resolveSessionStorePathForAcpMock = vi.fn();
  const loadSessionStoreMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  const ensureSessionMock = vi.fn();
  const runTurnMock = vi.fn();
  const cancelMock = vi.fn();
  const closeMock = vi.fn();
  const getCapabilitiesMock = vi.fn();
  const getStatusMock = vi.fn();
  const setModeMock = vi.fn();
  const setConfigOptionMock = vi.fn();
  const doctorMock = vi.fn();
  return {
    callGatewayMock,
    requireAcpRuntimeBackendMock,
    getAcpRuntimeBackendMock,
    listAcpSessionEntriesMock,
    readAcpSessionEntryMock,
    upsertAcpSessionMetaMock,
    resolveSessionStorePathForAcpMock,
    loadSessionStoreMock,
    sessionBindingCapabilitiesMock,
    sessionBindingBindMock,
    sessionBindingListBySessionMock,
    sessionBindingResolveByConversationMock,
    sessionBindingUnbindMock,
    ensureSessionMock,
    runTurnMock,
    cancelMock,
    closeMock,
    getCapabilitiesMock,
    getStatusMock,
    setModeMock,
    setConfigOptionMock,
    doctorMock,
  };
});

function createAcpCommandSessionBindingService() {
  const forward =
    <A extends unknown[], T>(fn: (...args: A) => T) =>
    (...args: A) =>
      fn(...args);
  return {
    bind: (input: unknown) => hoisted.sessionBindingBindMock(input),
    getCapabilities: forward((params: unknown) => hoisted.sessionBindingCapabilitiesMock(params)),
    listBySession: (targetSessionKey: string) =>
      hoisted.sessionBindingListBySessionMock(targetSessionKey),
    resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
    touch: vi.fn(),
    unbind: (input: unknown) => hoisted.sessionBindingUnbindMock(input),
  };
}

vi.mock("../../gateway/call.js", () => ({
  callGateway: (args: unknown) => hoisted.callGatewayMock(args),
}));

vi.mock("../../acp/runtime/registry.js", () => ({
  requireAcpRuntimeBackend: (id?: string) => hoisted.requireAcpRuntimeBackendMock(id),
  getAcpRuntimeBackend: (id?: string) => hoisted.getAcpRuntimeBackendMock(id),
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: (args: unknown) => hoisted.listAcpSessionEntriesMock(args),
  readAcpSessionEntry: (args: unknown) => hoisted.readAcpSessionEntryMock(args),
  upsertAcpSessionMeta: (args: unknown) => hoisted.upsertAcpSessionMetaMock(args),
  resolveSessionStorePathForAcp: (args: unknown) => hoisted.resolveSessionStorePathForAcpMock(args),
}));

vi.mock("../../agents/acp-spawn.js", () => ({
  resolveAcpSpawnRuntimePolicyError: (params: { cfg?: OpenClawConfig }) =>
    params.cfg?.agents?.defaults?.sandbox?.mode === "all"
      ? 'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.'
      : undefined,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    loadSessionStore: (...args: unknown[]) => hoisted.loadSessionStoreMock(...args),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  const patched = { ...actual } as typeof actual & {
    getSessionBindingService: () => ReturnType<typeof createAcpCommandSessionBindingService>;
  };
  patched.getSessionBindingService = () => createAcpCommandSessionBindingService();
  return patched;
});

const { handleAcpCommand } = await import("./commands-acp.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");
const { __testing: acpManagerTesting } = await import("../../acp/control-plane/manager.js");
const { __testing: acpResetTargetTesting, resolveEffectiveResetTargetSessionKey } =
  await import("./acp-reset-target.js");
const { createTaskRecord, resetTaskRegistryForTests } =
  await import("../../tasks/task-registry.js");
const { configureTaskRegistryRuntime } = await import("../../tasks/task-registry.store.js");
const { failTaskRunByRunId } = await import("../../tasks/task-executor.js");

function configureInMemoryTaskRegistryStoreForTests(): void {
  configureTaskRegistryRuntime({
    store: {
      loadSnapshot: () => ({
        tasks: new Map(),
        deliveryStates: new Map(),
      }),
      saveSnapshot: () => {},
      upsertTaskWithDeliveryState: () => {},
      upsertTask: () => {},
      deleteTaskWithDeliveryState: () => {},
      deleteTask: () => {},
      upsertDeliveryState: () => {},
      deleteDeliveryState: () => {},
      close: () => {},
    },
  });
}

function parseTelegramChatIdForTest(raw?: string | null): string | undefined {
  const trimmed = raw?.trim().replace(/^telegram:/i, "");
  if (!trimmed) {
    return undefined;
  }
  const topicMatch = /^(.*):topic:\d+$/i.exec(trimmed);
  return (topicMatch?.[1] ?? trimmed).trim() || undefined;
}

function parseDiscordConversationIdForTest(
  targets: Array<string | undefined | null>,
): string | undefined {
  for (const rawTarget of targets) {
    const target = rawTarget?.trim();
    if (!target) {
      continue;
    }
    const mentionMatch = /^<#(\d+)>$/.exec(target);
    if (mentionMatch?.[1]) {
      return mentionMatch[1];
    }
    if (/^channel:/i.test(target)) {
      return target;
    }
  }
  return undefined;
}

function parseDiscordParentChannelFromSessionKeyForTest(raw?: string | null): string | undefined {
  const sessionKey = raw?.trim().toLowerCase() ?? "";
  const match = sessionKey.match(/(?:^|:)channel:([^:]+)$/);
  return match?.[1] ? `channel:${match[1]}` : undefined;
}

function resolveFirstConversationTargetForTest(params: {
  channel?: string;
  commandTo?: string;
  fallbackTo?: string;
  originatingTo?: string;
}): string | null {
  for (const rawTarget of [params.originatingTo, params.commandTo, params.fallbackTo]) {
    const target = rawTarget?.trim();
    if (!target) {
      continue;
    }
    return params.channel && target.toLowerCase().startsWith(`${params.channel}:`)
      ? target.slice(params.channel.length + 1)
      : target;
  }
  return null;
}

function parsePrefixedConversationIdForTest(
  raw: string | undefined | null,
  channel: "imessage",
): string | undefined {
  const trimmed = raw
    ?.trim()
    .replace(new RegExp(`^${channel}:`, "i"), "")
    .replace(/^chat_guid:/i, "");
  return trimmed || undefined;
}

function resolvePrefixedConversationIdForTest(
  targets: Array<string | undefined | null>,
  channel: "imessage",
): string | undefined {
  return targets.map((target) => parsePrefixedConversationIdForTest(target, channel)).find(Boolean);
}

function setMinimalAcpCommandRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          conversationBindings: {
            defaultTopLevelPlacement: "current",
            buildBoundReplyPayload: ({
              operation,
              conversation,
            }: {
              operation: "acp-spawn";
              conversation: { conversationId: string };
            }) =>
              operation === "acp-spawn" && conversation.conversationId.includes(":topic:")
                ? { delivery: { pin: { enabled: true } } }
                : null,
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const chatId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => parseTelegramChatIdForTest(candidate))
                .find(Boolean);
              if (!chatId) {
                return null;
              }
              if (threadId) {
                return {
                  conversationId: `${chatId}:topic:${threadId}`,
                  parentConversationId: chatId,
                };
              }
              if (chatId.startsWith("-")) {
                return null;
              }
              return { conversationId: chatId, parentConversationId: chatId };
            },
          },
        },
      },
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              threadParentId,
              parentSessionKey,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              threadParentId?: string;
              parentSessionKey?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              if (threadId) {
                const parentConversationId =
                  (threadParentId?.trim()
                    ? `channel:${threadParentId.trim().replace(/^channel:/i, "")}`
                    : undefined) ??
                  parseDiscordParentChannelFromSessionKeyForTest(parentSessionKey) ??
                  parseDiscordConversationIdForTest([originatingTo, commandTo, fallbackTo]);
                return {
                  conversationId: threadId,
                  ...(parentConversationId && parentConversationId !== threadId
                    ? { parentConversationId }
                    : {}),
                };
              }
              const conversationId = parseDiscordConversationIdForTest([
                originatingTo,
                commandTo,
                fallbackTo,
              ]);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "imessage",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "imessage", label: "iMessage" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = resolvePrefixedConversationIdForTest(
                [originatingTo, commandTo, fallbackTo],
                "imessage",
              );
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
      },
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          conversationBindings: {
            defaultTopLevelPlacement: "child",
          },
          bindings: {
            resolveCommandConversation: ({
              threadId,
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              threadId?: string;
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const roomId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^room:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              if (!threadId || !roomId) {
                return null;
              }
              return {
                conversationId: threadId,
                parentConversationId: roomId,
              };
            },
          },
        },
      },
      ...(["feishu", "line"] as const).map((channelId) => ({
        pluginId: channelId,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: channelId, label: channelId }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = resolveFirstConversationTargetForTest({
                channel: channelId,
                originatingTo,
                commandTo,
                fallbackTo,
              });
              return conversationId ? { conversationId } : null;
            },
          },
        },
      })),
    ]),
  );
}

type FakeBinding = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: "subagent" | "session";
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  status: "active";
  boundAt: number;
  metadata?: {
    agentId?: string;
    label?: string;
    boundBy?: string;
    webhookId?: string;
  };
};

function createSessionBinding(overrides?: Partial<FakeBinding>): FakeBinding {
  return {
    bindingId: "default:thread-created",
    targetSessionKey: "agent:codex:acp:s1",
    targetKind: "session",
    conversation: {
      channel: "discord",
      accountId: "default",
      conversationId: "thread-created",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      agentId: "codex",
      boundBy: "user-1",
    },
    ...overrides,
  };
}

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
  },
  channels: {
    discord: {
      threadBindings: {
        enabled: true,
        spawnSessions: true,
      },
    },
  },
} satisfies OpenClawConfig;

function createDiscordParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
  });
  params.command.senderId = "user-1";
  return params;
}

const defaultAcpSessionKey = "agent:codex:acp:s1";
const defaultThreadId = "thread-1";

type AcpSessionIdentity = {
  state: "resolved";
  source: "status";
  acpxSessionId: string;
  agentSessionId: string;
  lastUpdatedAt: number;
};

function createThreadConversation(conversationId: string = defaultThreadId) {
  return {
    channel: "discord" as const,
    accountId: "default",
    conversationId,
    parentConversationId: "parent-1",
  };
}

function createBoundThreadSession(sessionKey: string = defaultAcpSessionKey) {
  return createSessionBinding({
    targetSessionKey: sessionKey,
    conversation: createThreadConversation(),
  });
}

function createAcpSessionEntry(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  return {
    sessionKey,
    storeSessionKey: sessionKey,
    acp: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      ...(options?.identity ? { identity: options.identity } : {}),
      mode: "persistent",
      state: options?.state ?? "idle",
      lastActivityAt: Date.now(),
    },
  };
}

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] as const,
  };
}

type AcpBindInput = {
  targetSessionKey: string;
  conversation: {
    channel?: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

function createAcpThreadBinding(input: AcpBindInput): FakeBinding {
  const nextConversationId =
    input.placement === "child" ? "thread-created" : input.conversation.conversationId;
  const boundBy = typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1";
  const channel = input.conversation.channel ?? "discord";
  const nextParentConversationId =
    input.placement === "child"
      ? input.conversation.conversationId
      : input.conversation.parentConversationId;
  const conversation = {
    channel,
    accountId: input.conversation.accountId,
    conversationId: nextConversationId,
    ...(nextParentConversationId ? { parentConversationId: nextParentConversationId } : {}),
  };
  return createSessionBinding({
    targetSessionKey: input.targetSessionKey,
    conversation,
    metadata: { boundBy, webhookId: "wh-1" },
  });
}

type MockWithCalls = {
  mock: {
    calls: Array<Array<unknown>>;
  };
};

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
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

function expectMockCallFields(
  mock: MockWithCalls,
  expected: Record<string, unknown>,
  callIndex = 0,
): Record<string, unknown> {
  return expectRecordFields(mockCallArg(mock, callIndex), expected);
}

function expectBindingBindCall(
  expected: {
    conversation?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    placement?: "current" | "child";
    targetKind?: "session";
  },
  callIndex = 0,
): Record<string, unknown> {
  const input = expectMockCallFields(
    hoisted.sessionBindingBindMock,
    {
      ...(expected.placement ? { placement: expected.placement } : {}),
      ...(expected.targetKind ? { targetKind: expected.targetKind } : {}),
    },
    callIndex,
  );
  if (expected.conversation) {
    expectRecordFields(input.conversation, expected.conversation);
  }
  if (expected.metadata) {
    expectRecordFields(input.metadata, expected.metadata);
  }
  return input;
}

function gatewayRequests(): Array<Record<string, unknown>> {
  return hoisted.callGatewayMock.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

function expectGatewayMethodCalled(method: string): void {
  expect(gatewayRequests().some((request) => request.method === method)).toBe(true);
}

function expectGatewayMethodNotCalled(method: string): void {
  expect(gatewayRequests().some((request) => request.method === method)).toBe(false);
}

function expectBoundIntroTextToExclude(match: string): void {
  const calls = hoisted.sessionBindingBindMock.mock.calls as Array<
    [{ metadata?: { introText?: unknown } }]
  >;
  const introText = calls
    .map((call) => call[0]?.metadata?.introText)
    .find((value): value is string => typeof value === "string");
  expect((introText ?? "").includes(match)).toBe(false);
}

function mockBoundThreadSession(options?: {
  sessionKey?: string;
  state?: "idle" | "running";
  identity?: AcpSessionIdentity;
}) {
  const sessionKey = options?.sessionKey ?? defaultAcpSessionKey;
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
    createBoundThreadSession(sessionKey),
  );
  hoisted.readAcpSessionEntryMock.mockReturnValue(
    createAcpSessionEntry({
      sessionKey,
      state: options?.state,
      identity: options?.identity,
    }),
  );
}

function createThreadParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = createDiscordParams(commandBody, cfg);
  params.ctx.MessageThreadId = defaultThreadId;
  return params;
}

type ConversationCommandFixture = {
  accountId?: string;
  channel: string;
  originatingTo: string;
  senderId?: string;
  sessionKey?: string;
  threadId?: string;
  threadParentId?: string;
};

function createConversationParams(
  commandBody: string,
  fixture: ConversationCommandFixture,
  cfg: OpenClawConfig = baseCfg,
) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: fixture.channel,
    Surface: fixture.channel,
    OriginatingChannel: fixture.channel,
    OriginatingTo: fixture.originatingTo,
    AccountId: fixture.accountId ?? "default",
    ...(fixture.senderId ? { SenderId: fixture.senderId } : {}),
    ...(fixture.sessionKey ? { SessionKey: fixture.sessionKey } : {}),
    ...(fixture.threadId ? { MessageThreadId: fixture.threadId } : {}),
    ...(fixture.threadParentId ? { ThreadParentId: fixture.threadParentId } : {}),
  });
  params.command.senderId = fixture.senderId ?? "user-1";
  return params;
}

async function runDiscordAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createDiscordParams(commandBody, cfg), true);
}

async function runThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createThreadParams(commandBody, cfg), true);
}

async function runTelegramAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "telegram",
        originatingTo: "telegram:-1003841603622",
        threadId: "498",
      },
      cfg,
    ),
    true,
  );
}

async function runTelegramDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "telegram",
        originatingTo: "telegram:123456789",
      },
      cfg,
    ),
    true,
  );
}

async function runSlackDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "slack",
        originatingTo: "user:U123",
        senderId: "U123",
      },
      cfg,
    ),
    true,
  );
}

function createMatrixThreadParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = createConversationParams(
    commandBody,
    {
      channel: "matrix",
      originatingTo: "room:!room:example.org",
    },
    cfg,
  );
  params.ctx.MessageThreadId = "$thread-root";
  return params;
}

async function runMatrixAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "matrix",
        originatingTo: "room:!room:example.org",
      },
      cfg,
    ),
    true,
  );
}

async function runMatrixThreadAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(createMatrixThreadParams(commandBody, cfg), true);
}

async function runFeishuDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "feishu",
        originatingTo: "user:ou_sender_1",
        senderId: "ou_sender_1",
      },
      cfg,
    ),
    true,
  );
}

async function runLineDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "line",
        originatingTo: "U1234567890abcdef1234567890abcdef",
        senderId: "U1234567890abcdef1234567890abcdef",
      },
      cfg,
    ),
    true,
  );
}

async function runIMessageDmAcpCommand(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  return handleAcpCommand(
    createConversationParams(
      commandBody,
      {
        channel: "imessage",
        originatingTo: "imessage:+15555550123",
      },
      cfg,
    ),
    true,
  );
}

async function runInternalAcpCommand(params: {
  commandBody: string;
  scopes: string[];
  cfg?: OpenClawConfig;
}) {
  const commandParams = buildCommandTestParams(params.commandBody, params.cfg ?? baseCfg, {
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
    OriginatingTo: "webchat:conversation-1",
    GatewayClientScopes: params.scopes,
  });
  commandParams.command.channel = INTERNAL_MESSAGE_CHANNEL;
  commandParams.command.senderId = "user-1";
  commandParams.command.senderIsOwner = true;
  return handleAcpCommand(commandParams, true);
}

describe("/acp command", () => {
  beforeEach(() => {
    setMinimalAcpCommandRegistryForTests();
    acpManagerTesting.resetAcpSessionManagerForTests();
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
    acpResetTargetTesting.setDepsForTest({
      getSessionBindingService: () => createAcpCommandSessionBindingService() as never,
    });
    hoisted.listAcpSessionEntriesMock.mockReset().mockResolvedValue([]);
    hoisted.callGatewayMock.mockReset().mockResolvedValue({ ok: true });
    hoisted.readAcpSessionEntryMock.mockReset().mockReturnValue(null);
    hoisted.upsertAcpSessionMetaMock.mockReset().mockResolvedValue({
      sessionId: "session-1",
      updatedAt: Date.now(),
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "run-1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    hoisted.resolveSessionStorePathForAcpMock.mockReset().mockReturnValue({
      cfg: baseCfg,
      storePath: "/tmp/sessions-acp.json",
    });
    hoisted.loadSessionStoreMock.mockReset().mockReturnValue({});
    hoisted.sessionBindingCapabilitiesMock
      .mockReset()
      .mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingBindMock
      .mockReset()
      .mockImplementation(async (input: AcpBindInput) => createAcpThreadBinding(input));
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);

    hoisted.ensureSessionMock
      .mockReset()
      .mockImplementation(async (input: { sessionKey: string }) => ({
        sessionKey: input.sessionKey,
        backend: "acpx",
        runtimeSessionName: `${input.sessionKey}:runtime`,
      }));
    hoisted.runTurnMock.mockReset().mockImplementation(async function* () {
      yield { type: "done" };
    });
    hoisted.cancelMock.mockReset().mockResolvedValue(undefined);
    hoisted.closeMock.mockReset().mockResolvedValue(undefined);
    hoisted.getCapabilitiesMock.mockReset().mockResolvedValue({
      controls: ["session/set_mode", "session/set_config_option", "session/status"],
    });
    hoisted.getStatusMock.mockReset().mockResolvedValue({
      summary: "status=alive sessionId=sid-1 pid=1234",
      details: { status: "alive", sessionId: "sid-1", pid: 1234 },
    });
    hoisted.setModeMock.mockReset().mockResolvedValue(undefined);
    hoisted.setConfigOptionMock.mockReset().mockResolvedValue(undefined);
    hoisted.doctorMock.mockReset().mockResolvedValue({
      ok: true,
      message: "acpx command available",
    });

    const runtimeBackend = {
      id: "acpx",
      runtime: {
        ensureSession: hoisted.ensureSessionMock,
        runTurn: hoisted.runTurnMock,
        getCapabilities: hoisted.getCapabilitiesMock,
        getStatus: hoisted.getStatusMock,
        setMode: hoisted.setModeMock,
        setConfigOption: hoisted.setConfigOptionMock,
        doctor: hoisted.doctorMock,
        cancel: hoisted.cancelMock,
        close: hoisted.closeMock,
      },
    };
    hoisted.requireAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
    hoisted.getAcpRuntimeBackendMock.mockReset().mockReturnValue(runtimeBackend);
    acpManagerTesting.setAcpSessionManagerForTests({
      initializeSession: async (input: {
        sessionKey: string;
        agent: string;
        mode: "persistent" | "oneshot";
        cwd?: string;
      }) => {
        const backend = hoisted.requireAcpRuntimeBackendMock("acpx") as {
          id?: string;
          runtime: typeof runtimeBackend.runtime;
        };
        const ensured = await hoisted.ensureSessionMock({
          sessionKey: input.sessionKey,
          agent: input.agent,
          mode: input.mode,
          cwd: input.cwd,
        });
        const now = Date.now();
        const meta = {
          backend: ensured.backend ?? "acpx",
          agent: input.agent,
          runtimeSessionName: ensured.runtimeSessionName ?? `${input.sessionKey}:runtime`,
          mode: input.mode,
          state: "idle" as const,
          lastActivityAt: now,
          ...(input.cwd ? { cwd: input.cwd, runtimeOptions: { cwd: input.cwd } } : {}),
          ...(typeof ensured.agentSessionId === "string" ||
          typeof ensured.backendSessionId === "string"
            ? {
                identity: {
                  state: "resolved" as const,
                  source: "status" as const,
                  acpxSessionId:
                    typeof ensured.backendSessionId === "string"
                      ? ensured.backendSessionId
                      : "acpx-1",
                  agentSessionId:
                    typeof ensured.agentSessionId === "string"
                      ? ensured.agentSessionId
                      : input.sessionKey,
                  lastUpdatedAt: now,
                },
              }
            : {}),
        };
        await hoisted.upsertAcpSessionMetaMock({
          sessionKey: input.sessionKey,
          mutate: () => meta,
        });
        return {
          runtime: backend.runtime,
          handle: {
            backend: meta.backend,
            runtimeSessionName: meta.runtimeSessionName,
          },
          meta,
        };
      },
      resolveSession: (input: { sessionKey: string }) => {
        const entry = hoisted.readAcpSessionEntryMock({
          sessionKey: input.sessionKey,
        }) as { acp?: Record<string, unknown> } | null;
        const meta =
          entry?.acp ??
          ({
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: `${input.sessionKey}:runtime`,
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          } as const);
        return {
          kind: "ready" as const,
          sessionKey: input.sessionKey,
          meta,
        };
      },
      cancelSession: async (input: unknown) => {
        await hoisted.cancelMock(input);
      },
      getSessionStatus: async (input: { sessionKey: string }) => {
        const status = await hoisted.getStatusMock(input);
        const entry = hoisted.readAcpSessionEntryMock({
          sessionKey: input.sessionKey,
        }) as { acp?: Record<string, unknown> } | null;
        const meta = entry?.acp ?? {};
        return {
          sessionKey: input.sessionKey,
          backend: typeof meta.backend === "string" ? meta.backend : "acpx",
          agent: typeof meta.agent === "string" ? meta.agent : "codex",
          identity: meta.identity,
          state: meta.state ?? "idle",
          mode: meta.mode ?? "persistent",
          runtimeOptions: meta.runtimeOptions ?? {},
          capabilities: {
            controls: ["session/set_mode", "session/set_config_option", "session/status"],
          },
          runtimeStatus: status,
          lastActivityAt:
            typeof meta.lastActivityAt === "number" ? meta.lastActivityAt : Date.now(),
          ...(typeof meta.lastError === "string" ? { lastError: meta.lastError } : {}),
        };
      },
      getObservabilitySnapshot: () => ({
        runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
        turns: {
          active: 0,
          queueDepth: 0,
          completed: 0,
          failed: 0,
          averageLatencyMs: 0,
          maxLatencyMs: 0,
        },
        errorsByCode: {},
      }),
      runTurn: async (input: { onEvent?: (event: unknown) => Promise<void> | void }) => {
        for await (const event of hoisted.runTurnMock(input) as AsyncIterable<unknown>) {
          await input.onEvent?.(event);
        }
      },
      setSessionRuntimeMode: async (input: { sessionKey: string; runtimeMode: string }) => {
        await hoisted.setModeMock(input);
        return { mode: input.runtimeMode };
      },
      setSessionConfigOption: async (input: { key: string; value: string }) => {
        await hoisted.setConfigOptionMock(input);
        return { [input.key]: input.value };
      },
      updateSessionRuntimeOptions: async (input: { patch: Record<string, unknown> }) => input.patch,
      closeSession: async (input: { clearMeta?: boolean; sessionKey: string }) => {
        await hoisted.closeMock(input);
        if (input.clearMeta === true) {
          await hoisted.upsertAcpSessionMetaMock({
            sessionKey: input.sessionKey,
            mutate: () => null,
          });
        }
        return {
          runtimeClosed: true,
          metaCleared: input.clearMeta === true,
        };
      },
    });
  });

  afterEach(() => {
    resetTaskRegistryForTests({ persist: false });
  });

  it("returns null when the message is not /acp", async () => {
    const result = await runDiscordAcpCommand("/status");
    expect(result).toBeNull();
  });

  it("shows help by default", async () => {
    const result = await runDiscordAcpCommand("/acp");
    expect(result?.reply?.text).toContain("ACP commands:");
    expect(result?.reply?.text).toContain("/acp spawn");
  });

  it("spawns an ACP session and binds a Discord thread", async () => {
    hoisted.ensureSessionMock.mockResolvedValueOnce({
      sessionKey: "agent:codex:acp:s1",
      backend: "acpx",
      runtimeSessionName: "agent:codex:acp:s1:runtime",
      agentSessionId: "codex-inner-1",
      backendSessionId: "acpx-1",
    });

    const result = await runDiscordAcpCommand("/acp spawn codex --cwd /home/bob/clawd");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Created thread thread-created and bound it");
    expect(hoisted.requireAcpRuntimeBackendMock).toHaveBeenCalledWith("acpx");
    expectMockCallFields(hoisted.ensureSessionMock, {
      agent: "codex",
      mode: "persistent",
      cwd: "/home/bob/clawd",
    });
    const bindInput = expectBindingBindCall({
      targetKind: "session",
      placement: "child",
    });
    const introText = (bindInput.metadata as { introText?: unknown } | undefined)?.introText;
    expect(typeof introText).toBe("string");
    expect(introText).toContain("cwd: /home/bob/clawd");
    expectBoundIntroTextToExclude("session ids: pending (available after the first reply)");
    expectGatewayMethodNotCalled("sessions.patch");
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    const upsertArgs = hoisted.upsertAcpSessionMetaMock.mock.calls.at(0)?.[0] as
      | {
          sessionKey: string;
          mutate: (
            current: unknown,
            entry: { sessionId: string; updatedAt: number } | undefined,
          ) => {
            backend?: string;
            runtimeSessionName?: string;
          };
        }
      | undefined;
    expect(upsertArgs?.sessionKey).toMatch(/^agent:codex:acp:/);
    const seededWithoutEntry = upsertArgs?.mutate(undefined, undefined);
    expect(seededWithoutEntry?.backend).toBe("acpx");
    expect(seededWithoutEntry?.runtimeSessionName).toContain(":runtime");
  });

  it("persists ACP spawn labels without a nested gateway self-call", async () => {
    const params = createDiscordParams("/acp spawn codex --bind here --label inbox");

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectGatewayMethodNotCalled("sessions.patch");
  });

  it("accepts unicode dash option prefixes in /acp spawn args", async () => {
    const result = await runThreadAcpCommand(
      "/acp spawn codex \u2014mode oneshot \u2014thread here \u2014cwd /home/bob/clawd \u2014label jeerreview",
    );

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this thread to");
    expectMockCallFields(hoisted.ensureSessionMock, {
      agent: "codex",
      mode: "oneshot",
      cwd: "/home/bob/clawd",
    });
    expectBindingBindCall({
      placement: "current",
      metadata: { label: "jeerreview" },
    });
  });

  it("binds the current Discord channel with --bind here without creating a child thread", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex --bind here", cfg);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:parent-1",
      },
    });
  });

  it("binds iMessage DMs with --bind here", async () => {
    const result = await runIMessageDmAcpCommand("/acp spawn codex --bind here");

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550123",
      },
    });
  });

  it("binds Slack DMs with --bind here through the generic conversation path", async () => {
    const result = await runSlackDmAcpCommand("/acp spawn codex --bind here");

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
    });
  });

  it("binds Telegram topic ACP spawns to full conversation ids", async () => {
    const result = await runTelegramAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(result?.reply?.delivery).toEqual({ pin: { enabled: true } });
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003841603622:topic:498",
      },
    });
  });

  it("binds Telegram DM ACP spawns to the DM conversation id", async () => {
    const result = await runTelegramDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expect(result?.reply?.channelData).toBeUndefined();
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123456789",
      },
    });
  });

  it("binds Matrix rooms with --bind here without requiring thread spawn", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
            spawnSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixAcpCommand("/acp spawn codex --bind here", cfg);

    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "!room:example.org",
      },
    });
  });

  it("creates Matrix thread-bound ACP spawns from top-level rooms when enabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
            spawnSessions: true,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("Created thread thread-created and bound it");
    expectBindingBindCall({
      placement: "child",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "!room:example.org",
      },
    });
  });

  it("binds Matrix thread ACP spawns to the current thread with the parent room id", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
            spawnSessions: true,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixThreadAcpCommand("/acp spawn codex --thread here", cfg);

    expect(result?.reply?.text).toContain("Bound this thread to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "matrix",
        accountId: "default",
        conversationId: "$thread-root",
        parentConversationId: "!room:example.org",
      },
    });
  });

  it("binds Feishu DM ACP spawns to the current DM conversation", async () => {
    const result = await runFeishuDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "user:ou_sender_1",
      },
    });
  });

  it("binds LINE DM ACP spawns to the current conversation", async () => {
    const result = await runLineDmAcpCommand("/acp spawn codex --thread here");

    expect(result?.reply?.text).toContain("Spawned ACP session agent:codex:acp:");
    expect(result?.reply?.text).toContain("Bound this conversation to");
    expectBindingBindCall({
      placement: "current",
      conversation: {
        channel: "line",
        accountId: "default",
        conversationId: "U1234567890abcdef1234567890abcdef",
      },
    });
  });

  it("requires explicit ACP target when acp.defaultAgent is not configured", async () => {
    const result = await runDiscordAcpCommand("/acp spawn");

    expect(result?.reply?.text).toContain("ACP target harness id is required");
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
  });

  it("rejects mixing --thread and --bind on the same /acp spawn", async () => {
    const result = await runDiscordAcpCommand("/acp spawn codex --thread here --bind here");

    expect(result?.reply?.text).toContain("Use either --thread or --bind");
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("rejects thread-bound ACP spawn when spawnSessions is disabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        discord: {
          threadBindings: {
            enabled: true,
            spawnSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("spawnSessions=true");
    expect(hoisted.closeMock).toHaveBeenCalledTimes(2);
    expectGatewayMethodCalled("sessions.delete");
    expectGatewayMethodNotCalled("sessions.patch");
  });

  it("rejects Matrix thread-bound ACP spawn when spawnSessions is disabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        matrix: {
          threadBindings: {
            enabled: true,
            spawnSessions: false,
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runMatrixAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("spawnSessions=true");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("forbids /acp spawn from sandboxed requester sessions", async () => {
    const cfg = {
      ...baseCfg,
      agents: {
        defaults: {
          sandbox: { mode: "all" },
        },
      },
    } satisfies OpenClawConfig;

    const result = await runDiscordAcpCommand("/acp spawn codex", cfg);

    expect(result?.reply?.text).toContain("Sandboxed sessions cannot spawn ACP sessions");
    expect(hoisted.requireAcpRuntimeBackendMock).not.toHaveBeenCalled();
    expect(hoisted.ensureSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  });

  it("cancels the ACP session bound to the current thread", async () => {
    mockBoundThreadSession({ state: "running" });
    const result = await runThreadAcpCommand("/acp cancel", baseCfg);
    expect(result?.reply?.text).toContain(
      `Cancel requested for ACP session ${defaultAcpSessionKey}`,
    );
    expect(hoisted.cancelMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      reason: "manual-cancel",
      sessionKey: defaultAcpSessionKey,
    });
  });

  it("sends steer instructions via ACP runtime", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return { key: defaultAcpSessionKey };
      }
      return { ok: true };
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Applied steering." };
      yield { type: "done" };
    });

    const result = await runDiscordAcpCommand(
      `/acp steer --session ${defaultAcpSessionKey} tighten logging`,
    );

    expectMockCallFields(hoisted.runTurnMock, {
      mode: "steer",
      text: "tighten logging",
    });
    expect(result?.reply?.text).toContain("Applied steering.");
  });

  it("resolves bound Telegram topic ACP sessions for /acp steer without explicit target", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockImplementation(
      (ref: { channel?: string; accountId?: string; conversationId?: string }) =>
        ref.channel === "telegram" &&
        ref.accountId === "default" &&
        ref.conversationId === "-1003841603622:topic:498"
          ? createSessionBinding({
              targetSessionKey: defaultAcpSessionKey,
              conversation: {
                channel: "telegram",
                accountId: "default",
                conversationId: "-1003841603622:topic:498",
              },
            })
          : null,
    );
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Viewed diver package." };
      yield { type: "done" };
    });

    const result = await runTelegramAcpCommand("/acp steer use npm to view package diver");

    expectMockCallFields(hoisted.runTurnMock, {
      cfg: baseCfg,
      mode: "steer",
      sessionKey: defaultAcpSessionKey,
      text: "use npm to view package diver",
    });
    expect(result?.reply?.text).toContain("Viewed diver package.");
  });

  it("resolves ACP reset targets through the configured default account when AccountId is omitted", () => {
    const cfg = {
      ...baseCfg,
      channels: {
        ...baseCfg.channels,
        discord: {
          ...baseCfg.channels.discord,
          defaultAccount: "work",
        },
      },
    } satisfies OpenClawConfig;
    hoisted.sessionBindingResolveByConversationMock.mockImplementation(
      (ref: {
        channel?: string;
        accountId?: string;
        conversationId?: string;
        parentConversationId?: string;
      }) =>
        ref.channel === "discord" &&
        ref.accountId === "work" &&
        ref.conversationId === defaultThreadId &&
        ref.parentConversationId === "parent-1"
          ? createSessionBinding({
              targetSessionKey: defaultAcpSessionKey,
              conversation: {
                channel: "discord",
                accountId: "work",
                conversationId: defaultThreadId,
                parentConversationId: "parent-1",
              },
            })
          : null,
    );

    const result = resolveEffectiveResetTargetSessionKey({
      cfg,
      channel: "discord",
      conversationId: defaultThreadId,
      parentConversationId: "parent-1",
    });

    expectMockCallFields(hoisted.sessionBindingResolveByConversationMock, {
      channel: "discord",
      accountId: "work",
      conversationId: defaultThreadId,
      parentConversationId: "parent-1",
    });
    expect(result).toBe(defaultAcpSessionKey);
  });

  it("blocks /acp steer when ACP dispatch is disabled by policy", async () => {
    const cfg = {
      ...baseCfg,
      acp: {
        ...baseCfg.acp,
        dispatch: { enabled: false },
      },
    } satisfies OpenClawConfig;
    const result = await runDiscordAcpCommand("/acp steer tighten logging", cfg);
    expect(result?.reply?.text).toContain("ACP dispatch is disabled by policy");
    expect(hoisted.runTurnMock).not.toHaveBeenCalled();
  });

  it("falls through to thread-bound resolution when explicit session token is unresolvable", async () => {
    // callGateway returns null for sessions.resolve (unresolvable token)
    // but a thread-bound session exists — should use thread-bound, not error out
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return null; // token lookup fails
      }
      return { ok: true };
    });
    mockBoundThreadSession();
    hoisted.readAcpSessionEntryMock.mockReturnValue(createAcpSessionEntry());
    hoisted.runTurnMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "Steered." };
      yield { type: "done" };
    });

    const result = await runThreadAcpCommand(
      `/acp steer --session unresolvable-token-xyz tighten logging`,
    );

    expectMockCallFields(hoisted.runTurnMock, {
      mode: "steer",
      sessionKey: defaultAcpSessionKey,
    });
    expect(result?.reply?.text).toContain("Steered.");
  });

  it("closes an ACP session, unbinds thread targets, and clears metadata", async () => {
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await runThreadAcpCommand("/acp close", baseCfg);

    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expectMockCallFields(hoisted.sessionBindingUnbindMock, {
      targetSessionKey: defaultAcpSessionKey,
      reason: "manual",
    });
    expect(hoisted.upsertAcpSessionMetaMock).toHaveBeenCalledTimes(1);
    const clearMetaArgs = hoisted.upsertAcpSessionMetaMock.mock.calls.at(0)?.[0] as
      | {
          sessionKey: string;
          mutate: (current: unknown, entry: { sessionId: string; updatedAt: number }) => unknown;
        }
      | undefined;
    expect(clearMetaArgs?.sessionKey).toBe(defaultAcpSessionKey);
    expect(clearMetaArgs?.mutate(undefined, { sessionId: "session-1", updatedAt: 0 })).toBeNull();
    expect(result?.reply?.text).toContain("Removed 1 binding");
  });

  it("closes the bound thread ACP session when an explicit session token is unresolvable", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return null;
      }
      return { ok: true };
    });
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await runThreadAcpCommand("/acp close not-a-session-target");

    expect(hoisted.closeMock).toHaveBeenCalledWith({
      cfg: baseCfg,
      sessionKey: defaultAcpSessionKey,
      reason: "manual-close",
      allowBackendUnavailable: true,
      clearMeta: true,
    });
    expectMockCallFields(hoisted.sessionBindingUnbindMock, {
      targetSessionKey: defaultAcpSessionKey,
      reason: "manual",
    });
    expect(result?.reply?.text).toContain(`Closed ACP session ${defaultAcpSessionKey}`);
  });

  it("reports an explicit bad ACP session token before requester fallback", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        return null;
      }
      return { ok: true };
    });
    const params = createConversationParams("/acp close not-a-session-target", {
      channel: "discord",
      originatingTo: "channel:parent-1",
      sessionKey: "requester-session",
    });

    const result = await handleAcpCommand(params, true);

    expect(result?.reply?.text).toContain("Unable to resolve session target: not-a-session-target");
    expect(hoisted.closeMock).not.toHaveBeenCalled();
    expect(hoisted.readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("handles /acp close in a bound thread when text commands are disabled", async () => {
    mockBoundThreadSession();
    hoisted.sessionBindingUnbindMock.mockResolvedValue([
      createBoundThreadSession() as SessionBindingRecord,
    ]);

    const result = await handleAcpCommand(createThreadParams("/acp close", baseCfg), false);

    expect(hoisted.closeMock).toHaveBeenCalledTimes(1);
    expectMockCallFields(hoisted.sessionBindingUnbindMock, {
      targetSessionKey: defaultAcpSessionKey,
      reason: "manual",
    });
    expect(result?.reply?.text).toContain("Removed 1 binding");
  });

  it("lists ACP sessions from the session store", async () => {
    hoisted.sessionBindingListBySessionMock.mockImplementation((key: string) =>
      key === defaultAcpSessionKey ? [createBoundThreadSession(key) as SessionBindingRecord] : [],
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      [defaultAcpSessionKey]: {
        sessionId: "sess-1",
        updatedAt: Date.now(),
        label: "codex-main",
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "runtime-1",
          mode: "persistent",
          state: "idle",
          lastActivityAt: Date.now(),
        },
      },
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    });

    const result = await runDiscordAcpCommand("/acp sessions", baseCfg);

    expect(result?.reply?.text).toContain("ACP sessions:");
    expect(result?.reply?.text).toContain("codex-main");
    expect(result?.reply?.text).toContain(`thread:${defaultThreadId}`);
  });

  it("shows ACP status for the thread-bound ACP session", async () => {
    mockBoundThreadSession({
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "codex-sid-1",
        lastUpdatedAt: Date.now(),
      },
    });
    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: defaultAcpSessionKey,
      runId: "acp-run-1",
      task: "Inspect ACP backlog",
      status: "running",
      progressSummary: "Fetching the latest runtime state",
    });
    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain(`session: ${defaultAcpSessionKey}`);
    expect(result?.reply?.text).toContain("agent session id: codex-sid-1");
    expect(result?.reply?.text).toContain("acpx session id: acpx-sid-1");
    expect(result?.reply?.text).toContain("taskStatus: running");
    expect(result?.reply?.text).toContain("taskProgress: Fetching the latest runtime state");
    expect(result?.reply?.text).toContain("capabilities:");
    expect(hoisted.getStatusMock).toHaveBeenCalledTimes(1);
  });

  it("sanitizes leaked task and runtime details in ACP status output", async () => {
    mockBoundThreadSession({
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-sid-1",
        agentSessionId: "codex-sid-1",
        lastUpdatedAt: Date.now(),
      },
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      ...createAcpSessionEntry({
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
        },
      }),
      acp: {
        ...createAcpSessionEntry().acp,
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-sid-1",
          agentSessionId: "codex-sid-1",
          lastUpdatedAt: Date.now(),
        },
        lastError: [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
      },
    });
    hoisted.getStatusMock.mockResolvedValue({
      summary: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      details: {
        payload: [
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "source: subagent",
        ].join("\n"),
      },
    });
    createTaskRecord({
      runtime: "acp",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      childSessionKey: defaultAcpSessionKey,
      runId: "acp-run-1",
      task: "Inspect ACP backlog",
      status: "running",
    });
    failTaskRunByRunId({
      runId: "acp-run-1",
      endedAt: Date.now(),
      error: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
      terminalSummary: "Needs approval to continue.",
    });

    const result = await runThreadAcpCommand("/acp status", baseCfg);

    expect(result?.reply?.text).toContain("ACP status:");
    expect(result?.reply?.text).toContain("taskSummary: Needs approval to continue.");
    expect(result?.reply?.text).not.toContain("OpenClaw runtime context (internal):");
    expect(result?.reply?.text).not.toContain("Internal task completion event");
  });

  it("updates ACP runtime mode via /acp set-mode", async () => {
    mockBoundThreadSession();
    const result = await runThreadAcpCommand("/acp set-mode plan", baseCfg);

    expectMockCallFields(hoisted.setModeMock, {
      cfg: baseCfg,
      runtimeMode: "plan",
      sessionKey: defaultAcpSessionKey,
    });
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("blocks mutating /acp actions for internal operator.write clients", async () => {
    const result = await runInternalAcpCommand({
      commandBody: "/acp set-mode plan",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("blocks /acp status for internal operator.write clients", async () => {
    const result = await runInternalAcpCommand({
      commandBody: "/acp status",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("keeps read-only /acp actions available to internal operator.write clients", async () => {
    hoisted.listAcpSessionEntriesMock.mockResolvedValue([
      createAcpSessionEntry({
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "runtime-1",
          agentSessionId: "session-1",
          lastUpdatedAt: Date.now(),
        },
      }),
    ]);

    const result = await runInternalAcpCommand({
      commandBody: "/acp sessions",
      scopes: ["operator.write"],
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("ACP sessions");
  });

  it("allows mutating /acp actions for internal operator.admin clients", async () => {
    mockBoundThreadSession();

    const result = await runInternalAcpCommand({
      commandBody: "/acp set-mode plan",
      scopes: ["operator.admin"],
    });

    expectMockCallFields(hoisted.setModeMock, {
      cfg: baseCfg,
      runtimeMode: "plan",
    });
    expect(result?.reply?.text).toContain("Updated ACP runtime mode");
  });

  it("updates ACP config options and keeps cwd local when using /acp set", async () => {
    mockBoundThreadSession();

    const setModel = await runThreadAcpCommand("/acp set model gpt-5.4", baseCfg);
    expectMockCallFields(hoisted.setConfigOptionMock, {
      key: "model",
      value: "gpt-5.4",
    });
    expect(setModel?.reply?.text).toContain("Updated ACP config option");

    hoisted.setConfigOptionMock.mockClear();
    const setCwd = await runThreadAcpCommand("/acp set cwd /tmp/worktree", baseCfg);
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
    expect(setCwd?.reply?.text).toContain("Updated ACP cwd");
  });

  it("rejects non-absolute cwd values via ACP runtime option validation", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp cwd relative/path", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(result?.reply?.text).toContain("absolute path");
  });

  it("rejects invalid timeout values before backend config writes", async () => {
    mockBoundThreadSession();

    const result = await runThreadAcpCommand("/acp timeout 10s", baseCfg);

    expect(result?.reply?.text).toContain("ACP error (ACP_INVALID_RUNTIME_OPTION)");
    expect(hoisted.setConfigOptionMock).not.toHaveBeenCalled();
  });

  it("returns actionable doctor output when backend is missing", async () => {
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const result = await runDiscordAcpCommand("/acp doctor", baseCfg);

    expect(result?.reply?.text).toContain("ACP doctor:");
    expect(result?.reply?.text).toContain("healthy: no");
    expect(result?.reply?.text).toContain("next:");
  });

  it("explains when acpx is blocked by plugins.allow", async () => {
    hoisted.getAcpRuntimeBackendMock.mockReturnValue(null);
    hoisted.requireAcpRuntimeBackendMock.mockImplementation(() => {
      throw new AcpRuntimeError(
        "ACP_BACKEND_MISSING",
        "ACP runtime backend is not configured. Install and enable the acpx runtime plugin.",
      );
    });

    const result = await runDiscordAcpCommand("/acp doctor", {
      ...baseCfg,
      plugins: { allow: ["discord"] },
    });

    expect(result?.reply?.text).toContain("pluginActivation: blocked");
    expect(result?.reply?.text).toContain("acpx");
    expect(result?.reply?.text).toContain('add "acpx" to plugins.allow');
  });

  it("shows deterministic install instructions via /acp install", async () => {
    const result = await runDiscordAcpCommand("/acp install", baseCfg);

    expect(result?.reply?.text).toContain("ACP install:");
    expect(result?.reply?.text).toContain("run:");
    expect(result?.reply?.text).toContain("then: /acp doctor");
  });
});
