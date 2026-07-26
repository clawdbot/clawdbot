// Feishu tests cover bot plugin behavior.
import type {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveGroupSessionKey } from "openclaw/plugin-sdk/session-store-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { parseMergeForwardContent } from "./bot-content.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  createFeishuTestRoute,
} from "./bot.test-support.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import { createFeishuMessageReceiveHandler } from "./monitor.message-handler.js";
import { setFeishuRuntime } from "./runtime.js";
import { setFeishuSyntheticDirectPreDispatchTarget } from "./synthetic-event-target.js";

type ConfiguredBindingRoute = ReturnType<typeof resolveConfiguredBindingRoute>;
type BoundConversation = ReturnType<
  ReturnType<typeof getSessionBindingService>["resolveByConversation"]
>;
type BindingReadiness = Awaited<ReturnType<typeof ensureConfiguredBindingRouteReady>>;
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends ReadonlyArray<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

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

let currentRuntimeConfig = {} as ClawdbotConfig;

function createFeishuBotRuntime(overrides: DeepPartial<PluginRuntime> = {}): PluginRuntime {
  const runtime = {
    config: {
      current: vi.fn(() => currentRuntimeConfig),
    },
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
      inbound: {
        run: vi.fn(async (params) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const turn = await params.adapter.resolveTurn(
            input,
            {
              kind: "message",
              canStartAgentTurn: true,
            },
            {},
          );
          await runtime.channel.session.recordInboundSession({
            storePath: runtime.channel.session.resolveStorePath(turn.cfg.session?.store, {
              agentId: turn.route.agentId,
            }),
            sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          return {
            admission: turn.admission ?? { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey: turn.route.sessionKey,
            dispatchResult:
              turn.admission?.kind === "observeOnly"
                ? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }
                : await mockDispatchInboundMessage({
                    ctx: turn.ctxPayload,
                    cfg: turn.cfg,
                    replyOptions: turn.replyOptions,
                  }),
          };
        }),
      },
      ...overrides.channel,
    },
    ...(overrides.system ? { system: overrides.system as PluginRuntime["system"] } : {}),
    ...(overrides.media ? { media: overrides.media as PluginRuntime["media"] } : {}),
  } as unknown as PluginRuntime;
  return runtime;
}

const resolveAgentRouteMock: PluginRuntime["channel"]["routing"]["resolveAgentRoute"] = (params) =>
  mockResolveAgentRoute(params);
const readSessionUpdatedAtMock: PluginRuntime["channel"]["session"]["readSessionUpdatedAt"] = (
  params,
) => mockReadSessionUpdatedAt(params);
const resolveStorePathMock: PluginRuntime["channel"]["session"]["resolveStorePath"] = (params) =>
  mockResolveStorePath(params);
const resolveEnvelopeFormatOptionsMock = () => ({});
const withReplyDispatcherMock = async ({
  run,
}: Parameters<PluginRuntime["channel"]["reply"]["withReplyDispatcher"]>[0]) => await run();

function mockCallArg<T>(
  mock: { mock: { calls: unknown[][] } },
  callIndex: number,
  argIndex: number,
  _type?: (value: unknown) => value is T,
): T {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call[argIndex] as T;
}

function lastMockCallArg<T>(
  mock: { mock: { calls: unknown[][] } },
  argIndex = 0,
  _type?: (value: unknown) => value is T,
): T | undefined {
  return mock.mock.calls.at(-1)?.[argIndex] as T | undefined;
}

type FeishuRoutePeer = { id: string; kind: "direct" | "group" };

function expectResolvedRouteCall(
  callIndex: number,
  peer: FeishuRoutePeer,
  parentPeer?: FeishuRoutePeer | null,
): void {
  const routeRequest = mockCallArg<{
    parentPeer?: FeishuRoutePeer | null;
    peer?: FeishuRoutePeer;
  }>(mockResolveAgentRoute, callIndex, 0);
  expect(routeRequest.peer).toEqual(peer);
  if (arguments.length >= 3) {
    expect(routeRequest.parentPeer).toEqual(parentPeer);
  }
}

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
  mockMaybeCreateDynamicAgent,
  mockBuildChannelInboundEventContext,
  mockDispatchInboundMessage,
  mockResolveFeishuBotName,
} = vi.hoisted(() => ({
  mockCreateFeishuReplyDispatcher: vi.fn(() => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: vi.fn(),
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
  mockResolveAgentRoute: vi.fn((_params?: unknown) => createFeishuTestRoute()),
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
  mockMaybeCreateDynamicAgent: vi.fn(),
  mockBuildChannelInboundEventContext: vi.fn(),
  mockDispatchInboundMessage: vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
  mockResolveFeishuBotName: vi.fn().mockResolvedValue("Peer Bot"),
}));

const finalizeInboundContextMock = mockBuildChannelInboundEventContext;

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    formatAgentEnvelope: ({ body }: { body: string }) => body,
    resolveEnvelopeFormatOptions: () => ({}),
    buildChannelInboundEventContext: (
      params: Parameters<typeof actual.buildChannelInboundEventContext>[0],
    ) =>
      actual.buildChannelInboundEventContext({
        ...params,
        finalize: (ctx) => {
          mockBuildChannelInboundEventContext(ctx);
          return ctx as never;
        },
      }),
  };
});

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return { ...actual, dispatchInboundMessage: mockDispatchInboundMessage };
});

vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return { ...actual, resolveStorePath: mockResolveStorePath };
});

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
  saveMessageResourceFeishu: mockDownloadMessageResourceFeishu,
}));

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: mockTranscribeFirstAudio,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: mockMaybeCreateDynamicAgent,
}));

