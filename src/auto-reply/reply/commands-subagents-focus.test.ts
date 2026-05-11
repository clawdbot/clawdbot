import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { createEmptyInlineDirectives } from "./commands-subagents.test-helpers.js";
import { handleSubagentsFocusAction } from "./commands-subagents/action-focus.js";
import { handleSubagentsUnfocusAction } from "./commands-subagents/action-unfocus.js";
import type { HandleCommandsParams } from "./commands-types.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const TOPIC_CHANNEL = "topic-chat";

const hoisted = vi.hoisted(() => ({
  readAcpSessionEntryMock: vi.fn(),
  resolveConversationBindingContextMock: vi.fn(),
  resolveFocusTargetSessionMock: vi.fn(),
  resolveStoredSubagentCapabilitiesMock: vi.fn(),
  sessionBindingCapabilitiesMock: vi.fn(),
  sessionBindingBindMock: vi.fn(),
  sessionBindingResolveByConversationMock: vi.fn(),
  sessionBindingUnbindMock: vi.fn(),
}));

function buildFocusSessionBindingService() {
  return {
    touch: vi.fn(),
    listBySession: vi.fn(),
    resolveByConversation(ref: unknown) {
      return hoisted.sessionBindingResolveByConversationMock(ref);
    },
    getCapabilities(params: unknown) {
      return hoisted.sessionBindingCapabilitiesMock(params);
    },
    bind(input: unknown) {
      return hoisted.sessionBindingBindMock(input);
    },
    unbind(input: unknown) {
      return hoisted.sessionBindingUnbindMock(input);
    },
  };
}

vi.mock("../../acp/runtime/session-identifiers.js", () => ({
  resolveAcpSessionCwd: () => undefined,
  resolveAcpThreadSessionDetailLines: (params: {
    meta?: { identity?: Record<string, unknown> };
  }) => {
    const identity = params.meta?.identity ?? {};
    const lines: string[] = [];
    if (typeof identity.agentSessionId === "string") {
      lines.push(`agent session id: ${identity.agentSessionId}`);
      lines.push(`codex resume ${identity.agentSessionId}`);
    }
    if (typeof identity.acpxSessionId === "string") {
      lines.push(`acpx session id: ${identity.acpxSessionId}`);
    }
    return lines;
  },
}));

vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
}));

vi.mock("../../channels/thread-bindings-messages.js", () => ({
  resolveThreadBindingIntroText: (params: { agentId: string; sessionDetails?: string[] }) =>
    [
      `⚙️ ${params.agentId} session active (idle auto-unfocus after 24h inactivity). Messages here go directly to this session.`,
      ...(params.sessionDetails ?? []),
    ].join("\n"),
  resolveThreadBindingThreadName: (params: { label?: string; agentId: string }) =>
    params.label ?? params.agentId,
}));

vi.mock("../../channels/thread-bindings-policy.js", () => ({
  formatThreadBindingDisabledError: (params: { channel: string }) =>
    `channels.${params.channel}.threadBindings.enabled=true required`,
  formatThreadBindingSpawnDisabledError: (params: { channel: string }) =>
    `channels.${params.channel}.threadBindings.spawnSessions=true`,
  resolveThreadBindingIdleTimeoutMsForChannel: () => 24 * 60 * 60 * 1000,
  resolveThreadBindingMaxAgeMsForChannel: () => undefined,
  resolveThreadBindingPlacementForCurrentContext: (params: {
    channel: string;
    threadId?: string;
  }) => (params.channel === ROOM_CHANNEL && !params.threadId ? "child" : "current"),
  resolveThreadBindingSpawnPolicy: (params: {
    cfg: OpenClawConfig;
    channel: string;
    accountId: string;
  }) => {
    const settings = params.cfg.channels?.[params.channel]?.threadBindings;
    return {
      enabled: settings?.enabled !== false,
      spawnEnabled: settings?.spawnSessions !== false,
      channel: params.channel,
      accountId: params.accountId,
      defaultSpawnContext: "fork",
    };
  },
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => buildFocusSessionBindingService(),
}));

vi.mock("../../agents/subagent-capabilities.js", () => ({
  resolveStoredSubagentCapabilities: (sessionKey: string, options: unknown) =>
    hoisted.resolveStoredSubagentCapabilitiesMock(sessionKey, options),
}));

vi.mock("./conversation-binding-input.js", () => ({
  resolveConversationBindingContextFromAcpCommand: (params: unknown) =>
    hoisted.resolveConversationBindingContextMock(params),
}));

