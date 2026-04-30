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

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "formatted",
      expect.objectContaining({
        textLimit: 1234,
        maxLinesPerMessage: 7,
        tableMode: "off",
        chunkMode: "newline",
      }),
    );
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

    expect(hoisted.sendWebhookMessageDiscordMock).toHaveBeenCalledWith(
      "hello from persona",
      expect.objectContaining({
        webhookId: "wh-1",
        webhookToken: "tok-1",
        accountId: "default",
        threadId: "thread-1",
        replyTo: "reply-1",
        username: "Codex",
        avatarUrl: "https://example.com/avatar.png",
      }),
    );
    expect(
      (hoisted.sendWebhookMessageDiscordMock.mock.calls[0]?.[1] as { cfg?: unknown } | undefined)
        ?.cfg,
    ).toBe(cfg);
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

    expect(hoisted.sendPollDiscordMock).toHaveBeenCalledWith(
      "channel:thread-1",
      {
        question: "Best snack?",
        options: ["banana", "apple"],
      },
      expect.objectContaining({
        accountId: "default",
      }),
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

    expect(hoisted.sendVoiceMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "https://example.com/voice.ogg",
      expect.objectContaining({
        accountId: "default",
        replyTo: "reply-1",
      }),
    );
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "voice note",
      expect.objectContaining({
        accountId: "default",
        replyTo: undefined,
      }),
    );
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "",
      expect.objectContaining({
        accountId: "default",
        mediaUrl: "https://example.com/extra.png",
        replyTo: undefined,
      }),
    );
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
      (hoisted.sendVoiceMessageDiscordMock.mock.calls[0]?.[2] as { replyTo?: unknown } | undefined)
        ?.replyTo,
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
      (hoisted.sendVoiceMessageDiscordMock.mock.calls[0]?.[2] as { replyTo?: unknown } | undefined)
        ?.replyTo,
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

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "rendered clip",
      expect.objectContaining({
        accountId: "default",
        replyTo: "reply-1",
      }),
    );
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "",
      expect.objectContaining({
        accountId: "default",
        mediaUrl: "/tmp/render.mp4",
      }),
    );
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

    expect(hoisted.sendDiscordComponentMessageMock).toHaveBeenCalledWith(
      "channel:123456",
      expect.objectContaining({ text: "hello" }),
      expect.objectContaining({
        mediaUrl: "https://example.com/1.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
        replyTo: "reply-1",
      }),
    );
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
        replyTo: undefined,
      }),
    );
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
      (
        hoisted.sendDiscordComponentMessageMock.mock.calls[0]?.[2] as
          | { replyTo?: unknown }
          | undefined
      )?.replyTo,
    ).toBe("reply-1");
    expect(
      (hoisted.sendMessageDiscordMock.mock.calls[0]?.[2] as { replyTo?: unknown } | undefined)
        ?.replyTo,
    ).toBe("reply-1");
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
      (
        hoisted.sendDiscordComponentMessageMock.mock.calls[0]?.[2] as
          | { replyTo?: unknown }
          | undefined
      )?.replyTo,
    ).toBe("explicit-reply-1");
    expect(
      (hoisted.sendMessageDiscordMock.mock.calls[0]?.[2] as { replyTo?: unknown } | undefined)
        ?.replyTo,
    ).toBe("explicit-reply-1");
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

    expect(hoisted.sendDiscordComponentMessageMock).toHaveBeenCalledWith(
      "channel:123456",
      expect.objectContaining({
        text: "native component text",
        blocks: [{ type: "text", text: "Native component body" }],
      }),
      expect.objectContaining({ accountId: "default" }),
    );
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

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "Approval @\u200beveryone <@\u200b123> <#\u200b456>",
      expect.objectContaining({
        accountId: "default",
      }),
    );
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

    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "Hello @everyone",
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });
});
