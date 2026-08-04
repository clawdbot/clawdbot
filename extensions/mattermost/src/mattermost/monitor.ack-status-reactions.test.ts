// Mattermost tests cover automatic ack wiring end to end through the real inbound dispatch path.
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MattermostPost } from "./client.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import { monitorMattermostProvider } from "./monitor.js";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

class FakeWebSocket {
  public readonly sent: string[] = [];
  private readonly openListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private readonly closeListeners: Array<(code: number, reason: Buffer) => void> = [];
  private readonly errorListeners: Array<(err: unknown) => void> = [];

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void | Promise<void>): void;
  on(event: "pong", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: unknown) => void): void;
  on(event: "open" | "message" | "pong" | "close" | "error", listener: unknown): void {
    if (event === "open") {
      this.openListeners.push(listener as () => void);
      return;
    }
    if (event === "message") {
      this.messageListeners.push(listener as (data: Buffer) => void | Promise<void>);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    if (event === "error") {
      this.errorListeners.push(listener as (err: unknown) => void);
    }
  }

  send(): void {}
  ping(): void {}
  close(): void {}
  terminate(): void {
    this.emitClose(1000);
  }

  get openListenerCount(): number {
    return this.openListeners.length;
  }

  emitOpen(): void {
    for (const listener of this.openListeners) {
      listener();
    }
  }

  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(this.messageListeners.map((listener) => Promise.resolve(listener(buffer))));
  }

  emitClose(code: number, reason = ""): void {
    const buffer = Buffer.from(reason, "utf8");
    for (const listener of this.closeListeners) {
      listener(code, buffer);
    }
  }
}

const mockState = vi.hoisted(() => ({
  createMattermostClient: vi.fn(),
  createMattermostDraftStream: vi.fn(),
  dispatchInboundMessage: vi.fn(),
  createReplyDispatcherWithTyping: vi.fn(),
  fetchMattermostMe: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  recordMattermostThreadParticipation: vi.fn(),
  registerMattermostMonitorSlashCommands: vi.fn(),
  registerPluginHttpRoute: vi.fn(),
  resolveChannelInfo: vi.fn(),
  resolveMattermostMedia: vi.fn(),
  resolveUserInfo: vi.fn(),
  runtimeCore: undefined as unknown,
  sendMessageMattermost: vi.fn(),
  request: vi.fn(async () => ({})),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: mockState.getGlobalHookRunner,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    createReplyDispatcherWithTyping: (...args: unknown[]) =>
      mockState.createReplyDispatcherWithTyping(...args),
    dispatchInboundMessage: async (params: Parameters<typeof actual.dispatchInboundMessage>[0]) => {
      try {
        return await mockState.dispatchInboundMessage(params);
      } finally {
        await params.onSettled?.();
      }
    },
  };
});

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: mockState.createMattermostClient,
    fetchMattermostMe: mockState.fetchMattermostMe,
    normalizeMattermostBaseUrl: (value: string | undefined) => value?.trim() ?? "",
  };
});

vi.mock("./draft-stream.js", async () => {
  const actual = await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
  return {
    createMattermostDraftStream: mockState.createMattermostDraftStream,
    createMattermostDraftPreviewBoundaryController:
      actual.createMattermostDraftPreviewBoundaryController,
  };
});

vi.mock("./monitor-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor-resources.js")>()),
  createMattermostMonitorResources: () => ({
    resolveMattermostMedia: mockState.resolveMattermostMedia,
    sendTypingIndicator: vi.fn(async () => {}),
    resolveChannelInfo: mockState.resolveChannelInfo,
    resolveUserInfo: mockState.resolveUserInfo,
    updateModelPickerPost: vi.fn(async () => {}),
  }),
}));

vi.mock("./monitor-ingress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./monitor-ingress.js")>();
  return {
    ...actual,
    createMattermostIngressMonitor: (
      options: Parameters<typeof actual.createMattermostIngressMonitor>[0],
    ) => ({
      receive: async (rawEvent: string) => {
        const payload = JSON.parse(rawEvent) as MattermostEventPayload;
        const post =
          typeof payload.data?.post === "string"
            ? (JSON.parse(payload.data.post) as MattermostPost)
            : (payload.data?.post as MattermostPost | undefined);
        if (payload.event !== "posted" || !post) {
          return;
        }
        await options.dispatch(post, payload, {
          abortSignal: new AbortController().signal,
          onAdopted: async () => {},
          onDeferred: () => {},
          onAdoptionFinalizing: () => {},
          onAbandoned: async () => {},
        });
      },
      stop: async () => {},
      waitForIdle: async () => {},
    }),
  };
});