vi.mock("./commands-subagents/shared.js", async () => {
  const actual = await vi.importActual<typeof import("./commands-subagents/shared.js")>(
    "./commands-subagents/shared.js",
  );
  return {
    ...actual,
    resolveFocusTargetSession: (params: unknown) => hoisted.resolveFocusTargetSessionMock(params),
  };
});

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function createSessionBindingRecord(
  overrides?: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:codex-acp:session-1",
    targetKind: "session",
    conversation: {
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      agentId: "codex-acp",
    },
    ...overrides,
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

type FocusTargetSessionParams = {
  requesterKey?: string;
};

type SessionBindingBindInput = {
  placement: "current" | "child";
  targetKind: "session" | "agent";
  targetSessionKey: string;
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  metadata?: Record<string, unknown>;
};

function firstFocusTargetSessionParams(): FocusTargetSessionParams {
  const firstCall = hoisted.resolveFocusTargetSessionMock.mock.calls[0];
  expect(firstCall).toBeDefined();
  return firstCall[0] as FocusTargetSessionParams;
}

function firstSessionBindingBindInput(): SessionBindingBindInput {
  const firstCall = hoisted.sessionBindingBindMock.mock.calls[0];
  expect(firstCall).toBeDefined();
  return firstCall[0] as SessionBindingBindInput;
}

function buildCommandParams(params?: {
  cfg?: OpenClawConfig;
  chatType?: string;
  senderId?: string;
  sessionEntry?: SessionEntry;
}): HandleCommandsParams {
  return {
    cfg: params?.cfg ?? baseCfg,
    ctx: {
      ChatType: params?.chatType ?? "group",
    },
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: params?.senderId ?? "user-1",
      rawBodyNormalized: "",
      commandBodyNormalized: "",
    },
    directives: createEmptyInlineDirectives(),
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionEntry: params?.sessionEntry,
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/openclaw-subagents-focus",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: true,
  };
}

function buildFocusContext(params?: {
  cfg?: OpenClawConfig;
  chatType?: string;
  senderId?: string;
  token?: string;
  requesterKey?: string;
}) {
  return {
    params: buildCommandParams({
      cfg: params?.cfg,
      chatType: params?.chatType,
      senderId: params?.senderId,
    }),
    handledPrefix: "/focus",
    requesterKey: params?.requesterKey ?? "agent:main:main",
    runs: [],
    restTokens: [params?.token ?? "codex-acp"],
  } satisfies Parameters<typeof handleSubagentsFocusAction>[0];
}

function buildUnfocusContext(params?: { senderId?: string }) {
  return {
    params: buildCommandParams({
      senderId: params?.senderId,
    }),
    handledPrefix: "/unfocus",
    requesterKey: "agent:main:main",
    runs: [],
    restTokens: [],
  } satisfies Parameters<typeof handleSubagentsUnfocusAction>[0];
}