vi.mock("./bot-name.js", () => ({
  resolveFeishuBotName: mockResolveFeishuBotName,
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

afterAll(() => {
  vi.doUnmock("./reply-dispatcher.js");
  vi.doUnmock("./reasoning-preview.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("./audio-preflight.runtime.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./bot-name.js");
  vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
  vi.resetModules();
});

async function dispatchMessage(params: {
  cfg: ClawdbotConfig;
  currentCfg?: ClawdbotConfig;
  event: FeishuMessageEvent;
  channelRuntime?: PluginRuntime["channel"];
  botOpenId?: string;
  directPreDispatchTarget?: string;
}) {
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
  currentRuntimeConfig = params.currentCfg ?? cfg;
  if (params.directPreDispatchTarget) {
    setFeishuSyntheticDirectPreDispatchTarget(params.event, params.directPreDispatchTarget);
  }
  await handleFeishuMessage({
    cfg,
    event: params.event,
    botOpenId: params.botOpenId,
    runtime,
    channelRuntime: params.channelRuntime,
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
    mockMaybeCreateDynamicAgent.mockReset().mockImplementation(async ({ cfg }) => ({
      created: false,
      updatedCfg: cfg,
    }));
    mockResolveFeishuBotName.mockReset().mockResolvedValue("Peer Bot");
    mockResolveAgentRoute.mockReset().mockReturnValue({
      ...createFeishuTestRoute(),
      sessionKey: "agent:main:feishu:direct:ou_sender_1",
    });
    mockSendMessageFeishu
      .mockReset()
      .mockResolvedValue({ messageId: "reply-msg", chatId: "oc_dm" });
    mockCreateFeishuReplyDispatcher.mockReset().mockReturnValue({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(),
    });

    setFeishuRuntime(createFeishuBotRuntime());
  });

  it("ensures configured ACP routes for Feishu DMs", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-1",
        senderOpenId: "ou_sender_1",
        chatId: "oc_dm",
      }),
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
      cfg: createFeishuTestConfig(
        { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-2",
        senderOpenId: "ou_sender_1",
        chatId: "oc_dm",
      }),
    });

    const message = mockCallArg<{ text?: string; to?: string }>(mockSendMessageFeishu, 0, 0);
    expect(message.to).toBe("chat:oc_dm");
    expect(message.text).toContain("runtime unavailable");
  });

  it("surfaces configured ACP initialization failures inside P2P direct-message threads", async () => {
    mockResolveConfiguredBindingRoute.mockReturnValue(createConfiguredFeishuRoute());
    mockEnsureConfiguredBindingRouteReady.mockResolvedValue(
      createConfiguredBindingReadiness(false, "runtime unavailable"),
    );

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-thread-child",
        senderOpenId: "ou_sender_1",
        chatId: "oc_dm",
        message: { root_id: "msg-thread-root", thread_id: "omt-acp-dm-thread" },
      }),
    });

    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_dm",
        replyToMessageId: "msg-thread-root",
        replyInThread: true,
      }),
    );
  });

  it("routes Feishu topic messages through active bound conversations", async () => {
    mockResolveBoundConversation.mockReturnValue(createBoundConversation());

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        {
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
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-3",
        senderOpenId: "ou_sender_1",
        chatId: "oc_group_chat",
        chatType: "group",
        text: "hello topic",
        message: { root_id: "om_topic_root" },
      }),
    });

    const conversationRef = mockCallArg<{ channel?: string; conversationId?: string }>(
      mockResolveBoundConversation,
      0,
      0,
    );
    expect(conversationRef.channel).toBe("feishu");
    expect(conversationRef.conversationId).toBe("oc_group_chat:topic:om_topic_root");
    expect(mockTouchBinding).toHaveBeenCalledWith("default:oc_group_chat:topic:om_topic_root");
  });

  it("records Feishu DM last-route updates on the resolved session", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async () => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "main",
      matchedBy: "default",
    });
    setFeishuRuntime(runtime);

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-dm-last-route",
        senderOpenId: "ou_sender_1",
        chatId: "oc_dm",
      }),
    });

    const recordParams = lastMockCallArg<{
      sessionKey?: string;
      updateLastRoute?: {
        accountId?: string;
        channel?: string;
        sessionKey?: string;
        to?: string;
      };
    }>(recordInboundSession);
    expect(recordParams?.sessionKey).toBe("agent:main:main");
    expect(recordParams?.updateLastRoute).toMatchObject({
      sessionKey: "agent:main:main",
      channel: "feishu",
      to: "user:ou_sender_1",
      accountId: "default",
    });
  });

  it("pins shared Feishu DM last-route updates to the configured owner", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async () => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    runtime.channel.pairing.readAllowFromStore = vi.fn().mockResolvedValue(["ou_sender_2"]);
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "main",
      matchedBy: "default",
    });
    setFeishuRuntime(runtime);

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        { enabled: true, allowFrom: ["ou_owner"], dmPolicy: "pairing" },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-dm-last-route-secondary",
        senderOpenId: "ou_sender_2",
        chatId: "oc_dm",
      }),
    });

    const recordParams = lastMockCallArg<{
      updateLastRoute?: {
        mainDmOwnerPin?: {
          ownerRecipient?: string;
          senderRecipient?: string;
          onSkip?: unknown;
        };
      };
    }>(recordInboundSession);
    expect(recordParams?.updateLastRoute?.mainDmOwnerPin).toMatchObject({
      ownerRecipient: "user:ou_owner",
      senderRecipient: "user:ou_sender_2",
    });
    expect(typeof recordParams?.updateLastRoute?.mainDmOwnerPin?.onSkip).toBe("function");
  });

  it("matches Feishu DM owner pins against user_id allowlist entries", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async () => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "main",
      matchedBy: "default",
    });
    setFeishuRuntime(runtime);

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        { enabled: true, allowFrom: ["user_123"], dmPolicy: "allowlist" },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-dm-last-route-user-id-owner",
        senderOpenId: "ou_owner",
        senderUserId: "user_123",
        chatId: "oc_dm",
      }),
    });

    const recordParams = lastMockCallArg<{
      updateLastRoute?: {
        mainDmOwnerPin?: {
          ownerRecipient?: string;
          senderRecipient?: string;
        };
      };
    }>(recordInboundSession);
    expect(recordParams?.updateLastRoute?.mainDmOwnerPin).toMatchObject({
      ownerRecipient: "user:user_123",
      senderRecipient: "user:user_123",
    });
  });

  it("records Feishu group last-route updates on the resolved session", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async () => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "agent-B",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:agent-B:feishu:group:oc_group_chat",
      mainSessionKey: "agent:agent-B:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    setFeishuRuntime(runtime);

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        {
          enabled: true,
          allowFrom: ["ou_sender_1"],
          groups: { oc_group_chat: { allow: true, requireMention: false } },
        },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-group-last-route",
        senderOpenId: "ou_sender_1",
        chatId: "oc_group_chat",
        chatType: "group",
        text: "hello group",
      }),
    });

    const recordParams = lastMockCallArg<{
      sessionKey?: string;
      updateLastRoute?: {
        accountId?: string;
        channel?: string;
        sessionKey?: string;
        to?: string;
      };
    }>(recordInboundSession);
    expect(recordParams?.sessionKey).toBe("agent:agent-B:feishu:group:oc_group_chat");
    expect(recordParams?.updateLastRoute).toMatchObject({
      sessionKey: "agent:agent-B:feishu:group:oc_group_chat",
      channel: "feishu",
      to: "chat:oc_group_chat",
      accountId: "default",
    });
  });

  it("records configured Feishu thread replies with the dispatcher fallback target", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async () => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "agent-B",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:agent-B:feishu:group:oc_group_chat",
      mainSessionKey: "agent:agent-B:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    setFeishuRuntime(runtime);

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        {
          enabled: true,
          allowFrom: ["ou_sender_1"],
          groups: {
            oc_group_chat: { allow: true, requireMention: false, replyInThread: "enabled" },
          },
        },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-group-thread-fallback",
        senderOpenId: "ou_sender_1",
        chatId: "oc_group_chat",
        chatType: "group",
        text: "start a thread",
      }),
    });

    const recordParams = lastMockCallArg<{
      updateLastRoute?: {
        threadId?: string;
        to?: string;
      };
    }>(recordInboundSession);
    expect(recordParams?.updateLastRoute).toMatchObject({
      to: "chat:oc_group_chat",
      threadId: "msg-group-thread-fallback",
    });
  });

  it("records auto-threaded Feishu group replies with the dispatcher target", async () => {
    const runtime = createFeishuBotRuntime();
    const recordInboundSession = vi.fn(async () => undefined);
    runtime.channel.session.recordInboundSession = recordInboundSession;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "agent-B",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:agent-B:feishu:group:oc_group_chat",
      mainSessionKey: "agent:agent-B:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    setFeishuRuntime(runtime);

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        {
          enabled: true,
          allowFrom: ["ou_sender_1"],
          groups: { oc_group_chat: { allow: true, requireMention: false } },
        },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-group-auto-thread",
        senderOpenId: "ou_sender_1",
        chatId: "oc_group_chat",
        chatType: "group",
        text: "continue the thread",
        message: { root_id: "om_thread_root" },
      }),
    });

    const recordParams = lastMockCallArg<{
      updateLastRoute?: {
        threadId?: string;
        to?: string;
      };
    }>(recordInboundSession);
    expect(recordParams?.updateLastRoute).toMatchObject({
      to: "chat:oc_group_chat",
      threadId: "msg-group-auto-thread",
    });
  });

  it("passes reasoning preview permission from session state into the dispatcher", async () => {
    mockResolveFeishuReasoningPreviewEnabled.mockReturnValue(true);

    await dispatchMessage({
      cfg: createFeishuTestConfig(
        { enabled: true, allowFrom: ["ou_sender_1"], dmPolicy: "open" },
        { session: { mainKey: "main", scope: "per-sender" } },
      ),
      event: createFeishuTestEvent({
        messageId: "msg-reasoning",
        senderOpenId: "ou_sender_1",
        chatId: "oc_dm",
      }),
    });

    const dispatcherOptions = mockCallArg<{ allowReasoningPreview?: boolean }>(
      mockCreateFeishuReplyDispatcher,
      0,
      0,
    );
    expect(dispatcherOptions.allowReasoningPreview).toBe(true);
  });
});