vi.mock("./monitor-slash.js", () => ({
  registerMattermostMonitorSlashCommands: mockState.registerMattermostMonitorSlashCommands,
}));

vi.mock("./thread-participation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./thread-participation.js")>()),
  recordMattermostThreadParticipation: mockState.recordMattermostThreadParticipation,
}));

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  return {
    ...actual,
    buildAgentMediaPayload: vi.fn(() => ({})),
    createChannelPairingController: vi.fn(() => ({
      readStoreForDmPolicy: vi.fn(async () => []),
      upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
    })),
    createChannelMessageReplyPipeline: vi.fn(() => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
      resolveResponsePrefix: () => undefined,
    })),
    registerPluginHttpRoute: mockState.registerPluginHttpRoute,
    resolveChannelMediaMaxBytes: vi.fn(() => 8 * 1024 * 1024),
    warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
  };
});

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageMattermost: mockState.sendMessageMattermost,
  };
});

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => mockState.runtimeCore,
  getOptionalMattermostRuntime: () => mockState.runtimeCore,
}));

function createRuntimeCore(cfg: OpenClawConfig) {
  type ReplyDispatcherOptions = {
    deliver: (payload: ReplyPayload, info: { kind: "tool" | "block" | "final" }) => Promise<void>;
  };
  mockState.createReplyDispatcherWithTyping.mockImplementation(
    (options: ReplyDispatcherOptions) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
      options,
    }),
  );
  const recordInboundSession = vi.fn(async (_turn?: unknown) => {});
  const dispatchPlanForTest = vi.fn(
    async (turn: {
      cfg: OpenClawConfig;
      channel: string;
      route: { agentId: string; sessionKey: string };
      ctxPayload: { SessionKey?: string };
      afterRecord?: () => void | Promise<void>;
      dispatcherOptions?: Record<string, unknown>;
      delivery: {
        observeMessageSent?: true;
        deliver: (
          payload: ReplyPayload,
          info: { kind: "tool" | "block" | "final" },
        ) => Promise<unknown>;
        onError?: unknown;
      };
      replyOptions?: Record<string, unknown>;
      record?: { onRecordError?: (err: unknown) => void };
    }) => {
      await recordInboundSession(turn);
      await turn.afterRecord?.();
      const prepared = mockState.createReplyDispatcherWithTyping({
        ...turn.dispatcherOptions,
        deliver: turn.delivery.deliver,
        onError: turn.delivery.onError,
      }) as { dispatcher: unknown; replyOptions?: Record<string, unknown> };
      const dispatchResult = await mockState.dispatchInboundMessage({
        ctx: turn.ctxPayload,
        cfg: turn.cfg,
        dispatcher: prepared.dispatcher,
        replyOptions: { ...prepared.replyOptions, ...turn.replyOptions },
        onSettled: undefined,
      });
      return {
        admission: { kind: "dispatch" as const },
        dispatched: true,
        ctxPayload: turn.ctxPayload,
        routeSessionKey: turn.route.sessionKey,
        dispatchResult,
      };
    },
  );
  const run = vi.fn(
    async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => unknown;
        resolveTurn: (
          input: unknown,
          eventClass: { kind: "message"; canStartAgentTurn: true },
          preflight: Record<string, never>,
        ) => Parameters<typeof dispatchPlanForTest>[0];
      };
    }) => {
      const input = params.adapter.ingest(params.raw);
      const turn = params.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      return await dispatchPlanForTest(turn);
    },
  );
  return {
    config: { current: () => cfg },
    logging: {
      shouldLogVerbose: () => false,
      getChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
    media: { mediaKindFromMime: () => "document" },
    system: { enqueueSystemEvent: vi.fn() },
    channel: {
      activity: { record: vi.fn() },
      commands: {
        isControlCommandMessage: () => false,
        shouldComputeCommandAuthorized: () => false,
        shouldHandleTextCommands: () => false,
      },
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: <T>(params: {
          onFlush: (
            entries: T[],
            createFlush: typeof createTestInboundDebounceFlush,
          ) => { completion: Promise<void> };
        }) => ({
          enqueue: async (entry: T) => {
            await params.onFlush([entry], createTestInboundDebounceFlush).completion;
          },
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        }),
      },
      groups: { resolveRequireMention: () => false },
      media: { readRemoteMediaBuffer: vi.fn(), saveMediaBuffer: vi.fn() },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
      pairing: { buildPairingReply: () => "pairing required" },
      reply: { settleReplyDispatcher: vi.fn(async ({ onSettled }) => onSettled?.()) },
      routing: {
        resolveAgentRoute: () => ({
          accountId: "default",
          agentId: "main",
          lastRoutePolicy: "main" as const,
          mainSessionKey: "mattermost:default:channel:chan-1",
          sessionKey: "mattermost:default:channel:chan-1",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-test-sessions.json",
        recordInboundSession,
        updateLastRoute: vi.fn(async () => {}),
      },
      inbound: { run },
      text: {
        chunkMarkdownTextWithMode: (text: string) => [text],
        convertMarkdownTables: (text: string) => text,
        hasControlCommand: () => false,
        resolveChunkMode: () => "length" as const,
        resolveMarkdownTableMode: () => "off" as const,
        resolveTextChunkLimit: () => 4000,
      },
    },
  };
}

const testRuntime = (): RuntimeEnv =>
  ({
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number): never => {
      throw new Error(`exit ${code}`);
    }) as RuntimeEnv["exit"],
  }) satisfies RuntimeEnv;

