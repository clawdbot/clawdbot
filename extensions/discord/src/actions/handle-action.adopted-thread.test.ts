import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");
const { beginDiscordActiveTurnThreadRoute, notifyDiscordActiveTurnThreadCreated } =
  await import("../active-turn-thread-route.js");

function discordConfig(actions?: Record<string, boolean>): OpenClawConfig {
  return {
    channels: { discord: { token: "tok", ...(actions ? { actions } : {}) } },
  } as OpenClawConfig;
}

describe("handleDiscordMessageAction adopted thread delivery", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("classifies generic sends only when targeting the active adopted thread", async () => {
    const sessionKey = "agent:main:discord:channel:channel-1";
    const onThreadReplyDelivered = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      accountId: "account-1",
      sourceChannelId: "channel-1",
      sourceMessageId: "message-1",
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered,
    });
    try {
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        accountId: "account-1",
        sourceChannelId: "channel-1",
        sourceMessageId: "message-1",
        threadId: "thread-1",
      });

      const unrelatedResult = await handleDiscordMessageAction({
        action: "send",
        params: {
          to: "channel:thread-2",
          message: "unrelated",
        },
        cfg: discordConfig(),
        accountId: "account-1",
        sessionKey,
      });

      expect(unrelatedResult.details).toEqual({ ok: true });
      expect(onThreadReplyDelivered).not.toHaveBeenCalled();

      const result = await handleDiscordMessageAction({
        action: "send",
        params: {
          to: "channel:thread-1",
          message: "done",
        },
        cfg: discordConfig(),
        accountId: "account-1",
        sessionKey,
      });

      expect(result.details).toEqual({
        ok: true,
        sourceReplyRoute: "current-source",
      });
      expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
    } finally {
      endRoute();
    }
  });

  it("classifies upload-file to the active adopted thread as current-source delivery", async () => {
    const sessionKey = "agent:main:discord:channel:channel-1";
    const onThreadReplyDelivered = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      accountId: "account-1",
      sourceChannelId: "channel-1",
      sourceMessageId: "message-1",
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered,
    });
    try {
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        accountId: "account-1",
        sourceChannelId: "channel-1",
        sourceMessageId: "message-1",
        threadId: "thread-1",
      });

      const result = await handleDiscordMessageAction({
        action: "upload-file",
        params: {
          to: "channel:thread-1",
          filePath: "/tmp/report.md",
        },
        cfg: discordConfig(),
        accountId: "account-1",
        sessionKey,
      });

      expect(result.details).toEqual({
        ok: true,
        sourceReplyRoute: "current-source",
      });
      expect(onThreadReplyDelivered).toHaveBeenCalledWith("thread-1");
    } finally {
      endRoute();
    }
  });

  it("keeps the source fallback eligible when a matching-thread send reports failure", async () => {
    const sessionKey = "agent:main:discord:channel:channel-1";
    const onThreadReplyDelivered = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      accountId: "account-1",
      sourceChannelId: "channel-1",
      sourceMessageId: "message-1",
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered,
    });
    try {
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        accountId: "account-1",
        sourceChannelId: "channel-1",
        sourceMessageId: "message-1",
        threadId: "thread-1",
      });
      handleDiscordActionMock.mockResolvedValueOnce({
        content: [],
        details: { ok: false, error: "delivery failed" },
      });

      const result = await handleDiscordMessageAction({
        action: "send",
        params: {
          to: "channel:thread-1",
          message: "done",
        },
        cfg: discordConfig(),
        accountId: "account-1",
        sessionKey,
      });

      expect(result.details).toEqual({ ok: false, error: "delivery failed" });
      expect(onThreadReplyDelivered).not.toHaveBeenCalled();
    } finally {
      endRoute();
    }
  });

  it("preserves a successful send when route-only target parsing rejects the target", async () => {
    const result = await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "@alice",
        message: "hello",
      },
      cfg: discordConfig(),
    });

    expect(result.details).toEqual({ ok: true });
  });

  it("preserves trusted workspace authority for thread replies and rejects forged action capabilities", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("trusted report"));
    const mediaAccess = {
      localRoots: ["/tmp/agent-workspace"],
      readFile: mediaReadFile,
      workspaceDir: "/tmp/agent-workspace",
    };
    const forgedMediaAccess = {
      localRoots: ["/tmp/forged-root"],
      readFile: vi.fn(async () => Buffer.from("forged report")),
      workspaceDir: "/tmp/forged-root",
    };
    const cfg = discordConfig({ threads: true });

    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        threadId: "thread-123",
        message: "thread update",
        filePath: "./report.md",
        mediaAccess: forgedMediaAccess,
      },
      cfg,
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      mediaReadFile,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      {
        action: "threadReply",
        accountId: undefined,
        channelId: "thread-123",
        content: "thread update",
        mediaUrl: "./report.md",
        replyTo: undefined,
      },
      cfg,
      { mediaAccess, mediaLocalRoots: mediaAccess.localRoots, mediaReadFile },
    );
    expect(handleDiscordActionMock.mock.calls[0]?.[1]).toBe(cfg);
    const actionOptions = handleDiscordActionMock.mock.calls[0]?.[2];
    expect(actionOptions?.mediaAccess).toBe(mediaAccess);
    expect(actionOptions?.mediaLocalRoots).toBe(mediaAccess.localRoots);
    expect(actionOptions?.mediaReadFile).toBe(mediaReadFile);
    expect(forgedMediaAccess.readFile).not.toHaveBeenCalled();
  });
});
