import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
    });

    expect(hoisted.sendDiscordComponentMessageMock).toHaveBeenCalledWith(
      "channel:123456",
      expect.objectContaining({ text: "hello" }),
      expect.objectContaining({
        mediaUrl: "https://example.com/1.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
      }),
    );
    expect(hoisted.sendMessageDiscordMock).toHaveBeenCalledWith(
      "channel:123456",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
      }),
    );
    expect(result).toEqual({
      channel: "discord",
      messageId: "msg-2",
      channelId: "ch-1",
    });
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
