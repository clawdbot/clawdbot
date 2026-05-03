import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("uses trusted requesterSenderId for moderation and ignores params senderUserId", async () => {
    await handleDiscordMessageAction({
      action: "timeout",
      params: {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5,
        senderUserId: "spoofed-admin-id",
      },
      cfg: {
        channels: { discord: { token: "tok", actions: { moderation: true } } },
      } as OpenClawConfig,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "timeout",
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        senderUserId: "trusted-sender-id",
      }),
      expect.objectContaining({
        channels: {
          discord: expect.objectContaining({
            token: "tok",
          }),
        },
      }),
    );
  });

  it("falls back to toolContext.currentMessageId for reactions", async () => {
    await handleDiscordMessageAction({
      action: "react",
      params: {
        channelId: "123",
        emoji: "ok",
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      toolContext: { currentMessageId: "9001" },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "react",
        channelId: "123",
        messageId: "9001",
        emoji: "ok",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("falls back to Discord toolContext.currentChannelId for reaction targets", async () => {
    await handleDiscordMessageAction({
      action: "react",
      params: {
        emoji: "ok",
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "user:U1",
        currentMessageId: "9001",
      },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "react",
        channelId: "user:U1",
        messageId: "9001",
        emoji: "ok",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("falls back to Discord toolContext.currentChannelId for sends", async () => {
    await handleDiscordMessageAction({
      action: "send",
      params: {
        message: "hello",
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:123",
        content: "hello",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("maps upload-file to Discord sendMessage with media read context", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const mediaAccess = {
      localRoots: ["/tmp/agent-root"],
      readFile: mediaReadFile,
    };

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
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      mediaAccess,
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:123",
        content: "caption",
        mediaUrl: "/tmp/agent-root/image.png",
        filename: "image.png",
        replyTo: "message-1",
        silent: true,
        __sessionKey: "session-1",
        __agentId: "agent-1",
      }),
      expect.any(Object),
      {
        mediaAccess,
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaReadFile,
      },
    );
  });

  it("falls back to Discord toolContext.currentChannelId for upload-file", async () => {
    await handleDiscordMessageAction({
      action: "upload-file",
      params: {
        path: "/tmp/agent-root/image.png",
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:123",
        content: "",
        mediaUrl: "/tmp/agent-root/image.png",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("requires a file path for upload-file", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "upload-file",
        params: {
          to: "channel:123",
        },
        cfg: {
          channels: { discord: { token: "tok" } },
        } as OpenClawConfig,
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("forwards top-level components on sends", async () => {
    const components = { blocks: [{ type: "text", text: "Pick one" }] };

    await handleDiscordMessageAction({
      action: "send",
      params: {
        message: "hello",
        components,
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:123",
        content: "hello",
        components,
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("does not use another provider's current target for Discord sends", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "send",
        params: {
          message: "hello",
        },
        cfg: {
          channels: { discord: { token: "tok" } },
        } as OpenClawConfig,
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
        cfg: {
          channels: { discord: { token: "tok" } },
        } as OpenClawConfig,
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
        cfg: {
          channels: { discord: { token: "tok" } },
        } as OpenClawConfig,
      }),
    ).rejects.toThrow(/messageId required/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });
});
