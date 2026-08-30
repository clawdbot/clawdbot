// Tests conversation binding lifecycle updates and non-destructive detach.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const TOPIC_CHANNEL = "topic-chat";

type ResolveCommandConversationParams = {
  threadId?: string;
  threadParentId?: string;
  parentSessionKey?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
};

type IdleLifecycleScenario = {
  name: string;
  createParams: (commandBody: string) => HandleCommandsParams;
  createBinding: () => SessionBindingRecord;
  updateBinding: ReturnType<typeof vi.fn>;
  expectedConversation?: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId: string;
    threadId: string;
  };
};

function firstText(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean) || undefined;
}

function normalizeCommandContextText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim().toLowerCase();
  }
  return "";
}

function resolveThreadTargetId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^thread-chat:/i, "")
    .replace(/^channel:/i, "")
    .trim();
}

function resolveThreadCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveThreadTargetId(params.threadParentId),
    resolveThreadTargetId(params.originatingTo),
    resolveThreadTargetId(params.commandTo),
    resolveThreadTargetId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveRoomId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^room-chat:/i, "")
    .replace(/^(room|channel):/i, "")
    .trim();
}

function resolveRoomCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveRoomId(params.originatingTo),
    resolveRoomId(params.commandTo),
    resolveRoomId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveTopicCommandConversation(params: ResolveCommandConversationParams) {
  const chatId = firstText([params.originatingTo, params.commandTo, params.fallbackTo])
    ?.replace(/^topic-chat:/i, "")
    .trim();
  if (!chatId) {
    return null;
  }
  if (params.threadId) {
    return {
      conversationId: `${chatId}:topic:${params.threadId}`,
      parentConversationId: chatId,
    };
  }
  if (chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
  };
}

const hoisted = vi.hoisted(() => {
  const threadChannel = "thread-chat";
  const roomChannel = "room-chat";
  const topicChannel = "topic-chat";
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setTelegramThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  function createRuntimeChannel(
    id: string,
    resolveCommandConversation: (params: ResolveCommandConversationParams) => {
      conversationId: string;
      parentConversationId?: string;
    } | null,
    setIdleTimeoutBySessionKey: typeof setThreadBindingIdleTimeoutBySessionKeyMock,
    setMaxAgeBySessionKey: typeof setThreadBindingMaxAgeBySessionKeyMock,
  ) {
    return {
      plugin: {
        id,
        meta: {},
        config: { hasPersistedAuthState: () => false },
        bindings: { resolveCommandConversation },
        conversationBindings: {
          supportsCurrentConversationBinding: true,
          setIdleTimeoutBySessionKey,
          setMaxAgeBySessionKey,
        },
      },
    };
  }
  const runtimeChannelRegistry = {
    channels: [
      createRuntimeChannel(
        threadChannel,
        resolveThreadCommandConversation,
        setThreadBindingIdleTimeoutBySessionKeyMock,
        setThreadBindingMaxAgeBySessionKeyMock,
      ),
      createRuntimeChannel(
        roomChannel,
        resolveRoomCommandConversation,
        setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
        setMatrixThreadBindingMaxAgeBySessionKeyMock,
      ),
      createRuntimeChannel(
        topicChannel,
        resolveTopicCommandConversation,
        setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
        setTelegramThreadBindingMaxAgeBySessionKeyMock,
      ),
    ],
  };
  return {
    setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKeyMock,
    setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
    setMatrixThreadBindingMaxAgeBySessionKeyMock,
    setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
    setTelegramThreadBindingMaxAgeBySessionKeyMock,
    sessionBindingResolveByConversationMock,
    sessionBindingUnbindMock,
    runtimeChannelRegistry,
  };
});

vi.mock("../../plugins/runtime.js", () => {
  return {
    getActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
    requireActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    requireActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginRegistryVersion: () => 1,
    getActivePluginChannelRegistryVersion: () => 1,
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) =>
    hoisted.runtimeChannelRegistry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  getLoadedChannelPlugin: (channelId: string) =>
    hoisted.runtimeChannelRegistry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  normalizeChannelId: (raw?: string | null) => {
    const normalized = raw?.trim().toLowerCase();
    return normalized || null;
  },
}));

