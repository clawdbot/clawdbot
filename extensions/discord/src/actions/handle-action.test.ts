// Discord tests cover handle action plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");
const {
  beginDiscordActiveTurnThreadRoute,
  notifyDiscordActiveTurnThreadCreated,
  notifyDiscordActiveTurnThreadReplyDelivered,
} = await import("../active-turn-thread-route.js");
const { discordInboundEventDelivery } = await import("../inbound-event-delivery.js");

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

  it("rejects fractional moderation durations before invoking Discord runtime", async () => {
    const cfg = discordConfig({ moderation: true });
    await expect(
      handleDiscordMessageAction({
        action: "timeout",
        params: {
          guildId: "guild-1",
          userId: "user-2",
          durationMin: 5.5,
        },
        cfg,
        requesterSenderId: "trusted-sender-id",
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).rejects.toThrow("durationMin must be a non-negative integer");
    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("rejects invalid autoArchiveMin before Discord thread-create runtime", async () => {
    const cfg = discordConfig({ threads: true });
    await expect(
      handleDiscordMessageAction({
        action: "thread-create",
        params: {
          channelId: "channel-1",
          threadName: "proof-thread",
          autoArchiveMin: 999,
        },
        cfg,
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).rejects.toThrow("autoArchiveMin must be one of 60, 1440, 4320, or 10080 minutes");
    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("uses Discord requesterSenderId for guild admin actions and ignores params senderUserId", async () => {
    const cfg = discordConfig({ channels: true });
    await handleDiscordMessageAction({
      action: "channel-delete",
      params: {
        channelId: "channel-1",
        senderUserId: "spoofed-admin-id",
      },
      cfg,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expectDiscordActionCall({
      payload: {
        action: "channelDelete",
        accountId: undefined,
        channelId: "channel-1",
        senderUserId: "trusted-sender-id",
      },
      cfg,
    });
  });

  it("rejects non-Discord requester ids for Discord guild admin actions", async () => {
    const cfg = discordConfig({ channels: true });
    await expect(
      handleDiscordMessageAction({
        action: "channel-delete",
        params: {
          channelId: "channel-1",
        },
        cfg,
        requesterSenderId: "telegram-user-id",
        toolContext: { currentChannelProvider: "telegram" },
      }),
    ).rejects.toThrow("trusted Discord sender identity");

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("keeps no-context Discord guild admin actions on the manual runtime path", async () => {
    const cfg = discordConfig({ channels: true });
    await handleDiscordMessageAction({
      action: "channel-delete",
      params: {
        channelId: "channel-1",
      },
      cfg,
      senderIsOwner: true,
    });

    expectDiscordActionCall({
      payload: {
        action: "channelDelete",
        accountId: undefined,
        channelId: "channel-1",
      },
      cfg,
    });
  });

  it("rejects no-context Discord guild admin actions without owner trust", async () => {
    const cfg = discordConfig({ channels: true });
    await expect(
      handleDiscordMessageAction({
        action: "channel-delete",
        params: {
          channelId: "channel-1",
        },
        cfg,
      }),
    ).rejects.toThrow("trusted Discord sender identity");

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("rejects non-Discord requester ids for Discord moderation actions", async () => {
    const cfg = discordConfig({ moderation: true });
    await expect(
      handleDiscordMessageAction({
        action: "timeout",
        params: {
          guildId: "guild-1",
          userId: "user-2",
          durationMin: 5,
        },
        cfg,
        requesterSenderId: "telegram-user-id",
        toolContext: { currentChannelProvider: "telegram" },
      }),
    ).rejects.toThrow("trusted Discord sender identity");

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("keeps read-only guild lookups available from non-Discord requesters", async () => {
    const cfg = discordConfig({ channelInfo: true });
    await handleDiscordMessageAction({
      action: "channel-info",
      params: {
        channelId: "channel-1",
      },
      cfg,
      requesterSenderId: "telegram-user-id",
      toolContext: { currentChannelProvider: "telegram" },
    });

    expectDiscordActionCall({
      payload: { action: "channelInfo", accountId: undefined, channelId: "channel-1" },
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

  it("forwards attested current-conversation context to Discord reads", async () => {
    const cfg = discordConfig();
    await handleDiscordMessageAction({
      action: "read",
      params: {
        channelId: "channel:123",
      },
      cfg,
      accountId: "ops",
      requesterAccountId: "ops",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "readMessages",
        accountId: "ops",
        channelId: "123",
        limit: undefined,
        before: undefined,
        after: undefined,
        around: undefined,
      },
      cfg,
      options: {
        ...defaultActionOptions(),
        conversationReadOrigin: "delegated",
        readContext: {
          requesterAccountId: "ops",
          currentChannelProvider: "discord",
          currentChannelId: "channel:123",
        },
      },
    });
  });

  it("forwards attested current-conversation context to Discord channel info", async () => {
    const cfg = discordConfig({ channelInfo: true });
    await handleDiscordMessageAction({
      action: "channel-info",
      params: {
        channelId: "123",
      },
      cfg,
      accountId: "ops",
      requesterAccountId: "ops",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:123",
      },
    });

    expectDiscordActionCall({
      payload: {
        action: "channelInfo",
        accountId: "ops",
        channelId: "123",
      },
      cfg,
      options: {
        conversationReadOrigin: "delegated",
        readContext: {
          requesterAccountId: "ops",
          currentChannelProvider: "discord",
          currentChannelId: "channel:123",
        },
      },
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

  it.each([
    {
      action: "send" as const,
      params: { to: "channel:c1", message: "hello" },
    },
    {
      action: "upload-file" as const,
      params: { to: "channel:c1", filePath: "/tmp/image.png" },
    },
    {
      action: "sticker" as const,
      params: { to: "channel:c1", stickerId: ["sticker-1"] },
    },
    {
      action: "thread-reply" as const,
      params: { threadId: "c1", message: "thread update" },
    },
    {
      action: "thread-create" as const,
      params: { channelId: "c1", messageId: "message-1", threadName: "investigation" },
    },
  ])(
    "records room-event delivery only after $action receives a positive receipt",
    async ({ action, params }) => {
      const sessionKey = "agent:main:discord:channel:c1";

      for (const ok of [false, true]) {
        const markDelivered = vi.fn();
        const onThreadAdopted = vi.fn();
        const endDelivery = discordInboundEventDelivery.begin(
          sessionKey,
          {
            outboundTo: "channel:c1",
            outboundAccountId: "default",
            markInboundEventDelivered: markDelivered,
          },
          { inboundEventKind: "room_event" },
        );
        const endThreadRoute =
          action === "thread-create"
            ? beginDiscordActiveTurnThreadRoute(sessionKey, {
                accountId: "default",
                sourceChannelId: "c1",
                sourceMessageId: "message-1",
                onThreadAdopted,
              })
            : () => {};

        handleDiscordActionMock.mockResolvedValueOnce({
          content: [],
          details: {
            ok,
            ...(ok ? {} : { error: "delivery failed" }),
            ...(action === "thread-create" ? { thread: { id: "thread-1" } } : {}),
          },
        });

        try {
          const result = await handleDiscordMessageAction({
            action,
            params,
            cfg: discordConfig({ threads: true, polls: true, stickers: true }),
            accountId: "default",
            sessionKey,
            inboundEventKind: "room_event",
          });

          expect(result.details).toMatchObject({ ok });
          expect(markDelivered).toHaveBeenCalledTimes(ok ? 1 : 0);
          if (action === "thread-create") {
            expect(onThreadAdopted).toHaveBeenCalledTimes(ok ? 1 : 0);
          }
        } finally {
          endThreadRoute();
          endDelivery();
        }
      }
    },
  );

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

  it("rejects upload-file with a buffer and points at send", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "upload-file",
        params: {
          to: "channel:123",
          filename: "report.pdf",
          contentType: "application/pdf",
          buffer: Buffer.from("report").toString("base64"),
        },
        cfg: discordConfig(),
      }),
    ).rejects.toThrow(
      'Use action: "send" for base64 buffer attachments; upload-file requires filePath, path, or media.',
    );

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
        mediaAccess: undefined,
        mediaLocalRoots: ["/tmp/agent-root"],
        mediaReadFile,
      },
    });
  });

  it("adopts a thread created from the active source message and confirms replies there", async () => {
    const sessionKey = "agent:main:discord:channel:channel-1";
    const onThreadAdopted = vi.fn();
    const onThreadReplyDelivered = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      accountId: "account-1",
      sourceChannelId: "channel-1",
      sourceMessageId: "message-1",
      onThreadAdopted,
      onThreadReplyDelivered,
    });
    try {
      expect(
        notifyDiscordActiveTurnThreadReplyDelivered({
          sessionKey,
          accountId: "account-1",
        }),
      ).toBe(false);

      handleDiscordActionMock.mockResolvedValueOnce({
        content: [],
        details: { ok: true, thread: { id: "thread-1" } },
      });
      await handleDiscordMessageAction({
        action: "thread-create",
        params: {
          channelId: "channel-1",
          messageId: "message-1",
          threadName: "investigation",
        },
        cfg: discordConfig({ threads: true }),
        accountId: "account-1",
        sessionKey,
      });

      expect(onThreadAdopted).toHaveBeenCalledWith("thread-1");

      handleDiscordActionMock.mockResolvedValueOnce({
        content: [],
        details: { ok: true },
      });
      const mismatchedResult = await handleDiscordMessageAction({
        action: "thread-reply",
        params: {
          threadId: "thread-2",
          message: "unrelated",
        },
        cfg: discordConfig({ threads: true }),
        accountId: "account-1",
        sessionKey,
      });

      expect(mismatchedResult.details).toEqual({ ok: true });
      expect(onThreadReplyDelivered).not.toHaveBeenCalled();

      handleDiscordActionMock.mockResolvedValueOnce({
        content: [],
        details: { ok: true },
      });
      const result = await handleDiscordMessageAction({
        action: "thread-reply",
        params: {
          threadId: "thread-1",
          message: "done",
        },
        cfg: discordConfig({ threads: true }),
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

  it("confirms only the matching adopted thread across concurrent routes", async () => {
    const sessionKey = "agent:main:discord:channel:channel-1";
    const firstReplyDelivered = vi.fn();
    const secondReplyDelivered = vi.fn();
    const endFirstRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      accountId: "account-1",
      sourceChannelId: "channel-1",
      sourceMessageId: "message-1",
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered: firstReplyDelivered,
    });
    const endSecondRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      accountId: "account-1",
      sourceChannelId: "channel-1",
      sourceMessageId: "message-2",
      onThreadAdopted: vi.fn(),
      onThreadReplyDelivered: secondReplyDelivered,
    });
    try {
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        accountId: "account-1",
        sourceChannelId: "channel-1",
        sourceMessageId: "message-1",
        threadId: "thread-1",
      });
      await notifyDiscordActiveTurnThreadCreated({
        sessionKey,
        accountId: "account-1",
        sourceChannelId: "channel-1",
        sourceMessageId: "message-2",
        threadId: "thread-2",
      });

      expect(
        notifyDiscordActiveTurnThreadReplyDelivered({
          sessionKey,
          accountId: "account-1",
          threadId: "thread-2",
        }),
      ).toBe(true);
      expect(firstReplyDelivered).not.toHaveBeenCalled();
      expect(secondReplyDelivered).toHaveBeenCalledWith("thread-2");
    } finally {
      endFirstRoute();
      endSecondRoute();
    }
  });

  it("keeps a successful thread-create result when progress migration fails", async () => {
    const sessionKey = "agent:main:discord:channel:channel-1";
    const onThreadAdoptionError = vi.fn();
    const endRoute = beginDiscordActiveTurnThreadRoute(sessionKey, {
      sourceChannelId: "channel-1",
      sourceMessageId: "message-1",
      onThreadAdopted: async () => {
        throw new Error("preview move failed");
      },
      onThreadAdoptionError,
    });
    try {
      const expectedResult = {
        content: [],
        details: { ok: true, thread: { id: "thread-1" } },
      };
      handleDiscordActionMock.mockResolvedValueOnce(expectedResult);

      const result = await handleDiscordMessageAction({
        action: "thread-create",
        params: {
          channelId: "channel-1",
          messageId: "message-1",
          threadName: "investigation",
        },
        cfg: discordConfig({ threads: true }),
        sessionKey,
      });

      expect(result).toBe(expectedResult);
      expect(onThreadAdoptionError).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      endRoute();
    }
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

  it("downgrades chart-only presentations to Discord component text", async () => {
    const cfg = discordConfig();

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "bar",
              title: "Revenue",
              categories: ["Q1", "Q2"],
              series: [{ name: "USD", values: [12, 18] }],
            },
          ],
        },
      },
      cfg,
    });

    expectDiscordActionCall({
      payload: {
        action: "sendMessage",
        accountId: undefined,
        to: "channel:123",
        content: "",
        mediaUrl: undefined,
        filename: undefined,
        replyTo: undefined,
        components: {
          blocks: [
            {
              type: "text",
              text: "-# Revenue (bar chart)\n- USD: Q1: 12; Q2: 18",
            },
          ],
        },
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

  it("downgrades oversized table presentations to complete text", async () => {
    const cfg = discordConfig();

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Large pipeline",
              headers: ["Account", "Stage"],
              rows: Array.from({ length: 900 }, (_entry, index) => [
                `account-${String(index)}-${"x".repeat(80)}`,
                "Review",
              ]),
            },
          ],
        },
      },
      cfg,
    });

    const [call] = handleDiscordActionMock.mock.calls;
    const payload = call?.[0] as Record<string, unknown> | undefined;
    expect(payload?.components).toBeUndefined();
    expect(payload?.content).toEqual(expect.stringContaining("account-0-"));
    expect(payload?.content).toEqual(expect.stringContaining("account-899-"));
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

  it("does not add session channel to search when explicit channelIds are provided", async () => {
    handleDiscordActionMock.mockResolvedValueOnce({ content: [], details: { ok: true } });
    await handleDiscordMessageAction({
      action: "search",
      params: {
        query: "test query",
        channelIds: ["ch-1", "ch-2"],
        guildId: "g1",
      },
      cfg: discordConfig(),
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "session-ch",
      },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    const payload = expectDefined(
      handleDiscordActionMock.mock.calls[0]?.[0],
      "Discord search action payload",
    );
    expect(payload).toMatchObject({
      action: "searchMessages",
      content: "test query",
      guildId: "g1",
      channelIds: ["ch-1", "ch-2"],
    });
    // Session channel must NOT appear as channelId when explicit channelIds exist.
    expect(payload.channelId).toBeUndefined();
  });

  it("does not inject session channel when guildId is explicit and no channel filters are provided", async () => {
    handleDiscordActionMock.mockResolvedValueOnce({ content: [], details: { ok: true } });
    await handleDiscordMessageAction({
      action: "search",
      params: {
        query: "guild-wide query",
        guildId: "g1",
      },
      cfg: discordConfig(),
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "session-ch",
      },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledTimes(1);
    const payload = expectDefined(
      handleDiscordActionMock.mock.calls[0]?.[0],
      "Discord guild search action payload",
    );
    expect(payload).toMatchObject({
      action: "searchMessages",
      content: "guild-wide query",
      guildId: "g1",
    });
    // Guild-wide search must NOT be narrowed to the session channel.
    expect(payload.channelId).toBeUndefined();
    expect(payload.channelIds).toBeUndefined();
  });
});
