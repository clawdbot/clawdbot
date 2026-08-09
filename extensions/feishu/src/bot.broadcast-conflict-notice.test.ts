// Feishu tests cover bot.broadcast plugin behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { feishuGroupNameCache } from "./bot-group-name-state.js";
import type { FeishuMessageEvent } from "./bot.js";
import { handleFeishuMessage } from "./bot.js";
import { feishuDedupeState } from "./dedup-state.js";
import type { FeishuMessageProcessingClaim } from "./dedup.js";
import type { FeishuIngressLifecycle } from "./feishu-ingress.js";
import { setFeishuRuntime } from "./runtime.js";

const {
  builtInboundContextCalls,
  mockCreateFeishuReplyDispatcher,
  mockCreateFeishuClient,
  mockDispatchReply,
  mockRecordInboundSession,
  mockResolveAgentRoute,
  mockResolveStorePath,
} = vi.hoisted(() => ({
  builtInboundContextCalls: [] as Array<Record<string, unknown>>,
  mockCreateFeishuReplyDispatcher: vi.fn((_params?: unknown) => ({
    dispatcherOptions: {},
    delivery: { deliver: vi.fn(async () => undefined) },
    replyOptions: {},
    ensureNoVisibleReplyFallback: vi.fn(),
  })),
  mockCreateFeishuClient: vi.fn(),
  mockDispatchReply: vi.fn().mockResolvedValue({ queuedFinal: false, counts: { final: 1 } }),
  mockRecordInboundSession: vi.fn().mockResolvedValue(undefined),
  mockResolveAgentRoute: vi.fn(),
  mockResolveStorePath: vi.fn(
    (_store?: unknown, _options?: { agentId?: string }) => "/tmp/feishu-session-store.json",
  ),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
    "openclaw/plugin-sdk/channel-inbound",
  );
  return {
    ...actual,
    buildChannelInboundEventContext: (
      params: Parameters<typeof actual.buildChannelInboundEventContext>[0],
    ) =>
      actual.buildChannelInboundEventContext({
        ...params,
        finalize: (ctx) => {
          builtInboundContextCalls.push(ctx);
          return ctx as never;
        },
      }),
  };
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

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}

function createIngressLifecycle() {
  const calls = {
    adopted: vi.fn(async () => {}),
    deferred: vi.fn(),
    finalizing: vi.fn(),
    abandoned: vi.fn(async () => {}),
  };
  const lifecycle: FeishuIngressLifecycle = {
    abortSignal: new AbortController().signal,
    onAdopted: calls.adopted,
    onDeferred: calls.deferred,
    onAdoptionFinalizing: calls.finalizing,
    onAbandoned: calls.abandoned,
  };
  return { calls, lifecycle };
}

function createReplayClaim(key: string): FeishuMessageProcessingClaim {
  return {
    keys: [key],
    commit: vi.fn(async () => true),
    release: vi.fn(),
  };
}

describe("broadcast dispatch", () => {
  const mockGetChatInfo = vi.fn();
  const mockShouldComputeCommandAuthorized = vi.fn(() => false);
  const resolvedTurnCalls: Array<Record<string, unknown>> = [];
  const mockSaveMediaBuffer = vi.fn().mockResolvedValue({
    path: "/tmp/inbound-clip.mp4",
    contentType: "video/mp4",
  });
  const runtimeStub = {
    system: {
      enqueueSystemEvent: vi.fn(),
    },
    channel: {
      routing: {
        resolveAgentRoute: (params: unknown) => mockResolveAgentRoute(params),
      },
      session: {
        resolveStorePath: mockResolveStorePath,
        recordInboundSession: mockRecordInboundSession,
      },
      reply: {},
      commands: {
        shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      media: {
        saveMediaBuffer: mockSaveMediaBuffer,
      },
      inbound: {
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const eventClass = {
            kind: "message" as const,
            canStartAgentTurn: true,
          };
          const turn = await params.adapter.resolveTurn(input, eventClass, {});
          if (!("route" in turn) || !("delivery" in turn)) {
            throw new Error("expected assembled Feishu channel turn plan");
          }
          resolvedTurnCalls.push(turn as unknown as Record<string, unknown>);
          const routeSessionKey = turn.route.sessionKey;
          await mockRecordInboundSession({
            storePath: mockResolveStorePath(),
            sessionKey: turn.ctxPayload.SessionKey ?? routeSessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          const dispatchResult = await mockDispatchReply({
            ctx: turn.ctxPayload,
            cfg: turn.cfg,
            replyOptions: turn.replyOptions,
          });
          const dispatched = !(dispatchResult as { undispatched?: boolean }).undispatched;
          if (dispatched && !(dispatchResult as { deferAdoption?: boolean }).deferAdoption) {
            await turn.replyOptions?.turnAdoptionLifecycle?.onAdopted?.();
          }
          return {
            admission: turn.admission ?? { kind: "dispatch" as const },
            dispatched,
            ctxPayload: turn.ctxPayload,
            routeSessionKey,
            ...(dispatched ? { dispatchResult } : {}),
          };
        }),
      },
      pairing: {
        readAllowFromStore: vi.fn().mockResolvedValue([]),
        upsertPairingRequest: vi.fn().mockResolvedValue({ code: "ABCDEFGH", created: false }),
        buildPairingReply: vi.fn(() => "Pairing response"),
      },
    },
    media: {
      detectMime: vi.fn(async () => "application/octet-stream"),
    },
  } as unknown as PluginRuntime;

  afterAll(() => {
    vi.doUnmock("./reply-dispatcher.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  function createBroadcastConfig(): ClawdbotConfig {
    return {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: true,
            },
          },
        },
      },
    };
  }

  function createBroadcastEvent(options: {
    messageId: string;
    text: string;
    botMentioned?: boolean;
  }): FeishuMessageEvent {
    return {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: options.messageId,
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: options.text }),
        ...(options.botMentioned
          ? {
              mentions: [
                {
                  key: "@_user_1",
                  id: { open_id: "bot-open-id" },
                  name: "Bot",
                  tenant_key: "",
                },
              ],
            }
          : {}),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    feishuDedupeState.reset();
    mockDispatchReply.mockReset().mockResolvedValue({
      queuedFinal: false,
      counts: { final: 1 },
    });
    mockResolveStorePath.mockReset().mockReturnValue("/tmp/feishu-session-store.json");
    feishuGroupNameCache.clear();
    builtInboundContextCalls.length = 0;
    resolvedTurnCalls.length = 0;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    });
    mockCreateFeishuReplyDispatcher.mockReturnValue({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(),
    });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        chat: {
          get: mockGetChatInfo.mockResolvedValue({
            code: 0,
            data: { name: "Broadcast Team" },
          }),
        },
      },
    });
    setFeishuRuntime(runtimeStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    feishuDedupeState.reset();
  });

  it("delivers the reply-session conflict notice with thread routing when broadcast lanes exhaust retries (#108320)", async () => {
    mockDispatchReply
      .mockReset()
      .mockRejectedValue(
        new Error(
          "reply session initialization conflicted for agent:main:feishu:group:oc-broadcast-group",
        ),
      );
    const mockNoticeReply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om-n" } });
    const mockNoticeCreate = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om-n" } });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        chat: {
          get: mockGetChatInfo.mockResolvedValue({
            code: 0,
            data: { name: "Broadcast Team" },
          }),
        },
        message: { reply: mockNoticeReply, create: mockNoticeCreate },
      },
    });
    const cfg = createBroadcastConfig();
    const broadcastGroups = cfg.channels?.feishu?.groups as Record<
      string,
      { replyInThread?: "enabled" | "disabled" }
    >;
    broadcastGroups["oc-broadcast-group"]!.replyInThread = "enabled";
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-conflict",
      text: "hello @bot",
      botMentioned: true,
    });
    event.message.root_id = "om-broadcast-root";
    event.message.thread_id = "omt-broadcast-thread";

    // Every lane exhausts its reply-session init conflict, so the fan-out
    // surfaces an AggregateError; the notice must still go out, anchored at the
    // resolved thread root with reply_in_thread, not the catch-block defaults.
    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(mockNoticeReply).toHaveBeenCalledTimes(1);
    expect(mockNoticeCreate).not.toHaveBeenCalled();
    const noticeRequest = mockNoticeReply.mock.calls[0]?.[0] as {
      path: { message_id: string };
      data: { content: string; msg_type: string; reply_in_thread?: boolean };
    };
    expect(noticeRequest.path.message_id).toBe("om-broadcast-root");
    expect(noticeRequest.data.msg_type).toBe("post");
    expect(noticeRequest.data.reply_in_thread).toBe(true);
    expect(noticeRequest.data.content).toContain("session stayed busy");
  });

  it("adopts the durable broadcast event once the conflict notice is delivered (#108320)", async () => {
    const broadcastClaim = createReplayClaim("broadcast-conflict-notice-adopt");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) =>
      options?.namespace === "broadcast"
        ? { kind: "claimed", handle: broadcastClaim }
        : { kind: "invalid" },
    );
    mockDispatchReply
      .mockReset()
      .mockRejectedValue(
        new Error(
          "reply session initialization conflicted for agent:main:feishu:group:oc-broadcast-group",
        ),
      );
    const mockNoticeReply = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om-n" } });
    const mockNoticeCreate = vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om-n" } });
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        chat: {
          get: mockGetChatInfo.mockResolvedValue({
            code: 0,
            data: { name: "Broadcast Team" },
          }),
        },
        message: { reply: mockNoticeReply, create: mockNoticeCreate },
      },
    });
    const transport = createIngressLifecycle();

    await handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-conflict-adopt",
        text: "hello @bot",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: transport.lifecycle,
    });

    // The delivered notice settles the durable event: adopt + commit, never
    // abandon + release, so a redelivery cannot duplicate the notice.
    expect(mockNoticeReply.mock.calls.length + mockNoticeCreate.mock.calls.length).toBe(1);
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).not.toHaveBeenCalled();
    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.release).not.toHaveBeenCalled();
  });

  it("abandons the durable broadcast event when the conflict notice send fails (#108320)", async () => {
    const broadcastClaim = createReplayClaim("broadcast-conflict-notice-abandon");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) =>
      options?.namespace === "broadcast"
        ? { kind: "claimed", handle: broadcastClaim }
        : { kind: "invalid" },
    );
    mockDispatchReply
      .mockReset()
      .mockRejectedValue(
        new Error(
          "reply session initialization conflicted for agent:main:feishu:group:oc-broadcast-group",
        ),
      );
    const mockNoticeReply = vi.fn().mockRejectedValue(new Error("feishu reply api unavailable"));
    const mockNoticeCreate = vi.fn().mockRejectedValue(new Error("feishu create api unavailable"));
    mockCreateFeishuClient.mockReturnValue({
      contact: {
        user: {
          get: vi.fn().mockResolvedValue({ data: { user: { name: "Sender" } } }),
        },
      },
      im: {
        chat: {
          get: mockGetChatInfo.mockResolvedValue({
            code: 0,
            data: { name: "Broadcast Team" },
          }),
        },
        message: { reply: mockNoticeReply, create: mockNoticeCreate },
      },
    });
    const transport = createIngressLifecycle();

    await expect(
      handleFeishuMessage({
        cfg: createBroadcastConfig(),
        event: createBroadcastEvent({
          messageId: "msg-broadcast-conflict-abandon",
          text: "hello @bot",
          botMentioned: true,
        }),
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
        turnAdoptionLifecycle: transport.lifecycle,
      }),
    ).rejects.toThrow("Feishu broadcast dispatch failed");

    // The notice never landed, so the durable event must stay redeliverable:
    // abandon + release, never adopt + commit.
    expect(mockNoticeReply.mock.calls.length + mockNoticeCreate.mock.calls.length).toBe(1);
    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
  });
});
