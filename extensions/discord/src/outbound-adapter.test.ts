// Discord tests cover outbound adapter plugin behavior.
import {
  adaptMessagePresentationForChannel,
  renderMessagePresentationFallbackText,
} from "openclaw/plugin-sdk/interactive-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordOutboundHoisted,
  expectDiscordThreadBotSend,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let normalizeDiscordOutboundTarget: typeof import("./normalize.js").normalizeDiscordOutboundTarget;
let discordOutbound: typeof import("./outbound-adapter.js").discordOutbound;
let beginDiscordInboundEventDeliveryCorrelation: typeof import("./inbound-event-delivery.js").beginDiscordInboundEventDeliveryCorrelation;

type MockCallSource = { mock: { calls: Array<Array<unknown>> } };

function mockCall(source: MockCallSource, label: string, callIndex = 0): Array<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  return call;
}

function mockObjectArg(
  source: MockCallSource,
  label: string,
  callIndex: number,
  argIndex: number,
): Record<string, unknown> {
  const value = mockCall(source, label, callIndex)[argIndex];
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} call ${callIndex} argument ${argIndex} to be an object`);
  }
  return value as Record<string, unknown>;
}

beforeAll(async () => {
  ({ normalizeDiscordOutboundTarget } = await import("./normalize.js"));
  ({ discordOutbound } = await import("./outbound-adapter.js"));
  ({ beginDiscordInboundEventDeliveryCorrelation } = await import("./inbound-event-delivery.js"));
});

describe("normalizeDiscordOutboundTarget", () => {
  it("normalizes bare numeric IDs to channel: prefix", () => {
    expect(normalizeDiscordOutboundTarget("1470130713209602050")).toEqual({
      ok: true,
      to: "channel:1470130713209602050",
    });
  });

  it("passes through channel: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("channel:123")).toEqual({ ok: true, to: "channel:123" });
  });

  it("passes through user: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("user:123")).toEqual({ ok: true, to: "user:123" });
  });

  it("passes through channel name strings", () => {
    expect(normalizeDiscordOutboundTarget("general")).toEqual({ ok: true, to: "general" });
  });

  it("returns error for empty target", () => {
    expect(normalizeDiscordOutboundTarget("").ok).toBe(false);
  });

  it("returns error for undefined target", () => {
    expect(normalizeDiscordOutboundTarget(undefined).ok).toBe(false);
  });

  it("trims whitespace", () => {
    expect(normalizeDiscordOutboundTarget("  123  ")).toEqual({ ok: true, to: "channel:123" });
  });

  it("normalizes bare IDs in allowFrom to user: targets", () => {
    expect(normalizeDiscordOutboundTarget("1470130713209602050", ["1470130713209602050"])).toEqual({
      ok: true,
      to: "user:1470130713209602050",
    });
  });
});

describe("discordOutbound", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
  });

  it("routes text sends to thread target when threadId is provided", async () => {
    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "hello",
      accountId: "default",
      threadId: "thread-1",
    });

    expectDiscordThreadBotSend({
      hoisted,
      text: "hello",
      result,
    });
  });

  it("sanitizes internal runtime scaffolding before Discord delivery", () => {
    expect(
      discordOutbound.sanitizeText?.({
        text: "<previous_response>null</previous_response>visible",
        payload: { text: "<previous_response>null</previous_response>visible" },
      }),
    ).toBe("visible");
  });

  it("uses allowFrom to disambiguate bare numeric DM delivery targets", () => {
    expect(
      discordOutbound.resolveTarget?.({
        to: "1470130713209602050",
        allowFrom: ["1470130713209602050"],
      }),
    ).toEqual({
      ok: true,
      to: "user:1470130713209602050",
    });
  });

  it("preserves Discord-native angle markup while stripping internal scaffolding", () => {
    expect(
      discordOutbound.sanitizeText?.({
        text: "soon <t:1710000000:R> run </deploy:123> <previous_response>null</previous_response>",
        payload: {
          text: "soon <t:1710000000:R> run </deploy:123> <previous_response>null</previous_response>",
        },
      }),
    ).toBe("soon <t:1710000000:R> run </deploy:123> ");
  });

  it("forwards explicit formatting options to Discord text sends", async () => {
    await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:123456",
      text: "formatted",
      accountId: "default",
      formatting: {
        textLimit: 1234,
        maxLinesPerMessage: 7,
        tableMode: "off",
        chunkMode: "newline",
      },
    });

    const call = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord");
    expect(call[0]).toBe("channel:123456");
    expect(call[1]).toBe("formatted");
    const options = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2);
    expect(options.textLimit).toBe(1234);
    expect(options.maxLinesPerMessage).toBe(7);
    expect(options.tableMode).toBe("off");
    expect(options.chunkMode).toBe("newline");
  });

  it.each([500, 429])(
    "does not replay an injected Discord delivery after status %i",
    async (status) => {
      hoisted.sendMessageDiscordMock
        .mockRejectedValueOnce(Object.assign(new Error(`discord ${status}`), { status }))
        .mockResolvedValueOnce({
          messageId: "msg-retry-ok",
          channelId: "ch-1",
        });

      await expect(
        discordOutbound.sendText?.({
          cfg: {
            channels: {
              discord: {
                token: "test-token",
                retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
              },
            },
          },
          to: "channel:123456",
          text: "do not replay me",
          accountId: "default",
        }),
      ).rejects.toThrow(`discord ${status}`);

      expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledTimes(1);
    },
  );

  it("uses webhook persona delivery for bound thread text replies", async () => {
    mockDiscordBoundThreadManager(hoisted);
    const cfg = {
      channels: {
        discord: {
          token: "resolved-token",
        },
      },
    };

    const result = await discordOutbound.sendText?.({
      cfg,
      to: "channel:parent-1",
      text: "hello from persona",
      accountId: "default",
      threadId: "thread-1",
      replyToId: "reply-1",
      identity: {
        name: "Codex",
        avatarUrl: "https://example.com/avatar.png",
      },
    });

    const call = mockCall(hoisted.sendWebhookMessageDiscordMock, "sendWebhookMessageDiscord");
    expect(call[0]).toBe("hello from persona");
    const options = mockObjectArg(
      hoisted.sendWebhookMessageDiscordMock,
      "sendWebhookMessageDiscord",
      0,
      1,
    );
    expect(options.webhookId).toBe("wh-1");
    expect(options.webhookToken).toBe("tok-1");
    expect(options.accountId).toBe("default");
    expect(options.threadId).toBe("thread-1");
    expect(options.replyTo).toBe("reply-1");
    expect(options.username).toBe("Codex");
    expect(options.avatarUrl).toBe("https://example.com/avatar.png");
    expect(options.cfg).toBe(cfg);
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-webhook-1",
      channelId: "thread-1",
    });
  });

  it("keeps webhook persona usernames on a UTF-16 boundary", async () => {
    mockDiscordBoundThreadManager(hoisted);

    await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "hello from persona",
      accountId: "default",
      threadId: "thread-1",
      identity: { name: `${"a".repeat(79)}🚀tail` },
    });

    const options = mockObjectArg(
      hoisted.sendWebhookMessageDiscordMock,
      "sendWebhookMessageDiscord",
      0,
      1,
    );
    expect(options.username).toBe("a".repeat(79));
  });

  it("falls back to bot send for silent delivery on bound threads", async () => {
    mockDiscordBoundThreadManager(hoisted);

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "silent update",
      accountId: "default",
      threadId: "thread-1",
      silent: true,
    });

    expect(hoisted.sendWebhookMessageDiscordMock).not.toHaveBeenCalled();
    expectDiscordThreadBotSend({
      hoisted,
      text: "silent update",
      result,
      options: { silent: true },
    });
  });

  it("falls back to bot send when webhook send fails", async () => {
    mockDiscordBoundThreadManager(hoisted);
    hoisted.sendWebhookMessageDiscordMock.mockRejectedValueOnce(new Error("rate limited"));

    const result = await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:parent-1",
      text: "fallback",
      accountId: "default",
      threadId: "thread-1",
    });

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledTimes(1);
    expectDiscordThreadBotSend({
      hoisted,
      text: "fallback",
      result,
    });
  });

  it("routes poll sends to thread target when threadId is provided", async () => {
    const result = await discordOutbound.sendPoll?.({
      cfg: {},
      to: "channel:parent-1",
      poll: {
        question: "Best snack?",
        options: ["banana", "apple"],
      },
      accountId: "default",
      threadId: "thread-1",
    });

    const call = mockCall(hoisted.sendPollDiscordMock, "sendPollDiscord");
    expect(call[0]).toBe("channel:thread-1");
    expect(call[1]).toEqual({
      question: "Best snack?",
      options: ["banana", "apple"],
    });
    expect(mockObjectArg(hoisted.sendPollDiscordMock, "sendPollDiscord", 0, 2).accountId).toBe(
      "default",
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "poll-1",
      channelId: "ch-1",
    });
  });

  it("routes audioAsVoice payloads through the Discord voice send helper", async () => {
    const onDeliveryResult = vi.fn();
    hoisted.sendMessageDiscordMock.mockImplementation(
      async (_to: unknown, _text: unknown, options: unknown) => {
        const deliveryResult = { messageId: "msg-1", channelId: "ch-1" };
        const onProgress = (options as { onDeliveryResult?: (result: unknown) => Promise<void> })
          .onDeliveryResult;
        await onProgress?.(deliveryResult);
        return deliveryResult;
      },
    );
    const result = await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "voice note",
        mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.png"],
        audioAsVoice: true,
      },
      accountId: "default",
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
      onDeliveryResult,
    });

    const voiceCall = mockCall(hoisted.sendVoiceMessageDiscordMock, "sendVoiceMessageDiscord");
    expect(voiceCall[0]).toBe("channel:123456");
    expect(voiceCall[1]).toBe("https://example.com/voice.ogg");
    const voiceOptions = mockObjectArg(
      hoisted.sendVoiceMessageDiscordMock,
      "sendVoiceMessageDiscord",
      0,
      2,
    );
    expect(voiceOptions.accountId).toBe("default");
    expect(voiceOptions.reply).toEqual({ messageId: "reply-1", scope: "first" });

    const messageCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0);
    expect(messageCall[0]).toBe("channel:123456");
    expect(messageCall[1]).toBe("voice note");
    const messageOptions = mockObjectArg(
      hoisted.sendMessageDiscordMock,
      "sendMessageDiscord",
      0,
      2,
    );
    expect(messageOptions.accountId).toBe("default");
    expect(messageOptions.reply).toBeUndefined();

    const mediaCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1);
    expect(mediaCall[0]).toBe("channel:123456");
    expect(mediaCall[1]).toBe("");
    const mediaOptions = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1, 2);
    expect(mediaOptions.accountId).toBe("default");
    expect(mediaOptions.mediaUrl).toBe("https://example.com/extra.png");
    expect(mediaOptions.reply).toBeUndefined();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      channelId: "ch-1",
    });
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual([
      "voice-1",
      "msg-1",
      "msg-1",
    ]);
  });

  it("uses a single implicit reply on audioAsVoice sends when replyToMode is batched", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "voice note",
        mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.png"],
        audioAsVoice: true,
      },
      accountId: "default",
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "batched",
    });

    expect(
      mockObjectArg(hoisted.sendVoiceMessageDiscordMock, "sendVoiceMessageDiscord", 0, 2).reply,
    ).toEqual({ messageId: "reply-1", scope: "first" });
    expect(
      hoisted.sendMessageDiscordMock.mock.calls.map(
        (call) => (call[2] as { reply?: unknown } | undefined)?.reply,
      ),
    ).toEqual([undefined, undefined]);
  });

  it.each([
    {
      name: "visible text",
      payload: {
        text: "voice note",
        mediaUrls: ["https://example.com/voice.ogg"],
        audioAsVoice: true,
      },
      expectedText: "voice note",
    },
    {
      name: "TTS supplement text",
      payload: {
        mediaUrls: ["https://example.com/voice.ogg"],
        audioAsVoice: true,
        ttsSupplement: {
          spokenText: "spoken answer",
        },
      },
      expectedText: "spoken answer",
    },
  ])("falls back to $name when audioAsVoice delivery fails", async ({ payload, expectedText }) => {
    hoisted.sendVoiceMessageDiscordMock.mockRejectedValueOnce(new Error("ffmpeg unavailable"));

    const result = await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload,
      accountId: "default",
      replyToId: "reply-1",
      replyToMode: "first",
    });

    expect(hoisted.sendVoiceMessageDiscordMock).toHaveBeenCalledOnce();
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledOnce();
    const messageCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0);
    expect(messageCall[0]).toBe("channel:123456");
    expect(messageCall[1]).toBe(expectedText);
    expect(mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2).reply).toEqual(
      { messageId: "reply-1", scope: "first" },
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      channelId: "ch-1",
    });
  });

  it("does not duplicate already-delivered TTS supplement text when audioAsVoice delivery fails", async () => {
    hoisted.sendVoiceMessageDiscordMock.mockRejectedValueOnce(new Error("ffmpeg unavailable"));

    const result = await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        mediaUrls: ["https://example.com/voice.ogg"],
        audioAsVoice: true,
        ttsSupplement: {
          spokenText: "spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      },
      accountId: "default",
      replyToId: "reply-1",
      replyToMode: "first",
    });

    expect(hoisted.sendVoiceMessageDiscordMock).toHaveBeenCalledOnce();
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channel: "discord",
      messageId: "",
      channelId: "channel:123456",
      receipt: {
        platformMessageIds: [],
        parts: [],
      },
    });
  });

  it("does not treat delivery progress failures as voice delivery failures", async () => {
    await expect(
      discordOutbound.sendPayload?.({
        cfg: {},
        to: "channel:123456",
        text: "",
        payload: {
          text: "voice note",
          mediaUrls: ["https://example.com/voice.ogg"],
          audioAsVoice: true,
        },
        accountId: "default",
        onDeliveryResult: async () => {
          throw new Error("progress unavailable");
        },
      }),
    ).rejects.toThrow("progress unavailable");

    expect(hoisted.sendVoiceMessageDiscordMock).toHaveBeenCalledOnce();
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("keeps replyToId on every internal audioAsVoice send when replyToMode is all", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "voice note",
        mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.png"],
        audioAsVoice: true,
      },
      accountId: "default",
      replyToId: "reply-1",
      replyToMode: "all",
    });

    expect(
      mockObjectArg(hoisted.sendVoiceMessageDiscordMock, "sendVoiceMessageDiscord", 0, 2).reply,
    ).toEqual({ messageId: "reply-1", scope: "all" });
    expect(
      hoisted.sendMessageDiscordMock.mock.calls.map(
        (call) => (call[2] as { reply?: unknown } | undefined)?.reply,
      ),
    ).toEqual([
      { messageId: "reply-1", scope: "all" },
      { messageId: "reply-1", scope: "all" },
    ]);
  });

  it("preserves explicit audioAsVoice payload replies when replyToMode is off", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "voice note",
        mediaUrls: ["https://example.com/voice.ogg", "https://example.com/extra.png"],
        audioAsVoice: true,
      },
      accountId: "default",
      replyToId: "explicit-reply-1",
      replyToMode: "off",
    });

    expect(
      mockObjectArg(hoisted.sendVoiceMessageDiscordMock, "sendVoiceMessageDiscord", 0, 2).reply,
    ).toEqual({ messageId: "explicit-reply-1", scope: "all" });
    expect(
      hoisted.sendMessageDiscordMock.mock.calls.map(
        (call) => (call[2] as { reply?: unknown } | undefined)?.reply,
      ),
    ).toEqual([
      { messageId: "explicit-reply-1", scope: "all" },
      { messageId: "explicit-reply-1", scope: "all" },
    ]);
  });

  it.each([
    {
      name: "implicit first-mode",
      mediaUrl: "/tmp/render.mp4",
      replyToIdSource: "implicit" as const,
      replyToMode: "first" as const,
      expectedReplies: [{ messageId: "reply-1", scope: "first" }, undefined],
    },
    {
      name: "implicit all-mode",
      mediaUrl: "/tmp/render.mp4",
      replyToIdSource: "implicit" as const,
      replyToMode: "all" as const,
      expectedReplies: [
        { messageId: "reply-1", scope: "all" },
        { messageId: "reply-1", scope: "all" },
      ],
    },
    {
      name: "explicit first-mode",
      mediaUrl: "/tmp/render.mp4",
      replyToIdSource: "explicit" as const,
      replyToMode: "first" as const,
      expectedReplies: [
        { messageId: "reply-1", scope: "all" },
        { messageId: "reply-1", scope: "all" },
      ],
    },
    {
      name: "encoded URL extension",
      mediaUrl: "https://cdn.discordapp.com/attachments/1/render%2Emp4?ex=1",
      replyToIdSource: "explicit" as const,
      replyToMode: "first" as const,
      expectedReplies: [
        { messageId: "reply-1", scope: "all" },
        { messageId: "reply-1", scope: "all" },
      ],
    },
  ])("sends $name video captions before media with the expected replies", async (testCase) => {
    await discordOutbound.sendMedia?.({
      cfg: {},
      to: "channel:123456",
      text: "rendered clip",
      mediaUrl: testCase.mediaUrl,
      accountId: "default",
      replyToId: "reply-1",
      replyToIdSource: testCase.replyToIdSource,
      replyToMode: testCase.replyToMode,
    });

    const captionCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0);
    expect(captionCall[0]).toBe("channel:123456");
    expect(captionCall[1]).toBe("rendered clip");
    const captionOptions = mockObjectArg(
      hoisted.sendMessageDiscordMock,
      "sendMessageDiscord",
      0,
      2,
    );
    expect(captionOptions.accountId).toBe("default");
    expect(captionOptions.reply).toEqual(testCase.expectedReplies[0]);

    const mediaCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1);
    expect(mediaCall[0]).toBe("channel:123456");
    expect(mediaCall[1]).toBe("");
    const mediaOptions = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1, 2);
    expect(mediaOptions.accountId).toBe("default");
    expect(mediaOptions.mediaUrl).toBe(testCase.mediaUrl);
    expect(mediaOptions.reply).toEqual(testCase.expectedReplies[1]);
  });

  it("marks implicit first-mode media sends for first-chunk native replies only", async () => {
    await discordOutbound.sendMedia?.({
      cfg: {},
      to: "channel:123456",
      text: "caption\nfollow-up",
      mediaUrl: "https://example.com/photo.png",
      accountId: "default",
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
      formatting: { maxLinesPerMessage: 1 },
    });

    const options = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2);
    expect(options.reply).toEqual({ messageId: "reply-1", scope: "first" });
  });

  it("touches bound thread activity after shared outbound delivery succeeds", async () => {
    const touchThread = vi.fn();
    hoisted.getThreadBindingManagerMock.mockReturnValue({
      getByThreadId: () => ({ threadId: "thread-1" }),
      touchThread,
    });

    await discordOutbound.afterDeliverPayload?.({
      cfg: {},
      target: {
        channel: "discord",
        to: "channel:parent-1",
        accountId: "default",
        threadId: "thread-1",
      },
      payload: { text: "delivered" },
      results: [{ channel: "discord", messageId: "msg-1" }],
    });

    expect(touchThread).toHaveBeenCalledWith({ threadId: "thread-1" });
  });

  it("notifies inbound event delivery after shared outbound delivery succeeds", async () => {
    const markDelivered = vi.fn();
    const end = beginDiscordInboundEventDeliveryCorrelation(
      "agent:main:discord:channel:c1",
      {
        outboundTo: "thread-1",
        outboundAccountId: "default",
        markInboundEventDelivered: markDelivered,
      },
      { inboundEventKind: "room_event" },
    );

    try {
      await discordOutbound.afterDeliverPayload?.({
        cfg: {},
        target: {
          channel: "discord",
          to: "channel:parent-1",
          accountId: "default",
          threadId: "thread-1",
        },
        payload: {
          text: "delivered",
          channelData: {
            discord: {
              __openclawInboundEventDelivery: {
                sessionKey: "agent:main:discord:channel:c1",
                inboundEventKind: "room_event",
              },
            },
          },
        },
        results: [{ channel: "discord", messageId: "msg-1" }],
      });
    } finally {
      end();
    }

    expect(markDelivered).toHaveBeenCalledTimes(1);
  });

  it("sends component payload media sequences with the component message first", async () => {
    hoisted.sendDiscordComponentMessageMock.mockResolvedValueOnce({
      messageId: "component-1",
      channelId: "ch-1",
    });
    hoisted.sendMessageDiscordMock.mockResolvedValueOnce({
      messageId: "msg-2",
      channelId: "ch-1",
    });

    const payload = await discordOutbound.renderPresentation?.({
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
      },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
      },
      ctx: {
        cfg: {},
        to: "channel:123456",
      },
    } as never);

    if (!payload) {
      throw new Error("expected Discord presentation payload");
    }

    const result = await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload,
      accountId: "default",
      mediaLocalRoots: ["/tmp/media"],
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    const componentCall = mockCall(
      hoisted.sendDiscordComponentMessageMock,
      "sendDiscordComponentMessage",
    );
    expect(componentCall[0]).toBe("channel:123456");
    expect(
      mockObjectArg(hoisted.sendDiscordComponentMessageMock, "sendDiscordComponentMessage", 0, 1)
        .text,
    ).toBe("hello");
    const componentOptions = mockObjectArg(
      hoisted.sendDiscordComponentMessageMock,
      "sendDiscordComponentMessage",
      0,
      2,
    );
    expect(componentOptions.mediaUrl).toBe("https://example.com/1.png");
    expect(componentOptions.mediaLocalRoots).toEqual(["/tmp/media"]);
    expect(componentOptions.accountId).toBe("default");
    expect(componentOptions.reply).toEqual({ messageId: "reply-1", scope: "first" });

    const messageCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord");
    expect(messageCall[0]).toBe("channel:123456");
    expect(messageCall[1]).toBe("");
    const messageOptions = mockObjectArg(
      hoisted.sendMessageDiscordMock,
      "sendMessageDiscord",
      0,
      2,
    );
    expect(messageOptions.mediaUrl).toBe("https://example.com/2.png");
    expect(messageOptions.mediaLocalRoots).toEqual(["/tmp/media"]);
    expect(messageOptions.accountId).toBe("default");
    expect(messageOptions.reply).toBeUndefined();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-2",
      channelId: "ch-1",
    });
  });

  it("preserves disabled presentation buttons through channel adaptation", async () => {
    const adaptedPresentation = adaptMessagePresentationForChannel({
      capabilities: discordOutbound.presentationCapabilities,
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Already handled", value: "done", disabled: true },
              { label: "Open docs", url: "https://example.com/docs", disabled: true },
            ],
          },
        ],
      },
    });

    const payload = await discordOutbound.renderPresentation?.({
      payload: { text: "Action state" },
      presentation: adaptedPresentation,
      ctx: {
        cfg: {},
        to: "channel:123456",
      },
    } as never);

    if (!payload) {
      throw new Error("expected Discord presentation payload");
    }

    const discordData = payload.channelData?.discord as
      | { presentationComponents?: { blocks?: Array<{ type?: string; buttons?: unknown[] }> } }
      | undefined;
    const buttons = discordData?.presentationComponents?.blocks?.find(
      (block) => block.type === "actions",
    )?.buttons;

    expect(buttons?.[0]).toEqual({
      label: "Already handled",
      style: "secondary",
      callbackData: "done",
      disabled: true,
    });
    expect(buttons?.[1]).toEqual({
      label: "Open docs",
      style: "link",
      url: "https://example.com/docs",
      disabled: true,
    });
  });

  it("falls back to chunked text when a table exceeds the Discord component envelope", async () => {
    const table = {
      type: "table" as const,
      caption: "Large pipeline",
      headers: ["Account", "Stage"],
      rows: Array.from({ length: 900 }, (_entry, index) => [
        `account-${String(index)}-${"x".repeat(80)}`,
        "Review",
      ]),
    };
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          table,
          {
            type: "buttons",
            buttons: [{ label: "Continue", action: { type: "command", command: "/continue" } }],
          },
        ],
      },
      capabilities: discordOutbound.presentationCapabilities,
    });

    const rendered = await discordOutbound.renderPresentation?.({
      payload: {},
      presentation,
      ctx: { cfg: {}, to: "channel:123456" },
    } as never);
    const fallbackText = renderMessagePresentationFallbackText({ presentation });
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: fallbackText,
      payload: { text: fallbackText },
      accountId: "default",
    });
    const textChunks = hoisted.sendMessageDiscordMock.mock.calls.map((call) => String(call[1]));
    const deliveredText = textChunks.join("\n");

    expect(presentation.blocks.length).toBeGreaterThan(40);
    expect(rendered).toBeNull();
    expect(hoisted.sendDiscordComponentMessageMock).not.toHaveBeenCalled();
    expect(textChunks.length).toBeGreaterThan(1);
    expect(deliveredText).toContain("account-0-");
    expect(deliveredText).toContain("account-899-");
    expect(deliveredText).toContain("Continue: `/continue`");
  });

  it("counts nested Discord components against the 40-component limit", async () => {
    const buttons = Array.from({ length: 25 }, (_entry, index) => ({
      label: `Action ${String(index)}`,
      value: `action-${String(index)}`,
    }));
    const buildPresentation = (textBlockCount: number) => ({
      title: "At limit",
      blocks: [
        ...Array.from({ length: textBlockCount }, (_entry, index) => ({
          type: "text" as const,
          text: `Detail ${String(index)}`,
        })),
        { type: "buttons" as const, buttons },
      ],
    });

    const atLimit = await discordOutbound.renderPresentation?.({
      payload: {},
      presentation: buildPresentation(8),
      ctx: { cfg: {}, to: "channel:123456" },
    } as never);
    const overLimit = await discordOutbound.renderPresentation?.({
      payload: {},
      presentation: buildPresentation(9),
      ctx: { cfg: {}, to: "channel:123456" },
    } as never);

    expect(atLimit).not.toBeNull();
    expect(overLimit).toBeNull();
  });

  it("keeps replyToId on every internal component media send when replyToMode is all", async () => {
    const payload = await discordOutbound.renderPresentation?.({
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
      },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
      },
      ctx: {
        cfg: {},
        to: "channel:123456",
      },
    } as never);

    if (!payload) {
      throw new Error("expected Discord presentation payload");
    }

    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload,
      accountId: "default",
      replyToId: "reply-1",
      replyToMode: "all",
    });

    expect(
      mockObjectArg(hoisted.sendDiscordComponentMessageMock, "sendDiscordComponentMessage", 0, 2)
        .reply,
    ).toEqual({ messageId: "reply-1", scope: "all" });
    expect(mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2).reply).toEqual(
      { messageId: "reply-1", scope: "all" },
    );
  });

  it("sends prepared native Discord payload data through outbound delivery", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "hello",
        mediaUrl: "https://example.com/photo.png",
        channelData: {
          discord: {
            components: [{ type: 1, components: [] }],
            filename: "photo.png",
          },
        },
      },
      accountId: "default",
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    const call = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord");
    expect(call[0]).toBe("channel:123456");
    expect(call[1]).toBe("hello");
    const options = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2);
    expect(options.mediaUrl).toBe("https://example.com/photo.png");
    expect(options.components).toEqual([{ type: 1, components: [] }]);
    expect(options.filename).toBe("photo.png");
    expect(options.accountId).toBe("default");
    expect(options.reply).toEqual({ messageId: "reply-1", scope: "first" });
  });

  it("preserves explicit component payload replies when replyToMode is off", async () => {
    const payload = await discordOutbound.renderPresentation?.({
      payload: {
        text: "hello",
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
      },
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
      },
      ctx: {
        cfg: {},
        to: "channel:123456",
      },
    } as never);

    if (!payload) {
      throw new Error("expected Discord presentation payload");
    }

    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload,
      accountId: "default",
      replyToId: "explicit-reply-1",
      replyToMode: "off",
    });

    expect(
      mockObjectArg(hoisted.sendDiscordComponentMessageMock, "sendDiscordComponentMessage", 0, 2)
        .reply,
    ).toEqual({ messageId: "explicit-reply-1", scope: "all" });
    expect(mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2).reply).toEqual(
      { messageId: "explicit-reply-1", scope: "all" },
    );
  });

  it("uses explicit maxLinesPerMessage in its adapter chunker", () => {
    expect(
      discordOutbound.chunker?.("line one\nline two\nline three", 2000, {
        formatting: { maxLinesPerMessage: 1 },
      }),
    ).toEqual(["line one", "line two", "line three"]);
  });

  it("renders channelData Discord components on payload sends", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "native component text",
        channelData: {
          discord: {
            components: {
              blocks: [{ type: "text", text: "Native component body" }],
            },
          },
        },
      },
      accountId: "default",
    });

    const call = mockCall(hoisted.sendDiscordComponentMessageMock, "sendDiscordComponentMessage");
    expect(call[0]).toBe("channel:123456");
    const payload = mockObjectArg(
      hoisted.sendDiscordComponentMessageMock,
      "sendDiscordComponentMessage",
      0,
      1,
    );
    expect(payload.text).toBe("native component text");
    expect(payload.blocks).toEqual([{ type: "text", text: "Native component body" }]);
    expect(
      mockObjectArg(hoisted.sendDiscordComponentMessageMock, "sendDiscordComponentMessage", 0, 2)
        .accountId,
    ).toBe("default");
    expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
  });

  it("neutralizes approval mentions only for approval payloads", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "Approval @everyone <@123> <#456>",
        channelData: {
          execApproval: {
            approvalId: "req-1",
            approvalSlug: "req-1",
          },
        },
      },
      accountId: "default",
    });

    const call = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord");
    expect(call[0]).toBe("channel:123456");
    expect(call[1]).toBe("Approval @\u200beveryone <@\u200b123> <#\u200b456>");
    expect(
      mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2).accountId,
    ).toBe("default");
  });

  it("uses a single implicit reply for chunked approval payload fallbacks", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "line one\nline two",
        channelData: {
          execApproval: {
            approvalId: "req-1",
            approvalSlug: "req-1",
          },
        },
      },
      accountId: "default",
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
      formatting: { maxLinesPerMessage: 1 },
    });

    expect(
      hoisted.sendMessageDiscordMock.mock.calls.map(
        (call) => (call[2] as { reply?: unknown } | undefined)?.reply,
      ),
    ).toEqual([{ messageId: "reply-1", scope: "first" }, undefined]);
  });

  it.each([
    { name: "implicit", replyToIdSource: "implicit" as const, scope: "first" as const },
    { name: "source-omitted", replyToIdSource: undefined, scope: "first" as const },
    { name: "explicit", replyToIdSource: "explicit" as const, scope: "all" as const },
  ])("sets $name first-mode text chunk fanout", async (testCase) => {
    await discordOutbound.sendText?.({
      cfg: {},
      to: "channel:123456",
      text: "line one\nline two",
      accountId: "default",
      replyToId: "reply-1",
      replyToIdSource: testCase.replyToIdSource,
      replyToMode: "first",
      formatting: { maxLinesPerMessage: 1 },
    });

    const options = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2);
    expect(options.reply).toEqual({ messageId: "reply-1", scope: testCase.scope });
  });

  it("leaves non-approval mentions unchanged", async () => {
    await discordOutbound.sendPayload?.({
      cfg: {},
      to: "channel:123456",
      text: "",
      payload: {
        text: "Hello @everyone",
      },
      accountId: "default",
    });

    const call = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord");
    expect(call[0]).toBe("channel:123456");
    expect(call[1]).toBe("Hello @everyone");
    expect(
      mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2).accountId,
    ).toBe("default");
  });
});
