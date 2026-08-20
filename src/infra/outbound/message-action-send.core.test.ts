// Covers core message-action send fallback, TTS application, and durable send
// policy after plugin preparation is absent.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
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
          threading: { threadAddressing: "message" },
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
              }: {
                threadId?: string | number | null;
                replyToId?: string | null;
              }) => {
                const root = threadId == null ? undefined : String(threadId);
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
      replyToId: "root-1",
      replyToIdSource: "explicit",
      threadId: "root-1",
    });
  });

  it.each([
    {
      label: "implicit first-mode reply",
      params: {},
      replyToMode: "first" as const,
      expectedReplyIds: ["source-1", undefined],
      expectedSource: "implicit",
      expectedMode: "first",
    },
    {
      label: "implicit all-mode reply",
      params: {},
      replyToMode: "all" as const,
      expectedReplyIds: ["source-1", "source-1"],
      expectedSource: "implicit",
      expectedMode: "all",
    },
    {
      label: "explicit reply while replies are otherwise off",
      params: { replyTo: "explicit-1" },
      replyToMode: "off" as const,
      expectedReplyIds: ["explicit-1", "explicit-1"],
      expectedSource: "explicit",
      expectedMode: undefined,
    },
  ])(
    "carries resolved reply facts through durable chunk fanout for $label",
    async ({ params, replyToMode, expectedReplyIds, expectedSource, expectedMode }) => {
      const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
        channel: "testchat",
        messageId: text,
      }));
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "testchat",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "testchat",
              outbound: {
                deliveryMode: "gateway",
                textChunkLimit: 2,
                chunker: (text, limit) => [text.slice(0, limit), text.slice(limit)],
                sendText,
              },
            }),
          },
        ]),
      );

      await runMessageAction({
        cfg: { channels: { testchat: { enabled: true } } } as OpenClawConfig,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:C1",
          message: "abcd",
          ...params,
        },
        gatewayOwnedDelivery: true,
        toolContext: {
          currentChannelProvider: "testchat",
          currentChannelId: "channel:C1",
          currentMessagingTarget: "channel:C1",
          currentMessageId: "source-1",
          replyToMode,
          hasRepliedRef: { value: false },
        },
        dryRun: false,
      });

      expect(sendText.mock.calls.map(([call]) => call.replyToId)).toEqual(expectedReplyIds);
      expect(sendText.mock.calls[0]?.[0]).toMatchObject({
        replyToIdSource: expectedSource,
        replyToMode: expectedMode,
      });
    },
  );

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

  it("prepends the channel responsePrefix to message-tool sends", async () => {
    const sendText = registerSlackTextPlugin();

    await runMessageAction({
      cfg: {
        channels: { slack: { enabled: true, responsePrefix: "[Nexus]" } },
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
        channels: { slack: { enabled: true, responsePrefix: "[Nexus]" } },
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
        channels: { slack: { enabled: true, responsePrefix: "[Nexus]" } },
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
        channels: { slack: { enabled: true, responsePrefix: "[{identity.name}]" } },
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
        channels: { slack: { enabled: true, responsePrefix: "[{provider}/{model}]" } },
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

  it("preserves structured speech through response prefixes when automatic TTS is off", async () => {
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
            responsePrefix: "[Nexus]",
          },
        },
        tts: {
          auto: "off",
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "Visible greeting",
        voiceText: "hello there",
        voiceProvider: "mock",
        voiceId: "voice-7",
        asVoice: true,
      },
      sessionKey: "agent:main:testchat:channel:abc",
      dryRun: false,
    });

    expect(ttsMocks.maybeApplyTtsToPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        channel: "testchat",
        payload: expect.objectContaining({
          text: "[Nexus] Visible greeting",
          audioAsVoice: true,
        }),
      }),
    );
    const ttsCall = firstMockArg(ttsMocks.maybeApplyTtsToPayload, "TTS payload");
    const ttsPayload = ttsCall.payload;
    expect(typeof ttsPayload === "object" && ttsPayload !== null).toBe(true);
    expect(getReplyPayloadMetadata(ttsPayload as object)?.tts).toEqual({
      tagged: true,
      text: "hello there",
      directives: [
        {
          provider: "mock",
          values: { voiceid: "voice-7" },
        },
      ],
    });
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
        tts: {
          auto: "inbound",
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