vi.mock("../../channels/plugins/conversation-bindings.js", () => ({
  setChannelConversationBindingIdleTimeoutBySessionKey: (params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string | null;
    idleTimeoutMs: number;
  }) => {
    return (
      hoisted.runtimeChannelRegistry.channels
        .find((entry) => entry.plugin.id === params.channelId)
        ?.plugin.conversationBindings.setIdleTimeoutBySessionKey({
          targetSessionKey: params.targetSessionKey,
          accountId: params.accountId,
          idleTimeoutMs: params.idleTimeoutMs,
        }) ?? []
    );
  },
  setChannelConversationBindingMaxAgeBySessionKey: (params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string | null;
    maxAgeMs: number;
  }) => {
    return (
      hoisted.runtimeChannelRegistry.channels
        .find((entry) => entry.plugin.id === params.channelId)
        ?.plugin.conversationBindings.setMaxAgeBySessionKey({
          targetSessionKey: params.targetSessionKey,
          accountId: params.accountId,
          maxAgeMs: params.maxAgeMs,
        }) ?? []
    );
  },
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => {
  return {
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
      touch: vi.fn(),
      unbind: hoisted.sessionBindingUnbindMock,
    }),
  };
});

let handleSessionCommand: (typeof import("./commands-session.js"))["handleSessionCommand"];
const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function buildSessionCommandParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "quietchat",
    Surface: "quietchat",
    From: "+1222",
    To: "+1222",
    SenderId: "user-1",
    ...ctxOverrides,
  } as HandleCommandsParams["ctx"];
  const channel = normalizeCommandContextText(ctx.Provider ?? ctx.Surface);
  const senderId = typeof ctx.SenderId === "string" ? ctx.SenderId : undefined;
  return {
    ctx,
    cfg: baseCfg,
    command: {
      surface: normalizeCommandContextText(ctx.Surface ?? ctx.Provider),
      channel,
      channelId: channel,
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      senderId,
      abortKey: senderId,
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: commandBody.trim().toLowerCase(),
      from: typeof ctx.From === "string" ? ctx.From : undefined,
      to: typeof ctx.To === "string" ? ctx.To : undefined,
    },
    directives: parseInlineSessionDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: channel,
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

function createThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: THREAD_CHANNEL,
    Surface: THREAD_CHANNEL,
    OriginatingChannel: THREAD_CHANNEL,
    OriginatingTo: "channel:thread-1",
    AccountId: "default",
    MessageThreadId: "thread-1",
    ...overrides,
  });
}

function createTopicCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: TOPIC_CHANNEL,
    Surface: TOPIC_CHANNEL,
    OriginatingChannel: TOPIC_CHANNEL,
    OriginatingTo: "-100200300:topic:77",
    AccountId: "default",
    MessageThreadId: "77",
    ...overrides,
  });
}

function createRoomThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$thread-1",
    ...overrides,
  });
}

function createRoomTriggerThreadCommandParams(
  commandBody: string,
  overrides?: Record<string, unknown>,
) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$root",
    ...overrides,
  });
}

function createRoomCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    ...overrides,
  });
}

function createLifecycleBinding(
  conversation: SessionBindingRecord["conversation"],
  overrides?: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  return {
    bindingId: `default:${conversation.conversationId}`,
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation,
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

function createThreadBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createLifecycleBinding(
    {
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "thread-1",
    },
    overrides,
  );
}

function createTopicBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createLifecycleBinding(
    {
      channel: TOPIC_CHANNEL,
      accountId: "default",
      conversationId: "-100200300:topic:77",
    },
    overrides,
  );
}

function createRoomBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createLifecycleBinding(
    {
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    },
    overrides,
  );
}

function createRoomTriggerBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createRoomBinding({
    bindingId: "default:$root",
    conversation: {
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
    },
    ...overrides,
  });
}

function expectIdleTimeoutSetReply(
  mock: ReturnType<typeof vi.fn>,
  text: string,
  idleTimeoutMs: number,
  idleTimeoutLabel: string,
) {
  expect(mock).toHaveBeenCalledWith({
    targetSessionKey: "agent:main:subagent:child",
    accountId: "default",
    idleTimeoutMs,
  });
  expect(text).toContain(`Idle timeout set to ${idleTimeoutLabel}`);
  expect(text).toContain("2026-02-20T02:00:00.000Z");
}

