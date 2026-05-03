import type * as ConversationRuntime from "openclaw/plugin-sdk/conversation-runtime";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { setFeishuRuntime } from "./runtime.js";

type ConfiguredBindingRoute = ReturnType<typeof ConversationRuntime.resolveConfiguredBindingRoute>;
type BoundConversation = ReturnType<
  ReturnType<typeof ConversationRuntime.getSessionBindingService>["resolveByConversation"]
>;
type BindingReadiness = Awaited<
  ReturnType<typeof ConversationRuntime.ensureConfiguredBindingRouteReady>
>;
type ReplyDispatcher = Parameters<
  PluginRuntime["channel"]["reply"]["withReplyDispatcher"]
>[0]["dispatcher"];
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends ReadonlyArray<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

function createReplyDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(),
    sendBlockReply: vi.fn(),
    sendFinalReply: vi.fn(),
    waitForIdle: vi.fn(),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createConfiguredFeishuRoute(): NonNullable<ConfiguredBindingRoute> {
  return {
    bindingResolution: {
      conversation: {
        channel: "feishu",
        accountId: "default",
        conversationId: "ou_sender_1",
      },
      compiledBinding: {
        channel: "feishu",
        accountPattern: "default",
        binding: {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "feishu",
            accountId: "default",
            peer: { kind: "direct", id: "ou_sender_1" },
          },
        },
        bindingConversationId: "ou_sender_1",
        target: {
          conversationId: "ou_sender_1",
        },
        agentId: "codex",
        provider: {
          compileConfiguredBinding: () => ({ conversationId: "ou_sender_1" }),
          matchInboundConversation: () => ({ conversationId: "ou_sender_1" }),
        },
        targetFactory: {
          driverId: "acp",
          materialize: () => ({
            record: {
              bindingId: "config:acp:feishu:default:ou_sender_1",
              targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
              targetKind: "session",
              conversation: {
                channel: "feishu",
                accountId: "default",
                conversationId: "ou_sender_1",
              },
              status: "active",
              boundAt: 0,
              metadata: { source: "config" },
            },
            statefulTarget: {
              kind: "stateful",
              driverId: "acp",
              sessionKey: "agent:codex:acp:binding:feishu:default:abc123",
              agentId: "codex",
            },
          }),
        },
      },
      match: {
        conversationId: "ou_sender_1",
      },
      record: {
        bindingId: "config:acp:feishu:default:ou_sender_1",
        targetSessionKey: "agent:codex:acp:binding:feishu:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "feishu",
          accountId: "default",
          conversationId: "ou_sender_1",
        },
        status: "active",
        boundAt: 0,
        metadata: { source: "config" },
      },
      statefulTarget: {
        kind: "stateful",
        driverId: "acp",
        sessionKey: "agent:codex:acp:binding:feishu:default:abc123",
        agentId: "codex",
      },
    },
    route: {
      agentId: "codex",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:codex:acp:binding:feishu:default:abc123",
      mainSessionKey: "agent:codex:main",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    } as ResolvedAgentRoute,
  };
}

function createConfiguredBindingReadiness(ok: boolean, error?: string): BindingReadiness {
  return (ok ? { ok: true } : { ok: false, error: error ?? "unknown error" }) as BindingReadiness;
}

function createBoundConversation(): NonNullable<BoundConversation> {
  return {
    bindingId: "default:oc_group_chat:topic:om_topic_root",
    targetSessionKey: "agent:codex:acp:binding:feishu:default:feedface",
    targetKind: "session",
    conversation: {
      channel: "feishu",
      accountId: "default",
      conversationId: "oc_group_chat:topic:om_topic_root",
      parentConversationId: "oc_group_chat",
    },
    status: "active",
    boundAt: 0,
  };
}

function buildDefaultResolveRoute(): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:dm:ou-attacker",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
  };
}

function _createUnboundConfiguredRoute(
  route: NonNullable<ConfiguredBindingRoute>["route"],
): ConfiguredBindingRoute {
  return { bindingResolution: null, route };
}

function createFeishuBotRuntime(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  return {
    channel: {
      routing: {
        resolveAgentRoute: resolveAgentRouteMock,
      },
      session: {
        readSessionUpdatedAt: readSessionUpdatedAtMock,
        resolveStorePath: resolveStorePathMock,
        recordInboundSession: vi.fn(async () => undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions:
          resolveEnvelopeFormatOptionsMock as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        finalizeInboundContext: finalizeInboundContextMock as never,
        dispatchReplyFromConfig: vi.fn().mockResolvedValue({
          queuedFinal: false,
          counts: { final: 1 },
        }),
        withReplyDispatcher: withReplyDispatcherMock as never,
      },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue(["ou_sender_1"]),
        upsertPairingRequest: vi.fn(),
        buildPairingReply: vi.fn(),
      },
      turn: {
        run: vi.fn(async (params) => {
          const input = await params.adapter.ingest(params.raw);
          const turn = await params.adapter.resolveTurn(input, {
            kind: "message",
            canStartAgentTurn: true,
          });
          return {
            dispatchResult: await turn.runDispatch(),
          };
        }),
        runPrepared: vi.fn(async (params) => ({
          dispatchResult: await params.runDispatch(),
        })),
      },
      ...overrides.channel,
    },
    ...(overrides.system ? { system: overrides.system as PluginRuntime["system"] } : {}),
    ...(overrides.media ? { media: overrides.media as PluginRuntime["media"] } : {}),
  } as unknown as PluginRuntime;
}

