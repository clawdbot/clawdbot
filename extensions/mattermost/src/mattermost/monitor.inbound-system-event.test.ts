// Mattermost tests cover monitor.inbound system event plugin behavior.
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createInboundDebouncer } from "openclaw/plugin-sdk/channel-inbound-debounce";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  createMessageReceiptFromOutboundResults,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { MattermostPost } from "./client.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import { monitorMattermostProvider } from "./monitor.js";
import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "./runtime-api.js";

class FakeWebSocket {
  public readonly sent: string[] = [];
  private readonly openListeners: Array<() => void> = [];
  private readonly messageListeners: Array<(data: Buffer) => void | Promise<void>> = [];
  private readonly pongListeners: Array<(data: Buffer) => void> = [];
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
    if (event === "pong") {
      this.pongListeners.push(listener as (data: Buffer) => void);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as (code: number, reason: Buffer) => void);
      return;
    }
    this.errorListeners.push(listener as (err: unknown) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

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

  emitError(err: unknown): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}

const mockState = vi.hoisted(() => ({
  abortController: undefined as AbortController | undefined,
  createReplyDispatcherWithTyping: vi.fn(),
  createMattermostClient: vi.fn(),
  createMattermostDraftStream: vi.fn(),
  deliveryPlanObserver: vi.fn(),
  dispatchInboundMessage: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  fetchMattermostMe: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  ingressQueue: undefined as unknown,
  progressDrafts: [] as Array<{ getSnapshot: () => { lines: readonly unknown[] } }>,
  registerMattermostMonitorSlashCommands: vi.fn(),
  registerPluginHttpRoute: vi.fn(),
  recordMattermostThreadParticipation: vi.fn(),
  resolveChannelInfo: vi.fn(),
  resolveMattermostMedia: vi.fn(),
  resolveUserInfo: vi.fn(),
  runtimeCore: undefined as unknown,
  sendMessageMattermost: vi.fn(),
  updateMattermostPost: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-runtime")>()),
  getGlobalHookRunner: mockState.getGlobalHookRunner,
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    createChannelProgressDraftCompositor: (
      ...args: Parameters<typeof actual.createChannelProgressDraftCompositor>
    ) => {
      const draft = actual.createChannelProgressDraftCompositor(...args);
      mockState.progressDrafts.push(draft);
      return draft;
    },
  };
});

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
    updateMattermostPost: mockState.updateMattermostPost,
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
    ) => {
      if (mockState.ingressQueue) {
        return actual.createMattermostIngressMonitor({
          ...options,
          queue: mockState.ingressQueue as NonNullable<typeof options.queue>,
          pollIntervalMs: 60_000,
        });
      }
      return {
        receive: async (rawEvent: string) => {
          const payload = JSON.parse(rawEvent) as MattermostEventPayload;
          const post =
            typeof payload.data?.post === "string"
              ? (JSON.parse(payload.data.post) as MattermostPost)
              : (payload.data?.post as MattermostPost | undefined);
          if (payload.event !== "posted" || !post) {
            return;
          }
          const senderId = post.user_id?.trim();
          if (!senderId) {
            throw new Error("Mattermost posted event is missing post.user_id");
          }
          await options.dispatch({ ...post, user_id: senderId }, payload, {
            abortSignal: new AbortController().signal,
            onAdopted: async () => {},
            onDeferred: () => {},
            onAdoptionFinalizing: () => {},
            onAbandoned: async () => {},
          });
        },
        stop: async () => {},
        waitForIdle: async () => {},
      };
    },
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
    createChannelMessageReplyPipeline: vi.fn((params: { cfg: OpenClawConfig }) => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
      resolveResponsePrefix: () => params.cfg.channels?.mattermost?.responsePrefix,
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

function createRuntimeCore(
  cfg: OpenClawConfig,
  routeOverride?: {
    accountId?: string;
    agentId?: string;
    lastRoutePolicy?: "main" | "session";
    mainSessionKey?: string;
    sessionKey?: string;
  },
  overrides: {
    inboundDebounceMs?: number;
    isControlCommandMessage?: (text?: string) => boolean;
    shouldComputeCommandAuthorized?: (text?: string) => boolean;
    shouldHandleTextCommands?: () => boolean;
    textHasControlCommand?: (text?: string) => boolean;
    createInboundDebouncer?: typeof createInboundDebouncer;
    verboseDebug?: (message: string) => void;
    chunkMarkdownTextWithMode?: (
      text: string,
      limit: number,
      mode: "length" | "newline",
    ) => string[];
    chunkMode?: "length" | "newline";
    textChunkLimit?: number;
  } = {},
) {
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
  type RecordInboundSessionInput = {
    storePath: string;
    sessionKey: string;
    ctx: unknown;
    createIfMissing?: boolean;
    groupResolution?: unknown;
    onRecordError?: (error: unknown) => void;
    updateLastRoute?: {
      accountId?: string;
      channel?: string;
      mainDmOwnerPin?: {
        onSkip?: () => void;
        ownerRecipient?: string;
        senderRecipient?: string;
      };
      sessionKey?: string;
      to?: string;
    };
  };
  const recordInboundSession = vi.fn(async (_params: RecordInboundSessionInput) => {});
  const dispatchPlanForTest = vi.fn(
    async (turn: {
      cfg: OpenClawConfig;
      channel: string;
      route: { agentId: string; sessionKey: string };
      ctxPayload: { SessionKey?: string };
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
      record?: {
        groupResolution?: unknown;
        createIfMissing?: boolean;
        updateLastRoute?: RecordInboundSessionInput["updateLastRoute"];
        onRecordError?: (err: unknown) => void;
      };
    }) => {
      mockState.deliveryPlanObserver(turn.delivery.observeMessageSent);
      await recordInboundSession({
        storePath: "/tmp/openclaw-test-sessions.json",
        sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
        ctx: turn.ctxPayload,
        groupResolution: turn.record?.groupResolution,
        createIfMissing: turn.record?.createIfMissing,
        updateLastRoute: turn.record?.updateLastRoute,
        onRecordError: turn.record?.onRecordError ?? (() => undefined),
      });
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
        onSettled: turn.dispatcherOptions?.onSettled,
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
    config: {
      current: () => cfg,
    },
    logging: {
      shouldLogVerbose: () => Boolean(overrides.verboseDebug),
      getChildLogger: () => ({
        debug: overrides.verboseDebug ?? vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    },
    media: {
      mediaKindFromMime: () => "document",
    },
    system: {
      enqueueSystemEvent: mockState.enqueueSystemEvent,
    },
    channel: {
      activity: {
        record: vi.fn(),
      },
      commands: {
        isControlCommandMessage: overrides.isControlCommandMessage ?? (() => false),
        shouldComputeCommandAuthorized: overrides.shouldComputeCommandAuthorized ?? (() => false),
        shouldHandleTextCommands: overrides.shouldHandleTextCommands ?? (() => false),
      },
      debounce: {
        resolveInboundDebounceMs: () => overrides.inboundDebounceMs ?? 0,
        createInboundDebouncer:
          overrides.createInboundDebouncer ??
          (<T>(params: {
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
          })),
      },
      groups: {
        resolveRequireMention: (params: { requireMentionOverride?: boolean }) =>
          params.requireMentionOverride ?? false,
      },
      media: {
        readRemoteMediaBuffer: vi.fn(),
        saveMediaBuffer: vi.fn(),
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: () => false,
      },
      pairing: {
        buildPairingReply: () => "pairing required",
      },
      reply: {
        settleReplyDispatcher: vi.fn(async ({ onSettled }) => onSettled?.()),
      },
      routing: {
        resolveAgentRoute: () => ({
          accountId: routeOverride?.accountId ?? "default",
          agentId: routeOverride?.agentId ?? "main",
          lastRoutePolicy: routeOverride?.lastRoutePolicy ?? "main",
          mainSessionKey: routeOverride?.mainSessionKey ?? "mattermost:default:channel:chan-1",
          sessionKey: routeOverride?.sessionKey ?? "mattermost:default:channel:chan-1",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/openclaw-test-sessions.json",
        recordInboundSession,
        updateLastRoute: vi.fn(async () => {}),
      },
      inbound: {
        run,
      },
      text: {
        chunkMarkdownTextWithMode:
          overrides.chunkMarkdownTextWithMode ?? ((text: string) => [text]),
        convertMarkdownTables: (text: string) => text,
        hasControlCommand: overrides.textHasControlCommand ?? (() => false),
        resolveChunkMode: () => overrides.chunkMode ?? "length",
        resolveMarkdownTableMode: () => "off",
        resolveTextChunkLimit: () => overrides.textChunkLimit ?? 4000,
      },
    },
  };
}

const testConfig: OpenClawConfig = {
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

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => mockState.runtimeCore,
  getOptionalMattermostRuntime: () => mockState.runtimeCore,
}));

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
  params: {
    id: string;
    message: string;
    channelId?: string;
    rootId?: string;
    senderId?: string;
    senderName?: string;
    createAt?: number;
    type?: string;
  },
) {
  const senderId = params.senderId ?? "user-1";
  const channelId = params.channelId ?? "chan-1";
  await socket.emitMessage({
    event: "posted",
    data: {
      channel_id: channelId,
      channel_name: "town-square",
      channel_display_name: "Town Square",
      sender_name: params.senderName ?? "alice",
      post: JSON.stringify({
        id: params.id,
        channel_id: channelId,
        user_id: senderId,
        message: params.message,
        root_id: params.rootId,
        create_at: params.createAt ?? 1_714_000_000_000,
        type: params.type,
      }),
    },
    broadcast: {
      channel_id: channelId,
      user_id: senderId,
    },
  });
}

describe("mattermost inbound user posts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.abortController = undefined;
    mockState.ingressQueue = undefined;
    mockState.progressDrafts.length = 0;
    mockState.getGlobalHookRunner.mockReturnValue(null);
    mockState.runtimeCore = createRuntimeCore(testConfig);
    mockState.createMattermostClient.mockReturnValue({});
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      flush: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
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
    mockState.dispatchInboundMessage.mockImplementation(async () => {
      mockState.abortController?.abort();
    });
  });

  it("preserves abandon retry accounting, backoff, threshold, and restart behavior", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 0, 2);
    vi.setSystemTime(now);
    const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mattermost-abandon-"));
    const stateDir = await fs.realpath(created);
    type Payload = { version: 1; receivedAt: number; rawEvent: string };
    const queue = createChannelIngressQueueForTests<Payload>({
      channelId: "mattermost",
      accountId: "default",
      stateDir,
    });
    mockState.ingressQueue = queue;
    mockState.runtimeCore = createRuntimeCore(testConfig, undefined, {
      inboundDebounceMs: 0,
      createInboundDebouncer,
    });
    mockState.dispatchInboundMessage.mockRejectedValue(
      new Error("Mattermost dispatch failed before adoption"),
    );

    const activeProviders: Array<{ stop: () => Promise<void> }> = [];
    const startProvider = async () => {
      const socket = new FakeWebSocket();
      const abortController = new AbortController();
      const monitor = monitorMattermostProvider({
        config: testConfig,
        runtime: testRuntime(),
        abortSignal: abortController.signal,
        webSocketFactory: () => socket,
      });
      for (let tick = 0; tick < 20 && socket.openListenerCount === 0; tick += 1) {
        await Promise.resolve();
      }
      expect(socket.openListenerCount).toBeGreaterThan(0);
      socket.emitOpen();
      let stopped = false;
      const provider = {
        socket,
        stop: async () => {
          if (stopped) {
            return;
          }
          stopped = true;
          abortController.abort();
          socket.emitClose(1000);
          await monitor;
        },
      };
      activeProviders.push(provider);
      return provider;
    };
    const send = async (provider: Awaited<ReturnType<typeof startProvider>>) => {
      await emitMattermostChannelPost(provider.socket, {
        id: "post-abandon-retry",
        message: "retry me",
      });
    };
    const pendingAttempt = async (attempts: number) => {
      let observed: Awaited<ReturnType<typeof queue.listPending>>[number] | undefined;
      await vi.waitFor(async () => {
        const pending = await queue.listPending({ limit: "all" });
        expect(pending).toEqual([
          expect.objectContaining({
            id: "post-abandon-retry",
            attempts,
            lastAttemptAt: expect.any(Number),
            lastError: "turn-abandoned",
          }),
        ]);
        observed = pending[0];
      });
      const lastAttemptAt = observed?.lastAttemptAt;
      if (lastAttemptAt === undefined) {
        throw new Error(`Missing Mattermost retry timestamp for attempt ${attempts}`);
      }
      return { ...observed, lastAttemptAt };
    };

    try {
      const first = await startProvider();
      await send(first);
      const firstAttempt = await pendingAttempt(1);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
      await first.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 999);
      const blocked = await startProvider();
      await send(blocked);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
      await blocked.stop();

      vi.setSystemTime(firstAttempt.lastAttemptAt + 1_001);
      const second = await startProvider();
      await send(second);
      const secondAttempt = await pendingAttempt(2);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(2);
      await second.stop();

      for (let attempt = 3; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await queue.claim("post-abandon-retry", { ownerId: `seed-${attempt}` });
        if (!claim) {
          throw new Error(`Expected Mattermost seed claim ${attempt}`);
        }
        await queue.release(claim, {
          lastError: "turn-abandoned",
          releasedAt: secondAttempt.lastAttemptAt,
        });
      }

      vi.setSystemTime(secondAttempt.lastAttemptAt + 64_001);
      const threshold = await startProvider();
      await send(threshold);
      const thresholdAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(3);
      await threshold.stop();

      vi.setSystemTime(thresholdAttempt.lastAttemptAt + 128_001);
      const beyond = await startProvider();
      await send(beyond);
      const beyondAttempt = await pendingAttempt(DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS + 1);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(4);
      await beyond.stop();

      vi.setSystemTime(beyondAttempt.lastAttemptAt + 1_000);
      const blockedRestart = await startProvider();
      await send(blockedRestart);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(4);
      await blockedRestart.stop();
    } finally {
      await Promise.allSettled(activeProviders.map(async (provider) => await provider.stop()));
      mockState.ingressQueue = undefined;
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("publishes recovering while API authentication retries, including 401", async () => {
    const abortController = new AbortController();
    const statusSink = vi.fn();
    mockState.fetchMattermostMe.mockRejectedValue(new Error("HTTP 401 Unauthorized"));

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      statusSink,
    });

    await vi.waitFor(() => {
      expect(statusSink).toHaveBeenCalledWith({
        connected: false,
        lifecycle: "recovering",
        lastError: "Error: HTTP 401 Unauthorized",
      });
    });
    abortController.abort();
    await monitor;
  });

  it("rejects startup before opening the websocket when interactions cannot bind", async () => {
    const statusSink = vi.fn();
    const webSocketFactory = vi.fn(() => new FakeWebSocket());
    mockState.registerPluginHttpRoute.mockImplementationOnce(() => {
      throw new Error("Mattermost interactions route conflict");
    });

    await expect(
      monitorMattermostProvider({
        config: testConfig,
        runtime: testRuntime(),
        abortSignal: new AbortController().signal,
        statusSink,
        webSocketFactory,
      }),
    ).rejects.toThrow("Mattermost interactions route conflict");

    expect(mockState.registerPluginHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        pluginId: "mattermost",
        source: "mattermost-interactions",
        throwOnFailure: true,
      }),
    );
    expect(mockState.registerPluginHttpRoute.mock.calls[0]?.[0]).not.toHaveProperty(
      "replaceExisting",
    );
    expect(mockState.registerMattermostMonitorSlashCommands).not.toHaveBeenCalled();
    expect(webSocketFactory).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it("unregisters interactions when slash command startup rejects", async () => {
    const unregisterInteractions = vi.fn();
    const statusSink = vi.fn();
    const webSocketFactory = vi.fn(() => new FakeWebSocket());
    mockState.registerPluginHttpRoute.mockReturnValueOnce(unregisterInteractions);
    mockState.registerMattermostMonitorSlashCommands.mockRejectedValueOnce(
      new Error("Mattermost slash setup failed"),
    );

    await expect(
      monitorMattermostProvider({
        config: testConfig,
        runtime: testRuntime(),
        abortSignal: new AbortController().signal,
        statusSink,
        webSocketFactory,
      }),
    ).rejects.toThrow("Mattermost slash setup failed");

    expect(unregisterInteractions).toHaveBeenCalledOnce();
    expect(webSocketFactory).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it.each([
    {
      label: "plain text",
      fileIds: [],
      failedMedia: [],
      expectedBody: "hello from mattermost",
    },
    {
      label: "an unavailable named attachment",
      fileIds: ["file-1"],
      failedMedia: [
        {
          contentType: "application/pdf",
          fileName: "quarterly report.pdf",
          kind: "document",
        },
      ],
      expectedBody:
        'hello from mattermost\n\n[mattermost attachment unavailable] "quarterly report.pdf"',
    },
  ])(
    "does not enqueue regular posts with $label as system events",
    async ({ fileIds, failedMedia, expectedBody }) => {
      const socket = new FakeWebSocket();
      const abortController = new AbortController();
      mockState.abortController = abortController;
      mockState.resolveMattermostMedia.mockResolvedValueOnce(failedMedia);

      const monitor = monitorMattermostProvider({
        config: testConfig,
        runtime: testRuntime(),
        abortSignal: abortController.signal,
        webSocketFactory: () => socket,
      });

      await vi.waitFor(() => {
        expect(socket.openListenerCount).toBeGreaterThan(0);
      });
      socket.emitOpen();

      await socket.emitMessage({
        event: "posted",
        data: {
          channel_id: "chan-1",
          channel_name: "town-square",
          channel_display_name: "Town Square",
          sender_name: "alice",
          post: JSON.stringify({
            id: "post-inbound-system-event-regular",
            channel_id: "chan-1",
            user_id: "user-1",
            message: "hello from mattermost",
            ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
            create_at: 1_714_000_000_000,
          }),
        },
        broadcast: {
          channel_id: "chan-1",
          user_id: "user-1",
        },
      });
      socket.emitClose(1000);
      await monitor;

      expect(mockState.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
      expect(mockState.deliveryPlanObserver).toHaveBeenCalledExactlyOnceWith(true);
      const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
      expect(ctx?.BodyForAgent).toBe(expectedBody);
      if (failedMedia.length > 0) {
        expect(ctx?.media).toEqual([
          expect.objectContaining({
            contentType: "application/pdf",
            fileName: "quarterly report.pdf",
          }),
        ]);
        expect(ctx?.media?.[0]?.path).toBeUndefined();
        expect(ctx?.media?.[0]?.url).toBeUndefined();
      }
      expect(ctx?.ConversationLabel).toBe("Town Square id:chan-1");
      expect(ctx?.MessageSid).toBe("post-inbound-system-event-regular");
      expect(ctx?.ConversationRouteContextObserved).toBe(true);
      expect(ctx?.ConversationRoutePeerId).toBe("chan-1");
      expect(ctx?.GroupSpace).toBe("team-1");
      expect(ctx?.NativeChannelId).toBe("chan-1");
      expect(ctx?.InboundAccessAuthorized).toBe(true);
      expect(ctx?.OriginatingChannel).toBe("mattermost");
      expect(ctx?.Provider).toBe("mattermost");
    },
  );

  it("formats current and pending-history timestamps in the configured user timezone", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          envelopeTimezone: "user",
          userTimezone: "Asia/Jakarta",
        },
      },
      messages: { groupChat: { historyLimit: 1 } },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "allowlist",
          groupAllowFrom: ["allowed-user"],
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(config);

    const monitor = monitorMattermostProvider({
      config,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "timezone-history",
      message: "history in Jakarta",
      senderId: "denied-user",
      senderName: "mallory",
      createAt: 1_714_000_000_000,
    });
    await emitMattermostChannelPost(socket, {
      id: "timezone-current",
      message: "current in Jakarta",
      senderId: "allowed-user",
      senderName: "alice",
      createAt: 1_714_003_600_000,
    });
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.Body).toContain("Thu 2024-04-25 06:06:40");
    expect(ctx?.Body).toContain("Thu 2024-04-25 07:06:40");
    expect(ctx?.Body).toContain("history in Jakarta");
    expect(ctx?.Body).toContain("current in Jakarta");
  });

  it.each([
    {
      name: "default visibility",
      contextVisibility: undefined,
      expectedHistory: ["denied second", "denied third"],
    },
    {
      name: "explicit all visibility",
      contextVisibility: "all",
      expectedHistory: ["denied second", "denied third"],
    },
    {
      name: "allowlist visibility",
      contextVisibility: "allowlist",
      expectedHistory: [],
    },
    {
      name: "allowlist quote visibility",
      contextVisibility: "allowlist_quote",
      expectedHistory: [],
    },
  ] as const)(
    "keeps denied group history bounded and policy-safe with $name",
    async ({ contextVisibility, expectedHistory }) => {
      const socket = new FakeWebSocket();
      const abortController = new AbortController();
      mockState.abortController = abortController;
      const config: OpenClawConfig = {
        messages: { groupChat: { historyLimit: 2 } },
        channels: {
          ...(contextVisibility ? { defaults: { contextVisibility } } : {}),
          mattermost: {
            enabled: true,
            baseUrl: "https://mattermost.example.com",
            botToken: "bot-token",
            chatmode: "onmessage",
            dmPolicy: "open",
            groupPolicy: "allowlist",
            groupAllowFrom: ["allowed-user"],
          },
        },
      };
      const isControlCommandMessage = vi.fn((text?: string) => text?.trim() === "/reset");
      const runtimeCore = createRuntimeCore(config, undefined, {
        isControlCommandMessage,
        shouldHandleTextCommands: () => true,
      });
      mockState.runtimeCore = runtimeCore;

      const monitor = monitorMattermostProvider({
        config,
        runtime: testRuntime(),
        abortSignal: abortController.signal,
        webSocketFactory: () => socket,
      });

      await vi.waitFor(() => {
        expect(socket.openListenerCount).toBeGreaterThan(0);
      });
      socket.emitOpen();

      for (const [index, message] of ["/reset", "denied second", "denied third"].entries()) {
        await emitMattermostChannelPost(socket, {
          id: `denied-history-${index}`,
          message,
          senderId: "denied-user",
          senderName: "mallory",
        });
        expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
        expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
        expect(mockState.createReplyDispatcherWithTyping).not.toHaveBeenCalled();
        expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
      }

      await emitMattermostChannelPost(socket, {
        id: "allowed-history-request",
        message: "summarize the conversation",
        senderId: "allowed-user",
        senderName: "alice",
      });
      socket.emitClose(1000);
      await monitor;

      expect(isControlCommandMessage).toHaveBeenCalledWith("/reset", config);
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
      expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
      expect(mockState.createReplyDispatcherWithTyping).toHaveBeenCalledTimes(1);
      const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
      expect(ctx?.SenderId).toBe("allowed-user");
      expect(ctx?.BodyForAgent).toBe("summarize the conversation");
      expect(ctx?.CommandSource).toBeUndefined();
      expect(ctx?.InboundHistory?.map((entry: { body: string }) => entry.body) ?? []).toEqual(
        expectedHistory,
      );
      expect(ctx?.Body).not.toContain("/reset");
      for (const history of expectedHistory) {
        expect(ctx?.Body).toContain(history);
      }
      if (expectedHistory.length === 0) {
        expect(ctx?.Body).not.toContain("denied second");
        expect(ctx?.Body).not.toContain("denied third");
      }
    },
  );

  it.each([
    { name: "default visibility", contextVisibility: undefined, expectedHistory: true },
    { name: "allowlist visibility", contextVisibility: "allowlist", expectedHistory: false },
  ] as const)(
    "preserves denied history policy over authenticated Mattermost HTTP and WebSocket with $name",
    async ({ contextVisibility, expectedHistory }) => {
      const token = "mattermost-loopback-proof-token";
      const requests: Array<{ path: string; authorization?: string }> = [];
      const server = createServer((request, response) => {
        requests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
        });
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401);
          response.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        if (request.url === "/api/v4/users/me") {
          response.end(JSON.stringify({ id: "bot-user", username: "openclaw", update_at: 1 }));
          return;
        }
        if (request.url === "/api/v4/channels/chan-1") {
          response.end(
            JSON.stringify({
              id: "chan-1",
              name: "town-square",
              display_name: "Town Square",
              team_id: "team-1",
              type: "O",
            }),
          );
          return;
        }
        response.writeHead(404);
        response.end(JSON.stringify({ message: "unknown loopback endpoint" }));
      });
      const websocket = new WebSocketServer({ server, path: "/api/v4/websocket" });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a Mattermost loopback TCP address");
      }

      const abortController = new AbortController();
      mockState.abortController = abortController;
      const verboseDebug = vi.fn();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const config: OpenClawConfig = {
        messages: { groupChat: { historyLimit: 2 } },
        channels: {
          ...(contextVisibility ? { defaults: { contextVisibility } } : {}),
          mattermost: {
            enabled: true,
            baseUrl,
            botToken: token,
            chatmode: "onmessage",
            dmPolicy: "open",
            groupPolicy: "allowlist",
            groupAllowFrom: ["allowed-user"],
            network: { dangerouslyAllowPrivateNetwork: true },
          },
        },
      };
      const runtimeCore = createRuntimeCore(config, undefined, { verboseDebug });
      mockState.runtimeCore = runtimeCore;
      const actualClient = await vi.importActual<typeof import("./client.js")>("./client.js");
      mockState.createMattermostClient.mockImplementation(actualClient.createMattermostClient);
      mockState.fetchMattermostMe.mockImplementation(actualClient.fetchMattermostMe);
      mockState.resolveChannelInfo.mockImplementation(async (channelId: string) => {
        const client = mockState.createMattermostClient.mock.results.at(-1)?.value;
        if (!client) {
          throw new Error("expected the production Mattermost HTTP client");
        }
        return await actualClient.fetchMattermostChannel(client, channelId);
      });

      const connection = once(websocket, "connection");
      let monitor: Promise<void> | undefined;
      try {
        monitor = monitorMattermostProvider({
          config,
          runtime: testRuntime(),
          abortSignal: abortController.signal,
        });
        const [socket] = await connection;
        const [rawAuthentication] = await once(socket, "message");
        expect(JSON.parse(String(rawAuthentication))).toMatchObject({
          action: "authentication_challenge",
          data: { token },
        });

        const sendPost = (params: { id: string; message: string; senderId: string }) => {
          socket.send(
            JSON.stringify({
              event: "posted",
              data: {
                channel_id: "chan-1",
                channel_name: "town-square",
                channel_display_name: "Town Square",
                sender_name: params.senderId === "allowed-user" ? "alice" : "mallory",
                post: JSON.stringify({
                  id: params.id,
                  channel_id: "chan-1",
                  user_id: params.senderId,
                  message: params.message,
                  create_at: 1_714_000_000_000,
                }),
              },
              broadcast: { channel_id: "chan-1", user_id: params.senderId },
            }),
          );
        };

        for (const [index, message] of ["denied first", "denied second"].entries()) {
          sendPost({
            id: `loopback-denied-${index}`,
            message,
            senderId: "denied-user",
          });
          await vi.waitFor(() => {
            const drops = verboseDebug.mock.calls.filter(([line]) =>
              String(line).includes("drop group sender=denied-user"),
            );
            expect(drops).toHaveLength(index + 1);
          });
          expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
          expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
          expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
        }

        sendPost({
          id: "loopback-allowed",
          message: "summarize the conversation",
          senderId: "allowed-user",
        });
        await vi.waitFor(() => {
          expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
        });

        const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
        expect(ctx?.SenderId).toBe("allowed-user");
        expect(ctx?.BodyForAgent).toBe("summarize the conversation");
        expect(ctx?.InboundHistory?.map((entry: { body: string }) => entry.body) ?? []).toEqual(
          expectedHistory ? ["denied first", "denied second"] : [],
        );
        expect(requests.length).toBeGreaterThanOrEqual(4);
        expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true);
        expect(requests.some((request) => request.path === "/api/v4/users/me")).toBe(true);
        expect(requests.some((request) => request.path === "/api/v4/channels/chan-1")).toBe(true);
      } finally {
        abortController.abort();
        for (const client of websocket.clients) {
          client.terminate();
        }
        if (monitor) {
          await monitor;
        }
        await new Promise<void>((resolve, reject) => {
          websocket.close((error) => (error ? reject(error) : resolve()));
        });
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("keeps verbose inbound previews on complete UTF-16 boundaries", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const verboseDebug = vi.fn();
    mockState.abortController = abortController;
    mockState.runtimeCore = createRuntimeCore(testConfig, undefined, { verboseDebug });

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-verbose-preview",
          channel_id: "chan-1",
          user_id: "user-1",
          message: `${"a".repeat(199)}😀tail`,
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(verboseDebug).toHaveBeenCalledWith(
      `mattermost inbound: from=mattermost:channel:chan-1 len=205 preview="${"a".repeat(199)}"`,
    );
  });

  it("dispatches a bare bot mention whose body is empty after normalization as a wake event", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-bare-mention",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "@openclaw",
          create_at: 1_714_000_000_001,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("@openclaw");
    expect(ctx?.MessageSid).toBe("post-bare-mention");
    expect(ctx?.OriginatingChannel).toBe("mattermost");
    expect(ctx?.Provider).toBe("mattermost");
  });

  it.each(
    [
      { message: "@openclawdia hello", expectedBody: null },
      { message: "@openclaw:remote.example hello", expectedBody: null },
      { message: "hello.@openclaw", expectedBody: "hello." },
      { message: "hello-@openclaw", expectedBody: "hello-" },
      { message: "hello:@openclaw", expectedBody: "hello:" },
      { message: "@openclaw.", expectedBody: "." },
      { message: "@openclaw-", expectedBody: "-" },
      { message: "@openclaw: hello", expectedBody: ": hello" },
    ].map(({ message, expectedBody }, index) => ({
      message,
      expectedBody,
      channelId: `mention-boundary-${index}`,
    })),
  )(
    "dispatches only genuine mention-required posts: $message",
    async ({ message, expectedBody, channelId }) => {
      const socket = new FakeWebSocket();
      const abortController = new AbortController();
      mockState.abortController = abortController;
      const runtime = testRuntime();
      const config: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            baseUrl: "https://mattermost.example.com",
            botToken: "bot-token",
            // No chatmode: "onmessage" would force requireMention off (accounts.ts).
            dmPolicy: "open",
            groupPolicy: "open",
            requireMention: true,
          },
        },
      };
      mockState.runtimeCore = createRuntimeCore(config);

      const monitor = monitorMattermostProvider({
        config,
        runtime,
        abortSignal: abortController.signal,
        webSocketFactory: () => socket,
      });

      await vi.waitFor(() => {
        expect(socket.openListenerCount).toBeGreaterThan(0);
      });
      socket.emitOpen();

      await emitMattermostChannelPost(socket, {
        id: "post-mention-boundary",
        message,
        channelId,
      });

      if (expectedBody === null) {
        await vi.waitFor(() => {
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(`mattermost: drop no mention target=${channelId}`),
          );
        });
        expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
      } else {
        expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
        expect(mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx.BodyForAgent).toBe(
          expectedBody,
        );
        expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("drop no mention"));
      }
      abortController.abort();
      socket.emitClose(1000);
      await monitor;
    },
  );

  it.each([undefined, false, true])(
    "keeps Mattermost progress useful and clears after delivery with toolProgress=%s",
    async (toolProgress) => {
      const socket = new FakeWebSocket();
      const abortController = new AbortController();
      mockState.abortController = abortController;
      const draftStream = {
        update: vi.fn(),
        flush: vi.fn(async () => {}),
        clear: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      mockState.createMattermostDraftStream.mockReturnValue(draftStream);
      const progressConfig: OpenClawConfig = {
        channels: {
          mattermost: {
            enabled: true,
            baseUrl: "https://mattermost.example.com",
            botToken: "bot-token",
            chatmode: "onmessage",
            dmPolicy: "open",
            groupPolicy: "open",
            streaming: {
              mode: "progress",
              progress: {
                label: "Working",
                toolProgress,
              },
            },
          },
        },
      };
      mockState.runtimeCore = createRuntimeCore(progressConfig);
      mockState.dispatchInboundMessage.mockImplementation(async (params) => {
        await params.replyOptions?.onToolStart?.({
          toolCallId: "read-1",
          name: "read",
          phase: "start",
        });
        params.replyOptions?.onAssistantMessageStart?.();
        params.replyOptions?.onReasoningEnd?.();
        await params.replyOptions?.onToolStart?.({
          toolCallId: "exec-1",
          name: "exec",
          phase: "start",
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool:read-1",
          kind: "tool",
          name: "read",
          status: "completed",
          progressText: "done",
        });
        await params.replyOptions?.onReasoningStream?.({ text: "Thinking" });
        await params.replyOptions?.onReasoningEnd?.();
        await params.replyOptions?.onReasoningStream?.({ text: "Checking" });
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool:read-1",
          kind: "tool",
          name: "read",
          status: "completed",
          progressText: "done",
        });
        await params.replyOptions?.onItemEvent?.({
          itemId: "tool:failed-1",
          kind: "tool",
          name: "exec",
          status: "failed",
        });
        await params.replyOptions?.onObservedReplyDelivery?.();
        abortController.abort();
      });

      const monitor = monitorMattermostProvider({
        config: progressConfig,
        runtime: testRuntime(),
        abortSignal: abortController.signal,
        webSocketFactory: () => socket,
      });

      await vi.waitFor(() => {
        expect(socket.openListenerCount).toBeGreaterThan(0);
      });
      socket.emitOpen();

      await socket.emitMessage({
        event: "posted",
        data: {
          channel_id: "chan-1",
          channel_name: "town-square",
          channel_display_name: "Town Square",
          sender_name: "alice",
          post: JSON.stringify({
            id: "post-progress",
            channel_id: "chan-1",
            user_id: "user-1",
            message: "run this",
            create_at: 1_714_000_000_000,
          }),
        },
        broadcast: {
          channel_id: "chan-1",
          user_id: "user-1",
        },
      });
      socket.emitClose(1000);
      await monitor;

      const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
      expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
      expect(draftStream.clear).toHaveBeenCalledTimes(1);
      const updates = draftStream.update.mock.calls.map((call) => String(call[0]));
      if (toolProgress) {
        expect(updates.at(-1)).toContain("Read");
        expect(updates.at(-1)).toContain("done");
      } else {
        expect(updates[0]).toBe("Working");
        expect(updates.at(-1)).not.toContain("Read");
        expect(updates.at(-1)).not.toContain("done");
      }
      expect(updates.at(-1)).toContain("failed");
      expect(updates.at(-1)).toContain("Checking");
      expect(updates.at(-1)).not.toContain("ThinkingChecking");
    },
  );

  it("does not drop inline command-looking group text from non-command-authorized senders", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const inlineCommandConfig: OpenClawConfig = {
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
    const isControlCommandMessage = vi.fn(() => false);
    const shouldComputeCommandAuthorized = vi.fn(() => true);
    mockState.runtimeCore = createRuntimeCore(inlineCommandConfig, undefined, {
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => true,
    });

    const monitor = monitorMattermostProvider({
      config: inlineCommandConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-inline-command",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello /status",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(isControlCommandMessage).toHaveBeenCalledWith("hello /status", inlineCommandConfig);
    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("hello /status");
    expect(ctx?.CommandAuthorized).toBe(false);
    // Inline non-control text must not be tagged as an explicit text-slash command turn —
    // only authorized control commands take the source-reply suppression bypass.
    expect(ctx?.CommandSource).toBeUndefined();
  });

  // Regression for issue #86664: typed `/reset` (and `/new`) on a Mattermost DM under
  // message_tool_only source delivery (e.g. Codex harness default) silently dropped the
  // acknowledgement because the inbound context was not tagged as an explicit text-slash
  // command turn. The explicit-command exception in source-reply-delivery-mode.ts only
  // fires when CommandSource is "text" (or "native") AND CommandAuthorized is true. Mirrors
  // the iMessage fix from #82642.
  it("tags authorized typed text-slash control commands with CommandSource: text", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const isControlCommandMessage = vi.fn((text?: string) =>
      ["/reset", "/new"].includes(text?.trim() ?? ""),
    );
    const shouldComputeCommandAuthorized = vi.fn(() => true);
    mockState.runtimeCore = createRuntimeCore(directConfig, undefined, {
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => true,
    });
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });

    const monitor = monitorMattermostProvider({
      config: directConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-reset",
          channel_id: "dm-1",
          user_id: "user-1",
          message: " /reset",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("/reset");
    expect(ctx?.CommandBody).toBe("/reset");
    expect(ctx?.CommandAuthorized).toBe(true);
    expect(ctx?.CommandSource).toBe("text");
  });

  // "@bot /reset" is how a control command gets typed in a mention-gated channel: Mattermost's
  // composer executes a bare "/reset" as a Mattermost slash command instead of posting it. The
  // mention must be stripped before command detection and before the debounce gate, or the
  // command is batched with chat text and reaches the model as prose.
  it("routes a mention-prefixed text command without debouncing", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const mentionConfig: OpenClawConfig = {
      messages: { inbound: { debounceMs: 60_000 } },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "oncall",
          dmPolicy: "open",
          groupPolicy: "open",
          groupAllowFrom: ["user-1"],
        },
      },
    };
    const isControlCommandMessage = vi.fn((text?: string) => text?.trim() === "/reset");
    mockState.runtimeCore = createRuntimeCore(mentionConfig, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage,
      shouldComputeCommandAuthorized: () => true,
      shouldHandleTextCommands: () => true,
    });

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-mention-command",
      message: "@openclaw /reset",
    });
    // Control commands bypass the 60s debounce window, so the turn dispatches right away.
    await vi.waitFor(() => {
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    });
    socket.emitClose(1000);
    await monitor;

    expect(isControlCommandMessage).toHaveBeenCalledWith("/reset", mentionConfig);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.WasMentioned).toBe(true);
    expect(ctx?.BodyForAgent).toBe("/reset");
    expect(ctx?.CommandBody).toBe("/reset");
    expect(ctx?.CommandAuthorized).toBe(true);
    expect(ctx?.CommandSource).toBe("text");
  });

  it("uses websocket channel type when REST channel lookup fails", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const runtimeCore = createRuntimeCore(testConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue(null);

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        channel_type: "O",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-ws-kind",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "hello with websocket kind",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("hello with websocket kind");
    expect(ctx?.ChatType).toBe("channel");
    expect(ctx?.ConversationLabel).toBe("Town Square id:chan-1");
    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
  });

  it("drops posts when neither REST nor websocket channel type can be resolved", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const channelTypeConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["trusted-user"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(channelTypeConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue(null);

    const monitor = monitorMattermostProvider({
      config: channelTypeConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "dm-1",
        sender_name: "mallory",
        post: JSON.stringify({
          id: "post-missing-kind",
          channel_id: "dm-1",
          user_id: "new-user",
          message: "hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "new-user",
      },
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();
    expect(runtimeCore.channel.session.recordInboundSession).not.toHaveBeenCalled();
  });

  it("does not debounce denied senders or system posts into an allowed turn", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    const config: OpenClawConfig = {
      channels: {
        defaults: { contextVisibility: "allowlist" },
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "allowlist",
          groupAllowFrom: ["allowed-user"],
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(config, undefined, {
      inboundDebounceMs: 10,
      createInboundDebouncer,
    });

    const monitor = monitorMattermostProvider({
      config,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-denied",
      message: "denied text",
      senderId: "denied-user",
      senderName: "mallory",
    });
    await emitMattermostChannelPost(socket, {
      id: "post-system",
      message: "system text",
      senderId: "allowed-user",
      senderName: "alice",
      type: "system_join_channel",
    });
    await emitMattermostChannelPost(socket, {
      id: "post-allowed",
      message: "allowed text",
      senderId: "allowed-user",
      senderName: "alice",
    });

    await vi.waitFor(() => {
      expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    socket.emitClose(1000);
    await monitor;

    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.SenderId).toBe("allowed-user");
    expect(ctx?.BodyForAgent).toBe("allowed text");
    expect(ctx?.Body).not.toContain("denied text");
    expect(ctx?.Body).not.toContain("system text");
  });

  it("flushes pending group text before authorizing a bare abort without a mention", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const mentionConfig: OpenClawConfig = {
      messages: { inbound: { debounceMs: 60_000 } },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "oncall",
          dmPolicy: "open",
          groupPolicy: "open",
          groupAllowFrom: ["user-1"],
        },
      },
    };
    const isBareAbort = (text?: string) => ["abort", "stop"].includes(text?.trim() ?? "");
    const runtimeCore = createRuntimeCore(mentionConfig, undefined, {
      inboundDebounceMs: 60_000,
      createInboundDebouncer,
      isControlCommandMessage: isBareAbort,
      shouldComputeCommandAuthorized: isBareAbort,
      shouldHandleTextCommands: () => true,
      textHasControlCommand: () => false,
    });
    mockState.runtimeCore = runtimeCore;

    const monitor = monitorMattermostProvider({
      config: mentionConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-pending",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "pending text",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    expect(mockState.dispatchInboundMessage).not.toHaveBeenCalled();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "chan-1",
        channel_name: "town-square",
        channel_display_name: "Town Square",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-abort",
          channel_id: "chan-1",
          user_id: "user-1",
          message: "abort",
          create_at: 1_714_000_000_100,
        }),
      },
      broadcast: {
        channel_id: "chan-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const ctx = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("abort");
    expect(ctx?.CommandAuthorized).toBe(true);
  });

  it("pins direct-message main route updates to the configured owner", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(directConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });
    const monitor = monitorMattermostProvider({
      config: directConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-dm-1",
          channel_id: "dm-1",
          user_id: "user-1",
          message: "direct hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
    const [recordCall] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
    expect(recordCall?.storePath).toBe("/tmp/openclaw-test-sessions.json");
    expect(recordCall?.sessionKey).toBe("mattermost:default:channel:chan-1");
    const updateLastRoute = recordCall?.updateLastRoute;
    expect(updateLastRoute?.sessionKey).toBe("mattermost:default:channel:chan-1");
    expect(updateLastRoute?.channel).toBe("mattermost");
    expect(updateLastRoute?.to).toBe("user:user-1");
    expect(updateLastRoute?.accountId).toBe("default");
    expect(updateLastRoute?.mainDmOwnerPin?.ownerRecipient).toBe("user-1");
    expect(updateLastRoute?.mainDmOwnerPin?.senderRecipient).toBe("user-1");
    expect(typeof updateLastRoute?.mainDmOwnerPin?.onSkip).toBe("function");
    expect(recordCall?.createIfMissing).toBeUndefined();
    expect(recordCall?.groupResolution).toBeUndefined();
    expect(recordCall?.onRecordError).toBeInstanceOf(Function);
  });

  it("keeps per-channel direct-message route updates on the isolated session", async () => {
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    const directConfig: OpenClawConfig = {
      session: { dmScope: "per-channel-peer" },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "allowlist",
          groupPolicy: "open",
          allowFrom: ["user-1"],
        },
      },
    };
    const runtimeCore = createRuntimeCore(directConfig, {
      lastRoutePolicy: "session",
      mainSessionKey: "agent:main:main",
      sessionKey: "agent:main:mattermost:direct:user-1",
    });
    mockState.runtimeCore = runtimeCore;
    mockState.resolveChannelInfo.mockResolvedValue({
      id: "dm-1",
      name: "",
      display_name: "",
      team_id: "team-1",
      type: "D",
    });
    const { monitorMattermostProvider: monitorMattermostProviderLocal } =
      await import("./monitor.js");

    const monitor = monitorMattermostProviderLocal({
      config: directConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await socket.emitMessage({
      event: "posted",
      data: {
        channel_id: "dm-1",
        sender_name: "alice",
        post: JSON.stringify({
          id: "post-dm-2",
          channel_id: "dm-1",
          user_id: "user-1",
          message: "isolated direct hello",
          create_at: 1_714_000_000_000,
        }),
      },
      broadcast: {
        channel_id: "dm-1",
        user_id: "user-1",
      },
    });
    socket.emitClose(1000);
    await monitor;

    expect(runtimeCore.channel.session.recordInboundSession).toHaveBeenCalledTimes(1);
    const [recordCall] = runtimeCore.channel.session.recordInboundSession.mock.calls.at(0) ?? [];
    expect(recordCall?.sessionKey).toBe("agent:main:mattermost:direct:user-1");
    const updateLastRoute = recordCall?.updateLastRoute;
    expect(updateLastRoute?.sessionKey).toBe("agent:main:mattermost:direct:user-1");
    expect(updateLastRoute?.sessionKey).not.toBe("agent:main:main");
    expect(updateLastRoute?.channel).toBe("mattermost");
    expect(updateLastRoute?.to).toBe("user:user-1");
    expect(updateLastRoute?.accountId).toBe("default");
    expect(updateLastRoute?.mainDmOwnerPin).toBeUndefined();
  });

  it("keeps core block streaming enabled when preview streaming is off", async () => {
    const offConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "off", block: { enabled: true } },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(offConfig);
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: offConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-streaming-off",
      message: "stream this in blocks",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(false);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBeUndefined();
  });

  it("preserves provider previews for observer-only hooks", async () => {
    mockState.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "message_sent"),
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-observer-hook-preview",
      message: "show a preview",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.createMattermostDraftStream).toHaveBeenCalledTimes(1);
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(true);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBe(true);
  });

  it.each([
    { label: "reply_payload_sending", hooks: ["reply_payload_sending"] },
    { label: "message_sending", hooks: ["message_sending"] },
    {
      label: "both modifying hooks",
      hooks: ["reply_payload_sending", "message_sending"],
    },
  ])("suppresses provider previews when $label is registered", async ({ hooks }) => {
    const registeredHooks = new Set(hooks);
    mockState.getGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => registeredHooks.has(hookName)),
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;

    const monitor = monitorMattermostProvider({
      config: testConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: `post-${hooks.join("-")}-preview`,
      message: "do not expose this preview",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.createMattermostDraftStream).not.toHaveBeenCalled();
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBeUndefined();
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBeUndefined();
    expect(replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBeUndefined();
    expect(replyOptions?.onObservedReplyDelivery).toBeUndefined();
  });

  it("preserves text-tool-text boundaries while grouping interleaved tool updates", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: {
            mode: "block",
            preview: { toolProgress: true, commandText: "raw" },
          },
        },
      },
    };
    const chunkMarkdownTextWithMode = vi.fn((text: string) => [text]);
    const runtimeCore = createRuntimeCore(blockConfig, undefined, {
      chunkMarkdownTextWithMode,
      chunkMode: "newline",
      textChunkLimit: 1234,
    });
    mockState.runtimeCore = runtimeCore;
    const draftUpdate = vi.fn();
    const forceNewMessage = vi.fn(async () => {});
    let releaseToolBoundary: (() => void) | undefined;
    let releaseAssistantBoundary: (() => void) | undefined;
    let releaseFinalBoundary: (() => void) | undefined;
    let assistantBoundarySettled = false;
    const toolBoundaryPending = new Promise<void>((resolve) => {
      releaseToolBoundary = resolve;
    });
    const assistantBoundaryPending = new Promise<void>((resolve) => {
      releaseAssistantBoundary = resolve;
    });
    const finalBoundaryPending = new Promise<void>((resolve) => {
      releaseFinalBoundary = resolve;
    });
    forceNewMessage.mockImplementation(async () => {
      const callNumber = forceNewMessage.mock.calls.length;
      if (callNumber === 1) {
        await toolBoundaryPending;
        return;
      }
      if (callNumber === 2) {
        await assistantBoundaryPending;
        assistantBoundarySettled = true;
        return;
      }
      if (callNumber === 5) {
        await finalBoundaryPending;
      }
    });
    mockState.createMattermostDraftStream.mockReturnValue({
      update: draftUpdate,
      updateAssistantText: draftUpdate,
      forceNewMessage,
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });

    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    let sameToolUpdateBoundaryCount = -1;
    let hiddenReasoningBoundaryCount = -1;
    let consecutiveToolBoundaryCount = -1;
    let reasoningStartBoundaryCount = -1;
    let secondReasoningBoundaryCount = -1;
    let reasoningTextBoundaryCount = -1;
    let toolBeforeFinalBoundaryCount = -1;
    let finalOnlyBoundaryCount = -1;
    let interleavedToolDraft = "";
    let reasoningDraft = "";
    let finalToolDraft = "";
    let secondPartialArrivedBeforeBoundarySettled = false;
    let finalDeliveryWaitedForBoundary = false;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      params.replyOptions?.onPartialReply?.({ text: "A much longer first block" });
      const firstToolStart = params.replyOptions?.onToolStart?.({
        toolCallId: "bash-1",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "ls" },
      });
      const secondToolStart = params.replyOptions?.onToolStart?.({
        toolCallId: "bash-2",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "pwd" },
      });
      const firstToolUpdate = params.replyOptions?.onToolStart?.({
        toolCallId: "bash-1",
        name: "bash",
        phase: "update",
        detailMode: "raw",
        args: { command: "ls -alh" },
      });
      sameToolUpdateBoundaryCount = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningEnd?.();
      hiddenReasoningBoundaryCount = forceNewMessage.mock.calls.length;
      const consecutiveToolStart = params.replyOptions?.onToolStart?.({
        toolCallId: "bash-3",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "whoami" },
      });
      consecutiveToolBoundaryCount = forceNewMessage.mock.calls.length;
      interleavedToolDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");

      params.replyOptions?.onAssistantMessageStart?.();
      const assistantBoundary = params.replyOptions?.onPartialReply?.({ text: "Done." });
      secondPartialArrivedBeforeBoundarySettled =
        !assistantBoundarySettled && draftUpdate.mock.calls.at(-1)?.[0] === "Done.";
      releaseToolBoundary?.();
      releaseAssistantBoundary?.();
      await Promise.all([
        firstToolStart,
        secondToolStart,
        firstToolUpdate,
        consecutiveToolStart,
        assistantBoundary,
      ]);
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Private chain of thought" });
      reasoningStartBoundaryCount = forceNewMessage.mock.calls.length;
      reasoningDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");
      await params.replyOptions?.onReasoningEnd?.();
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onReasoningStream?.({ text: "Second reasoning item" });
      secondReasoningBoundaryCount = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Answer after reasoning" });
      reasoningTextBoundaryCount = forceNewMessage.mock.calls.length;
      params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onToolStart?.({
        toolCallId: "bash-final",
        name: "bash",
        phase: "start",
        detailMode: "raw",
        args: { command: "date" },
      });
      toolBeforeFinalBoundaryCount = forceNewMessage.mock.calls.length;
      finalToolDraft = String(draftUpdate.mock.calls.at(-1)?.[0] ?? "");
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      const finalDelivery = dispatcherOptions?.deliver(
        { text: "Final without a partial" },
        { kind: "final" },
      );
      finalOnlyBoundaryCount = forceNewMessage.mock.calls.length;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      finalDeliveryWaitedForBoundary = mockState.sendMessageMattermost.mock.calls.length === 0;
      releaseFinalBoundary?.();
      await finalDelivery;
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: blockConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-tool-progress",
      message: "run a tool",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const draftStreamOptions = mockState.createMattermostDraftStream.mock.calls.at(0)?.[0] as
      | { chunkText?: (text: string) => string[] }
      | undefined;
    chunkMarkdownTextWithMode.mockClear();
    expect(draftStreamOptions?.chunkText?.("first\n\nsecond")).toEqual(["first\n\nsecond"]);
    expect(chunkMarkdownTextWithMode).toHaveBeenCalledWith("first\n\nsecond", 1234, "newline");
    const replyOptions = mockState.dispatchInboundMessage.mock.calls.at(0)?.[0].replyOptions;
    expect(replyOptions?.disableBlockStreaming).toBe(true);
    expect(replyOptions?.preserveProgressCallbackStartOrder).toBe(true);
    expect(sameToolUpdateBoundaryCount).toBe(1);
    expect(hiddenReasoningBoundaryCount).toBe(1);
    expect(consecutiveToolBoundaryCount).toBe(1);
    expect(reasoningStartBoundaryCount).toBe(3);
    expect(secondReasoningBoundaryCount).toBe(3);
    expect(reasoningTextBoundaryCount).toBe(3);
    expect(toolBeforeFinalBoundaryCount).toBe(4);
    expect(interleavedToolDraft).toContain("pwd");
    expect(interleavedToolDraft).toContain("ls -alh");
    expect(interleavedToolDraft).toContain("whoami");
    expect(reasoningDraft).toBe("Thinking…");
    expect(finalToolDraft).toContain("date");
    expect(finalOnlyBoundaryCount).toBe(5);
    expect(forceNewMessage).toHaveBeenCalledTimes(5);
    expect(finalDeliveryWaitedForBoundary).toBe(true);
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "Final without a partial",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(secondPartialArrivedBeforeBoundarySettled).toBe(true);
    expect(draftUpdate).toHaveBeenNthCalledWith(1, "A much longer first block");
    expect(draftUpdate).toHaveBeenCalledWith("Done.");
    expect(draftUpdate).toHaveBeenCalledWith("Answer after reasoning");
  });

  it("finalizes only the current block when the terminal reply is cumulative", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "block" },
          responsePrefix: "[bot]",
        },
      },
    };
    const runtimeCore = createRuntimeCore(blockConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.updateMattermostPost.mockRejectedValueOnce(new Error("edit failed"));
    const forceNewMessage = vi.fn(async () => {});
    const updateAssistantText = vi.fn();
    const resolveFinalText = vi.fn((text: string) =>
      text === "[bot] First block\n\nSecond block"
        ? { kind: "remaining" as const, text: "Second block", publishedParts: [] }
        : { kind: "full" as const, text, publishedParts: [] },
    );
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText,
      forceNewMessage,
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => "preview-current"),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText,
    });

    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "First block" });
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Second block" });
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver(
        { text: "[bot] First block\n\nSecond block" },
        { kind: "final" },
      );
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: blockConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();

    await emitMattermostChannelPost(socket, {
      id: "post-cumulative-final",
      message: "stream two blocks",
    });
    socket.emitClose(1000);
    await monitor;

    expect(forceNewMessage).toHaveBeenCalledTimes(1);
    expect(updateAssistantText).toHaveBeenNthCalledWith(1, "[bot] First block");
    expect(updateAssistantText).toHaveBeenNthCalledWith(2, "Second block");
    expect(resolveFinalText).toHaveBeenCalledWith("[bot] First block\n\nSecond block");
    expect(mockState.updateMattermostPost).toHaveBeenCalledWith({}, "preview-current", {
      message: "Second block",
    });
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "Second block",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("records participation when the confirmed preview already contains the final", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "block" },
        },
      },
    };
    const runtimeCore = createRuntimeCore(blockConfig);
    mockState.runtimeCore = runtimeCore;
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: vi.fn(() => ({
        kind: "already-delivered" as const,
        publishedParts: [{ messageId: "preview-sealed", content: "Only block" }],
      })),
    });

    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Only block" });
      await params.replyOptions?.onAssistantMessageStart?.();
      const dispatcherOptions =
        mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
      await dispatcherOptions?.deliver({ text: "Only block" }, { kind: "final" });
      abortController.abort();
    });

    const monitor = monitorMattermostProvider({
      config: blockConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-confirmed-preview-final",
      message: "stream one block",
      rootId: "thread-root-confirmed-preview",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.sendMessageMattermost).not.toHaveBeenCalled();
    expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
      "default",
      "chan-1",
      "thread-root-confirmed-preview",
      { agentId: "main" },
    );
  });

  it("records participation when confirmed-preview cleanup fails", async () => {
    const blockConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "block" },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(blockConfig);
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {
        throw new Error("preview cleanup failed");
      }),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: vi.fn(() => ({
        kind: "already-delivered" as const,
        publishedParts: [{ messageId: "preview-sealed", content: "Only block" }],
      })),
    });

    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(async (params) => {
      try {
        await params.replyOptions?.onAssistantMessageStart?.();
        await params.replyOptions?.onPartialReply?.({ text: "Only block" });
        await params.replyOptions?.onAssistantMessageStart?.();
        const dispatcherOptions =
          mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
        await expect(
          dispatcherOptions?.deliver({ text: "Only block" }, { kind: "final" }),
        ).rejects.toThrow("preview cleanup failed");
      } finally {
        abortController.abort();
      }
    });

    const monitor = monitorMattermostProvider({
      config: blockConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-confirmed-preview-cleanup-failure",
      message: "stream one block",
      rootId: "thread-root-confirmed-preview-cleanup-failure",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
      "default",
      "chan-1",
      "thread-root-confirmed-preview-cleanup-failure",
      { agentId: "main" },
    );
  });

  it("records participation when a later send step fails after a visible thread post", async () => {
    const progressConfig: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          baseUrl: "https://mattermost.example.com",
          botToken: "bot-token",
          chatmode: "onmessage",
          dmPolicy: "open",
          groupPolicy: "open",
          streaming: { mode: "progress", progress: { toolProgress: true } },
        },
      },
    };
    mockState.runtimeCore = createRuntimeCore(progressConfig);
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ channel: "mattermost", messageId: "partial-post-1", channelId: "chan-1" }],
      kind: "text",
      replyToId: "thread-root-partial",
    });
    mockState.sendMessageMattermost.mockRejectedValueOnce(
      createChannelPartialDeliveryError(new Error("bookkeeping failed"), {
        messageIds: ["partial-post-1"],
        receipt,
        visibleReplySent: true,
        content: "Visible partial reply",
      }),
    );
    mockState.createMattermostDraftStream.mockReturnValue({
      update: vi.fn(),
      updateAssistantText: vi.fn(),
      forceNewMessage: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      postId: vi.fn(() => undefined),
      clear: vi.fn(async () => {}),
      discardPending: vi.fn(async () => {}),
      seal: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      settleBoundaries: vi.fn(async () => {}),
      resolveFinalText: (text: string) => ({ kind: "full" as const, text, publishedParts: [] }),
    });
    const socket = new FakeWebSocket();
    const abortController = new AbortController();
    mockState.abortController = abortController;
    mockState.dispatchInboundMessage.mockImplementation(
      async (dispatchParams: {
        replyOptions?: {
          onReasoningStream?: (payload: ReplyPayload) => void | Promise<void>;
        };
      }) => {
        try {
          const dispatcherOptions =
            mockState.createReplyDispatcherWithTyping.mock.results.at(-1)?.value?.options;
          await expect(
            dispatcherOptions?.deliver({ text: "Visible partial reply" }, { kind: "final" }),
          ).rejects.toThrow("bookkeeping failed");
          await dispatchParams.replyOptions?.onReasoningStream?.({ text: "late reasoning" });
        } finally {
          abortController.abort();
        }
      },
    );

    const monitor = monitorMattermostProvider({
      config: progressConfig,
      runtime: testRuntime(),
      abortSignal: abortController.signal,
      webSocketFactory: () => socket,
    });

    await vi.waitFor(() => {
      expect(socket.openListenerCount).toBeGreaterThan(0);
    });
    socket.emitOpen();
    await emitMattermostChannelPost(socket, {
      id: "post-partial-thread",
      message: "reply in this thread",
      rootId: "thread-root-partial",
    });
    socket.emitClose(1000);
    await monitor;

    expect(mockState.recordMattermostThreadParticipation).toHaveBeenCalledWith(
      "default",
      "chan-1",
      "thread-root-partial",
      { agentId: "main" },
    );
    expect(mockState.progressDrafts.at(-1)?.getSnapshot().lines).toEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
