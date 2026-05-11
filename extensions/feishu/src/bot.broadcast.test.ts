import type { EnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import type { FeishuMessageEvent } from "./bot.js";
import { clearGroupNameCache, handleFeishuMessage } from "./bot.js";
import { setFeishuRuntime } from "./runtime.js";

const { mockCreateFeishuReplyDispatcher, mockCreateFeishuClient, mockResolveAgentRoute } =
  vi.hoisted(() => ({
    mockCreateFeishuReplyDispatcher: vi.fn((_params?: unknown) => ({
      dispatcher: {
        sendToolResult: vi.fn(),
        sendBlockReply: vi.fn(),
        sendFinalReply: vi.fn(),
        waitForIdle: vi.fn(),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
    })),
    mockCreateFeishuClient: vi.fn(),
    mockResolveAgentRoute: vi.fn(),
  }));

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

describe("broadcast dispatch", () => {
  const finalizeInboundContextCalls: Array<Record<string, unknown>> = [];
  const mockGetChatInfo = vi.fn();
  const mockFinalizeInboundContext: PluginRuntime["channel"]["reply"]["finalizeInboundContext"] = (
    ctx,
  ) => {
    finalizeInboundContextCalls.push(ctx);
    return {
      ...ctx,
      CommandAuthorized: typeof ctx.CommandAuthorized === "boolean" ? ctx.CommandAuthorized : false,
    };
  };
  const mockDispatchReplyFromConfig = vi
    .fn()
    .mockResolvedValue({ queuedFinal: false, counts: { final: 1 } });
  const mockWithReplyDispatcher: PluginRuntime["channel"]["reply"]["withReplyDispatcher"] = async ({
    dispatcher,
    run,
    onSettled,
  }) => {
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
  };
  const resolveEnvelopeFormatOptionsMock: PluginRuntime["channel"]["reply"]["resolveEnvelopeFormatOptions"] =
    () => ({}) satisfies EnvelopeFormatOptions;
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
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
        recordInboundSession: vi.fn().mockResolvedValue(undefined),
      },
      reply: {
        resolveEnvelopeFormatOptions: resolveEnvelopeFormatOptionsMock,
        formatAgentEnvelope: vi.fn((params: { body: string }) => params.body),
        finalizeInboundContext:
          mockFinalizeInboundContext as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        dispatchReplyFromConfig: mockDispatchReplyFromConfig,
        withReplyDispatcher:
          mockWithReplyDispatcher as unknown as PluginRuntime["channel"]["reply"]["withReplyDispatcher"],
      },
      commands: {
        shouldComputeCommandAuthorized: mockShouldComputeCommandAuthorized,
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
      },
      media: {
        saveMediaBuffer: mockSaveMediaBuffer,
      },
      turn: {
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["turn"]["run"]>[0]) => {
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
          if (!("runDispatch" in turn)) {
            throw new Error("feishu broadcast test runtime only supports prepared turns");
          }
          await turn.recordInboundSession({
            storePath: turn.storePath,
            sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
            ctx: turn.ctxPayload,
            groupResolution: turn.record?.groupResolution,
            createIfMissing: turn.record?.createIfMissing,
            updateLastRoute: turn.record?.updateLastRoute,
            onRecordError: turn.record?.onRecordError ?? (() => undefined),
          });
          return {
            admission: { kind: "dispatch" as const },
            dispatched: true,
            ctxPayload: turn.ctxPayload,
            routeSessionKey: turn.routeSessionKey,
            dispatchResult: await turn.runDispatch(),
          };
        }),
        runPrepared: vi.fn(
          async (turn: Parameters<PluginRuntime["channel"]["turn"]["runPrepared"]>[0]) => {
            await turn.recordInboundSession({
              storePath: turn.storePath,
              sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
              ctx: turn.ctxPayload,
              groupResolution: turn.record?.groupResolution,
              createIfMissing: turn.record?.createIfMissing,
              updateLastRoute: turn.record?.updateLastRoute,
              onRecordError: turn.record?.onRecordError ?? (() => undefined),
            });
            return {
              admission: { kind: "dispatch" as const },
              dispatched: true,
              ctxPayload: turn.ctxPayload,
              routeSessionKey: turn.routeSessionKey,
              dispatchResult: await turn.runDispatch(),
            };
          },
        ),
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
    clearGroupNameCache();
    finalizeInboundContextCalls.length = 0;
    mockResolveAgentRoute.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "default",
      sessionKey: "agent:main:feishu:group:oc-broadcast-group",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
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

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);
    const sessionKeys = finalizeInboundContextCalls.map((call) => call.SessionKey);
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
    expect(
      finalizeInboundContextCalls
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
    const dispatcherParams = mockCreateFeishuReplyDispatcher.mock.calls[0]?.[0] as
      | { agentId?: string }
      | undefined;
    expect(dispatcherParams?.agentId).toBe("main");
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

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
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

    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
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

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(finalizeInboundContextCalls).toHaveLength(1);
    expect(finalizeInboundContextCalls[0]?.SessionKey).toBe(
      "agent:main:feishu:group:oc-broadcast-group",
    );
    expect(finalizeInboundContextCalls[0]?.GroupSubject).toBe("Broadcast Team");
    expect(finalizeInboundContextCalls[0]?.ConversationLabel).toBe("Broadcast Team");
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
    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(2);

    mockDispatchReplyFromConfig.mockClear();
    mockGetChatInfo.mockClear();
    finalizeInboundContextCalls.length = 0;

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
      accountId: "account-B",
    });
    expect(mockDispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
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

    expect(mockDispatchReplyFromConfig).toHaveBeenCalledTimes(1);
    const sessionKey =
      typeof finalizeInboundContextCalls[0]?.SessionKey === "string"
        ? finalizeInboundContextCalls[0].SessionKey
        : "";
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