const resolveAgentRouteMock: PluginRuntime["channel"]["routing"]["resolveAgentRoute"] = (params) =>
  mockResolveAgentRoute(params);
const readSessionUpdatedAtMock: PluginRuntime["channel"]["session"]["readSessionUpdatedAt"] = (
  params,
) => mockReadSessionUpdatedAt(params);
const resolveStorePathMock: PluginRuntime["channel"]["session"]["resolveStorePath"] = (params) =>
  mockResolveStorePath(params);
const resolveEnvelopeFormatOptionsMock = () => ({});
const finalizeInboundContextMock = (ctx: Record<string, unknown>) => ctx;
const withReplyDispatcherMock = async ({
  run,
}: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => await run();

const {
  mockCreateFeishuReplyDispatcher,
  mockSendMessageFeishu,
  mockGetMessageFeishu,
  mockListFeishuThreadMessages,
  mockDownloadMessageResourceFeishu,
  mockCreateFeishuClient,
  mockResolveAgentRoute,
  mockReadSessionUpdatedAt,
  mockResolveStorePath,
  mockResolveConfiguredBindingRoute,
  mockEnsureConfiguredBindingRouteReady,
  mockResolveBoundConversation,
  mockTouchBinding,
  mockResolveFeishuReasoningPreviewEnabled,
  mockTranscribeFirstAudio,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcher: createReplyDispatcher(),
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
  mockSendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "pairing-msg", chatId: "oc-dm" }),
  mockGetMessageFeishu: vi.fn().mockResolvedValue(null),
  mockListFeishuThreadMessages: vi.fn().mockResolvedValue([]),
  mockDownloadMessageResourceFeishu: vi.fn().mockResolvedValue({
    buffer: Buffer.from("video"),
    contentType: "video/mp4",
    fileName: "clip.mp4",
  }),
  mockCreateFeishuClient: vi.fn(),
  mockResolveAgentRoute: vi.fn((_params?: unknown) => buildDefaultResolveRoute()),
  mockReadSessionUpdatedAt: vi.fn((_params?: unknown): number | undefined => undefined),
  mockResolveStorePath: vi.fn((_params?: unknown) => "/tmp/feishu-sessions.json"),
  mockResolveConfiguredBindingRoute: vi.fn(
    ({
      route,
    }: {
      route: NonNullable<ConfiguredBindingRoute>["route"];
    }): ConfiguredBindingRoute => ({
      bindingResolution: null,
      route,
    }),
  ),
  mockEnsureConfiguredBindingRouteReady: vi.fn(
    async (_params?: unknown): Promise<BindingReadiness> => ({ ok: true }),
  ),
  mockResolveBoundConversation: vi.fn((_ref?: unknown) => null as BoundConversation),
  mockTouchBinding: vi.fn(),
  mockResolveFeishuReasoningPreviewEnabled: vi.fn(() => false),
  mockTranscribeFirstAudio: vi.fn(),
}));

vi.mock("./reply-dispatcher.js", () => ({
  createFeishuReplyDispatcher: mockCreateFeishuReplyDispatcher,
}));

vi.mock("./reasoning-preview.js", () => ({
  resolveFeishuReasoningPreviewEnabled: mockResolveFeishuReasoningPreviewEnabled,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
  getMessageFeishu: mockGetMessageFeishu,
  listFeishuThreadMessages: mockListFeishuThreadMessages,
}));

vi.mock("./media.js", () => ({
  downloadMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: mockTranscribeFirstAudio,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/conversation-runtime")>(
    "openclaw/plugin-sdk/conversation-runtime",
  );
  return {
    ...actual,
    resolveConfiguredBindingRoute: (params: unknown) =>
      mockResolveConfiguredBindingRoute(params as { route: ResolvedAgentRoute }),
    resolveRuntimeConversationBindingRoute: (params: {
      route: ResolvedAgentRoute;
      conversation: Parameters<
        ReturnType<typeof actual.getSessionBindingService>["resolveByConversation"]
      >[0];
    }) => {
      const bindingRecord = mockResolveBoundConversation(params.conversation);
      const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
      if (!bindingRecord || !boundSessionKey) {
        return { bindingRecord: null, route: params.route };
      }
      mockTouchBinding(bindingRecord.bindingId);
      return {
        bindingRecord,
        boundSessionKey,
        boundAgentId: params.route.agentId,
        route: {
          ...params.route,
          sessionKey: boundSessionKey,
          lastRoutePolicy: boundSessionKey === params.route.mainSessionKey ? "main" : "session",
          matchedBy: "binding.channel",
        },
      };
    },
    ensureConfiguredBindingRouteReady: (params: unknown) =>
      mockEnsureConfiguredBindingRouteReady(params),
    getSessionBindingService: () => ({
      resolveByConversation: mockResolveBoundConversation,
      touch: mockTouchBinding,
    }),
  };
});

