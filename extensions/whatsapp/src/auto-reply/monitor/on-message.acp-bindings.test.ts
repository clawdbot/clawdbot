// Whatsapp tests cover inbound configured ACP binding route materialization.
import type { ConfiguredBindingRouteResult } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const processMessageMock = vi.hoisted(() => vi.fn());
const maybeBroadcastMessageMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());
const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const resolveAgentRouteMock = vi.hoisted(() => vi.fn());
const applyGroupGatingMock = vi.hoisted(() => vi.fn());
const updateLastRouteInBackgroundMock = vi.hoisted(() => vi.fn());
const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());
const maybeSendAckReactionMock = vi.hoisted(() => vi.fn());
const createStatusReactionControllerMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  resolveConfiguredBindingRoute: (...args: unknown[]) => resolveConfiguredBindingRouteMock(...args),
  ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
    ensureConfiguredBindingRouteReadyMock(...args),
}));

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (...args: unknown[]) => maybeSendAckReactionMock(...args),
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/routing")>();
  return {
    ...actual,
    buildGroupHistoryKey: () => "group-key",
    resolveAgentRoute: (...args: unknown[]) => resolveAgentRouteMock(...args),
  };
});

vi.mock("../../accounts.js", () => ({
  resolveWhatsAppAccount: () => ({
    accountId: "work",
    authDir: "/tmp/whatsapp-auth",
    mentionPatterns: [],
    selfChatMode: false,
  }),
}));

vi.mock("../../group-session-key.js", () => ({
  resolveWhatsAppGroupSessionRoute: (route: unknown) => route,
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => "+15551234567",
  getSenderIdentity: () => ({ e164: "+15551234567", name: "Alice" }),
}));

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: (...args: unknown[]) => maybeBroadcastMessageMock(...args),
}));

vi.mock("./group-gating.js", () => ({
  applyGroupGating: (...args: unknown[]) => applyGroupGatingMock(...args),
}));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: (...args: unknown[]) => updateLastRouteInBackgroundMock(...args),
}));

vi.mock("./process-message.js", () => ({
  processMessage: (...args: unknown[]) => processMessageMock(...args),
}));

vi.mock("./status-reaction.js", () => ({
  createWhatsAppStatusReactionController: (...args: unknown[]) =>
    createStatusReactionControllerMock(...args),
}));

import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { createWebOnMessageHandler } from "./on-message.js";

const baseRoute = {
  agentId: "sandboxed-agent",
  accountId: "work",
  channel: "whatsapp",
  sessionKey: "agent:sandboxed-agent:whatsapp:direct:+15551234567",
  mainSessionKey: "agent:sandboxed-agent:main",
  matchedBy: "binding.agent",
  lastRoutePolicy: "bound",
};

const boundSessionKey = "agent:sandboxed-agent:acp:binding:whatsapp:work:abc123";
const directConversationId = "+15551234567";
const groupConversationId = "120363001234567890@g.us";

const configuredBindingRecord = {
  bindingId: `config:acp:whatsapp:work:${directConversationId}`,
  targetSessionKey: boundSessionKey,
  targetKind: "session",
  conversation: {
    channel: "whatsapp",
    accountId: "work",
    conversationId: directConversationId,
  },
  status: "active",
  boundAt: 0,
  metadata: {
    source: "config",
    mode: "oneshot",
    agentId: "sandboxed-agent",
  },
} as const;

const configuredStatefulTarget = {
  kind: "stateful",
  driverId: "acp",
  sessionKey: boundSessionKey,
  agentId: "sandboxed-agent",
} as const;

const configuredBindingResolution = {
  conversation: {
    channel: "whatsapp",
    accountId: "work",
    conversationId: directConversationId,
  },
  compiledBinding: {
    channel: "whatsapp",
    accountPattern: "work",
    binding: {
      type: "acp",
      agentId: "sandboxed-agent",
      match: {
        channel: "whatsapp",
        accountId: "work",
        peer: { kind: "direct", id: directConversationId },
      },
    },
    bindingConversationId: directConversationId,
    target: { conversationId: directConversationId },
    agentId: "sandboxed-agent",
    provider: {
      compileConfiguredBinding: () => ({ conversationId: directConversationId }),
      matchInboundConversation: () => ({ conversationId: directConversationId }),
    },
    targetFactory: {
      driverId: "acp",
      materialize: () => ({
        record: configuredBindingRecord,
        statefulTarget: configuredStatefulTarget,
      }),
    },
  },
  match: { conversationId: "+15551234567" },
  record: configuredBindingRecord,
  statefulTarget: configuredStatefulTarget,
} as const;