describe("handleFeishuMessage command authorization", () => {
  const mockFinalizeInboundContext = mockBuildChannelInboundEventContext;
  const mockDispatchReplyFromConfig = mockDispatchInboundMessage;
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
  const mockShouldComputeCommandAuthorized = vi.fn<
    PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"]
  >(() => true);
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
    mockDispatchReplyFromConfig.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
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
    mockMaybeCreateDynamicAgent.mockReset().mockImplementation(async ({ cfg }) => ({
      created: false,
      updatedCfg: cfg,
    }));
    mockResolveAgentRoute.mockReturnValue(createFeishuTestRoute());
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

  it("routes /compact through the standard reply dispatch path (#90185)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });

    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-compact-command",
        senderOpenId: "ou-command-user",
        text: "/compact",
      }),
    });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const dispatchParams = mockCallArg<{
      ctx: {
        CommandAuthorized?: boolean;
        CommandBody?: string;
        BodyForCommands?: string;
        RawBody?: string;
        MessageSid?: string;
      };
    }>(mockDispatchReplyFromConfig, 0, 0);
    expect(dispatchParams.ctx).toMatchObject({
      CommandAuthorized: true,
      CommandBody: "/compact",
      BodyForCommands: "/compact",
      RawBody: "/compact",
      MessageSid: "msg-compact-command",
    });
  });

  it("does not enqueue inbound preview text as system events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-no-system-preview",
      text: "hi there",
    });

    await dispatchMessage({ cfg, event });

    expect(mockEnqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not send no-visible fallback when send policy denied delivery", async () => {
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sendPolicyDenied: true,
      noVisibleReplyFallbackEligible: true,
    });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });

    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-send-policy-deny",
        senderOpenId: "ou-sender",
      }),
    });

    expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
  });

  it("sends no-visible fallback when queued final delivery fails", async () => {
    mockDispatchReplyFromConfig.mockResolvedValueOnce({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      failedCounts: { tool: 0, block: 0, final: 1 },
    });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });

    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-final-delivery-failed",
        senderOpenId: "ou-sender",
      }),
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith("dispatch-complete-no-visible-reply");
  });

  it("uses refreshed config for dynamic agent dispatch", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
      configWrites: false,
      dynamicAgentCreation: { enabled: true },
    });
    const refreshedCfg = {
      ...cfg,
      agents: {
        list: [
          {
            id: "feishu-ou-attacker",
            workspace: "/tmp/feishu-ou-attacker",
            agentDir: "/tmp/feishu-ou-attacker/agent",
          },
        ],
      },
    } as ClawdbotConfig;
    mockMaybeCreateDynamicAgent.mockResolvedValueOnce({
      created: false,
      updatedCfg: refreshedCfg,
    });

    const event = createFeishuTestEvent({ messageId: "msg-dynamic-config-writes-disabled" });

    await dispatchMessage({ cfg, event });

    const dynamicAgentRequest = mockCallArg<{
      accountId?: string;
      senderOpenId?: string;
    }>(mockMaybeCreateDynamicAgent, 0, 0);
    expect(dynamicAgentRequest.senderOpenId).toBe("ou-attacker");
    expect(dynamicAgentRequest.accountId).toBe("default");
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: refreshedCfg }),
    );
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: refreshedCfg }),
    );
  });

  it("drops a DM denied by refreshed dynamic-agent policy", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
      dynamicAgentCreation: { enabled: true },
    });
    const refreshedCfg = createFeishuTestConfig({
      dmPolicy: "allowlist",
      allowFrom: ["ou-admin"],
      dynamicAgentCreation: { enabled: true },
    });
    await dispatchMessage({
      cfg,
      currentCfg: refreshedCfg,
      event: createFeishuTestEvent({ messageId: "msg-refreshed-policy-deny" }),
    });

    expect(mockMaybeCreateDynamicAgent).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("reauthorizes current policy before dispatching an existing bound route", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockResolveAgentRoute.mockReturnValue({
      ...createFeishuTestRoute(),
      matchedBy: "binding.peer",
    });
    const cfg = createFeishuTestConfig({ dmPolicy: "open", allowFrom: ["*"] });
    const currentCfg = createFeishuTestConfig({
      dmPolicy: "allowlist",
      allowFrom: ["ou-admin"],
    });

    await dispatchMessage({
      cfg,
      currentCfg,
      event: createFeishuTestEvent({ messageId: "msg-bound-refreshed-policy-deny" }),
    });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge before dynamic creation when current policy requires it", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg = createFeishuTestConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
      dynamicAgentCreation: { enabled: true },
    });
    const currentCfg = createFeishuTestConfig({
      dmPolicy: "pairing",
      allowFrom: [],
      dynamicAgentCreation: { enabled: true },
    });

    await dispatchMessage({
      cfg,
      currentCfg,
      event: createFeishuTestEvent({ messageId: "msg-refreshed-policy-pairing" }),
    });

    expect(mockMaybeCreateDynamicAgent).not.toHaveBeenCalled();
    expect(mockUpsertPairingRequest).toHaveBeenCalledTimes(1);
    expect(mockSendMessageFeishu).toHaveBeenCalledTimes(1);
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("recomputes command authorization against refreshed dynamic-agent config", async () => {
    const cfg = createFeishuTestConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
      dynamicAgentCreation: { enabled: true },
    });
    const refreshedCfg = {
      ...cfg,
      commands: { useAccessGroups: true },
    } as ClawdbotConfig;
    mockShouldComputeCommandAuthorized.mockImplementation((_body, candidateCfg) => {
      return candidateCfg === refreshedCfg;
    });
    mockMaybeCreateDynamicAgent.mockResolvedValueOnce({
      created: false,
      updatedCfg: refreshedCfg,
    });

    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId: "msg-refreshed-command-auth",
        text: "/status",
      }),
    });

    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("/status", refreshedCfg);
    const context = mockCallArg<{ CommandAuthorized?: boolean }>(mockFinalizeInboundContext, 0, 0);
    expect(context.CommandAuthorized).toBe(true);
  });

  it("blocks open DMs when a restrictive allowlist does not match", async () => {
    const cfg = createFeishuTestConfig(
      { dmPolicy: "open", allowFrom: ["ou-admin"] },
      { commands: { useAccessGroups: true } },
    );
    const event = createFeishuTestEvent({
      messageId: "msg-auth-bypass-regression",
      text: "/status",
    });

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
  });

  it("reads pairing allow store for non-command DMs when dmPolicy is pairing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue(["ou-attacker"]);

    const cfg = createFeishuTestConfig(
      { dmPolicy: "pairing", allowFrom: [] },
      { commands: { useAccessGroups: true } },
    );
    const event = createFeishuTestEvent({
      messageId: "msg-read-store-non-command",
      text: "hello there",
    });

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
    const cfg = createFeishuTestConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
      resolveSenderNames: false,
    });
    const event = createFeishuTestEvent({ messageId: "msg-skip-sender-lookup" });

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

    const cfg = createFeishuTestConfig({ enabled: true, dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "om_reply_001",
      senderOpenId: "ou-replier",
      text: "reply text",
      message: { root_id: "om_root_001", parent_id: "om_parent_001" },
    });

    await dispatchMessage({ cfg, event });

    const context = mockCallArg<{
      ReplyToId?: string;
      RootMessageId?: string;
      SupplementalContext?: { quote?: { body?: string } };
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.ReplyToId).toBe("om_parent_001");
    expect(context.RootMessageId).toBe("om_root_001");
    expect(context.SupplementalContext?.quote?.body).toBe("quoted content");
  });

  it("uses message create_time as Timestamp instead of Date.now()", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-create-time",
        text: "delete this",
        message: { create_time: "1700000000000" },
      }),
    });

    const context = mockCallArg<{ Timestamp?: number }>(mockFinalizeInboundContext, 0, 0);
    expect(context.Timestamp).toBe(1700000000000);
  });

  it.each([
    {
      name: "falls back to Date.now() when create_time is absent",
      messageId: "msg-no-create-time",
      createTime: undefined,
    },
    {
      name: "falls back to Date.now() when create_time is malformed",
      messageId: "msg-malformed-create-time",
      createTime: "1700000000000ms",
    },
  ])("$name", async ({ messageId, createTime }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const before = Date.now();
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId,
        message: createTime ? { create_time: createTime } : {},
      }),
    });
    const after = Date.now();

    const call = mockFinalizeInboundContext.mock.calls.at(0)?.[0] as { Timestamp: number };
    expect(call.Timestamp).toBeGreaterThanOrEqual(before);
    expect(call.Timestamp).toBeLessThanOrEqual(after);
  });

  it("replies pairing challenge to DM chat_id instead of user:sender id", async () => {
    const cfg = createFeishuTestConfig({ dmPolicy: "pairing" });
    const event = createFeishuTestEvent({
      messageId: "msg-pairing-chat-reply",
      sender: { sender_id: { user_id: "u_mobile_only" } },
      chatId: "oc_dm_chat_1",
    });

    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({ cfg, event });

    const message = mockCallArg<{ to?: string }>(mockSendMessageFeishu, 0, 0);
    expect(message.to).toBe("chat:oc_dm_chat_1");
  });

  it("replies to the explicit pre-dispatch target for synthetic DMs", async () => {
    const cfg = createFeishuTestConfig({ dmPolicy: "pairing" });
    const event = createFeishuTestEvent({
      messageId: "synthetic-invite",
      senderOpenId: "ou_synthetic_inviter",
      chatId: "ou_synthetic_inviter",
      text: "join the meeting",
    });
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    await dispatchMessage({
      cfg,
      event,
      directPreDispatchTarget: "user:ou_synthetic_inviter",
    });

    const message = mockCallArg<{ to?: string }>(mockSendMessageFeishu, 0, 0);
    expect(message.to).toBe("user:ou_synthetic_inviter");
  });
  it("creates pairing request and drops unauthorized DMs in pairing mode", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadAllowFromStore.mockResolvedValue([]);
    mockUpsertPairingRequest.mockResolvedValue({ code: "ABCDEFGH", created: true });

    const cfg = createFeishuTestConfig({ dmPolicy: "pairing", allowFrom: [] });
    const event = createFeishuTestEvent({
      messageId: "msg-pairing-flow",
      senderOpenId: "ou-unapproved",
    });

    await dispatchMessage({ cfg, event });

    expect(mockUpsertPairingRequest).toHaveBeenCalledWith({
      channel: "feishu",
      accountId: "default",
      id: "ou-unapproved",
      meta: { name: undefined },
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledTimes(1);
    const pairingMessage = mockCallArg<{ accountId?: string; text?: string; to?: string }>(
      mockSendMessageFeishu,
      0,
      0,
    );
    expect(pairingMessage.to).toBe("chat:oc-dm");
    expect(pairingMessage.text).toContain("Your Feishu user id: ou-unapproved");
    expect(pairingMessage.text).toContain("Pairing code:");
    expect(pairingMessage.text).toContain("ABCDEFGH");
    expect(pairingMessage.accountId).toBe("default");
    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("computes group command authorization from group allowFrom", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);

    const cfg = createFeishuTestConfig(
      { groups: { "oc-group": { requireMention: false } } },
      { commands: { useAccessGroups: true } },
    );
    const event = createFeishuTestEvent({
      messageId: "msg-group-command-auth",
      chatId: "oc-group",
      chatType: "group",
      text: "/status",
    });

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    const context = mockCallArg<{
      ChatType?: string;
      CommandAuthorized?: boolean;
      SenderId?: string;
      GroupRequireMention?: boolean;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.ChatType).toBe("group");
    expect(context.CommandAuthorized).toBe(false);
    expect(context.SenderId).toBe("ou-attacker");
    expect(context.GroupRequireMention).toBe(false);
  });

  it("normalizes group mention-prefixed slash commands before command-auth probing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);

    const cfg = createFeishuTestConfig({
      groups: { "oc-group": { requireMention: false } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-group-mention-command-probe",
      chatId: "oc-group",
      chatType: "group",
      text: "@_user_1/model",
      message: {
        mentions: [{ key: "@_user_1", id: { open_id: "ou-bot" }, name: "Bot", tenant_key: "" }],
      },
    });

    await dispatchMessage({ cfg, event });

    expect(mockShouldComputeCommandAuthorized).toHaveBeenCalledWith("/model", cfg);
  });

  it("falls back to top-level allowFrom for group command authorization", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(true);
    mockResolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const cfg = createFeishuTestConfig(
      { allowFrom: ["ou-admin"], groups: { "oc-group": { requireMention: false } } },
      { commands: { useAccessGroups: true } },
    );
    const event = createFeishuTestEvent({
      messageId: "msg-group-command-fallback",
      senderOpenId: "ou-admin",
      chatId: "oc-group",
      chatType: "group",
      text: "/status",
    });

    await dispatchMessage({ cfg, event });

    expect(mockResolveCommandAuthorizedFromAuthorizers).not.toHaveBeenCalled();
    const context = mockCallArg<{
      ChatType?: string;
      CommandAuthorized?: boolean;
      SenderId?: string;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.ChatType).toBe("group");
    expect(context.CommandAuthorized).toBe(true);
    expect(context.SenderId).toBe("ou-admin");
  });

  it("allows group sender when global groupSenderAllowFrom includes sender", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groupSenderAllowFrom: ["ou-allowed"],
      groups: { "oc-group": { requireMention: false } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-global-group-sender-allow",
      senderOpenId: "ou-allowed",
      chatId: "oc-group",
      chatType: "group",
    });

    await dispatchMessage({ cfg, event });

    const context = mockCallArg<{ ChatType?: string; SenderId?: string }>(
      mockFinalizeInboundContext,
      0,
      0,
    );
    expect(context.ChatType).toBe("group");
    expect(context.SenderId).toBe("ou-allowed");
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("verifies app-scoped bot mention ids before admitting bot-authored events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const baseFeishuConfig = {
      groupPolicy: "open" as const,
      groups: { "oc-bot-group": { requireMention: true } },
    };
    const createEvent = (messageId: string, mentionedOpenId?: string): FeishuMessageEvent =>
      createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-peer-bot",
        senderType: "bot",
        chatId: "oc-bot-group",
        chatType: "group",
        text: mentionedOpenId ? "@_openclaw /status" : "/status",
        message: {
          mentions: mentionedOpenId
            ? [{ key: "@_openclaw", id: { open_id: mentionedOpenId }, name: "OpenClaw" }]
            : undefined,
        },
      });

    await dispatchMessage({
      cfg: createFeishuTestConfig(baseFeishuConfig),
      event: createEvent("msg-bot-off", "ou-other-app-openclaw"),
      botOpenId: "ou-openclaw",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const getMessage = vi.fn().mockImplementation(({ path }: { path: { message_id: string } }) =>
      Promise.resolve({
        code: 0,
        data: {
          items: [
            {
              mentions:
                path.message_id === "msg-bot-mentioned"
                  ? [
                      {
                        key: "@_openclaw",
                        id: "ou-openclaw",
                        id_type: "open_id",
                        name: "OpenClaw",
                      },
                    ]
                  : [],
            },
          ],
        },
      }),
    );
    mockCreateFeishuClient.mockReturnValue({ im: { message: { get: getMessage } } });

    await dispatchMessage({
      cfg: createFeishuTestConfig({ ...baseFeishuConfig, allowBots: true }),
      event: createEvent("msg-bot-unmentioned"),
      botOpenId: "ou-openclaw",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const unrelatedMentionEvent = createEvent("msg-bot-other-mention", "ou-other-bot");
    unrelatedMentionEvent.message.mentions![0]!.name = "Other Bot";
    await dispatchMessage({
      cfg: createFeishuTestConfig({ ...baseFeishuConfig, allowBots: true }),
      event: unrelatedMentionEvent,
      botOpenId: "ou-openclaw",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();

    const admittedEvent = createEvent("msg-bot-mentioned", "ou-other-app-openclaw");
    admittedEvent.message.content = JSON.stringify({ text: "@_openclaw @_alice /status" });
    admittedEvent.message.mentions?.push({
      key: "@_alice",
      id: { open_id: "ou-alice" },
      name: "Alice",
    });
    await dispatchMessage({
      cfg: createFeishuTestConfig({ ...baseFeishuConfig, allowBots: true }),
      event: admittedEvent,
      botOpenId: "ou-openclaw",
    });

    expect(mockResolveFeishuBotName).toHaveBeenCalledWith(
      expect.objectContaining({ openId: "ou-peer-bot" }),
    );
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredMentionTargets: [{ openId: "ou-peer-bot", name: "Peer Bot", key: "" }],
      }),
    );
    const inbound = mockCallArg<{ CommandBody?: string; BodyForAgent?: string }>(
      mockFinalizeInboundContext,
      0,
      0,
    );
    expect(inbound.CommandBody).toBe("/status");
    expect(inbound.BodyForAgent).not.toContain("ou-other-app-openclaw");
    expect(inbound.BodyForAgent).not.toContain("ou-alice");
    expect(getMessage).toHaveBeenCalledTimes(3);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("fails closed for bot ingress when the local bot identity is unavailable", async () => {
    const cfg = createFeishuTestConfig({
      allowBots: true,
      groupPolicy: "open",
      groups: { "oc-bot-group": { requireMention: true } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-bot-no-local-id",
      senderOpenId: "ou-peer-bot",
      senderType: "bot",
      chatId: "oc-bot-group",
      chatType: "group",
      text: "@_openclaw ping",
    });

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("uses channels.defaults.botLoopProtection for admitted Feishu bot pairs", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    const cfg = createFeishuTestConfig(
      {
        allowBots: true,
        groupPolicy: "open",
        groups: { "oc-loop-group": { requireMention: false } },
      },
      {
        channels: {
          defaults: {
            botLoopProtection: {
              maxEventsPerWindow: 1,
              windowSeconds: 60,
              cooldownSeconds: 60,
            },
          },
        },
      },
    );
    const event = (messageId: string): FeishuMessageEvent =>
      createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-loop-peer",
        senderType: "bot",
        chatId: "oc-loop-group",
        chatType: "group",
        text: "@_openclaw ping",
        message: {
          mentions: [{ key: "@_openclaw", id: { open_id: "ou-loop-self" }, name: "OpenClaw" }],
        },
      });

    await dispatchMessage({ cfg, event: event("msg-loop-1"), botOpenId: "ou-loop-self" });
    await dispatchMessage({ cfg, event: event("msg-loop-2"), botOpenId: "ou-loop-self" });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps Feishu group policy bound to the chat while preserving speaker identity", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groupSenderAllowFrom: ["ou-allowed"],
      groups: { "oc-group": { requireMention: false } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-group-context-79457",
      senderOpenId: "ou-allowed",
      chatId: "oc-group",
      chatType: "group",
    });

    await dispatchMessage({ cfg, event });

    const finalized = mockCallArg<{
      ChatType?: string;
      From?: string;
      OriginatingChannel?: string;
      OriginatingTo?: string;
      NativeChannelId?: string;
      SenderId?: string;
      To?: string;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(finalized.ChatType).toBe("group");
    expect(finalized.From).toBe("feishu:ou-allowed");
    expect(finalized.To).toBe("chat:oc-group");
    expect(finalized.OriginatingChannel).toBe("feishu");
    expect(finalized.OriginatingTo).toBe("chat:oc-group");
    expect(finalized.NativeChannelId).toBe("oc-group");
    expect(finalized.SenderId).toBe("ou-allowed");
    const groupSessionKey = resolveGroupSessionKey(finalized as never);
    if (!groupSessionKey) {
      throw new Error("Expected group session key");
    }
    expect(groupSessionKey.channel).toBe("feishu");
    expect(groupSessionKey.id).toBe("oc-group");
    expect(groupSessionKey.key).toBe("feishu:group:oc-group");
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "blocks group sender when global groupSenderAllowFrom excludes sender",
      cfg: createFeishuTestConfig({
        groupPolicy: "open",
        groupSenderAllowFrom: ["ou-allowed"],
        groups: { "oc-group": { requireMention: false } },
      }),
      messageId: "msg-global-group-sender-block",
      senderOpenId: "ou-blocked",
    },
    {
      name: "prefers per-group allowFrom over global groupSenderAllowFrom",
      cfg: createFeishuTestConfig({
        groupPolicy: "open",
        groupSenderAllowFrom: ["ou-global"],
        groups: {
          "oc-group": { allowFrom: ["ou-group-only"], requireMention: false },
        },
      }),
      messageId: "msg-per-group-precedence",
      senderOpenId: "ou-global",
    },
  ])("$name", async ({ cfg, messageId, senderOpenId }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId,
        chatId: "oc-group",
        chatType: "group",
      }),
    });

    expect(mockFinalizeInboundContext).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "drops quoted group context from senders outside the group sender allowlist in allowlist mode",
      parentId: "om_parent_blocked",
      messageId: "msg-group-quoted-filter",
      quotedBody: "blocked quoted content",
      contextVisibility: "allowlist" as const,
      expectedBody: undefined,
    },
    {
      name: "keeps quoted group context from non-allowlisted senders in default all mode",
      parentId: "om_parent_visible",
      messageId: "msg-group-quoted-visible",
      quotedBody: "visible quoted content",
      contextVisibility: undefined,
      expectedBody: "visible quoted content",
    },
  ])("$name", async ({ parentId, messageId, quotedBody, contextVisibility, expectedBody }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: parentId,
      chatId: "oc-group",
      senderId: "ou-blocked",
      senderType: "user",
      content: quotedBody,
      contentType: "text",
    });

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groupSenderAllowFrom: ["ou-allowed"],
      ...(contextVisibility ? { contextVisibility } : {}),
      groups: { "oc-group": { requireMention: false } },
    });
    const event = createFeishuTestEvent({
      messageId,
      senderOpenId: "ou-allowed",
      chatId: "oc-group",
      chatType: "group",
      message: { parent_id: parentId },
    });

    await dispatchMessage({ cfg, event });

    const context = mockCallArg<{
      ReplyToId?: string;
      SupplementalContext?: { quote?: { body?: string } };
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.ReplyToId).toBe(parentId);
    expect(context.SupplementalContext?.quote?.body).toBe(expectedBody);
  });

  it("dispatches group image message when groupPolicy is open (requireMention defaults to false)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    // requireMention is not set, so open policy defaults it to false.
    const cfg = createFeishuTestConfig({ groupPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-group-image-open",
      senderOpenId: "ou-sender",
      chatId: "oc-group-open",
      chatType: "group",
      messageType: "image",
      content: JSON.stringify({ image_key: "img_v3_test" }),
    });

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("replaces a failed image download placeholder with an unavailable notice", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired image key"));

    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-image-failed",
        senderOpenId: "ou-sender",
        messageType: "image",
        content: JSON.stringify({ image_key: "expired-image" }),
      }),
    });

    const context = mockCallArg<{
      BodyForAgent?: string;
      CommandBody?: string;
      MediaPath?: string;
      MediaTypes?: string[];
      RawBody?: string;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.RawBody).toBe("");
    expect(context.CommandBody).toBe("");
    expect(context.BodyForAgent).toContain("[feishu attachment unavailable]");
    expect(context.BodyForAgent).not.toContain("<media:image>");
    expect(context.MediaPath).toBeUndefined();
    expect(context.MediaTypes).toEqual(["image"]);
  });

  it("preserves an audio transcript when the media download fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired audio key"));

    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-audio-failed",
        senderOpenId: "ou-sender",
        messageType: "audio",
        content: JSON.stringify({ file_key: "expired-audio", speech_to_text: "spoken words" }),
      }),
    });

    const context = mockCallArg<{
      BodyForAgent?: string;
      CommandBody?: string;
      MediaPath?: string;
      MediaTypes?: string[];
      RawBody?: string;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.RawBody).toBe("spoken words");
    expect(context.CommandBody).toBe("spoken words");
    expect(context.BodyForAgent).toContain("spoken words\n\n[feishu attachment unavailable]");
    expect(context.MediaPath).toBeUndefined();
  });

  it("drops the unstable filename annotation when a file download fails", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired file key"));

    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-file-failed",
        senderOpenId: "ou-sender",
        messageType: "file",
        content: JSON.stringify({ file_key: "expired-file", file_name: "q1.pdf" }),
      }),
    });

    const context = mockCallArg<{
      BodyForAgent?: string;
      CommandBody?: string;
      MediaPath?: string;
      MediaTypes?: string[];
      RawBody?: string;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.RawBody).toBe("");
    expect(context.CommandBody).toBe("");
    expect(context.BodyForAgent).toContain("[feishu attachment unavailable]");
    expect(context.BodyForAgent).not.toContain("q1.pdf");
    expect(context.BodyForAgent).not.toContain("<media:document>");
    expect(context.MediaPath).toBeUndefined();
    expect(context.MediaTypes).toEqual(["document"]);
  });

  it.each([
    {
      name: "drops group image message when groupPolicy is open but requireMention is explicitly true",
      cfg: createFeishuTestConfig({ groupPolicy: "open", requireMention: true }),
      messageId: "msg-group-image-open-explicit-mention",
      chatId: "oc-group-open",
    },
    {
      name: "drops group image message when groupPolicy is allowlist and requireMention is not set (defaults to true)",
      cfg: createFeishuTestConfig({
        groupPolicy: "allowlist",
        groups: { "oc-allowlist-group": { allow: true } },
      }),
      messageId: "msg-group-image-allowlist",
      chatId: "oc-allowlist-group",
    },
  ])("$name", async ({ cfg, messageId, chatId }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-sender",
        chatId,
        chatType: "group",
        messageType: "image",
        content: JSON.stringify({ image_key: "img_v3_test" }),
      }),
    });

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

    const cfg = createFeishuTestConfig({
      groupPolicy: "allowlist",
      // groupAllowFrom intentionally omitted -> empty []
      groups: { "oc-explicit-group": { requireMention: false } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-explicit-group-67687",
      senderOpenId: "ou-sender",
      chatId: "oc-explicit-group",
      chatType: "group",
      text: "hello bot",
    });

    await dispatchMessage({ cfg, event });

    // Group must be admitted: the inbound finalize/dispatch path runs.
    expect(mockFinalizeInboundContext).toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).toHaveBeenCalled();
  });

  it.each([
    {
      name: "does not let explicit group config override disabled group policy",
      cfg: createFeishuTestConfig({
        groupPolicy: "disabled",
        groups: { "oc-disabled-policy-group": { requireMention: false } },
      }),
      messageId: "msg-disabled-policy-group",
      chatId: "oc-disabled-policy-group",
      text: "hello bot",
    },
    {
      name: "does not treat wildcard group defaults as allowlist admission",
      cfg: createFeishuTestConfig({
        groupPolicy: "allowlist",
        groups: { "*": { requireMention: false } },
      }),
      messageId: "msg-wildcard-group-default",
      chatId: "oc-wildcard-only",
      text: "hello bot",
    },
    {
      name: "drops message when groupConfig.enabled is false",
      cfg: createFeishuTestConfig({ groups: { "oc-disabled-group": { enabled: false } } }),
      messageId: "msg-disabled-group",
      chatId: "oc-disabled-group",
      text: "hello",
    },
  ])("$name", async ({ cfg, messageId, chatId, text }) => {
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-sender",
        chatId,
        chatType: "group",
        text,
      }),
    });

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

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-audio-inbound",
      senderOpenId: "ou-voice",
      messageType: "audio",
      content: JSON.stringify({ file_key: "file_audio_payload", duration: 1200 }),
    });

    await dispatchMessage({ cfg, event });

    const downloadRequest = mockCallArg<{ fileKey?: string; messageId?: string; type?: string }>(
      mockDownloadMessageResourceFeishu,
      0,
      0,
    );
    expect(downloadRequest.messageId).toBe("msg-audio-inbound");
    expect(downloadRequest.fileKey).toBe("file_audio_payload");
    expect(downloadRequest.type).toBe("file");
    const transcribeRequest = mockCallArg<{
      cfg?: { channels?: { feishu?: { dmPolicy?: string } } };
      ctx?: {
        ChatType?: string;
        media?: Array<{ path?: string; contentType?: string; kind?: string }>;
      };
    }>(mockTranscribeFirstAudio, 0, 0);
    expect(transcribeRequest.ctx?.media).toEqual([
      { path: "/tmp/inbound-voice.ogg", contentType: "audio/ogg", kind: "audio" },
    ]);
    expect(transcribeRequest.ctx?.ChatType).toBe("direct");
    expect(transcribeRequest.cfg?.channels?.feishu?.dmPolicy).toBe("open");
    const finalized = mockCallArg<{
      BodyForAgent?: string;
      CommandBody?: string;
      MediaPaths?: string[];
      MediaTranscribedIndexes?: number[];
      MediaTypes?: string[];
      RawBody?: string;
      Transcript?: string;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(finalized.BodyForAgent).toBe(
      "[message_id: msg-audio-inbound]\nou-voice: voice transcript",
    );
    expect(finalized.RawBody).toBe("voice transcript");
    expect(finalized.CommandBody).toBe("voice transcript");
    expect(finalized.Transcript).toBe("voice transcript");
    expect(finalized.MediaPaths).toEqual(["/tmp/inbound-voice.ogg"]);
    expect(finalized.MediaTypes).toEqual(["audio/ogg"]);
    expect(finalized.MediaTranscribedIndexes).toEqual([0]);
    expect(finalized.BodyForAgent).not.toContain("file_audio_payload");
  });

  it.each([
    {
      name: "uses video file_key (not thumbnail image_key) for inbound video download",
      messageId: "msg-video-inbound",
      messageType: "video" as const,
      fileKey: "file_video_payload",
      imageKey: "img_thumb_payload",
      fileName: "clip.mp4",
      savedFileName: "clip.mp4",
    },
    {
      name: "uses media message_type file_key (not thumbnail image_key) for inbound mobile video download",
      messageId: "msg-media-inbound",
      messageType: "media" as const,
      fileKey: "file_media_payload",
      imageKey: "img_media_thumb",
      fileName: "mobile.mp4",
      savedFileName: "clip.mp4",
    },
  ])("$name", async ({ messageId, messageType, fileKey, imageKey, fileName, savedFileName }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-sender",
        messageType,
        content: JSON.stringify({ file_key: fileKey, image_key: imageKey, file_name: fileName }),
      }),
    });

    const downloadRequest = mockCallArg<{
      fileKey?: string;
      messageId?: string;
      type?: string;
    }>(mockDownloadMessageResourceFeishu, 0, 0);
    expect(downloadRequest.messageId).toBe(messageId);
    expect(downloadRequest.fileKey).toBe(fileKey);
    expect(downloadRequest.type).toBe("file");
    const mediaBuffer = mockCallArg<Buffer>(mockSaveMediaBuffer, 0, 0);
    expect(Buffer.isBuffer(mediaBuffer)).toBe(true);
    expect(mediaBuffer.toString()).toBe("video");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 1)).toBe("video/mp4");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 2)).toBe("inbound");
    expect(typeof mockCallArg(mockSaveMediaBuffer, 0, 3)).toBe("number");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 4)).toBe(savedFileName);
  });

  it("falls back to the message payload filename when download metadata omits it", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockResolvedValueOnce({
      buffer: Buffer.from("video"),
      contentType: "video/mp4",
    });

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-media-payload-name",
      senderOpenId: "ou-sender",
      messageType: "media",
      content: JSON.stringify({
        file_key: "file_media_payload",
        image_key: "img_media_thumb",
        file_name: "payload-name.mp4",
      }),
    });

    await dispatchMessage({ cfg, event });

    const mediaBuffer = mockCallArg<Buffer>(mockSaveMediaBuffer, 0, 0);
    expect(Buffer.isBuffer(mediaBuffer)).toBe(true);
    expect(mediaBuffer.toString()).toBe("video");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 1)).toBe("video/mp4");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 2)).toBe("inbound");
    expect(typeof mockCallArg(mockSaveMediaBuffer, 0, 3)).toBe("number");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 4)).toBe("payload-name.mp4");
  });

  it("downloads embedded media tags from post messages as files", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-post-media",
      senderOpenId: "ou-sender",
      messageType: "post",
      content: JSON.stringify({
        title: "Rich text",
        content: [
          [{ tag: "media", file_key: "file_post_media_payload", file_name: "embedded.mov" }],
        ],
      }),
    });

    await dispatchMessage({ cfg, event });

    const downloadRequest = mockCallArg<{ fileKey?: string; messageId?: string; type?: string }>(
      mockDownloadMessageResourceFeishu,
      0,
      0,
    );
    expect(downloadRequest.messageId).toBe("msg-post-media");
    expect(downloadRequest.fileKey).toBe("file_post_media_payload");
    expect(downloadRequest.type).toBe("file");
    const postMediaBuffer = mockCallArg<Buffer>(mockSaveMediaBuffer, 0, 0);
    expect(Buffer.isBuffer(postMediaBuffer)).toBe(true);
    expect(postMediaBuffer.toString()).toBe("video");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 1)).toBe("video/mp4");
    expect(mockCallArg(mockSaveMediaBuffer, 0, 2)).toBe("inbound");
    expect(typeof mockCallArg(mockSaveMediaBuffer, 0, 3)).toBe("number");
  });

  it("removes failed rich-post media markers while preserving post text", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockDownloadMessageResourceFeishu.mockRejectedValueOnce(new Error("expired image key"));

    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId: "msg-post-image-failed",
        senderOpenId: "ou-sender",
        messageType: "post",
        content: JSON.stringify({
          title: "Rich text",
          content: [
            [
              { tag: "text", text: "Before " },
              { tag: "img", image_key: "expired-image" },
              { tag: "text", text: " after" },
            ],
          ],
        }),
      }),
    });

    const context = mockCallArg<{
      BodyForAgent?: string;
      MediaPath?: string;
      RawBody?: string;
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.RawBody).toBe("Rich text\n\nBefore  after");
    expect(context.BodyForAgent).toContain(
      "Rich text\n\nBefore  after\n\n[feishu attachment unavailable]",
    );
    expect(context.BodyForAgent).not.toContain("![image]");
    expect(context.MediaPath).toBeUndefined();
  });

  it("includes message_id in BodyForAgent on its own line", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-message-id-line",
      senderOpenId: "ou-msgid",
    });

    await dispatchMessage({ cfg, event });

    const context = mockCallArg<{ BodyForAgent?: string }>(mockFinalizeInboundContext, 0, 0);
    expect(context.BodyForAgent).toBe("[message_id: msg-message-id-line]\nou-msgid: hello");
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

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-merge-forward",
      senderOpenId: "ou-merge",
      messageType: "merge_forward",
      text: "Merged and Forwarded Message",
    });

    await dispatchMessage({ cfg, event });

    expect(mockGetMerged).toHaveBeenCalledWith({
      path: { message_id: "msg-merge-forward" },
    });
    const context = mockCallArg<{ BodyForAgent?: string }>(mockFinalizeInboundContext, 0, 0);
    expect(context.BodyForAgent).toContain(
      "[Merged and Forwarded Messages]\n- alpha\n- [File: report.pdf]",
    );
  });

  it("does not partially parse malformed merge_forward create_time values", () => {
    const content = JSON.stringify([
      {
        message_id: "container",
        msg_type: "merge_forward",
        body: { content: JSON.stringify({ text: "Merged and Forwarded Message" }) },
      },
      {
        message_id: "partial",
        upper_message_id: "container",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "partial" }) },
        create_time: "2000ms",
      },
      {
        message_id: "valid",
        upper_message_id: "container",
        msg_type: "text",
        body: { content: JSON.stringify({ text: "valid" }) },
        create_time: "1000",
      },
    ]);

    expect(parseMergeForwardContent({ content })).toBe(
      "[Merged and Forwarded Messages]\n- partial\n- valid",
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

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-merge-empty",
      senderOpenId: "ou-merge-empty",
      messageType: "merge_forward",
      text: "Merged and Forwarded Message",
    });

    await dispatchMessage({ cfg, event });

    const context = mockCallArg<{ BodyForAgent?: string }>(mockFinalizeInboundContext, 0, 0);
    expect(context.BodyForAgent).toContain("[Merged and Forwarded Message - could not fetch]");
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

    const cfg = createFeishuTestConfig({
      appId: "cli_test",
      appSecret: "sec_test", // pragma: allowlist secret
      groups: { "oc-group": { requireMention: false } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-perm-1",
      senderOpenId: "ou-perm",
      chatId: "oc-group",
      chatType: "group",
      text: "hello group",
    });

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const context = mockCallArg<{ BodyForAgent?: string }>(mockFinalizeInboundContext, 0, 0);
    expect(context.BodyForAgent).toContain(
      "Permission grant URL: https://open.feishu.cn/app/cli_test",
    );
    expect(context.BodyForAgent).toContain("ou-perm: hello group");
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

    const cfg = createFeishuTestConfig({
      appId: "cli_scope_bug",
      appSecret: "sec_scope_bug", // pragma: allowlist secret
      groups: { "oc-group": { requireMention: false } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-perm-scope-1",
      senderOpenId: "ou-perm-scope",
      chatId: "oc-group",
      chatType: "group",
      text: "hello group",
    });

    await dispatchMessage({ cfg, event });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const context = mockCallArg<{ BodyForAgent?: string }>(mockFinalizeInboundContext, 0, 0);
    expect(context.BodyForAgent).not.toContain("Permission grant URL");
    expect(context.BodyForAgent).toContain("ou-perm-scope: hello group");
  });

  it.each([
    {
      name: "routes group sessions by sender when groupSessionScope=group_sender",
      scope: "group_sender" as const,
      messageId: "msg-scope-group-sender",
      senderOpenId: "ou-scope-user",
      text: "group sender scope",
      message: {},
      expectedPeer: { kind: "group" as const, id: "oc-group:sender:ou-scope-user" },
      expectedParentPeer: null,
    },
    {
      name: "routes topic sessions and parentPeer when groupSessionScope=group_topic_sender",
      scope: "group_topic_sender" as const,
      messageId: "msg-scope-topic-sender",
      senderOpenId: "ou-topic-user",
      text: "topic sender scope",
      message: { root_id: "om_root_topic" },
      expectedPeer: {
        kind: "group" as const,
        id: "oc-group:topic:om_root_topic:sender:ou-topic-user",
      },
      expectedParentPeer: { kind: "group" as const, id: "oc-group" },
    },
    {
      name: "keeps root_id as topic key when root_id and thread_id both exist",
      scope: "group_topic_sender" as const,
      messageId: "msg-scope-topic-thread-id",
      senderOpenId: "ou-topic-user",
      text: "topic sender scope",
      message: { root_id: "om_root_topic", thread_id: "omt_topic_1" },
      expectedPeer: {
        kind: "group" as const,
        id: "oc-group:topic:om_root_topic:sender:ou-topic-user",
      },
      expectedParentPeer: { kind: "group" as const, id: "oc-group" },
    },
  ])(
    "$name",
    async ({ scope, messageId, senderOpenId, text, message, expectedPeer, expectedParentPeer }) => {
      mockShouldComputeCommandAuthorized.mockReturnValue(false);
      await dispatchMessage({
        cfg: createFeishuTestConfig({
          groups: { "oc-group": { requireMention: false, groupSessionScope: scope } },
        }),
        event: createFeishuTestEvent({
          messageId,
          senderOpenId,
          chatId: "oc-group",
          chatType: "group",
          text,
          message,
        }),
      });

      expectResolvedRouteCall(0, expectedPeer, expectedParentPeer);
    },
  );

  it("uses thread_id as the canonical topic key in Feishu topic groups", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": { requireMention: false, groupSessionScope: "group_topic" },
      },
    });
    const topicStarter = createFeishuTestEvent({
      messageId: "om_topic_starter_message",
      senderOpenId: "ou-topic-user",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "topic starter",
      message: { root_id: "omt_topic_1" },
    });
    const topicReply = createFeishuTestEvent({
      messageId: "om_topic_reply_message",
      senderOpenId: "ou-topic-user",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "topic reply",
      message: { root_id: "om_topic_starter_message", thread_id: "omt_topic_1" },
    });

    await dispatchMessage({ cfg, event: topicStarter });
    await dispatchMessage({ cfg, event: topicReply });

    const starterRouteRequest = mockCallArg<{
      parentPeer?: { id?: string; kind?: string };
      peer?: { id?: string; kind?: string };
    }>(mockResolveAgentRoute, 0, 0);
    expect(starterRouteRequest.peer).toEqual({ kind: "group", id: "oc-group:topic:omt_topic_1" });
    expect(starterRouteRequest.parentPeer).toEqual({ kind: "group", id: "oc-group" });
    const replyRouteRequest = mockCallArg<{
      parentPeer?: { id?: string; kind?: string };
      peer?: { id?: string; kind?: string };
    }>(mockResolveAgentRoute, 1, 0);
    expect(replyRouteRequest.peer).toEqual({ kind: "group", id: "oc-group:topic:omt_topic_1" });
    expect(replyRouteRequest.parentPeer).toEqual({ kind: "group", id: "oc-group" });
  });

  it.each([
    {
      name: "uses thread_id as topic key when root_id is missing",
      cfg: createFeishuTestConfig({
        groups: {
          "oc-group": { requireMention: false, groupSessionScope: "group_topic_sender" },
        },
      }),
      messageId: "msg-scope-topic-thread-only",
      senderOpenId: "ou-topic-user",
      text: "topic sender scope",
      message: { thread_id: "omt_topic_1" },
      expectedPeer: {
        kind: "group" as const,
        id: "oc-group:topic:omt_topic_1:sender:ou-topic-user",
      },
    },
    {
      name: "maps legacy topicSessionMode=enabled to group_topic routing",
      cfg: createFeishuTestConfig({
        topicSessionMode: "enabled",
        groups: { "oc-group": { requireMention: false } },
      }),
      messageId: "msg-legacy-topic-mode",
      senderOpenId: "ou-legacy",
      text: "legacy topic mode",
      message: { root_id: "om_root_legacy" },
      expectedPeer: { kind: "group" as const, id: "oc-group:topic:om_root_legacy" },
    },
    {
      name: "maps legacy topicSessionMode=enabled to root_id when both root_id and thread_id exist",
      cfg: createFeishuTestConfig({
        topicSessionMode: "enabled",
        groups: { "oc-group": { requireMention: false } },
      }),
      messageId: "msg-legacy-topic-thread-id",
      senderOpenId: "ou-legacy-thread-id",
      text: "legacy topic mode",
      message: { root_id: "om_root_legacy", thread_id: "omt_topic_legacy" },
      expectedPeer: { kind: "group" as const, id: "oc-group:topic:om_root_legacy" },
    },
    {
      name: "uses message_id as topic root when group_topic + replyInThread and no root_id",
      cfg: createFeishuTestConfig({
        groups: {
          "oc-group": {
            requireMention: false,
            groupSessionScope: "group_topic",
            replyInThread: "enabled",
          },
        },
      }),
      messageId: "msg-new-topic-root",
      senderOpenId: "ou-topic-init",
      text: "create topic",
      message: {},
      expectedPeer: { kind: "group" as const, id: "oc-group:topic:msg-new-topic-root" },
    },
  ])("$name", async ({ cfg, messageId, senderOpenId, text, message, expectedPeer }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId,
        chatId: "oc-group",
        chatType: "group",
        text,
        message,
      }),
    });

    expectResolvedRouteCall(0, expectedPeer, { kind: "group", id: "oc-group" });
  });

  it("keeps topic session key stable after first turn creates a thread", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": {
          requireMention: false,
          groupSessionScope: "group_topic",
          replyInThread: "enabled",
        },
      },
    });
    const firstTurn = createFeishuTestEvent({
      messageId: "msg-topic-first",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "group",
      text: "create topic",
    });
    const secondTurn = createFeishuTestEvent({
      messageId: "msg-topic-second",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "group",
      text: "follow up in same topic",
      message: { root_id: "msg-topic-first", thread_id: "omt_topic_created" },
    });

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    expectResolvedRouteCall(0, { kind: "group", id: "oc-group:topic:msg-topic-first" });
    expectResolvedRouteCall(1, { kind: "group", id: "oc-group:topic:msg-topic-first" });
  });

  it("hydrates missing native topic thread_id before routing starter events", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "msg-native-topic-first",
      chatId: "oc-group",
      chatType: "topic_group",
      content: "topic starter",
      contentType: "text",
      threadId: "omt_native_topic",
    });

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": {
          requireMention: false,
          groupSessionScope: "group_topic",
          replyInThread: "enabled",
        },
      },
    });
    const firstTurn = createFeishuTestEvent({
      messageId: "msg-native-topic-first",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "create native topic",
    });
    const secondTurn = createFeishuTestEvent({
      messageId: "msg-native-topic-second",
      senderOpenId: "ou-topic-init",
      chatId: "oc-group",
      chatType: "topic_group",
      text: "follow up in same native topic",
      message: { thread_id: "omt_native_topic" },
    });

    await dispatchMessage({ cfg, event: firstTurn });
    await dispatchMessage({ cfg, event: secondTurn });

    const getMessageRequest = mockCallArg<{ messageId?: string }>(mockGetMessageFeishu, 0, 0);
    expect(getMessageRequest.messageId).toBe("msg-native-topic-first");
    expectResolvedRouteCall(0, { kind: "group", id: "oc-group:topic:omt_native_topic" });
    expectResolvedRouteCall(1, { kind: "group", id: "oc-group:topic:omt_native_topic" });
  });

  it.each([
    {
      name: "replies to the topic root when handling a message inside an existing topic",
      cfg: createFeishuTestConfig({
        groups: { "oc-group": { requireMention: false, replyInThread: "enabled" } },
      }),
      messageId: "om_child_message",
      senderOpenId: "ou-topic-user",
      rootId: "om_root_topic",
      text: "reply inside topic",
      expected: {
        replyToMessageId: "om_root_topic",
        rootId: "om_root_topic",
        typingTargetMessageId: "om_child_message",
      },
    },
    {
      name: "replies to triggering message in normal group even when root_id is present (#32980)",
      cfg: createFeishuTestConfig({
        groups: {
          "oc-group": { requireMention: false, groupSessionScope: "group" },
        },
      }),
      messageId: "om_quote_reply",
      senderOpenId: "ou-normal-user",
      rootId: "om_original_msg",
      text: "hello in normal group",
      expected: { replyToMessageId: "om_quote_reply", rootId: "om_original_msg" },
    },
    {
      name: "replies to topic root in topic-mode group with root_id",
      cfg: createFeishuTestConfig({
        groups: {
          "oc-group": { requireMention: false, groupSessionScope: "group_topic" },
        },
      }),
      messageId: "om_topic_reply",
      senderOpenId: "ou-topic-user",
      rootId: "om_topic_root",
      text: "hello in topic group",
      expected: {
        replyToMessageId: "om_topic_root",
        rootId: "om_topic_root",
        typingTargetMessageId: "om_topic_reply",
      },
    },
    {
      name: "replies to topic root in topic-sender group with root_id",
      cfg: createFeishuTestConfig({
        groups: {
          "oc-group": { requireMention: false, groupSessionScope: "group_topic_sender" },
        },
      }),
      messageId: "om_topic_sender_reply",
      senderOpenId: "ou-topic-sender-user",
      rootId: "om_topic_sender_root",
      text: "hello in topic sender group",
      expected: {
        replyToMessageId: "om_topic_sender_root",
        rootId: "om_topic_sender_root",
        typingTargetMessageId: "om_topic_sender_reply",
      },
    },
  ])("$name", async ({ cfg, messageId, senderOpenId, rootId, text, expected }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg,
      event: createFeishuTestEvent({
        messageId,
        senderOpenId,
        chatId: "oc-group",
        chatType: "group",
        text,
        message: { root_id: rootId },
      }),
    });

    const dispatcherOptions = mockCallArg<{
      replyToMessageId?: string;
      rootId?: string;
      typingTargetMessageId?: string;
    }>(mockCreateFeishuReplyDispatcher, 0, 0);
    expect(dispatcherOptions).toMatchObject(expected);
  });

  it("uses explicit synthetic typing targets without changing reply routing", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "synthetic-reaction-turn",
      senderOpenId: "ou-synthetic",
      chatId: "oc-synthetic-dm",
      text: "[reacted with THUMBSUP to message om_reply_anchor]",
      message: {
        typing_target_message_id: "om_reacted_message",
        reply_target_message_id: "om_reply_anchor",
      },
    });

    await dispatchMessage({ cfg, event });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_anchor",
        typingTargetMessageId: "om_reacted_message",
      }),
    );
  });

  it.each([
    {
      name: "keeps P2P replies inside a direct-message thread when Feishu supplies thread_id",
      messageId: "om_dm_thread_child",
      senderOpenId: "ou-thread-dm",
      chatId: "oc-dm-thread",
      rootId: "om_dm_thread_root",
      threadId: "omt_dm_thread",
      text: "hello inside a DM thread",
      expected: {
        replyToMessageId: "om_dm_thread_root",
        rootId: "om_dm_thread_root",
        skipReplyToInMessages: false,
        replyInThread: true,
        threadReply: true,
      },
    },
    {
      name: "keeps root_id-only P2P replies as quote replies outside thread mode",
      messageId: "om_dm_quote_reply",
      senderOpenId: "ou-quote-dm",
      chatId: "oc-dm-quote",
      rootId: "om_dm_quote_root",
      threadId: undefined,
      text: "quoted DM reply",
      expected: {
        replyToMessageId: "om_dm_quote_reply",
        rootId: "om_dm_quote_root",
        skipReplyToInMessages: true,
        replyInThread: false,
        threadReply: false,
      },
    },
  ])("$name", async ({ messageId, senderOpenId, chatId, rootId, threadId, text, expected }) => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    await dispatchMessage({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      event: createFeishuTestEvent({
        messageId,
        senderOpenId,
        chatId,
        text,
        message: {
          root_id: rootId,
          ...(threadId ? { thread_id: threadId } : {}),
        },
      }),
    });

    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it("forces thread replies when inbound message contains thread_id", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": {
          requireMention: false,
          groupSessionScope: "group",
          replyInThread: "disabled",
        },
      },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-thread-reply",
      senderOpenId: "ou-thread-reply",
      chatId: "oc-group",
      chatType: "group",
      text: "thread content",
      message: { thread_id: "omt_topic_thread_reply" },
    });

    await dispatchMessage({ cfg, event });

    const dispatcherOptions = mockCallArg<{ replyInThread?: boolean; threadReply?: boolean }>(
      mockCreateFeishuReplyDispatcher,
      0,
      0,
    );
    expect(dispatcherOptions.replyInThread).toBe(true);
    expect(dispatcherOptions.threadReply).toBe(true);
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

    const cfg = createFeishuTestConfig({
      groups: { "oc-group": { requireMention: false, groupSessionScope: "group_topic" } },
    });
    const event = createFeishuTestEvent({
      messageId: "om_topic_followup_existing_session",
      senderOpenId: "ou-topic-user",
      chatId: "oc-group",
      chatType: "group",
      text: "current turn",
      message: { root_id: "om_topic_root" },
    });

    await dispatchMessage({ cfg, event });

    expect(mockReadSessionUpdatedAt).toHaveBeenCalledWith({
      storePath: "/tmp/feishu-sessions.json",
      sessionKey: "agent:main:feishu:dm:ou-attacker",
    });
    const listRequest = mockCallArg<{ rootMessageId?: string }>(mockListFeishuThreadMessages, 0, 0);
    expect(listRequest.rootMessageId).toBe("om_topic_root");
    const context = mockCallArg<{
      MessageThreadId?: string;
      SupplementalContext?: {
        thread?: { historyBody?: string; label?: string; starterBody?: string };
      };
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.SupplementalContext?.thread?.starterBody).toBe("root starter");
    expect(context.SupplementalContext?.thread?.historyBody).toBe(
      "assistant reply\n\nfollow-up question",
    );
    expect(context.SupplementalContext?.thread?.label).toBe("Feishu thread in oc-group");
    expect(context.MessageThreadId).toBe("om_topic_root");
  });

  it("skips topic thread bootstrap when the thread session already exists", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockReadSessionUpdatedAt.mockReturnValue(1710000000000);

    const cfg = createFeishuTestConfig({
      groups: { "oc-group": { requireMention: false, groupSessionScope: "group_topic" } },
    });
    const event = createFeishuTestEvent({
      messageId: "om_topic_followup",
      senderOpenId: "ou-topic-user",
      chatId: "oc-group",
      chatType: "group",
      text: "current turn",
      message: { root_id: "om_topic_root" },
    });

    await dispatchMessage({ cfg, event });

    expect(mockGetMessageFeishu).not.toHaveBeenCalled();
    expect(mockListFeishuThreadMessages).not.toHaveBeenCalled();
    const context = mockCallArg<{
      MessageThreadId?: string;
      SupplementalContext?: {
        thread?: { historyBody?: string; label?: string; starterBody?: string };
      };
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.SupplementalContext?.thread?.starterBody).toBeUndefined();
    expect(context.SupplementalContext?.thread?.historyBody).toBeUndefined();
    expect(context.SupplementalContext?.thread?.label).toBe("Feishu thread in oc-group");
    expect(context.MessageThreadId).toBe("om_topic_root");
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

    const cfg = createFeishuTestConfig({
      groups: {
        "oc-group": { requireMention: false, groupSessionScope: "group_topic_sender" },
      },
    });
    const event = createFeishuTestEvent({
      messageId: "om_topic_followup_mixed_ids",
      senderOpenId: "ou-topic-user",
      senderUserId: "user_topic_1",
      chatId: "oc-group",
      chatType: "group",
      text: "current turn",
      message: { root_id: "om_topic_root" },
    });

    await dispatchMessage({ cfg, event });

    const context = mockCallArg<{
      MessageThreadId?: string;
      SupplementalContext?: {
        thread?: { historyBody?: string; label?: string; starterBody?: string };
      };
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.SupplementalContext?.thread?.starterBody).toBe("root starter");
    expect(context.SupplementalContext?.thread?.historyBody).toBe(
      "assistant reply\n\nfollow-up question",
    );
    expect(context.SupplementalContext?.thread?.label).toBe("Feishu thread in oc-group");
    expect(context.MessageThreadId).toBe("om_topic_root");
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

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groupSenderAllowFrom: ["ou-allowed"],
      contextVisibility: "allowlist",
      groups: { "oc-group": { requireMention: false, groupSessionScope: "group_topic" } },
    });
    const event = createFeishuTestEvent({
      messageId: "om_topic_followup_allowlisted",
      senderOpenId: "ou-allowed",
      chatId: "oc-group",
      chatType: "group",
      text: "current turn",
      message: { root_id: "om_topic_root", thread_id: "omt_topic_1" },
    });

    await dispatchMessage({ cfg, event });

    const context = mockCallArg<{
      SupplementalContext?: { thread?: { historyBody?: string; starterBody?: string } };
    }>(mockFinalizeInboundContext, 0, 0);
    expect(context.SupplementalContext?.thread?.starterBody).toBe("assistant reply");
    expect(context.SupplementalContext?.thread?.historyBody).toBe(
      "assistant reply\n\nallowed follow-up",
    );
  });

  it("does not dispatch twice for the same image message_id (concurrent dedupe)", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const event = createFeishuTestEvent({
      messageId: "msg-image-dedup",
      senderOpenId: "ou-image-dedup",
      messageType: "image",
      content: JSON.stringify({ image_key: "img_dedup_payload" }),
    });

    await Promise.all([dispatchMessage({ cfg, event }), dispatchMessage({ cfg, event })]);
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("dedupes Feishu media by message_id plus file_key", async () => {
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open" });
    const createAudioEvent = (fileKey: string): FeishuMessageEvent =>
      createFeishuTestEvent({
        messageId: "msg-audio-reused-id",
        senderOpenId: "ou-audio-dedup",
        messageType: "audio",
        content: JSON.stringify({ file_key: fileKey, duration: 1200 }),
      });

    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_first") });
    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_second") });
    await dispatchMessage({ cfg, event: createAudioEvent("file_audio_first") });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    expect(mockDownloadMessageResourceFeishu).toHaveBeenCalledTimes(2);
    const firstDownloadRequest = mockCallArg<{
      fileKey?: string;
      messageId?: string;
      type?: string;
    }>(mockDownloadMessageResourceFeishu, 0, 0);
    expect(firstDownloadRequest.messageId).toBe("msg-audio-reused-id");
    expect(firstDownloadRequest.fileKey).toBe("file_audio_first");
    expect(firstDownloadRequest.type).toBe("file");
    const secondDownloadRequest = mockCallArg<{
      fileKey?: string;
      messageId?: string;
      type?: string;
    }>(mockDownloadMessageResourceFeishu, 1, 0);
    expect(secondDownloadRequest.messageId).toBe("msg-audio-reused-id");
    expect(secondDownloadRequest.fileKey).toBe("file_audio_second");
    expect(secondDownloadRequest.type).toBe("file");
  });

  it("skips empty-text messages with no media to prevent blank user turns in session (#74634)", async () => {
    // Feishu can deliver { "text": "" } events (empty-text or media-stripped
    // messages). Writing blank user content to the session causes downstream
    // LLM providers such as MiniMax to reject requests with "messages must not
    // be empty". The handler should drop such events before queuing a reply.
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({ dmPolicy: "open", allowFrom: ["*"] });
    const event = createFeishuTestEvent({
      messageId: "msg-empty-text-74634",
      senderOpenId: "ou-empty-text-sender",
      text: "",
    });

    await dispatchMessage({ cfg, event });

    // No reply should be dispatched: empty message is silently skipped
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });

  it("does not drop empty-text message when it quotes a parent message (#90177)", async () => {
    // A Feishu reply containing only @bot (no additional text) was being
    // dropped before the quoted message content was fetched. The handler
    // should fetch quoted content first and only skip if all of current
    // text, media, and quoted content are empty.
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_quoted_001",
      chatId: "oc-dm",
      content: "quoted message content from parent",
      contentType: "text",
    });

    const cfg = createFeishuTestConfig({ dmPolicy: "open", allowFrom: ["*"] });
    const event = createFeishuTestEvent({
      messageId: "msg-empty-with-quote",
      senderOpenId: "ou-reply-only-bot",
      text: "",
      message: { parent_id: "om_quoted_001" },
    });

    await dispatchMessage({ cfg, event });

    // A reply should be dispatched because quoted content provides context
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
  });

  it("dispatches mention-only group reply with quoted content in requireMention:true group (#90177)", async () => {
    // #90177 is specifically about group chats. The empty-message drop happens
    // after the group admission/mention gate, so the fix must also work when
    // the sender mentions the bot in a requireMention:true group and quotes a
    // parent message with meaningful content — the reply should dispatch with
    // the quoted text in the body.
    mockShouldComputeCommandAuthorized.mockReturnValue(false);
    mockGetMessageFeishu.mockResolvedValueOnce({
      messageId: "om_group_quoted_001",
      chatId: "oc-group-90177",
      content: "parent message with context",
      contentType: "text",
    });

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groups: { "oc-group-90177": { requireMention: true } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-group-empty-with-quote",
      senderOpenId: "ou-group-sender",
      chatId: "oc-group-90177",
      chatType: "group",
      text: "",
      message: {
        parent_id: "om_group_quoted_001",
        mentions: [
          { key: "@_bot_1", id: { open_id: "ou-bot-90177" }, name: "Bot", tenant_key: "" },
        ],
      },
    });

    await dispatchMessage({ cfg, event, botOpenId: "ou-bot-90177" });

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const context = mockCallArg<{ Body?: string }>(mockFinalizeInboundContext, 0, 0);
    expect(context.Body).toContain("[Replying to:");
    expect(context.Body).toContain("parent message with context");
  });

  it("does not over-fetch quoted message for unmentioned empty reply in requireMention:true group (#90177)", async () => {
    // An empty-text reply that quotes a parent but does NOT mention the bot
    // in a requireMention:true group should be rejected at the mention gate
    // before the quoted message is fetched, so getMessageFeishu is never
    // called and nothing is dispatched.
    mockShouldComputeCommandAuthorized.mockReturnValue(false);

    const cfg = createFeishuTestConfig({
      groupPolicy: "open",
      groups: { "oc-group-90177-neg": { requireMention: true } },
    });
    const event = createFeishuTestEvent({
      messageId: "msg-group-unmentioned-empty-quote",
      senderOpenId: "ou-group-sender-neg",
      chatId: "oc-group-90177-neg",
      chatType: "group",
      text: "",
      message: { parent_id: "om_group_quoted_neg" },
    });

    await dispatchMessage({ cfg, event, botOpenId: "ou-bot-90177-neg" });

    expect(mockGetMessageFeishu).not.toHaveBeenCalled();
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
  });
});

