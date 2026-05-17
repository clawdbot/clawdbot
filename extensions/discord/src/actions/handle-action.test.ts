import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");
const { beginDiscordInboundEventDeliveryCorrelation } =
  await import("../inbound-event-delivery.js");

function discordConfig(actions?: Record<string, boolean>): OpenClawConfig {
  return {
    channels: { discord: { token: "tok", ...(actions ? { actions } : {}) } },
  } as OpenClawConfig;
}

function defaultActionOptions() {
  return {
    mediaAccess: undefined,
    mediaLocalRoots: undefined,
    mediaReadFile: undefined,
  };
}

function expectDiscordActionCall(params: {
  payload: unknown;
  cfg: OpenClawConfig;
  options?: unknown;
}) {
  expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
  const [call] = handleDiscordActionMock.mock.calls;
  if (!call) {
    throw new Error("expected Discord action call");
  }
  const [payload, cfg, options] = call;
  expect(payload).toEqual(params.payload);
  expect(cfg).toBe(params.cfg);
  if ("options" in params) {
    expect(options).toEqual(params.options);
  } else {
    expect(options).toBeUndefined();
  }
}

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("uses trusted requesterSenderId for moderation and ignores params senderUserId", async () => {
    const cfg = discordConfig({ moderation: true });
    await handleDiscordMessageAction({
      action: "timeout",
      params: {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5,
        senderUserId: "spoofed-admin-id",
      },
      cfg,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expectDiscordActionCall({
      payload: {
        action: "timeout",
        accountId: undefined,
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        until: undefined,
        reason: undefined,
        deleteMessageDays: undefined,
        senderUserId: "trusted-sender-id",
      },
      cfg,
    });
  });

  it("falls back to toolContext.currentMessageId for reactions", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "react",
      params: {
        channelId: "123",
        emoji: "ok",
      },
      cfg,
      toolContext: { currentMessageId: "9001" },
    });

    expectDiscordActionCall({
      payload: {
        action: "react",
        accountId: undefined,
        channelId: "123",
        messageId: "9001",
        emoji: "ok",
        remove: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("falls back to Discord toolContext.currentChannelId for reaction targets", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "react",
      params: {
        emoji: "ok",
      },
      cfg,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "user:U1",
        currentMessageId: "9001",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "react",
        accountId: undefined,
        channelId: "user:U1",
        messageId: "9001",
        emoji: "ok",
        remove: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("falls back to Discord toolContext.currentChannelId for sends", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "send",
      params: {
        message: "hello",
      },
      cfg,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "sendMessage",
        accountId: undefined,
        to: "channel:123",
        content: "hello",
        mediaUrl: undefined,
        filename: undefined,
        replyTo: undefined,
        components: undefined,
        embeds: undefined,
        asVoice: false,
        silent: false,
        __sessionKey: undefined,
        __agentId: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("forwards threadName on sends", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "send",
      params: {
        target: "channel:thread-1",
        message: "hello",
        threadName: "Renamed thread",
      },
      cfg,
    });

    expectDiscordActionCall({
      payload: {
        action: "sendMessage",
        accountId: undefined,
        to: "channel:thread-1",
        content: "hello",
        threadName: "Renamed thread",
        mediaUrl: undefined,
        filename: undefined,
        replyTo: undefined,
        components: undefined,
        embeds: undefined,
        asVoice: false,
        silent: false,
        __sessionKey: undefined,
        __agentId: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("notifies inbound event delivery after message sends", async () => {
    const markDelivered = vi.fn();
    const end = beginDiscordInboundEventDeliveryCorrelation(
      "agent:main:discord:channel:c1",
      {
        outboundTo: "channel:c1",
        outboundAccountId: "default",
        markInboundEventDelivered: markDelivered,
      },
      { inboundEventKind: "room_event" },
    );

    try {
      await handleDiscordMessageAction({
        action: "send",
        params: {
          to: "channel:c1",
          message: "hello",
        },
        cfg: discordConfig(),
        accountId: "default",
        sessionKey: "agent:main:discord:channel:c1",
        inboundEventKind: "room_event",
      });
    } finally {
      end();
    }

    expect(markDelivered).toHaveBeenCalledTimes(1);
  });

  it("notifies inbound event delivery after visible message actions", async () => {
    const markDelivered = vi.fn();
    const end = beginDiscordInboundEventDeliveryCorrelation(
      "agent:main:discord:channel:c1",
      {
        outboundTo: "channel:c1",
        outboundAccountId: "default",
        markInboundEventDelivered: markDelivered,
      },
      { inboundEventKind: "room_event" },
    );

    try {
      await handleDiscordMessageAction({
        action: "upload-file",
        params: {
          to: "channel:c1",
          filePath: "/tmp/image.png",
        },
        cfg: discordConfig(),
        accountId: "default",
        sessionKey: "agent:main:discord:channel:c1",
        inboundEventKind: "room_event",
      });
    } finally {
      end();
    }

    expect(markDelivered).toHaveBeenCalledTimes(1);
  });

  it("maps upload-file to Discord sendMessage with media read context", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const mediaAccess = {
      localRoots: ["/tmp/agent-root"],
      readFile: mediaReadFile,
    };
    const cfg = discordConfig();

    await handleDiscordMessageAction({
      action: "upload-file",
      params: {
        target: "channel:123",
        filePath: "/tmp/agent-root/image.png",
        message: "caption",
        filename: "image.png",
        replyTo: "message-1",
        silent: true,
        __sessionKey: "session-1",
        __agentId: "agent-1",
      },
      cfg,
      mediaAccess,
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
    });

    expectDiscordActionCall({
      payload: {
        action: "sendMessage",
        accountId: undefined,
        to: "channel:123",
        content: "caption",
        mediaUrl: "/tmp/agent-root/image.png",
        filename: "image.png",
        replyTo: "message-1",
        silent: true,
        __sessionKey: "session-1",
        __agentId: "agent-1",
      },
      cfg,
      options: {
        mediaAccess,
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaReadFile,
      },
    });
  });

  it("falls back to Discord toolContext.currentChannelId for upload-file", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "upload-file",
      params: {
        path: "/tmp/agent-root/image.png",
      },
      cfg,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "sendMessage",
        accountId: undefined,
        to: "channel:123",
        content: "",
        mediaUrl: "/tmp/agent-root/image.png",
        filename: undefined,
        replyTo: undefined,
        silent: false,
        __sessionKey: undefined,
        __agentId: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("requires a file path for upload-file", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "upload-file",
        params: {
          to: "channel:123",
        },
        cfg: discordConfig(),
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("maps thread-reply filePath to Discord threadReply with media read context", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("report"));
    const cfg = discordConfig({ threads: true });

    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        threadId: "thread-123",
        message: "thread update",
        filePath: "/tmp/agent-root/report.md",
      },
      cfg,
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
    });

    expectDiscordActionCall({
      payload: {
        action: "threadReply",
        accountId: undefined,
        channelId: "thread-123",
        content: "thread update",
        mediaUrl: "/tmp/agent-root/report.md",
        replyTo: undefined,
      },
      cfg,
      options: {
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaReadFile,
      },
    });
  });

  it("forwards top-level components on sends", async () => {
    const components = { blocks: [{ type: "text", text: "Pick one" }] };
    const cfg = discordConfig();

    await handleDiscordMessageAction({
      action: "send",
      params: {
        message: "hello",
        components,
      },
      cfg,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "sendMessage",
        accountId: undefined,
        to: "channel:123",
        content: "hello",
        mediaUrl: undefined,
        filename: undefined,
        replyTo: undefined,
        components,
        embeds: undefined,
        asVoice: false,
        silent: false,
        __sessionKey: undefined,
        __agentId: undefined,
      },
      cfg,
      options: defaultActionOptions(),
    });
  });

  it("does not use another provider's current target for Discord sends", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "send",
        params: {
          message: "hello",
        },
        cfg: discordConfig(),
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "channel:123",
        },
      }),
    ).rejects.toThrow(/channel target is required/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("does not use another provider's current target for Discord reactions", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "react",
        params: {
          emoji: "ok",
        },
        cfg: discordConfig(),
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "user:U1",
          currentMessageId: "9001",
        },
      }),
    ).rejects.toThrow(/channel target is required/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("rejects reactions when no message id source is available", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "react",
        params: {
          channelId: "123",
          emoji: "ok",
        },
        cfg: discordConfig(),
      }),
    ).rejects.toThrow(/messageId required/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });
});
