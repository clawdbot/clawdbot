import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");
const { beginDiscordActiveTurnThreadRoute, notifyDiscordActiveTurnThreadCreated } =
  await import("../active-turn-thread-route.js");

function discordConfig(): OpenClawConfig {
  return {
    channels: { discord: { token: "tok" } },
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
});