describe("/session conversation bindings", () => {
  beforeAll(async () => {
    ({ handleSessionCommand } = await import("./commands-session.js"));
  });

  beforeEach(() => {
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    vi.useRealTimers();
  });

  it.each([
    { name: "thread", createParams: createThreadCommandParams, createBinding: createThreadBinding },
    { name: "topic", createParams: createTopicCommandParams, createBinding: createTopicBinding },
    { name: "room", createParams: createRoomThreadCommandParams, createBinding: createRoomBinding },
    {
      name: "triggering thread",
      createParams: createRoomTriggerThreadCommandParams,
      createBinding: createRoomTriggerBinding,
    },
  ])("unbinds only the current $name conversation", async ({ createParams, createBinding }) => {
    const binding = createBinding();
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);

    const result = await handleSessionCommand(createParams("/session unbind"), true);

    expect(result?.reply?.text).toBe("✅ Conversation unbound.");
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledExactlyOnceWith({
      bindingId: binding.bindingId,
      reason: "manual",
    });
  });

  it("unbinds generic current conversations without channel lifecycle support", async () => {
    const binding = createLifecycleBinding({
      channel: "webchat",
      accountId: "default",
      conversationId: "chat-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);
    const params = buildSessionCommandParams("/session unbind", {
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      OriginatingTo: "chat-1",
    });

    const result = await handleSessionCommand(params, true);

    expect(result?.reply?.text).toBe("✅ Conversation unbound.");
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledExactlyOnceWith({
      bindingId: binding.bindingId,
      reason: "manual",
    });
  });

  it("requires the binding owner to unbind a conversation", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());

    const result = await handleSessionCommand(
      createThreadCommandParams("/session unbind", { SenderId: "other-user" }),
      true,
    );

    expect(result?.reply?.text).toContain("Only user-1 can unbind this conversation.");
    expect(hoisted.sessionBindingUnbindMock).not.toHaveBeenCalled();
  });

  it.each(["/session unbind other-session", "/session unbind all"])(
    "does not accept a detach target in %s",
    async (command) => {
      const result = await handleSessionCommand(createThreadCommandParams(command), true);
      expect(result?.reply?.text).toContain("Usage:");
      expect(hoisted.sessionBindingUnbindMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "sets idle timeout for the bound thread-chat session",
      createParams: createThreadCommandParams,
      createBinding: createThreadBinding,
      updateBinding: hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
    },
    {
      name: "sets idle timeout for bound topic-chat conversations",
      createParams: createTopicCommandParams,
      createBinding: createTopicBinding,
      updateBinding: hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
    },
    {
      name: "sets idle timeout for bound room-chat threads",
      createParams: createRoomThreadCommandParams,
      createBinding: createRoomBinding,
      updateBinding: hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
    },
    {
      name: "sets idle timeout for the triggering room-chat always-thread turn",
      createParams: createRoomTriggerThreadCommandParams,
      createBinding: createRoomTriggerBinding,
      updateBinding: hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      expectedConversation: {
        channel: ROOM_CHANNEL,
        accountId: "default",
        conversationId: "$root",
        parentConversationId: "!room:example.org",
        threadId: "$root",
      },
    },
  ] satisfies IdleLifecycleScenario[])(
    "$name",
    async ({
      createParams,
      createBinding,
      updateBinding,
      expectedConversation,
    }: IdleLifecycleScenario) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
      hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createBinding());
      updateBinding.mockReturnValue([
        {
          targetSessionKey: "agent:main:subagent:child",
          boundAt: Date.now(),
          lastActivityAt: Date.now(),
          idleTimeoutMs: 2 * 60 * 60 * 1000,
        },
      ]);

      const result = await handleSessionCommand(createParams("/session idle 2h"), true);
      if (expectedConversation) {
        expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith(
          expectedConversation,
        );
      }
      expectIdleTimeoutSetReply(updateBinding, result?.reply?.text ?? "", 2 * 60 * 60 * 1000, "2h");
    },
  );

  it("rejects unsafe bare-hour lifecycle durations", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());

    const result = await handleSessionCommand(
      createThreadCommandParams("/session idle 9999999999999"),
      true,
    );

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toBe(
      "Usage: /session idle <duration|off> | /session max-age <duration|off> | /session unbind (example: /session idle 24h)",
    );
  });

  it("shows active idle timeout when no value is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          lastActivityAt: Date.now(),
          idleTimeoutMs: 2 * 60 * 60 * 1000,
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(createThreadCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
    expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("falls back to bind time when idle activity timestamp is out of range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          lastActivityAt: 8_700_000_000_000_000,
          idleTimeoutMs: 2 * 60 * 60 * 1000,
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(createThreadCommandParams("/session idle"), true);
    expect(result?.reply?.text).toContain("Idle timeout active (2h");
    expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
  });

  it("treats overflowed idle timeout metadata as disabled", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          lastActivityAt: Date.now(),
          idleTimeoutMs: Number.MAX_SAFE_INTEGER,
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(createThreadCommandParams("/session idle"), true);
    expect(result?.reply?.text).toBe(
      "ℹ️ Idle timeout is currently disabled for this bound session.",
    );
  });

  it.each([
    {
      name: "sets max age for the bound thread-chat session",
      createParams: createThreadCommandParams,
      createBinding: createThreadBinding,
      updateBinding: hoisted.setThreadBindingMaxAgeBySessionKeyMock,
      boundAt: undefined,
      expiry: "2026-02-20T03:00:00.000Z",
    },
    {
      name: "sets max age for bound room-chat threads",
      createParams: createRoomThreadCommandParams,
      createBinding: createRoomBinding,
      updateBinding: hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock,
      boundAt: "2026-02-19T22:00:00.000Z",
      expiry: "2026-02-20T01:00:00.000Z",
    },
    {
      name: "reports topic-chat max-age expiry from the original bind time",
      createParams: createTopicCommandParams,
      createBinding: createTopicBinding,
      updateBinding: hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock,
      boundAt: "2026-02-19T22:00:00.000Z",
      expiry: "2026-02-20T01:00:00.000Z",
    },
  ] satisfies Array<{
    name: string;
    createParams: (commandBody: string) => HandleCommandsParams;
    createBinding: (overrides?: Partial<SessionBindingRecord>) => SessionBindingRecord;
    updateBinding: ReturnType<typeof vi.fn>;
    boundAt: string | undefined;
    expiry: string;
  }>)("$name", async ({ createParams, createBinding, updateBinding, boundAt, expiry }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
    const bindingTime = boundAt ? Date.parse(boundAt) : Date.now();
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createBinding({ boundAt: bindingTime }),
    );
    updateBinding.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: bindingTime,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(createParams("/session max-age 3h"), true);
    expect(updateBinding).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(result?.reply?.text).toContain("Max age set to 3h");
    expect(result?.reply?.text).toContain(expiry);
  });

  it("disables max age when set to off", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "user-1",
          lastActivityAt: Date.now(),
          idleTimeoutMs: 24 * 60 * 60 * 1000,
          maxAgeMs: 2 * 60 * 60 * 1000,
        },
      }),
    );
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        maxAgeMs: 0,
      },
    ]);

    const result = await handleSessionCommand(
      createThreadCommandParams("/session max-age off"),
      true,
    );

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 0,
    });
    expect(result?.reply?.text).toContain("Max age disabled");
  });

  it("is unavailable outside bindable channels", async () => {
    const params = buildSessionCommandParams("/session idle 2h");
    const result = await handleSessionCommand(params, true);
    expect(result?.reply?.text).toContain(
      "currently available only on channels that support conversation binding lifecycle updates",
    );
  });

  it("requires a bound room-chat thread for lifecycle updates", async () => {
    const result = await handleSessionCommand(createRoomCommandParams("/session idle 2h"), true);

    expect(result?.reply?.text).toContain("This conversation is not currently bound.");
    expect(hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
  });

  it("requires binding owner for lifecycle updates", async () => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: {
          boundBy: "owner-1",
          lastActivityAt: Date.now(),
          idleTimeoutMs: 24 * 60 * 60 * 1000,
          maxAgeMs: 0,
        },
      }),
    );

    const result = await handleSessionCommand(
      createThreadCommandParams("/session idle 2h", {
        SenderId: "other-user",
      }),
      true,
    );

    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Only owner-1 can update session lifecycle settings");
  });
});