describe("focus actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveStoredSubagentCapabilitiesMock.mockReturnValue({
      controlScope: "children",
    });
    hoisted.sessionBindingCapabilitiesMock.mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(null);
    hoisted.resolveFocusTargetSessionMock.mockResolvedValue({
      targetKind: "acp",
      targetSessionKey: "agent:codex-acp:session-1",
      agentId: "codex-acp",
      label: "codex-acp",
    });
    hoisted.sessionBindingBindMock.mockImplementation(
      async (input: {
        targetSessionKey: string;
        placement: "current" | "child";
        conversation: {
          channel: string;
          accountId: string;
          conversationId: string;
          parentConversationId?: string;
        };
        metadata?: Record<string, unknown>;
      }) =>
        createSessionBindingRecord({
          targetSessionKey: input.targetSessionKey,
          targetKind: "session",
          conversation: {
            channel: input.conversation.channel,
            accountId: input.conversation.accountId,
            conversationId:
              input.placement === "child" ? "thread-created" : input.conversation.conversationId,
            ...(input.conversation.parentConversationId
              ? { parentConversationId: input.conversation.parentConversationId }
              : {}),
          },
          metadata: {
            ...input.metadata,
            boundBy:
              typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1",
          },
        }),
    );
  });

  it("binds the current thread-chat thread", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("bound this conversation");
    expect(result.reply?.text).toContain("(acp)");
    expect(firstFocusTargetSessionParams().requesterKey).toBe("agent:main:main");
    const bindInput = firstSessionBindingBindInput();
    expect(bindInput.placement).toBe("current");
    expect(bindInput.targetKind).toBe("session");
    expect(bindInput.targetSessionKey).toBe("agent:codex-acp:session-1");
    expect(bindInput.conversation.channel).toBe(THREAD_CHANNEL);
    expect(bindInput.conversation.conversationId).toBe("thread-1");
  });

  it("rejects /focus from a leaf subagent", async () => {
    hoisted.resolveStoredSubagentCapabilitiesMock.mockReturnValue({
      controlScope: "none",
    });
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });

    const result = await handleSubagentsFocusAction(
      buildFocusContext({
        requesterKey: "agent:main:subagent:leaf-a",
      }),
    );

    expect(result.reply?.text).toContain("Leaf subagents cannot control other sessions.");
    expect(hoisted.resolveFocusTargetSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("binds topic-chat topics as current conversations", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: TOPIC_CHANNEL,
      accountId: "default",
      conversationId: "-100200300:topic:77",
      parentConversationId: "-100200300",
      threadId: "77",
    });

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("bound this conversation");
    const bindInput = firstSessionBindingBindInput();
    expect(bindInput.placement).toBe("current");
    expect(bindInput.conversation.channel).toBe(TOPIC_CHANNEL);
    expect(bindInput.conversation.conversationId).toBe("-100200300:topic:77");
  });

  it("creates a room-chat child thread from a top-level room when spawning is enabled", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "!room:example.org",
    });

    const result = await handleSubagentsFocusAction(
      buildFocusContext({
        cfg: {
          ...baseCfg,
          channels: {
            [ROOM_CHANNEL]: {
              threadBindings: {
                enabled: true,
                spawnSessions: true,
              },
            },
          } as OpenClawConfig["channels"],
        } as OpenClawConfig,
      }),
    );

    expect(result.reply?.text).toContain("created child conversation thread-created and bound it");
    const bindInput = firstSessionBindingBindInput();
    expect(bindInput.placement).toBe("child");
    expect(bindInput.conversation.channel).toBe(ROOM_CHANNEL);
    expect(bindInput.conversation.conversationId).toBe("!room:example.org");
  });

  it("treats a room thread turn as the current thread", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
      threadId: "$root",
    });

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("bound this conversation");
    const bindInput = firstSessionBindingBindInput();
    expect(bindInput.placement).toBe("current");
    expect(bindInput.conversation.channel).toBe(ROOM_CHANNEL);
    expect(bindInput.conversation.conversationId).toBe("$root");
    expect(bindInput.conversation.parentConversationId).toBe("!room:example.org");
  });

  it("rejects room top-level thread creation when spawnSessions is disabled", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "!room:example.org",
    });

    const result = await handleSubagentsFocusAction(
      buildFocusContext({
        cfg: {
          ...baseCfg,
          channels: {
            [ROOM_CHANNEL]: {
              threadBindings: {
                enabled: true,
                spawnSessions: false,
              },
            },
          } as OpenClawConfig["channels"],
        } as OpenClawConfig,
      }),
    );

    expect(result.reply?.text).toContain(
      `channels.${ROOM_CHANNEL}.threadBindings.spawnSessions=true`,
    );
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("includes ACP session identifiers in intro text when available", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      acp: {
        identity: {
          agentSessionId: "codex-123",
          acpxSessionId: "acpx-456",
        },
      },
    });

    await handleSubagentsFocusAction(buildFocusContext());

    const introText = firstSessionBindingBindInput().metadata?.introText;
    expect(typeof introText).toBe("string");
    expect(introText).toContain("agent session id: codex-123");
    expect(introText).toContain("acpx session id: acpx-456");
    expect(introText).toContain("codex resume codex-123");
  });

  it("rejects rebinding when another user owns the thread", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        metadata: { boundBy: "user-2" },
      }),
    );

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("Only user-2 can refocus this conversation.");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported channels", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue(null);

    const result = await handleSubagentsFocusAction(buildFocusContext());

    expect(result.reply?.text).toContain("must be run inside a bindable conversation");
  });

  it("unfocuses the active binding for the binding owner", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
      threadId: "thread-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:thread-1",
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsUnfocusAction(buildUnfocusContext());

    expect(result.reply?.text).toContain("Conversation unfocused");
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:thread-1",
      reason: "manual",
    });
  });

  it("unfocuses an active room thread binding for the binding owner", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
      threadId: "$thread-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:room-thread-1",
        conversation: {
          channel: ROOM_CHANNEL,
          accountId: "default",
          conversationId: "$thread-1",
          parentConversationId: "!room:example.org",
        },
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsUnfocusAction(buildUnfocusContext());

    expect(result.reply?.text).toContain("Conversation unfocused");
    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    });
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:room-thread-1",
      reason: "manual",
    });
  });

  it("drops self-parent refs before resolving /unfocus bindings", async () => {
    hoisted.resolveConversationBindingContextMock.mockReturnValue({
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "dm-1",
      parentConversationId: "dm-1",
    });
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:dm-1",
        conversation: {
          channel: THREAD_CHANNEL,
          accountId: "default",
          conversationId: "dm-1",
        },
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsUnfocusAction(buildUnfocusContext());

    expect(result.reply?.text).toContain("Conversation unfocused");
    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "dm-1",
    });
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:dm-1",
      reason: "manual",
    });
  });
});
