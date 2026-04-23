import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

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
  const runtimeChannelRegistry = {
    channels: [
      {
        plugin: {
          id: threadChannel,
          meta: {},
          config: {
            hasPersistedAuthState: () => false,
          },
          bindings: {
            resolveCommandConversation: resolveThreadCommandConversation,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            setIdleTimeoutBySessionKey: setThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setThreadBindingMaxAgeBySessionKeyMock,
          },
        },
      },
      {
        plugin: {
          id: roomChannel,
          meta: {},
          config: {
            hasPersistedAuthState: () => false,
          },
          bindings: {
            resolveCommandConversation: resolveRoomCommandConversation,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            setIdleTimeoutBySessionKey: setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setMatrixThreadBindingMaxAgeBySessionKeyMock,
          },
        },
      },
      {
        plugin: {
          id: topicChannel,
          meta: {},
          config: {
            hasPersistedAuthState: () => false,
          },
          bindings: {
            resolveCommandConversation: resolveTopicCommandConversation,
          },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            setIdleTimeoutBySessionKey: setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
            setMaxAgeBySessionKey: setTelegramThreadBindingMaxAgeBySessionKeyMock,
          },
        },
      },
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
    if (params.channelId === THREAD_CHANNEL) {
      return hoisted.setThreadBindingIdleTimeoutBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
      });
    }
    if (params.channelId === ROOM_CHANNEL) {
      return hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
      });
    }
    if (params.channelId === TOPIC_CHANNEL) {
      return hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        idleTimeoutMs: params.idleTimeoutMs,
      });
    }
    return [];
  },
  setChannelConversationBindingMaxAgeBySessionKey: (params: {
    channelId: string;
    targetSessionKey: string;
    accountId?: string | null;
    maxAgeMs: number;
  }) => {
    if (params.channelId === THREAD_CHANNEL) {
      return hoisted.setThreadBindingMaxAgeBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
      });
    }
    if (params.channelId === ROOM_CHANNEL) {
      return hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
      });
    }
    if (params.channelId === TOPIC_CHANNEL) {
      return hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock({
        targetSessionKey: params.targetSessionKey,
        accountId: params.accountId,
        maxAgeMs: params.maxAgeMs,
      });
    }
    return [];
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
      unbind: vi.fn(),
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
    directives: parseInlineDirectives(commandBody),
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

function createThreadBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "thread-1",
    },
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

function createTopicBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:-100200300:topic:77",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: TOPIC_CHANNEL,
      accountId: "default",
      conversationId: "-100200300:topic:77",
    },
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

function createRoomBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "default:$thread-1",
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation: {
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    },
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

describe("/session idle and /session max-age", () => {
  beforeEach(async () => {
    if (!handleSessionCommand) {
      ({ handleSessionCommand } = await import("./commands-session.js"));
    }
  });

  beforeEach(() => {
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    vi.useRealTimers();
  });

  it("sets idle timeout for the focused thread-chat session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(createThreadCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
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

  it("sets max age for the focused thread-chat session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createThreadCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T03:00:00.000Z");
  });

  it("sets idle timeout for focused topic-chat conversations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createTopicBinding());
    hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(createTopicCommandParams("/session idle 2h"), true);
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setTelegramThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for focused room-chat threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createRoomThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets idle timeout for the triggering room-chat always-thread turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomTriggerBinding());
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt: Date.now(),
        lastActivityAt: Date.now(),
        idleTimeoutMs: 2 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createRoomTriggerThreadCommandParams("/session idle 2h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
      threadId: "$root",
    });
    expectIdleTimeoutSetReply(
      hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
      text,
      2 * 60 * 60 * 1000,
      "2h",
    );
  });

  it("sets max age for focused room-chat threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createRoomBinding({ boundAt }));
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createRoomThreadCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
  });

  it("reports topic-chat max-age expiry from the original bind time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));

    const boundAt = Date.parse("2026-02-19T22:00:00.000Z");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createTopicBinding({ boundAt }),
    );
    hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock.mockReturnValue([
      {
        targetSessionKey: "agent:main:subagent:child",
        boundAt,
        lastActivityAt: Date.now(),
        maxAgeMs: 3 * 60 * 60 * 1000,
      },
    ]);

    const result = await handleSessionCommand(
      createTopicCommandParams("/session max-age 3h"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(hoisted.setTelegramThreadBindingMaxAgeBySessionKeyMock).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      maxAgeMs: 3 * 60 * 60 * 1000,
    });
    expect(text).toContain("Max age set to 3h");
    expect(text).toContain("2026-02-20T01:00:00.000Z");
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
      "currently available only on channels that support focused conversation bindings",
    );
  });

  it("requires a focused room-chat thread for lifecycle updates", async () => {
    const result = await handleSessionCommand(createRoomCommandParams("/session idle 2h"), true);

    expect(result?.reply?.text).toContain("This conversation is not currently focused.");
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