async function dispatchMessage(params: { cfg: ClawdbotConfig; event: FeishuMessageEvent }) {
  const runtime = createRuntimeEnv();
  const feishuConfig = params.cfg.channels?.feishu;
  const cfg =
    feishuConfig?.dmPolicy === "open" && feishuConfig.allowFrom === undefined
      ? ({
          ...params.cfg,
          channels: {
            ...params.cfg.channels,
            feishu: {
              ...feishuConfig,
              allowFrom: ["*"],
            },
          },
        } as ClawdbotConfig)
      : params.cfg;
  await handleFeishuMessage({
    cfg,
    event: params.event,
    runtime,
  });
  return runtime;
}

describe("handleFeishuMessage ACP routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveConfiguredBindingRoute.mockReset().mockImplementation(
      ({
        route,
      }: {
        route: NonNullable<ConfiguredBindingRoute>["route"];
      }): ConfiguredBindingRoute => ({
        bindingResolution: null,
        route,
      }),
    );
    mockEnsureConfiguredBindingRouteReady.mockReset().mockResolvedValue({ ok: true });
    mockResolveBoundConversation.mockReset().mockReturnValue(null);
    mockTouchBinding.mockReset();
    mockResolveFeishuReasoningPreviewEnabled.mockReset().mockReturnValue(false);
    mockTranscribeFirstAudio.mockReset().mockResolvedValue(undefined);
    mockResolveAgentRoute.mockReset().mockReturnValue({
      ...buildDefaultResolveRoute(),
      sessionKey: "agent:main:feishu:direct:ou_sender_1",
    });
    mockSendMessageFeishu
      .mockReset()
      .mockResolvedValue({ messageId: "reply-msg", chatId: "oc_dm" });
    mockCreateFeishuReplyDispatcher.mockReset().mockReturnValue({
      dispatcher: createReplyDispatcher(),
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    });

    setFeishuRuntime(createFeishuBotRuntime());
  });

  it("ensures configured ACP routes for Feishu DMs", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());

    await dispatchMessage({
      cfg: {
        session: { mainKey: "main", scope: "per-sender" },
        channels: { feishu: { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" } },
      },
      event: {
        sender: { sender_id: { open_id: "ou_sender_1" } },
        message: {
          message_id: "msg-1",
          chat_id: "oc_dm",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    });

    expect(mockResolveConfiguredBindingRoute).toHaveBeenCalledTimes(1);
    expect(mockEnsureConfiguredBindingRouteReady).toHaveBeenCalledTimes(1);
  });

  it("surfaces configured ACP initialization failures to the Feishu conversation", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());
    mockEnsureConfiguredBindingRouteReady.mockResolvedValue(
      createConfiguredBindingReadiness(false, "runtime unavailable"),
    );

    await dispatchMessage({
      cfg: {
        session: { mainKey: "main", scope: "per-sender" },
        channels: { feishu: { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" } },
      },
      event: {
        sender: { sender_id: { open_id: "ou_sender_1" } },
        message: {
          message_id: "msg-2",
          chat_id: "oc_dm",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm",
        text: expect.stringContaining("runtime unavailable"),
      }),
    );
  });

  it("routes Feishu topic messages through active bound conversations", async () => {
    mockResolveBoundConversation.mockReturnValue(createBoundConversation());

    await dispatchMessage({
      cfg: {
        session: { mainKey: "main", scope: "per-sender" },
        channels: {
          feishu: {
            enabled: true,
            allowFrom: ["ou_sender_1"],
            groups: {
              oc_group_chat: {
                allow: true,
                requireMention: false,
                groupSessionScope: "group_topic",
              },
            },
          },
        },
      },
      event: {
        sender: { sender_id: { open_id: "ou_sender_1" } },
        message: {
          message_id: "msg-3",
          chat_id: "oc_group_chat",
          chat_type: "group",
          message_type: "text",
          root_id: "om_topic_root",
          content: JSON.stringify({ text: "hello topic" }),
        },
      },
    });

    expect(mockResolveBoundConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feishu",
        conversationId: "oc_group_chat:topic:om_topic_root",
      }),
    );
    expect(mockTouchBinding).toHaveBeenCalledWith("default:oc_group_chat:topic:om_topic_root");
  });

  it("passes reasoning preview permission from session state into the dispatcher", async () => {
    mockResolveFeishuReasoningPreviewEnabled.mockReturnValue(true);

    await dispatchMessage({
      cfg: {
        session: { mainKey: "main", scope: "per-sender" },
        channels: { feishu: { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" } },
      },
      event: {
        sender: { sender_id: { open_id: "ou_sender_1" } },
        message: {
          message_id: "msg-reasoning",
          chat_id: "oc_dm",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
      },
    });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ allowReasoningPreview: true }),
    );
  });
});

