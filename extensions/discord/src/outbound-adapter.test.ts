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

  it.each([500, 429])("retries transient Discord text send status %i", async (status) => {
    hoisted.sendMessageDiscordMock
      .mockRejectedValueOnce(Object.assign(new Error(`discord ${status}`), { status }))
      .mockResolvedValueOnce({
        messageId: "msg-retry-ok",
        channelId: "ch-1",
      });

    const result = await discordOutbound.sendText?.({
      cfg: {
        channels: {
          discord: {
            token: "test-token",
            retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
          },
        },
      },
      to: "channel:123456",
      text: "retry me",
      accountId: "default",
    });

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-retry-ok",
      channelId: "ch-1",
    });
  });

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
      replyToMode: "first",
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
    expect(voiceOptions.replyTo).toBe("reply-1");

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
    expect(messageOptions.replyTo).toBeUndefined();

    const mediaCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1);
    expect(mediaCall[0]).toBe("channel:123456");
    expect(mediaCall[1]).toBe("");
    const mediaOptions = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1, 2);
    expect(mediaOptions.accountId).toBe("default");
    expect(mediaOptions.mediaUrl).toBe("https://example.com/extra.png");
    expect(mediaOptions.replyTo).toBeUndefined();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-1",
      channelId: "ch-1",
    });
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
      mockObjectArg(hoisted.sendVoiceMessageDiscordMock, "sendVoiceMessageDiscord", 0, 2).replyTo,
    ).toBe("reply-1");
    expect(
      hoisted.sendMessageDiscordMock.mock.calls.map(
        (call) => (call[2] as { replyTo?: unknown } | undefined)?.replyTo,
      ),
    ).toEqual(["reply-1", "reply-1"]);
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
      mockObjectArg(hoisted.sendVoiceMessageDiscordMock, "sendVoiceMessageDiscord", 0, 2).replyTo,
    ).toBe("explicit-reply-1");
    expect(
      hoisted.sendMessageDiscordMock.mock.calls.map(
        (call) => (call[2] as { replyTo?: unknown } | undefined)?.replyTo,
      ),
    ).toEqual(["explicit-reply-1", "explicit-reply-1"]);
  });

  it("sends video captions as text before a media-only video follow-up", async () => {
    await discordOutbound.sendMedia?.({
      cfg: {},
      to: "channel:123456",
      text: "rendered clip",
      mediaUrl: "/tmp/render.mp4",
      accountId: "default",
      replyToId: "reply-1",
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
    expect(captionOptions.replyTo).toBe("reply-1");

    const mediaCall = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1);
    expect(mediaCall[0]).toBe("channel:123456");
    expect(mediaCall[1]).toBe("");
    const mediaOptions = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 1, 2);
    expect(mediaOptions.accountId).toBe("default");
    expect(mediaOptions.mediaUrl).toBe("/tmp/render.mp4");
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
    expect(componentOptions.replyTo).toBe("reply-1");

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
    expect(messageOptions.replyTo).toBeUndefined();
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-2",
      channelId: "ch-1",
    });
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
        .replyTo,
    ).toBe("reply-1");
    expect(mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2).replyTo).toBe(
      "reply-1",
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
    });

    const call = mockCall(hoisted.sendMessageDiscordMock, "sendMessageDiscord");
    expect(call[0]).toBe("channel:123456");
    expect(call[1]).toBe("hello");
    const options = mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2);
    expect(options.mediaUrl).toBe("https://example.com/photo.png");
    expect(options.components).toEqual([{ type: 1, components: [] }]);
    expect(options.filename).toBe("photo.png");
    expect(options.accountId).toBe("default");
    expect(options.replyTo).toBe("reply-1");
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
        .replyTo,
    ).toBe("explicit-reply-1");
    expect(mockObjectArg(hoisted.sendMessageDiscordMock, "sendMessageDiscord", 0, 2).replyTo).toBe(
      "explicit-reply-1",
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
        (call) => (call[2] as { replyTo?: unknown } | undefined)?.replyTo,
      ),
    ).toEqual(["reply-1", undefined]);
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