describe("createFeishuMessageReceiveHandler media dedupe", () => {
  it("preserves the original dispatch dedupe key when debounce merges text content", async () => {
    const handleMessage = vi.fn(async () => undefined);
    const core = {
      channel: {
        debounce: {
          resolveInboundDebounceMs: vi.fn(() => 10),
          createInboundDebouncer: vi.fn(
            (options: { onFlush: (entries: FeishuMessageEvent[]) => Promise<void> | void }) => {
              const entries: FeishuMessageEvent[] = [];
              return {
                enqueue: async (event: FeishuMessageEvent) => {
                  entries.push(event);
                  if (entries.length === 2) {
                    await options.onFlush(entries);
                  }
                },
              };
            },
          ),
        },
        commands: {
          isControlCommandMessage: vi.fn(() => false),
        },
      },
    } as unknown as PluginRuntime;
    const createTextEvent = (messageId: string, createTime: string, text: string) =>
      createFeishuTestEvent({
        messageId,
        senderOpenId: "ou-text-debounce",
        text,
        message: { create_time: createTime },
      });
    const last = createTextEvent("msg-text-last", "1710000001000", "second");
    const handler = createFeishuMessageReceiveHandler({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      channelRuntime: core.channel,
      accountId: "receive-text-debounce",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: ({ event }) =>
        (JSON.parse(event.message.content) as { text: string }).text,
      hasProcessedMessage: vi.fn(async () => false),
    });

    await handler(createTextEvent("msg-text-first", "1710000000000", "first"));
    await handler(last);

    const call = mockCallArg<{
      event?: FeishuMessageEvent;
      messageDedupeKey?: string;
    }>(handleMessage, 0, 0);
    expect(call.event?.message.content).toBe(JSON.stringify({ text: "first\nsecond" }));
    expect(call.messageDedupeKey).toBe(resolveFeishuMessageDedupeKey(last));
    expect(resolveFeishuMessageDedupeKey(call.event as FeishuMessageEvent)).not.toBe(
      call.messageDedupeKey,
    );
  });

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
    const createAudioEvent = (fileKey: string): FeishuMessageEvent =>
      createFeishuTestEvent({
        messageId: "msg-audio-receive-reused-id",
        senderOpenId: "ou-audio-receive-dedup",
        messageType: "audio",
        content: JSON.stringify({ file_key: fileKey, duration: 1200 }),
      });
    const handler = createFeishuMessageReceiveHandler({
      cfg: createFeishuTestConfig({ dmPolicy: "open" }),
      channelRuntime: core.channel,
      accountId: "receive-media-dedupe",
      chatHistories: new Map(),
      handleMessage,
      resolveDebounceText: () => "",
      hasProcessedMessage: vi.fn(async () => false),
    });

    const firstEvent = createAudioEvent("file_audio_receive_first");
    const secondEvent = createAudioEvent("file_audio_receive_second");
    await handler(firstEvent);
    await handler(secondEvent);
    await handler(createAudioEvent("file_audio_receive_first"));

    expect(handleMessage).toHaveBeenCalledTimes(2);
    const firstCall = mockCallArg<{
      event?: FeishuMessageEvent;
      processingClaim?: { commit: () => Promise<boolean> };
    }>(handleMessage, 0, 0);
    expect(firstCall.event).toEqual(firstEvent);
    expect(firstCall.processingClaim?.commit).toBeTypeOf("function");
    const secondCall = mockCallArg<{
      event?: FeishuMessageEvent;
      processingClaim?: { commit: () => Promise<boolean> };
    }>(handleMessage, 1, 0);
    expect(secondCall.event).toEqual(secondEvent);
    expect(secondCall.processingClaim?.commit).toBeTypeOf("function");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