const configuredGroupBindingRecord = {
  ...configuredBindingRecord,
  bindingId: `config:acp:whatsapp:work:${groupConversationId}`,
  conversation: {
    channel: "whatsapp",
    accountId: "work",
    conversationId: groupConversationId,
  },
} as const;

const configuredGroupBindingResolution = {
  ...configuredBindingResolution,
  conversation: {
    channel: "whatsapp",
    accountId: "work",
    conversationId: groupConversationId,
  },
  compiledBinding: {
    ...configuredBindingResolution.compiledBinding,
    binding: {
      ...configuredBindingResolution.compiledBinding.binding,
      match: {
        channel: "whatsapp",
        accountId: "work",
        peer: { kind: "group", id: groupConversationId },
      },
    },
    bindingConversationId: groupConversationId,
    target: { conversationId: groupConversationId },
    provider: {
      compileConfiguredBinding: () => ({ conversationId: groupConversationId }),
      matchInboundConversation: () => ({ conversationId: groupConversationId }),
    },
    targetFactory: {
      driverId: "acp",
      materialize: () => ({
        record: configuredGroupBindingRecord,
        statefulTarget: configuredStatefulTarget,
      }),
    },
  },
  match: { conversationId: groupConversationId },
  record: configuredGroupBindingRecord,
} as const;

type ConfiguredBindingResolution = NonNullable<ConfiguredBindingRouteResult["bindingResolution"]>;

function resolvedConfiguredRoute(
  bindingResolution: ConfiguredBindingResolution = configuredBindingResolution,
) {
  return ({ route }: { route: typeof baseRoute }) => ({
    bindingResolution,
    boundSessionKey,
    boundAgentId: "sandboxed-agent",
    route: {
      ...route,
      agentId: "sandboxed-agent",
      sessionKey: boundSessionKey,
      matchedBy: "binding.channel",
    },
  });
}

function createCfg(): Record<string, unknown> {
  return {
    bindings: [
      {
        type: "acp",
        agentId: "sandboxed-agent",
        match: {
          channel: "whatsapp",
          accountId: "work",
          peer: { kind: "direct", id: "+15551234567" },
        },
      },
    ],
  };
}

function createGroupCfg(): Record<string, unknown> {
  return {
    bindings: [
      {
        type: "acp",
        agentId: "sandboxed-agent",
        match: {
          channel: "whatsapp",
          accountId: "work",
          peer: { kind: "group", id: "120363001234567890@g.us" },
        },
      },
    ],
  };
}

function createHandler(warn = vi.fn(), cfg: Record<string, unknown> = createCfg()) {
  const groupHistories = new Map();
  return {
    warn,
    groupHistories,
    handler: createWebOnMessageHandler({
      cfg: cfg as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories,
      groupMemberNames: new Map(),
      echoTracker: {
        has: () => false,
        forget: () => {},
        rememberText: () => {},
        buildCombinedKey: ({ combinedBody }: { combinedBody: string }) => combinedBody,
      },
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn,
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/whatsapp-auth", accountId: "work" },
    }),
  };
}

function createMessage() {
  return createTestWebInboundMessage({
    admission: {
      accountId: "work",
      conversation: {
        kind: "direct",
        id: "15551234567@s.whatsapp.net",
      },
      sender: {
        id: "15551234567@s.whatsapp.net",
      },
    },
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "15559876543@s.whatsapp.net",
    },
  });
}

type TestMessageOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;

function createGroupMessage(overrides: TestMessageOverrides = {}) {
  const { admission, platform, ...message } = overrides;
  return createTestWebInboundMessage({
    ...message,
    admission: {
      ...admission,
      accountId: "work",
      conversation: {
        kind: "group",
        id: "120363001234567890@g.us",
        ...admission?.conversation,
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
        ...admission?.senderAccess,
      },
    },
    platform: {
      chatJid: "120363001234567890@g.us",
      recipientJid: "15559876543@s.whatsapp.net",
      ...platform,
    },
  });
}