describe("handleFeishuMessage command authorization", () => {
  const mockFinalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ({
    ...ctx,
    CommandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : false,
  }));
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockWithReplyDispatcher = vi.fn(
    async ({
      dispatcher,
      run,
      onSettled,
    }: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => {
      try {
        return await run();
      } finally {
        dispatcher.markComplete();
        try {
          await dispatcher.waitForIdle();
        } finally {
          await onSettled?.();
        }
      }
    },
  );
  const mockResolveCommandAuthorizedFromAuthorizers = vi.fn(() => false);
  const mockShouldComputeCommandAuthorized = vi.fn(() => true);
  const mockReadAllowFromStore = vi.fn().mockResolvedValue([]);
  const mockUpsertPairingRequest = vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false });
  const mockBuildPairingReply = vi.fn(() => "Pairing response");
  const mockEnqueueSystemEvent = vi.fn();
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    id: "inbound-clip.mp4",
    path: "/tmp/inbound-clip.mp4",
    size: Buffer.byteLength("video"),
    contentType: "video/mp4",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldComputeCommandAuthorized.mockReset().mockReturnValue(true);
    mockGetMessageFeishu.mockReset().mockResolvedValue(null);
    mockListFeishuThreadMessages.mockReset().mockResolvedValue([]);
    mockReadSessionUpdatedAt.mockReturnValue(undefined);
    mockResolveStorePath.mockReturnValue("/tmp/feishu-sessions.json");
    mockResolveConfiguredBindingRoute.mockReset().mockImplementation(
      ({
        route,
      }: {
        route: NonNullable<ConfiguredBindingRoute>["route"];
      }): ConfiguredBindingRoute => ({
        bindingResolution: null,
        route,
      }),
    );
    mockEnsureConfiguredBindingRouteReady.mockReset().mockResolvedValue({ ok: true });
    mockResolveBoundConversation.mockReset().mockReturnValue(null);
    mockTouchBinding.mockReset();
    mockTranscribeFirstAudio.mockReset().mockResolvedValue(undefined);
    mockResolveAgentRoute.mockReturnValue(buildDefaultResolveRoute());
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
    });
    mockEnqueueSystemEvent.mockReset();
    setFeishuRuntime(
      createFeishuBotRuntime({
        system: {
          enqueueSystemEvent: mockEnqueueSystemEvent,
        },
        channel: {
          reply: {
            resolveEnvelopeFormatOptions:
              resolveEnvelopeFormatOptionsMock as unknown as PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"],
            formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
            finalizeInboundContext: mockFinalizeInboundContext as never,
            dispatchReplyFromConfig: mockDispatchReplyFromConfig,
            withReplyDispatcher: mockWithReplyDispatcher as never,
          },
          commands: {
            shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
            resolveCommandAuthorizedFromAuthorizers: mockResolveCommandAuthorizedFromAuthorizers,
          },
          pairing: {
            readAllowFromStore: mockReadAllowFromStore,
            upsertPairingRequest: mockUpsertPairingRequest,
            buildPairingReply: mockBuildPairingReply,
          },
          media: {
            saveMediaBuffer: mockSaveMediaBuffer,
          },
        },
        media: {
          detectMime: vi.fn(async () => "application/octet-stream"),
        },
      }),
    );
  });

  it("does not enqueue inbound preview text as system events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-no-system-preview",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hi there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("blocks open DMs when a restrictive allowlist does not match", async () => {
    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["ou-admin"],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-auth-bypass-regression",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-read-store-non-command",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello there" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadAllowFromStore).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
    });
    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("skips sender-name lookup when resolveSenderNames is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["*"],
          resolveSenderNames: false,
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-skip-sender-lookup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuClient).not.toHaveBeenCalled();
  });

  it("propagates parent/root message ids into inbound context for reply reconstruction", async () => {
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_parent_001",
      chatId: "oc-group",
      content: "quoted content",
      contentType: "text",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-replier",
        },
      },
      message: {
        message_id: "om_reply_001",
        root_id: "om_root_001",
        parent_id: "om_parent_001",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "reply text" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "om_parent_001",
        RootMessageId: "om_root_001",
        ReplyToBody: "quoted content",
      }),
    );
  });

  it("uses message create_time as Timestamp instead of Date.now()", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-create-time",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "delete this" }),
        create_time: "1700000000000",
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        Timestamp: 1700000000000,
      }),
    );
  });

  it("falls back to Date.now() when create_time is absent", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-no-create-time",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    const before = Date.now();
    await dispatchMessage({ cfg, event });
    const after = Date.now();

    const call = mockFinalizeInboundContext.mock.calls[0]?.[0] as { Timestamp: number };
    expect(call.Timestamp).toBeGreaterThanOrEqual(before);
    expect(call.Timestamp).toBeLessThanOrEqual(after);
  });

  it("replies pairing challenge to DM chat_id instead of user:sender id", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          user_id: "u_mobile_only",
        },
      },
      message: {
        message_id: "msg-pairing-chat-reply",
        chat_id: "oc_dm_chat_1",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({ cfg, event });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm_chat_1",
      }),
    );
  });
  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-unapproved",
        },
      },
      message: {
        message_id: "msg-pairing-flow",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        text: expect.stringContaining("Your Feishu user id: ou-unapproved"),
        accountId: "default",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        text: expect.stringContaining("Pairing code:"),
        accountId: "default",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc-dm",
        text: expect.stringContaining("ABCDEFGH"),
        accountId: "default",
      }),
    );
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-command-auth",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: false, allowed: false }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: false,
        SenderId: "ou-attacker",
      }),
    );
  });

  it("normalizes group mention-prefixed slash commands before command-auth probing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-attacker",
        },
      },
      message: {
        message_id: "msg-group-mention-command-probe",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "@_user_1/model" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Bot", tenant_key: "" }],
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("/model", cfg);
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg: ClawdbotConfig = {
      commands: { useAccessGroups: true },
      channels: {
        feishu: {
          allowFrom: ["ou-admin"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-admin",
        },
      },
      message: {
        message_id: "msg-group-command-fallback",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "/status" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [{ configured: true, allowed: true }],
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        CommandAuthorized: true,
        SenderId: "ou-admin",
      }),
    );
  });

  it("allows group sender when global groupSenderAllowFrom includes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
      message: {
        message_id: "msg-global-group-sender-allow",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ChatType: "group",
        SenderId: "ou-allowed",
      }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("blocks group sender when global groupSenderAllowFrom excludes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-blocked",
        },
      },
      message: {
        message_id: "msg-global-group-sender-block",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("prefers per-group allowFrom over global groupSenderAllowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-global"],
          groups: {
            "oc-group": {
              allowFrom: ["ou-group-only"],
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-global",
        },
      },
      message: {
        message_id: "msg-per-group-precedence",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops quoted group context from senders outside the group sender allowlist in allowlist mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_parent_blocked",
      chatId: "oc-group",
      senderId: "ou-blocked",
      senderType: "user",
      content: "blocked quoted content",
      contentType: "text",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          contextVisibility: "allowlist",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
      message: {
        message_id: "msg-group-quoted-filter",
        parent_id: "om_parent_blocked",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "om_parent_blocked",
        ReplyToBody: undefined,
      }),
    );
  });

  it("keeps quoted group context from non-allowlisted senders in default all mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_parent_visible",
      chatId: "oc-group",
      senderId: "ou-blocked",
      senderType: "user",
      content: "visible quoted content",
      contentType: "text",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-allowed",
        },
      },
      message: {
        message_id: "msg-group-quoted-visible",
        parent_id: "om_parent_visible",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ReplyToId: "om_parent_visible",
        ReplyToBody: "visible quoted content",
      }),
    );
  });

  it("dispatches group image message when groupPolicy is open (requireMention defaults to false)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          // requireMention is NOT set — should default to false for open policy
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-group-image-open",
        chat_id: "oc-group-open",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v3_test" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("drops group image message when groupPolicy is open but requireMention is explicitly true", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          requireMention: true, // explicit override — user opts into mention-required even for open
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-group-image-open-explicit-mention",
        chat_id: "oc-group-open",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v3_test" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops group image message when groupPolicy is allowlist and requireMention is not set (defaults to true)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "allowlist",
          // requireMention not set — for non-open policy defaults to true
          groups: {
            "oc-allowlist-group": {
              allow: true,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-group-image-allowlist",
        chat_id: "oc-allowlist-group",
        chat_type: "group",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v3_test" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("admits group when chat_id is explicitly configured under groups, even with empty groupAllowFrom (#67687)", async () => {
    // Regression for #67687: a group that only sets `groups.<chat_id>.requireMention=false`
    // (and leaves `groupAllowFrom` empty) should still be admitted under the schema-default
    // `groupPolicy="allowlist"`. The group's explicit presence in `channels.feishu.groups`
    // is the operator's allowlist signal, and the per-group `requireMention` override should
    // then control mention gating for inbound text events.
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "allowlist",
          // groupAllowFrom intentionally omitted -> empty []
          groups: {
            "oc-explicit-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-explicit-group-67687",
        chat_id: "oc-explicit-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello bot" }),
      },
    };

    await dispatchMessage({ cfg, event });

    // Group must be admitted: the inbound finalize/dispatch path runs.
    expect(mockFinalizeInboundContext).toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).toHaveBeenCalled();
  });

  it("does not let explicit group config override disabled group policy", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "disabled",
          groups: {
            "oc-disabled-policy-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-disabled-policy-group",
        chat_id: "oc-disabled-policy-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello bot" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("does not treat wildcard group defaults as allowlist admission", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "allowlist",
          groups: {
            "*": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-wildcard-group-default",
        chat_id: "oc-wildcard-only",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello bot" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("drops message when groupConfig.enabled is false", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-disabled-group": {
              enabled: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: { open_id: "ou-sender" },
      },
      message: {
        message_id: "msg-disabled-group",
        chat_id: "oc-disabled-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("transcribes inbound audio before building the agent turn", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "voice.ogg",
    });
    mockSaveMediaBuffer.mockResolvedValueOnce({
      id: "inbound-voice.ogg",
      path: "/tmp/inbound-voice.ogg",
      size: Buffer.byteLength("voice"),
      contentType: "audio/ogg",
    });
    mockTranscribeFirstAudio.mockResolvedValueOnce("voice transcript");

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-voice",
        },
      },
      message: {
        message_id: "msg-audio-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({
          file_key: "file_audio_payload",
          duration: 1200,
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-audio-inbound",
        fileKey: "file_audio_payload",
        type: "file",
      }),
    );
    expect(mockTranscribeFirstAudio).toHaveBeenCalledWith({
      ctx: {
        MediaPaths: ["/tmp/inbound-voice.ogg"],
        MediaTypes: ["audio/ogg"],
        ChatType: "direct",
      },
      cfg: expect.objectContaining({
        channels: expect.objectContaining({
          feishu: expect.objectContaining({ dmPolicy: "open" }),
        }),
      }),
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "[message_id: msg-audio-inbound]\nou-voice: voice transcript",
        RawBody: "voice transcript",
        CommandBody: "voice transcript",
        Transcript: "voice transcript",
        MediaPaths: ["/tmp/inbound-voice.ogg"],
        MediaTypes: ["audio/ogg"],
        MediaTranscribedIndexes: [0],
      }),
    );
    const finalized = mockFinalizeInboundContext.mock.calls[0]?.[0];
    expect(finalized.BodyForAgent).not.toContain("file_audio_payload");
  });

  it("uses video file_key (not thumbnail image_key) for inbound video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-video-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "video",
        content: JSON.stringify({
          file_key: "file_video_payload",
          image_key: "img_thumb_payload",
          file_name: "clip.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-video-inbound",
        fileKey: "file_video_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("uses media message_type file_key (not thumbnail image_key) for inbound mobile video download", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-media-inbound",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_media_payload",
          image_key: "img_media_thumb",
          file_name: "mobile.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-media-inbound",
        fileKey: "file_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "clip.mp4",
    );
  });

  it("falls back to the message payload filename when download metadata omits it", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockResolvedValueOnce({
      buffer: Buffer.from("video"),
      contentType: "video/mp4",
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-media-payload-name",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "media",
        content: JSON.stringify({
          file_key: "file_media_payload",
          image_key: "img_media_thumb",
          file_name: "payload-name.mp4",
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
      "payload-name.mp4",
    );
  });

  it("downloads embedded media tags from post messages as files", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-sender",
        },
      },
      message: {
        message_id: "msg-post-media",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "Rich text",
          content: [
            [
              {
                tag: "media",
                file_key: "file_post_media_payload",
                file_name: "embedded.mov",
              },
            ],
          ],
        }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-post-media",
        fileKey: "file_post_media_payload",
        type: "file",
      }),
    );
    expect(mockSaveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      expect.any(Number),
    );
  });

  it("includes message_id in BodyForAgent on its own line", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-msgid",
        },
      },
      message: {
        message_id: "msg-message-id-line",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: "[message_id: msg-message-id-line]\nou-msgid: hello",
      }),
    );
  });

  it("expands merge_forward content from API sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const mockGetMerged = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: "container",
            msg_type: "merge_forward",
            body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
          },
          {
            message_id: "sub-2",
            upper_message_id: "container",
            msg_type: "file",
            body: { content: JSON.stringify({ file_name: "report.pdf" }) },
            create_time: "2000",
          },
          {
            message_id: "sub-1",
            upper_message_id: "container",
            msg_type: "text",
            body: { content: JSON.stringify({ text: "alpha" }) },
            create_time: "1000",
          },
        ],
      },
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: mockGetMerged,
        },
      },
    } as unknown as PluginRuntime);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge",
        },
      },
      message: {
        message_id: "msg-merge-forward",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockGetMerged).toHaveBeenCalledWith({
      path: { message_id: "msg-merge-forward" },
    });
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "[Merged and Forwarded Messages]\n- alpha\n- [File: report.pdf]",
        ),
      }),
    );
  });

  it("falls back when merge_forward API returns no sub-messages", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        message: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-merge-empty",
        },
      },
      message: {
        message_id: "msg-merge-empty",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "merge_forward",
        content: JSON.stringify({ text: "Merged and Forwarded Message" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("[Merged and Forwarded Message - could not fetch]"),
      }),
    );
  });

  it("dispatches once and appends permission notice to the main agent body", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied https://open.feishu.cn/app/cli_test",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-perm",
        },
      },
      message: {
        message_id: "msg-perm-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining(
          "Permission grant URL: https://open.feishu.cn/app/cli_test",
        ),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm: hello group"),
      }),
    );
  });

  it("ignores stale non-existent contact scope permission errors", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockRejectedValue({
            response: {
              data: {
                code: 99991672,
                msg: "permission denied: contact:contact.base:readonly https://open.feishu.cn/app/cli_scope_bug",
              },
            },
          }),
        },
      },
    });

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_scope_bug",
          appSecret: "sec_scope_bug", // pragma: allowlist secret
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-perm-scope",
        },
      },
      message: {
        message_id: "msg-perm-scope-1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.not.stringContaining("Permission grant URL"),
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        BodyForAgent: expect.stringContaining("ou-perm-scope: hello group"),
      }),
    );
  });

  it("routes group sessions by sender when groupSessionScope=group_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-scope-user" } },
      message: {
        message_id: "msg-scope-group-sender",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "group sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:sender:ou-scope-user" },
        parentPeer: null,
      }),
    );
  });

  it("routes topic sessions and parentPeer when groupSessionScope=group_topic_sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-sender",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("keeps root_id as topic key when root_id and thread_id both exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_topic",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_topic:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses thread_id as the canonical topic key in Feishu topic groups", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const topicStarter: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_topic_starter_message",
        chat_id: "oc-group",
        chat_type: "topic_group",
        root_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic starter" }),
      },
    };
    const topicReply: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_topic_reply_message",
        chat_id: "oc-group",
        chat_type: "topic_group",
        root_id: "om_topic_starter_message",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic reply" }),
      },
    };

    await dispatchMessage({ cfg, event: topicStarter });
    await dispatchMessage({ cfg, event: topicReply });

    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:omt_topic_1" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:omt_topic_1" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses thread_id as topic key when root_id is missing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "msg-scope-topic-thread-only",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_1",
        message_type: "text",
        content: JSON.stringify({ text: "topic sender scope" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:omt_topic_1:sender:ou-topic-user" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to group_topic routing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy" } },
      message: {
        message_id: "msg-legacy-topic-mode",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("maps legacy topicSessionMode=enabled to root_id when both root_id and thread_id exist", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          topicSessionMode: "enabled",
          groups: {
            "oc-group": {
              requireMention: false,
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-legacy-thread-id" } },
      message: {
        message_id: "msg-legacy-topic-thread-id",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "om_root_legacy",
        thread_id: "omt_topic_legacy",
        message_type: "text",
        content: JSON.stringify({ text: "legacy topic mode" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:om_root_legacy" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("uses message_id as topic root when group_topic + replyInThread and no root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-new-topic-root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockResolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-new-topic-root" },
        parentPeer: { kind: "group", id: "oc-group" },
      }),
    );
  });

  it("keeps topic session key stable after first turn creates a thread", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const firstTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-first",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "create topic" }),
      },
    };
    const secondTurn: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-init" } },
      message: {
        message_id: "msg-topic-second",
        chat_id: "oc-group",
        chat_type: "group",
        root_id: "msg-topic-first",
        thread_id: "omt_topic_created",
        message_type: "text",
        content: JSON.stringify({ text: "follow up in same topic" }),
      },
    };

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
    expect(mockResolveAgentRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { kind: "group", id: "oc-group:topic:msg-topic-first" },
      }),
    );
  });

  it("replies to the topic root when handling a message inside an existing topic", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              replyInThread: "enabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_child_message",
        root_id: "om_root_topic",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "reply inside topic" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_root_topic",
        rootId: "om_root_topic",
      }),
    );
  });

  it("replies to triggering message in normal group even when root_id is present (#32980)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-normal-user" } },
      message: {
        message_id: "om_quote_reply",
        root_id: "om_original_msg",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello in normal group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_quote_reply",
        rootId: "om_original_msg",
      }),
    );
  });

  it("replies to topic root in topic-mode group with root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_topic_reply",
        root_id: "om_topic_root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello in topic group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_topic_root",
        rootId: "om_topic_root",
      }),
    );
  });

  it("replies to topic root in topic-sender group with root_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-sender-user" } },
      message: {
        message_id: "om_topic_sender_reply",
        root_id: "om_topic_sender_root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello in topic sender group" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_topic_sender_root",
        rootId: "om_topic_sender_root",
      }),
    );
  });

  it("forces thread replies when inbound message contains thread_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group",
              replyInThread: "disabled",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-thread-reply" } },
      message: {
        message_id: "msg-thread-reply",
        chat_id: "oc-group",
        chat_type: "group",
        thread_id: "omt_topic_thread_reply",
        message_type: "text",
        content: JSON.stringify({ text: "thread content" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyInThread: true,
        threadReply: true,
      }),
    );
  });

  it("bootstraps topic thread context only for a new thread session", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_topic_root",
      chatId: "oc-group",
      content: "root starter",
      contentType: "text",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      {
        messageId: "om_bot_reply",
        senderId: "app_1",
        senderType: "app",
        content: "assistant reply",
        contentType: "text",
        createTime: 1710000000000,
      },
      {
        messageId: "om_follow_up",
        senderId: "ou-topic-user",
        senderType: "user",
        content: "follow-up question",
        contentType: "text",
        createTime: 1710000001000,
      },
    ]);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_topic_followup_existing_session",
        root_id: "om_topic_root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "current turn" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockReadSessionUpdatedAt).toHaveBeenCalledWith({
      storePath: "/tmp/feishu-sessions.json",
      sessionKey: "agent:main:feishu:dm:ou-attacker",
    });
    expect(mockListFeishuThreadMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        rootMessageId: "om_topic_root",
      }),
    );
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ThreadStarterBody: "root starter",
        ThreadHistoryBody: "assistant reply\n\nfollow-up question",
        ThreadLabel: "Feishu thread in oc-group",
        MessageThreadId: "om_topic_root",
      }),
    );
  });

  it("skips topic thread bootstrap when the thread session already exists", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadSessionUpdatedAt.mockReturnValue(1710000000000);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-topic-user" } },
      message: {
        message_id: "om_topic_followup",
        root_id: "om_topic_root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "current turn" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockGetMessageFeishu).not.toHaveBeenCalled();
    expect(mockListFeishuThreadMessages).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ThreadStarterBody: undefined,
        ThreadHistoryBody: undefined,
        ThreadLabel: "Feishu thread in oc-group",
        MessageThreadId: "om_topic_root",
      }),
    );
  });

  it("keeps sender-scoped thread history when the inbound event and thread history use different sender ids", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_topic_root",
      chatId: "oc-group",
      content: "root starter",
      contentType: "text",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      {
        messageId: "om_bot_reply",
        senderId: "app_1",
        senderType: "app",
        content: "assistant reply",
        contentType: "text",
        createTime: 1710000000000,
      },
      {
        messageId: "om_follow_up",
        senderId: "user_topic_1",
        senderType: "user",
        content: "follow-up question",
        contentType: "text",
        createTime: 1710000001000,
      },
    ]);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic_sender",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-topic-user",
          user_id: "user_topic_1",
        },
      },
      message: {
        message_id: "om_topic_followup_mixed_ids",
        root_id: "om_topic_root",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "current turn" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ThreadStarterBody: "root starter",
        ThreadHistoryBody: "assistant reply\n\nfollow-up question",
        ThreadLabel: "Feishu thread in oc-group",
        MessageThreadId: "om_topic_root",
      }),
    );
  });

  it("filters topic bootstrap context to allowlisted group senders", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValue({
      messageId: "om_topic_root",
      chatId: "oc-group",
      senderId: "ou-blocked",
      senderType: "user",
      content: "blocked root starter",
      contentType: "text",
      threadId: "omt_topic_1",
    });
    mockListFeishuThreadMessages.mockResolvedValue([
      {
        messageId: "om_blocked_reply",
        senderId: "ou-blocked",
        senderType: "user",
        content: "blocked follow-up",
        contentType: "text",
        createTime: 1710000000000,
      },
      {
        messageId: "om_bot_reply",
        senderId: "app_1",
        senderType: "app",
        content: "assistant reply",
        contentType: "text",
        createTime: 1710000001000,
      },
      {
        messageId: "om_allowed_reply",
        senderId: "ou-allowed",
        senderType: "user",
        content: "allowed follow-up",
        contentType: "text",
        createTime: 1710000002000,
      },
    ]);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          groupPolicy: "open",
          groupSenderAllowFrom: ["ou-allowed"],
          contextVisibility: "allowlist",
          groups: {
            "oc-group": {
              requireMention: false,
              groupSessionScope: "group_topic",
            },
          },
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-allowed" } },
      message: {
        message_id: "om_topic_followup_allowlisted",
        root_id: "om_topic_root",
        thread_id: "omt_topic_1",
        chat_id: "oc-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "current turn" }),
      },
    };

    await dispatchMessage({ cfg, event });

    expect(mockFinalizeInboundContext).toHaveBeenCalledWith(
      expect.objectContaining({
        ThreadStarterBody: "assistant reply",
        ThreadHistoryBody: "assistant reply\n\nallowed follow-up",
      }),
    );
  });

  it("does not dispatch twice for the same image message_id (concurrent dedupe)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-image-dedup",
        },
      },
      message: {
        message_id: "msg-image-dedup",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({
          image_key: "img_dedup_payload",
        }),
      },
    };

    await Promise.all([dispatchMessage({ cfg, event }), dispatchMessage({ cfg, event })]);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("dedupes Feishu media by message_id plus file_key", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
        },
      },
    } as ClawdbotConfig;
    const createAudioEvent = (fileKey: string): FeishuMessageEvent => ({
      sender: {
        sender_id: {
          open_id: "ou-audio-dedup",
        },
      },
      message: {
        message_id: "msg-audio-reused-id",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({
          file_key: fileKey,
          duration: 1200,
        }),
      },
    });

    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_first") });
    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_second") });
    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_first") });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledTimes(2);
    expect(mockDownloadMessageResourceFeishu).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messageId: "msg-audio-reused-id",
        fileKey: "file_audio_first",
        type: "file",
      }),
    );
    expect(mockDownloadMessageResourceFeishu).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messageId: "msg-audio-reused-id",
        fileKey: "file_audio_second",
        type: "file",
      }),
    );
  });

  it("skips empty-text messages with no media to prevent blank user turns in session (#74634)", async () => {
    // Feishu can deliver { "text": "" } events (empty-text or media-stripped
    // messages). Writing blank user content to the session causes downstream
    // LLM providers such as MiniMax to reject requests with "messages must not
    // be empty". The handler should drop such events before queuing a reply.
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    } as ClawdbotConfig;

    const event: FeishuMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou-empty-text-sender",
        },
      },
      message: {
        message_id: "msg-empty-text-74634",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "text",
        // Feishu encodes empty text as {"text":""}
        content: JSON.stringify({ text: "" }),
      },
    };

    await dispatchMessage({ cfg, event });

    // No reply should be dispatched: empty message is silently skipped
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });
});