async function emitMattermostChannelPost(
  socket: FakeWebSocket,
  params: { id: string; message: string; senderId?: string },
) {
  const senderId = params.senderId ?? "user-1";
  await socket.emitMessage({
    event: "posted",
    data: {
      channel_id: "chan-1",
      channel_name: "town-square",
      channel_display_name: "Town Square",
      sender_name: "alice",
      post: JSON.stringify({
        id: params.id,
        channel_id: "chan-1",
        user_id: senderId,
        message: params.message,
        create_at: 1_714_000_000_000,
      }),
    },
    broadcast: { channel_id: "chan-1", user_id: senderId },
  });
}

const baseConfig: OpenClawConfig = {
  channels: {
    mattermost: {
      enabled: true,
      baseUrl: "https://mattermost.example.com",
      botToken: "bot-token",
      chatmode: "onmessage",
      dmPolicy: "open",
      groupPolicy: "open",
    },
  },
};

describe("mattermost ack reactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.getGlobalHookRunner.mockReturnValue(null);
    mockState.request.mockReset();
    mockState.request.mockImplementation(async () => ({}));
    mockState.createMattermostClient.mockReturnValue({ request: mockState.request });
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      forceNewMessage: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    mockState.fetchMattermostMe.mockResolvedValue({
      id: "bot-user",
      username: "openclaw",
      update_at: 1,
    });
    mockState.registerMattermostMonitorSlashCommands.mockResolvedValue(undefined);
    mockState.registerPluginHttpRoute.mockReturnValue(vi.fn());
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "chan-1",
      name: "town-square",
      display_name: "Town Square",
      team_id: "team-1",
      type: "O",
    });
    mockState.resolveMattermostMedia.mockResolvedValue([]);
    mockState.resolveUserInfo.mockResolvedValue({ id: "user-1", username: "alice" });
    mockState.sendMessageMattermost.mockResolvedValue({});
  });

  it("reacts with the ack emoji only after the accepted post is recorded", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const recordOrder: string[] = [];
    const config: OpenClawConfig = {
      ...baseConfig,
      messages: { ackReactionScope: "all" },
    };
    const runtimeCore = createRuntimeCore(config);
    runtimeCore.channel.session.recordInboundSession.mockImplementation(async () => {
      recordOrder.push("record");
    });
    mockState.runtimeCore = runtimeCore;
    mockState.request.mockImplementation(async () => {
      recordOrder.push("react");
      return {};
    });
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      abortController.abort();
      return { queuedFinal: false, counts: {} };
    });

    const monitor = monitorMattermostProvider({
      config,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, { id: "post-ack", message: "hello" });
    socket.emitClose(1000);
    await monitor;

    expect(recordOrder).toEqual(["record", "react"]);
    expect(mockState.request).toHaveBeenCalledExactlyOnceWith("/reactions", {
      method: "POST",
      body: JSON.stringify({ user_id: "bot-user", post_id: "post-ack", emoji_name: "eyes" }),
    });
  });

  it("does not react when durable session recording fails", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const config: OpenClawConfig = {
      ...baseConfig,
      messages: { ackReactionScope: "all" },
    };
    const runtimeCore = createRuntimeCore(config);
    runtimeCore.channel.session.recordInboundSession.mockRejectedValue(new Error("record failed"));
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, { id: "post-record-failed", message: "hello" });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.request).not.toHaveBeenCalled();
  });

  it("does not react at all under the default group-mentions scope without a mention", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const runtimeCore = createRuntimeCore(baseConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      abortController.abort();
      return { queuedFinal: false, counts: {} };
    });

    const monitor = monitorMattermostProvider({
      config: baseConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });
    await vi.waitFor(() => expect(socket.openListenerCount).toBeGreaterThan(0));
    socket.emitOpen();
    await emitMattermostChannelPost(socket, { id: "post-no-mention", message: "hello team" });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.request).not.toHaveBeenCalled();
  });
});
