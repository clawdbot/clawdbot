// Covers core message-action send fallback, TTS application, and durable send
// policy after plugin preparation is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: ttsMocks.maybeApplyTtsToPayload,
}));

function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error(`expected ${label} input to be an object`);
  }
  return arg as Record<string, unknown>;
}

const slackConfig = {
  channels: {
    slack: {
      enabled: true,
    },
  },
} as OpenClawConfig;

function registerSlackTextPlugin(accountIds: string[] = ["default"]) {
  const sendText = vi.fn().mockResolvedValue({
    channel: "slack",
    messageId: "m1",
    chatId: "C123",
  });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        source: "test",
        plugin: {
          ...createOutboundTestPlugin({
            id: "slack",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
          config: {
            listAccountIds: () => accountIds,
            resolveAccount: () => ({ enabled: true }),
            isConfigured: () => true,
          },
        },
      },
    ]),
  );
  return sendText;
}

describe("runMessageAction core send routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    ttsMocks.maybeApplyTtsToPayload
      .mockReset()
      .mockImplementation(async (params: { payload: unknown }) => params.payload);
  });

  it("promotes caption to message for media sends when message is empty", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m1",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({
                channel: "testchat",
                messageId: "t1",
                chatId: "c1",
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        testchat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        media: "https://example.com/cat.png",
        caption: "caption-only text",
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendMedia).toHaveBeenCalledOnce();
    const mediaInput = firstMockArg(sendMedia, "send media");
    expect(mediaInput.text).toBe("caption-only text");
    expect(mediaInput.mediaUrl).toBe("https://example.com/cat.png");
  });

  it("does not misclassify send as poll when zero-valued poll params are present", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m2",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn().mockResolvedValue({
                channel: "testchat",
                messageId: "t2",
                chatId: "c1",
              }),
              sendMedia,
            },
          }),
        },
      ]),
    );
    const cfg = {
      channels: {
        testchat: {
          enabled: true,
        },
      },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        media: "https://example.com/file.txt",
        message: "hello",
        pollDurationHours: 0,
        pollDurationSeconds: 60,
        pollMulti: false,
        pollPublic: true,
        pollAnonymous: false,
        pollOptionIndex: 0,
        pollQuestion: "",
        pollOption: [],
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendMedia).toHaveBeenCalledOnce();
    const mediaInput = firstMockArg(sendMedia, "send media");
    expect(mediaInput.text).toBe("hello");
    expect(mediaInput.mediaUrl).toBe("https://example.com/file.txt");
  });

  it("accepts Telegram numeric forum topic targets through plugin-owned grammar", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(),
            },
            messaging: {
              normalizeTarget: (raw) =>
                raw === "-1001234567890:topic:42" ? "telegram:-1001234567890:topic:42" : undefined,
              targetResolver: {
                looksLikeId: (raw) => raw === "-1001234567890:topic:42",
              },
            },
          }),
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: {
        channels: {
          telegram: {
            botToken: "123:test",
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "telegram",
        target: "-1001234567890:topic:42",
        message: "topic hello",
      },
      dryRun: true,
    });

    if (result.kind !== "send") {
      throw new Error(`Expected send result, got ${result.kind}`);
    }
    const payload = result.payload as { dryRun?: boolean; to?: string };
    expect(result.to).toBe("telegram:-1001234567890:topic:42");
    expect(payload.to).toBe("telegram:-1001234567890:topic:42");
    expect(payload.dryRun).toBe(true);
  });

  it("preserves an explicit provider reply target with its canonical thread root", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "m1",
      chatId: "C1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "testchat",
              outbound: {
                deliveryMode: "direct",
                sendText,
              },
            }),
            threading: {
              resolveAutoThreadId: ({
                toolContext,
                replyToId,
              }: {
                toolContext?: {
                  currentMessageId?: string | number;
                  currentThreadTs?: string;
                };
                replyToId?: string | null;
              }) =>
                replyToId === toolContext?.currentMessageId
                  ? toolContext?.currentThreadTs
                  : undefined,
              resolveReplyTransport: ({
                threadId,
                replyToId,
              }: {
                threadId?: string | number | null;
                replyToId?: string | null;
              }) => {
                const root = replyToId ?? (threadId == null ? undefined : String(threadId));
                return { replyToId: root, threadId: root };
              },
            },
          },
        },
      ]),
    );

    await runMessageAction({
      cfg: {
        channels: {
          testchat: {
            enabled: true,
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:C1",
        message: "threaded",
        replyTo: "child-1",
      },
      toolContext: {
        currentChannelProvider: "testchat",
        currentChannelId: "channel:C1",
        currentThreadTs: "root-1",
        currentMessageId: "child-1",
        replyToMode: "all",
      },
      dryRun: false,
    });

    expect(firstMockArg(sendText, "send text")).toMatchObject({
      replyToId: "child-1",
      threadId: "root-1",
    });
  });

  it("uses best-effort delivery for implicit message-tool-only source replies", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        message: "visible source reply",
        bestEffort: false,
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      sessionKey: "agent:main:slack:channel:C123",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendText).toHaveBeenCalledOnce();
  });

  it("carries a prepared conversation-turn id to the channel send", async () => {
    const sendText = registerSlackTextPlugin();

    await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "correlated hello",
      },
      preparedMessageId: "platform-message-1",
      dryRun: false,
    });

    expect(firstMockArg(sendText, "send text").preparedMessageId).toBe("platform-message-1");
  });

  it("uses an active gateway-mode adapter directly when the Gateway owns the turn", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "reef-message-1",
      chatId: "molty",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "gateway",
              sendText,
            },
          }),
        },
      ]),
    );

    const result = await runMessageAction({
      cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:C123",
        message: "correlated hello",
      },
      preparedMessageId: "reef-message-1",
      gatewayOwnedDelivery: true,
      dryRun: false,
    });

    expect(sendText).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: "send",
      sendResult: { via: "direct", result: { messageId: "reef-message-1" } },
    });
  });

  it("prepends messages.responsePrefix to message-tool sends", async () => {
    const sendText = registerSlackTextPlugin();

    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true } },
        messages: { responsePrefix: "[Nexus]" },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:OTHER",
        message: "hello world",
      },
      dryRun: false,
    });

    expect(sendText).toHaveBeenCalledOnce();
    expect(firstMockArg(sendText, "send text").text).toBe("[Nexus] hello world");
  });

  it("does not double-apply responsePrefix when the text already carries it", async () => {
    const sendText = registerSlackTextPlugin();

    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true } },
        messages: { responsePrefix: "[Nexus]" },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:OTHER",
        message: "[Nexus] already prefixed",
      },
      dryRun: false,
    });

    expect(sendText).toHaveBeenCalledOnce();
    expect(firstMockArg(sendText, "send text").text).toBe("[Nexus] already prefixed");
  });

  it("leaves media-only sends without a responsePrefix", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "slack",
      messageId: "m1",
      chatId: "C123",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({
              id: "slack",
              outbound: {
                deliveryMode: "direct",
                sendText: vi.fn().mockResolvedValue({
                  channel: "slack",
                  messageId: "t1",
                  chatId: "C123",
                }),
                sendMedia,
              },
            }),
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({ enabled: true }),
              isConfigured: () => true,
            },
          },
        },
      ]),
    );

    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true } },
        messages: { responsePrefix: "[Nexus]" },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:OTHER",
        media: "https://example.com/cat.png",
      },
      dryRun: false,
    });

    expect(sendMedia).toHaveBeenCalledOnce();
    expect(firstMockArg(sendMedia, "send media").text ?? "").toBe("");
  });

  it("resolves identity templates in responsePrefix on message-tool sends", async () => {
    const sendText = registerSlackTextPlugin();

    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true } },
        messages: { responsePrefix: "[{identity.name}]" },
        agents: { list: [{ id: "main", identity: { name: "Nexus" } }] },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:OTHER",
        message: "hello world",
      },
      agentId: "main",
      dryRun: false,
    });

    expect(sendText).toHaveBeenCalledOnce();
    expect(firstMockArg(sendText, "send text").text).toBe("[Nexus] hello world");
  });

  it("skips responsePrefix on tool sends when a model template cannot be resolved", async () => {
    const sendText = registerSlackTextPlugin();

    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true } },
        messages: { responsePrefix: "[{provider}/{model}]" },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:OTHER",
        message: "hello world",
      },
      dryRun: false,
    });

    expect(sendText).toHaveBeenCalledOnce();
    // A tool send performs no live model selection, so the unresolved template is dropped
    // rather than leaked as a literal `{provider}/{model}` prefix.
    expect(firstMockArg(sendText, "send text").text).toBe("hello world");
  });

  it("uses best-effort delivery for explicit current-source message-tool-only replies", async () => {
    const sendText = registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        target: "channel:C123",
        message: "visible current-channel source reply",
        bestEffort: false,
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      sessionKey: "agent:main:slack:channel:C123",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    if (result.kind !== "send") {
      throw new Error(`expected send result, got ${result.kind}`);
    }
    expect(sendText).toHaveBeenCalledOnce();
    expect(result.to).toBe("channel:C123");
  });

  it("marks explicit sends to the trusted current source conversation", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "visible source reply",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("does not trust ambient routing when the authorized source differs", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        message: "not the authorized source",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C999",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not mark same-target sends through another account", async () => {
    registerSlackTextPlugin(["default", "other"]);

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        accountId: "other",
        target: "channel:C123",
        message: "cross-account reply",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("does not mark same-target sends to another thread", async () => {
    registerSlackTextPlugin();

    const result = await runMessageAction({
      cfg: slackConfig,
      action: "send",
      params: {
        channel: "slack",
        target: "channel:C123",
        threadId: "other-thread",
        message: "thread-only reply",
      },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "channel:C123",
        currentThreadTs: "source-thread",
      },
      messageActionAuthorization: {
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
          currentThreadTs: "source-thread",
          currentSourceTurnId: "source-turn-1",
        },
      },
      sessionKey: "agent:main:slack:channel:C123:thread:source-thread",
      defaultAccountId: "default",
      sourceReplyDeliveryMode: "message_tool_only",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("preserves required delivery when message-tool-only sends target another conversation", async () => {
    const sendText = registerSlackTextPlugin();

    await expect(
      runMessageAction({
        cfg: slackConfig,
        action: "send",
        params: {
          target: "channel:C999",
          message: "explicit durable send",
          bestEffort: false,
        },
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
        },
        sessionKey: "agent:main:slack:channel:C123",
        sourceReplyDeliveryMode: "message_tool_only",
        dryRun: false,
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("preserves required delivery when message-tool-only sends to another explicit channel", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "telegram",
      messageId: "m1",
      chatId: "C999",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    await expect(
      runMessageAction({
        cfg: {
          channels: {
            telegram: {
              enabled: true,
            },
          },
          tools: {
            message: {
              crossContext: {
                allowAcrossProviders: true,
              },
            },
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "telegram",
          message: "explicit channel-only durable send",
          bestEffort: false,
        },
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "channel:C123",
        },
        sessionKey: "agent:main:slack:channel:C123",
        sourceReplyDeliveryMode: "message_tool_only",
        dryRun: false,
      }),
    ).rejects.toThrow("missing reconcileUnknownSend");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("applies TTS to message-tool sends before core outbound delivery", async () => {
    const sendMedia = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "voice-1",
      chatId: "c1",
    });
    ttsMocks.maybeApplyTtsToPayload.mockResolvedValueOnce({
      mediaUrl: "file:///tmp/openclaw-voice.ogg",
      audioAsVoice: true,
      spokenText: "hello there",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText: vi.fn(),
              sendMedia,
            },
          }),
        },
      ]),
    );

    await runMessageAction({
      cfg: {
        channels: {
          testchat: {
            enabled: true,
          },
        },
        messages: {
          tts: {
            auto: "tagged",
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "[[tts:text]]hello there[[/tts:text]]",
      },
      sessionKey: "agent:main:testchat:channel:abc",
      dryRun: false,
    });

    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        channel: "testchat",
        payload: expect.objectContaining({
          text: "[[tts:text]]hello there[[/tts:text]]",
        }),
      }),
    );
    expect(sendMedia).toHaveBeenCalledOnce();
    const mediaInput = firstMockArg(sendMedia, "send media");
    expect(mediaInput.text).toBe("");
    expect(mediaInput.mediaUrl).toBe("file:///tmp/openclaw-voice.ogg");
  });

  it("forwards inbound audio context to message-tool TTS", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "text-1",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: {
              deliveryMode: "direct",
              sendText,
            },
          }),
        },
      ]),
    );

    await runMessageAction({
      cfg: {
        channels: {
          testchat: {
            enabled: true,
          },
        },
        messages: {
          tts: {
            auto: "inbound",
          },
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "voice reply",
      },
      sessionKey: "agent:main:testchat:channel:abc",
      inboundAudio: true,
      dryRun: false,
    });

    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        channel: "testchat",
        inboundAudio: true,
        payload: expect.objectContaining({
          text: "voice reply",
        }),
      }),
    );
    expect(sendText).toHaveBeenCalledOnce();
  });
});