describe("createFeishuMessageReceiveHandler media dedupe", () => {
  it("keeps same-id media variants distinct at receive time", async () => {
    const handleMessage = vi.fn(async () => undefined);
    const core = {
      channel: {
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 0),
          createInboundDebouncer: vi.fn(
            (options: { onFlush: (entries: FeishuMessageEvent[]) => Promise<void> | void }) => ({
              enqueue: async (event: FeishuMessageEvent) => {
                await options.onFlush([event]);
              },
            }),
          ),
        },
        text: {
          hasControlCommand: vi.fn(() => false),
        },
      },
    } as unknown as PluginRuntime;
    const createAudioEvent = (fileKey: string): FeishuMessageEvent => ({
      sender: {
        sender_id: {
          open_id: "ou-audio-receive-dedup",
        },
      },
      message: {
        message_id: "msg-audio-receive-reused-id",
        chat_id: "oc-dm",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({
          file_key: fileKey,
          duration: 1200,
        }),
      },
    });
    const handler = createFeishuMessageReceiveHandler({
      cfg: { channels: { feishu: { dmPolicy: "open" } } } as ClawdbotConfig,
      core,
      accountId: "receive-media-dedupe",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: () => "",
      hasProcessedMessage: vi.fn(async () => false),
      recordProcessedMessage: vi.fn(async () => true),
    });

    await handler(createAudioEvent("file_audio_receive_first"));
    await handler(createAudioEvent("file_audio_receive_second"));
    await handler(createAudioEvent("file_audio_receive_first"));

    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(handleMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        event: createAudioEvent("file_audio_receive_first"),
        processingClaimHeld: true,
      }),
    );
    expect(handleMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        event: createAudioEvent("file_audio_receive_second"),
        processingClaimHeld: true,
      }),
    );
  });
});