function createGroupAudioMessage() {
  return createTestWebInboundMessage({
    admission: {
      accountId: "work",
      conversation: {
        kind: "group",
        id: "120363001234567890@g.us",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    payload: {
      body: "",
      media: {
        type: "audio/ogg; codecs=opus",
        path: "/tmp/voice.ogg",
        kind: "audio",
      },
    },
    platform: {
      chatJid: "120363001234567890@g.us",
      recipientJid: "15559876543@s.whatsapp.net",
    },
  });
}

describe("createWebOnMessageHandler configured ACP bindings", () => {
  beforeEach(() => {
    processMessageMock.mockReset();
    processMessageMock.mockResolvedValue(true);
    maybeBroadcastMessageMock.mockReset();
    maybeBroadcastMessageMock.mockResolvedValue(false);
    applyGroupGatingMock.mockReset();
    applyGroupGatingMock.mockResolvedValue({ shouldProcess: true });
    updateLastRouteInBackgroundMock.mockReset();
    transcribeFirstAudioMock.mockReset();
    transcribeFirstAudioMock.mockResolvedValue("agent please handle this");
    maybeSendAckReactionMock.mockReset();
    maybeSendAckReactionMock.mockResolvedValue(null);
    createStatusReactionControllerMock.mockReset();
    createStatusReactionControllerMock.mockResolvedValue(null);
    resolveAgentRouteMock.mockReset();
    resolveAgentRouteMock.mockReturnValue(baseRoute);
    ensureConfiguredBindingRouteReadyMock.mockReset();
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockImplementation(resolvedConfiguredRoute());
  });

  it("rewrites matching WhatsApp inbound turns to the configured ACP session key", async () => {
    const { handler } = createHandler();

    await handler(createMessage());

    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "work",
        conversationId: "+15551234567",
        route: baseRoute,
      }),
    );
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      bindingResolution: configuredBindingResolution,
    });
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        route: expect.objectContaining({
          sessionKey: boundSessionKey,
          matchedBy: "binding.channel",
        }),
      }),
    );
  });

  it("drops the inbound turn instead of falling back when ACP binding readiness fails", async () => {
    const { handler, warn } = createHandler();
    ensureConfiguredBindingRouteReadyMock.mockResolvedValueOnce({
      ok: false,
      error: "acpx backend unavailable",
    });

    await handler(createMessage());

    expect(processMessageMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "whatsapp: configured ACP binding unavailable for conversation +15551234567: acpx backend unavailable",
    );
  });

  it("keeps the ordinary WhatsApp route when no configured ACP binding matches", async () => {
    const { handler } = createHandler();
    resolveConfiguredBindingRouteMock.mockImplementationOnce(({ route }) => ({
      bindingResolution: null,
      route,
    }));

    await handler(createMessage());

    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        route: expect.objectContaining({
          sessionKey: baseRoute.sessionKey,
          matchedBy: baseRoute.matchedBy,
        }),
      }),
    );
  });

  it("skips broadcast fan-out for configured ACP binding routes", async () => {
    const { handler } = createHandler(vi.fn(), {
      ...createCfg(),
      broadcast: {
        "+15551234567": ["ordinary-agent"],
      },
    });

    await handler(createMessage());

    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        route: expect.objectContaining({
          sessionKey: boundSessionKey,
          matchedBy: "binding.channel",
        }),
      }),
    );
  });

  it("waits for group admission before ensuring a configured ACP binding target", async () => {
    resolveConfiguredBindingRouteMock.mockImplementationOnce(
      resolvedConfiguredRoute(configuredGroupBindingResolution),
    );
    const pendingEntry = {
      sender: "Alice",
      body: "ambient group message",
    };
    applyGroupGatingMock.mockImplementationOnce(
      async (params: { groupHistories: Map<string, unknown[]>; groupHistoryKey: string }) => {
        params.groupHistories.set(params.groupHistoryKey, [pendingEntry]);
        return { shouldProcess: false };
      },
    );
    const { handler, groupHistories } = createHandler(vi.fn(), createGroupCfg());

    await handler(createGroupMessage());

    expect(applyGroupGatingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sandboxed-agent",
        sessionKey: boundSessionKey,
      }),
    );
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
    expect(groupHistories.get("group-key")).toEqual([pendingEntry]);
  });

  it("does not record ordinary group routes before group admission", async () => {
    resolveConfiguredBindingRouteMock.mockImplementationOnce(({ route }) => ({
      bindingResolution: null,
      route,
    }));
    applyGroupGatingMock.mockResolvedValueOnce({ shouldProcess: false });
    const { handler } = createHandler(vi.fn(), { channels: { whatsapp: {} } });

    await handler(createGroupMessage());

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(1);
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("does not record group routes when admission blocks dispatch", async () => {
    const { handler } = createHandler(vi.fn(), { channels: { whatsapp: {} } });

    await handler(
      createGroupMessage({
        admission: {
          ingress: {
            admission: "drop",
            decision: "block",
            reasonCode: "group_policy_not_allowlisted",
          },
          senderAccess: {
            allowed: false,
            decision: "block",
            reasonCode: "group_policy_not_allowlisted",
          },
          activationAccess: {
            allowed: false,
            shouldSkip: true,
            reasonCode: "group_policy_not_allowlisted",
          },
        },
      }),
    );

    expect(applyGroupGatingMock).not.toHaveBeenCalled();
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("does not record configured ACP group routes when readiness fails", async () => {
    resolveConfiguredBindingRouteMock.mockImplementationOnce(
      resolvedConfiguredRoute(configuredGroupBindingResolution),
    );
    const { handler, warn } = createHandler(vi.fn(), createGroupCfg());
    ensureConfiguredBindingRouteReadyMock.mockResolvedValueOnce({
      ok: false,
      error: "acpx backend unavailable",
    });

    await handler(createGroupMessage());

    expect(applyGroupGatingMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "whatsapp: configured ACP binding unavailable for conversation 120363001234567890@g.us: acpx backend unavailable",
    );
  });

  it("removes preflight ack when configured ACP readiness fails after group audio mention gating", async () => {
    const ackReaction = {
      ackReactionPromise: Promise.resolve(true),
      ackReactionValue: "👀",
      remove: vi.fn(async () => undefined),
    };
    resolveConfiguredBindingRouteMock.mockImplementationOnce(
      resolvedConfiguredRoute(configuredGroupBindingResolution),
    );
    applyGroupGatingMock
      .mockResolvedValueOnce({ shouldProcess: false, needsMentionText: true })
      .mockResolvedValueOnce({ shouldProcess: true });
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);
    ensureConfiguredBindingRouteReadyMock.mockResolvedValueOnce({
      ok: false,
      error: "acpx backend unavailable",
    });
    const { handler } = createHandler(vi.fn(), createGroupCfg());

    await handler(createGroupAudioMessage());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(ackReaction.remove).toHaveBeenCalledTimes(1);
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("clears preflight status reaction when configured ACP readiness fails after group audio mention gating", async () => {
    const statusReactionController = {
      setQueued: vi.fn(async () => undefined),
      setThinking: vi.fn(async () => undefined),
      setTool: vi.fn(async () => undefined),
      setCompacting: vi.fn(async () => undefined),
      cancelPending: vi.fn(),
      setDone: vi.fn(async () => undefined),
      setError: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      restoreInitial: vi.fn(async () => undefined),
    };
    resolveConfiguredBindingRouteMock.mockImplementationOnce(
      resolvedConfiguredRoute(configuredGroupBindingResolution),
    );
    applyGroupGatingMock
      .mockResolvedValueOnce({ shouldProcess: false, needsMentionText: true })
      .mockResolvedValueOnce({ shouldProcess: true });
    createStatusReactionControllerMock.mockResolvedValueOnce(statusReactionController);
    ensureConfiguredBindingRouteReadyMock.mockResolvedValueOnce({
      ok: false,
      error: "acpx backend unavailable",
    });
    const { handler } = createHandler(vi.fn(), {
      ...createGroupCfg(),
      messages: {
        statusReactions: { enabled: true },
      },
    });

    await handler(createGroupAudioMessage());

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(statusReactionController.setQueued).toHaveBeenCalledTimes(1);
    expect(statusReactionController.cancelPending).toHaveBeenCalledTimes(1);
    expect(statusReactionController.clear).toHaveBeenCalledTimes(1);
    expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("records configured ACP group routes after admission and readiness", async () => {
    resolveConfiguredBindingRouteMock.mockImplementationOnce(
      resolvedConfiguredRoute(configuredGroupBindingResolution),
    );
    const { handler } = createHandler(vi.fn(), createGroupCfg());

    await handler(createGroupMessage());

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeAgentId: "sandboxed-agent",
        sessionKey: boundSessionKey,
        channel: "whatsapp",
        to: "120363001234567890@g.us",
        accountId: "work",
      }),
    );
    expect(ensureConfiguredBindingRouteReadyMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateLastRouteInBackgroundMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(processMessageMock).toHaveBeenCalledTimes(1);
  });
});
