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

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-mentioned",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(2);
    const sessionKeys = builtInboundContextCalls.map((call) => call.SessionKey);
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");
    const recordCalls = (
      runtimeStub.channel.session.recordInboundSession as unknown as {
        mock: {
          calls: Array<
            [
              {
                updateLastRoute?: {
                  sessionKey?: unknown;
                  channel?: unknown;
                  to?: unknown;
                };
              },
            ]
          >;
        };
      }
    ).mock.calls;
    expect(
      recordCalls
        .map(([call]) => ({
          sessionKey: call.updateLastRoute?.["sessionKey"],
          channel: call.updateLastRoute?.["channel"],
          to: call.updateLastRoute?.["to"],
        }))
        .toSorted((left, right) => String(left.sessionKey).localeCompare(String(right.sessionKey))),
    ).toEqual([
      {
        sessionKey: "agent:main:feishu:group:oc-broadcast-group",
        channel: "feishu",
        to: "chat:oc-broadcast-group",
      },
      {
        sessionKey: "agent:susan:feishu:group:oc-broadcast-group",
        channel: "feishu",
        to: "chat:oc-broadcast-group",
      },
    ]);
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
    expect(
      builtInboundContextCalls
        .map((call) => ({
          sessionKey: call.SessionKey,
          groupSubject: call.GroupSubject,
          conversationLabel: call.ConversationLabel,
        }))
        .toSorted((left, right) => String(left.sessionKey).localeCompare(String(right.sessionKey))),
    ).toEqual([
      {
        sessionKey: "agent:main:feishu:group:oc-broadcast-group",
        groupSubject: "Broadcast Team",
        conversationLabel: "Broadcast Team",
      },
      {
        sessionKey: "agent:susan:feishu:group:oc-broadcast-group",
        groupSubject: "Broadcast Team",
        conversationLabel: "Broadcast Team",
      },
    ]);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    const dispatcherParams = mockCreateFeishuReplyDispatcher.mock.calls.at(0)?.[0] as
      | { agentId?: string }
      | undefined;
    expect(dispatcherParams?.agentId).toBe("main");
  });

  it("sends no-visible-reply fallback for active broadcast zero-final dispatch", async () => {
    mockDispatchReply
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { final: 0 },
        noVisibleReplyFallbackEligible: true,
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-zero-final",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
  });

  it("sends no-visible-reply fallback for active broadcast failed final delivery", async () => {
    mockDispatchReply
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: true,
        counts: { final: 1 },
        failedCounts: { tool: 0, block: 0, final: 1 },
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-final-failed",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).toHaveBeenCalledWith(
      "broadcast-dispatch-complete-no-visible-reply",
    );
  });

  it("skips no-visible-reply fallback for source-suppressed active broadcast dispatch", async () => {
    mockDispatchReply
      .mockResolvedValueOnce({ queuedFinal: false, counts: { final: 1 } })
      .mockResolvedValueOnce({
        queuedFinal: false,
        counts: { final: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
        noVisibleReplyFallbackEligible: true,
      });
    const ensureNoVisibleReplyFallback = vi.fn();
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback,
    });
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-source-suppressed",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(ensureNoVisibleReplyFallback).not.toHaveBeenCalled();
  });

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-not-mentioned",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "ou_known_bot",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("skips broadcast dispatch when bot identity is unknown (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-unknown-bot-id",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("preserves single-agent dispatch when no broadcast config", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-no-broadcast",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(builtInboundContextCalls).toHaveLength(1);
    expect(builtInboundContextCalls[0]?.SessionKey).toBe(
      "agent:main:feishu:group:oc-broadcast-group",
    );
    expect(builtInboundContextCalls[0]?.GroupSubject).toBe("Broadcast Team");
    expect(builtInboundContextCalls[0]?.ConversationLabel).toBe("Broadcast Team");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });

  it("cross-account broadcast dedup: second account skips dispatch", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "main"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-multi-account-dedup",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-A",
    });
    expect(mockDispatchReply).toHaveBeenCalledTimes(2);

    mockDispatchReply.mockClear();
    mockGetChatInfo.mockClear();
    builtInboundContextCalls.length = 0;

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-B",
    });
    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("abandons a failed broadcast claim and re-dispatches it on redelivery", async () => {
    const firstClaim = createReplayClaim("broadcast-first-attempt");
    const retryClaim = createReplayClaim("broadcast-retry");
    const firstSusanClaim = createReplayClaim("broadcast-susan-first-attempt");
    const retrySusanClaim = createReplayClaim("broadcast-susan-retry");
    const mainClaim = createReplayClaim("broadcast-main");
    let broadcastAttempt = 0;
    let susanAttempt = 0;
    let mainAttempt = 0;
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => {
      if (options?.namespace === "broadcast") {
        broadcastAttempt += 1;
        return {
          kind: "claimed",
          handle: broadcastAttempt === 1 ? firstClaim : retryClaim,
        };
      }
      if (options?.namespace === "broadcast:susan") {
        susanAttempt += 1;
        return {
          kind: "claimed",
          handle: susanAttempt === 1 ? firstSusanClaim : retrySusanClaim,
        };
      }
      if (options?.namespace === "broadcast:main") {
        mainAttempt += 1;
        return mainAttempt === 1 ? { kind: "claimed", handle: mainClaim } : { kind: "duplicate" };
      }
      return { kind: "invalid" };
    });
    mockDispatchReply
      .mockRejectedValueOnce(new Error("observer dispatch failed"))
      .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-redelivery",
      text: "retry me",
      botMentioned: true,
    });
    const firstTransport = createIngressLifecycle();
    const cfg = createBroadcastConfig();
    (cfg.broadcast as Record<string, unknown>).strategy = "sequential";

    await expect(
      handleFeishuMessage({
        cfg,
        event,
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
        turnAdoptionLifecycle: firstTransport.lifecycle,
      }),
    ).rejects.toThrow("observer dispatch failed");

    expect(mockDispatchReply).toHaveBeenCalledTimes(2);
    expect(firstClaim.commit).not.toHaveBeenCalled();
    expect(firstClaim.release).toHaveBeenCalledTimes(1);
    expect(firstSusanClaim.commit).not.toHaveBeenCalled();
    expect(firstSusanClaim.release).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.release).not.toHaveBeenCalled();
    expect(firstTransport.calls.adopted).not.toHaveBeenCalled();
    expect(firstTransport.calls.abandoned).toHaveBeenCalledTimes(1);

    mockDispatchReply.mockClear();
    const retryTransport = createIngressLifecycle();
    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: retryTransport.lifecycle,
    });

    // The adopted main lane stays committed; only failed Susan re-dispatches.
    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    expect(retryTransport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(retryTransport.calls.abandoned).not.toHaveBeenCalled();
    expect(retryClaim.release).not.toHaveBeenCalled();
    expect(retryClaim.commit).toHaveBeenCalledTimes(1);
    expect(retrySusanClaim.commit).toHaveBeenCalledTimes(1);
    expect(retrySusanClaim.release).not.toHaveBeenCalled();
  });

  it("keeps an adopted active lane committed when its no-visible fallback fails", async () => {
    const broadcastClaim = createReplayClaim("broadcast-fallback-failure");
    const susanClaim = createReplayClaim("broadcast-fallback-failure-susan");
    const mainClaim = createReplayClaim("broadcast-fallback-failure-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith("agent:main:")
        ? {
            queuedFinal: false,
            counts: { final: 0 },
            noVisibleReplyFallbackEligible: true,
          }
        : { queuedFinal: false, counts: { final: 1 } },
    );
    mockCreateFeishuReplyDispatcher.mockReturnValueOnce({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      replyOptions: {},
      ensureNoVisibleReplyFallback: vi.fn(async () => {
        throw new Error("fallback send failed");
      }),
    });
    const transport = createIngressLifecycle();

    await expect(
      handleFeishuMessage({
        cfg: createBroadcastConfig(),
        event: createBroadcastEvent({
          messageId: "msg-broadcast-fallback-failure",
          text: "fallback must retry",
          botMentioned: true,
        }),
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
        turnAdoptionLifecycle: transport.lifecycle,
      }),
    ).rejects.toThrow("fallback send failed");

    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.release).not.toHaveBeenCalled();
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("releases an agent claim when broadcast lane setup fails", async () => {
    const broadcastClaim = createReplayClaim("broadcast-setup-failure");
    const susanClaim = createReplayClaim("broadcast-setup-failure-susan");
    const mainClaim = createReplayClaim("broadcast-setup-failure-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    mockResolveStorePath.mockImplementation((_store, options?: { agentId?: string }) => {
      if (options?.agentId === "susan") {
        throw new Error("session path failed");
      }
      return "/tmp/feishu-session-store.json";
    });
    const cfg = createBroadcastConfig();
    (cfg.broadcast as Record<string, unknown>).strategy = "sequential";
    const transport = createIngressLifecycle();

    await expect(
      handleFeishuMessage({
        cfg,
        event: createBroadcastEvent({
          messageId: "msg-broadcast-setup-failure",
          text: "setup must release",
          botMentioned: true,
        }),
        botOpenId: "bot-open-id",
        runtime: createRuntimeEnv(),
        turnAdoptionLifecycle: transport.lifecycle,
      }),
    ).rejects.toThrow("session path failed");

    expect(susanClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.release).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("abandons the shared claim when an agent lane is not dispatched", async () => {
    const broadcastClaim = createReplayClaim("broadcast-undispatched");
    const susanClaim = createReplayClaim("broadcast-undispatched-susan");
    const mainClaim = createReplayClaim("broadcast-undispatched-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    mockDispatchReply.mockImplementation(async ({ ctx }) =>
      String(ctx.SessionKey).startsWith("agent:susan:")
        ? { queuedFinal: false, counts: { final: 0 }, undispatched: true }
        : { queuedFinal: false, counts: { final: 1 } },
    );
    const transport = createIngressLifecycle();

    await handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-undispatched",
        text: "do not tombstone",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: transport.lifecycle,
    });

    expect(susanClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.release).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(broadcastClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("commits the shared broadcast claim only after transport adoption", async () => {
    const broadcastClaim = createReplayClaim("broadcast-adoption-order");
    const susanClaim = createReplayClaim("broadcast-adoption-order-susan");
    const mainClaim = createReplayClaim("broadcast-adoption-order-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    const transport = createIngressLifecycle();
    let finishAdoption!: () => void;
    const adoptionGate = new Promise<void>((resolve) => {
      finishAdoption = resolve;
    });
    transport.calls.adopted.mockImplementationOnce(async () => await adoptionGate);

    const handling = handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-adoption-order",
        text: "adopt before dedupe",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: transport.lifecycle,
    });

    await vi.waitFor(() => expect(transport.calls.adopted).toHaveBeenCalledTimes(1));
    expect(transport.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);

    finishAdoption();
    await handling;

    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(broadcastClaim.commit).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(broadcastClaim.release).not.toHaveBeenCalled();
  });

  it("waits for every independently deferred broadcast lane before adoption", async () => {
    const broadcastClaim = createReplayClaim("broadcast-deferred");
    const susanClaim = createReplayClaim("broadcast-deferred-susan");
    const mainClaim = createReplayClaim("broadcast-deferred-main");
    vi.spyOn(feishuDedupeState.guard, "claim").mockImplementation(async (_messageId, options) => ({
      kind: "claimed",
      handle:
        options?.namespace === "broadcast:susan"
          ? susanClaim
          : options?.namespace === "broadcast:main"
            ? mainClaim
            : broadcastClaim,
    }));
    let deferredLifecycle:
      | Pick<FeishuIngressLifecycle, "onAdopted" | "onDeferred" | "onAbandoned">
      | undefined;
    mockDispatchReply.mockImplementation(async ({ ctx, replyOptions }) => {
      if (String(ctx.SessionKey).startsWith("agent:susan:")) {
        deferredLifecycle = replyOptions?.turnAdoptionLifecycle;
        deferredLifecycle?.onDeferred();
        return { queuedFinal: false, counts: { final: 1 }, deferAdoption: true };
      }
      return { queuedFinal: false, counts: { final: 1 } };
    });
    const transport = createIngressLifecycle();

    await handleFeishuMessage({
      cfg: createBroadcastConfig(),
      event: createBroadcastEvent({
        messageId: "msg-broadcast-deferred",
        text: "wait for every lane",
        botMentioned: true,
      }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
      turnAdoptionLifecycle: transport.lifecycle,
    });

    expect(transport.calls.deferred).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(broadcastClaim.commit).not.toHaveBeenCalled();
    expect(mainClaim.commit).toHaveBeenCalledTimes(1);
    expect(susanClaim.commit).not.toHaveBeenCalled();

    await deferredLifecycle?.onAdopted();

    expect(susanClaim.commit).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(broadcastClaim.commit).toHaveBeenCalledTimes(1);
  });

  it("skips unknown agents not in agents.list", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-unknown-agent",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    const sessionKey =
      typeof builtInboundContextCalls[0]?.SessionKey === "string"
        ? builtInboundContextCalls[0].SessionKey
        : "";
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
