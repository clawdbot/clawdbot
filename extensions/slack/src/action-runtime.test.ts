import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import { parseSlackBlocksInput } from "./blocks-input.js";

const originalSlackActionRuntime = { ...slackActionRuntime };
const deleteSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const downloadSlackFile = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const editSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const getSlackMemberInfo = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackEmojis = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackPins = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackReactions = vi.fn(async (..._args: unknown[]) => ({}));
const pinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const reactSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const readSlackMessages = vi.fn(async (..._args: unknown[]) => ({}));
const removeOwnSlackReactions = vi.fn(async (..._args: unknown[]) => ["thumbsup"]);
const removeSlackReaction = vi.fn(async (..._args: unknown[]) => ({}));
const recordSlackThreadParticipation = vi.fn();
const sendSlackMessage = vi.fn(async (..._args: unknown[]) => ({ channelId: "C123" }));
const unpinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));

describe("handleSlackAction", () => {
  function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
    return {
      channels: {
        slack: {
          botToken: "tok",
          ...overrides,
        },
      },
    } as OpenClawConfig;
  }

  function createReplyToFirstContext(hasRepliedRef: { value: boolean }) {
    return {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first" as const,
      hasRepliedRef,
    };
  }

  function createReplyToFirstScenario() {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    const hasRepliedRef = { value: false };
    const context = createReplyToFirstContext(hasRepliedRef);
    return { cfg, context, hasRepliedRef };
  }

  function expectLastSlackSend(content: string, threadTs?: string) {
    expect(sendSlackMessage).toHaveBeenLastCalledWith(
      "channel:C123",
      content,
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: undefined,
        threadTs,
        blocks: undefined,
      }),
    );
  }

  async function sendSecondMessageAndExpectNoThread(params: {
    cfg: OpenClawConfig;
    context: ReturnType<typeof createReplyToFirstContext>;
  }) {
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "Second" },
      params.cfg,
      params.context,
    );
    expectLastSlackSend("Second");
  }

  async function resolveReadToken(cfg: OpenClawConfig): Promise<string | undefined> {
    readSlackMessages.mockClear();
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });
    await handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg);
    const opts = readSlackMessages.mock.calls[0]?.[1] as { token?: string } | undefined;
    return opts?.token;
  }

  async function resolveSendToken(cfg: OpenClawConfig): Promise<string | undefined> {
    sendSlackMessage.mockClear();
    await handleSlackAction({ action: "sendMessage", to: "channel:C1", content: "Hello" }, cfg);
    const opts = sendSlackMessage.mock.calls[0]?.[2] as { token?: string } | undefined;
    return opts?.token;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(slackActionRuntime, originalSlackActionRuntime, {
      deleteSlackMessage,
      downloadSlackFile,
      editSlackMessage,
      getSlackMemberInfo,
      listSlackEmojis,
      listSlackPins,
      listSlackReactions,
      parseSlackBlocksInput,
      pinSlackMessage,
      reactSlackMessage,
      readSlackMessages,
      recordSlackThreadParticipation,
      removeOwnSlackReactions,
      removeSlackReaction,
      sendSlackMessage,
      unpinSlackMessage,
    });
  });

  it.each([
    { name: "raw channel id", channelId: "C1" },
    { name: "channel: prefixed id", channelId: "channel:C1" },
  ])("adds reactions for $name", async ({ channelId }) => {
    const result = await handleSlackAction(
      {
        action: "react",
        channelId,
        messageId: "123.456",
        emoji: "✅",
      },
      slackConfig(),
    );
    expect(reactSlackMessage).toHaveBeenCalledWith(
      "C1",
      "123.456",
      "✅",
      expect.objectContaining({ cfg: expect.any(Object) }),
    );
    expect(JSON.parse((result.content?.[0] as { type: "text"; text: string }).text)).toEqual({
      ok: true,
      added: "✅",
    });
  });

  it("removes reactions on empty emoji", async () => {
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "",
      },
      slackConfig(),
    );
    expect(removeOwnSlackReactions).toHaveBeenCalledWith(
      "C1",
      "123.456",
      expect.objectContaining({ cfg: expect.any(Object) }),
    );
  });

  it("removes reactions when remove flag set", async () => {
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "✅",
        remove: true,
      },
      slackConfig(),
    );
    expect(removeSlackReaction).toHaveBeenCalledWith(
      "C1",
      "123.456",
      "✅",
      expect.objectContaining({ cfg: expect.any(Object) }),
    );
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "",
          remove: true,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "✅",
        },
        slackConfig({ actions: { reactions: false } }),
      ),
    ).rejects.toThrow(/Slack reactions are disabled/);
  });

  it("passes threadTs to sendSlackMessage for thread replies", async () => {
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
      },
      slackConfig(),
    );
    expect(sendSlackMessage).toHaveBeenCalledWith(
      "channel:C123",
      "Hello thread",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: undefined,
        threadTs: "1234567890.123456",
        blocks: undefined,
      }),
    );
  });

  it("returns a friendly error when downloadFile cannot fetch the attachment", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
      },
      slackConfig(),
    );
    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({ maxBytes: 20 * 1024 * 1024 }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({ ok: false }),
      }),
    );
  });

  it("passes download scope (channel/thread) to downloadSlackFile", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);

    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
        to: "channel:C1",
        replyTo: "123.456",
      },
      slackConfig(),
    );

    expect(downloadSlackFile).toHaveBeenCalledWith(
      "F123",
      expect.objectContaining({
        channelId: "C1",
        threadId: "123.456",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({ ok: false }),
      }),
    );
  });

  it("returns non-image downloadFile results as file metadata instead of image content", async () => {
    downloadSlackFile.mockResolvedValueOnce({
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
      placeholder: "[Slack file: report.pdf (fileId: F123)]",
    });

    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
      },
      slackConfig(),
    );

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("/tmp/openclaw-media/report.pdf"),
      }),
    );
    expect(result.content.some((entry) => entry.type === "image")).toBe(false);
    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        fileId: "F123",
        path: "/tmp/openclaw-media/report.pdf",
        contentType: "application/pdf",
        media: {
          mediaUrl: "/tmp/openclaw-media/report.pdf",
          contentType: "application/pdf",
        },
      }),
    );
  });

  it("forwards resolved botToken to action functions instead of relying on config re-read", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    await handleSlackAction({ action: "downloadFile", fileId: "F123" }, slackConfig());
    const opts = downloadSlackFile.mock.calls[0]?.[1] as { token?: string } | undefined;
    expect(opts?.token).toBe("tok");
  });

  it("keeps resolved userToken for downloadFile reads when configured", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    await handleSlackAction(
      { action: "downloadFile", fileId: "F123" },
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
            userToken: "xoxp-user",
          },
        },
      }),
    );
    const opts = downloadSlackFile.mock.calls[0]?.[1] as { token?: string } | undefined;
    expect(opts?.token).toBe("xoxp-user");
  });

  it.each([
    {
      name: "JSON blocks",
      blocks: JSON.stringify([
        { type: "section", text: { type: "mrkdwn", text: "*Deploy* status" } },
      ]),
      expectedBlocks: [{ type: "section", text: { type: "mrkdwn", text: "*Deploy* status" } }],
    },
    {
      name: "array blocks",
      blocks: [{ type: "divider" }],
      expectedBlocks: [{ type: "divider" }],
    },
  ])("accepts $name and allows empty content", async ({ blocks, expectedBlocks }) => {
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "",
        blocks,
      },
      slackConfig(),
    );
    expect(sendSlackMessage).toHaveBeenCalledWith(
      "channel:C123",
      "",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: undefined,
        threadTs: undefined,
        blocks: expectedBlocks,
      }),
    );
  });

  it.each([
    {
      name: "invalid blocks JSON",
      blocks: "{not json",
      expectedError: /blocks must be valid JSON/i,
    },
    { name: "empty blocks arrays", blocks: "[]", expectedError: /at least one block/i },
  ])("rejects $name", async ({ blocks, expectedError }) => {
    await expect(
      handleSlackAction(
        {
          action: "sendMessage",
          to: "channel:C123",
          content: "",
          blocks,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(expectedError);
  });

  it("requires at least one of content, blocks, or mediaUrl", async () => {
    await expect(
      handleSlackAction(
        {
          action: "sendMessage",
          to: "channel:C123",
          content: "",
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/requires content, blocks, or mediaUrl/i);
  });

  it("routes uploadFile through sendSlackMessage with upload metadata", async () => {
    await handleSlackAction(
      {
        action: "uploadFile",
        to: "user:U123",
        filePath: "/tmp/report.png",
        initialComment: "fresh report",
        filename: "report-final.png",
        title: "Report Final",
        threadTs: "111.222",
      },
      slackConfig(),
    );

    expect(sendSlackMessage).toHaveBeenCalledWith(
      "user:U123",
      "fresh report",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: "/tmp/report.png",
        threadTs: "111.222",
        uploadFileName: "report-final.png",
        uploadTitle: "Report Final",
      }),
    );
  });

  it("sends media before a separate blocks message", async () => {
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123" });
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123" });

    const result = await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "hello",
        mediaUrl: "https://example.com/file.png",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
      slackConfig(),
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expect(sendSlackMessage).toHaveBeenNthCalledWith(
      1,
      "channel:C123",
      "",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: "https://example.com/file.png",
        threadTs: undefined,
      }),
    );
    expect(sendSlackMessage.mock.calls[0]?.[2]).not.toHaveProperty("blocks");
    expect(sendSlackMessage).toHaveBeenNthCalledWith(
      2,
      "channel:C123",
      "hello",
      expect.objectContaining({
        cfg: expect.any(Object),
        blocks: [{ type: "divider" }],
        threadTs: undefined,
      }),
    );
    expect(sendSlackMessage.mock.calls[1]?.[2]).not.toHaveProperty("mediaUrl");
    expect(result.details).toEqual({
      ok: true,
      result: { channelId: "C123" },
    });
  });

  it.each([
    {
      name: "JSON blocks",
      blocks: JSON.stringify([{ type: "divider" }]),
      expectedBlocks: [{ type: "divider" }],
    },
    {
      name: "array blocks",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      expectedBlocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
    },
  ])("passes $name to editSlackMessage", async ({ blocks, expectedBlocks }) => {
    await handleSlackAction(
      {
        action: "editMessage",
        channelId: "C123",
        messageId: "123.456",
        content: "",
        blocks,
      },
      slackConfig(),
    );
    expect(editSlackMessage).toHaveBeenCalledWith(
      "C123",
      "123.456",
      "",
      expect.objectContaining({
        cfg: expect.any(Object),
        blocks: expectedBlocks,
      }),
    );
  });

  it("requires content or blocks for editMessage", async () => {
    await expect(
      handleSlackAction(
        {
          action: "editMessage",
          channelId: "C123",
          messageId: "123.456",
          content: "",
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/requires content or blocks/i);
  });

  it("auto-injects threadTs from context when replyToMode=all", async () => {
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Threaded reply",
      },
      slackConfig(),
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Threaded reply", "1111111111.111111");
  });

  it("replyToMode=first threads first message then stops", async () => {
    const { cfg, context } = createReplyToFirstScenario();

    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "First" },
      cfg,
      context,
    );

    expectLastSlackSend("First", "1111111111.111111");
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first normalizes channel target when accounting explicit threadTs", async () => {
    const { cfg, context, hasRepliedRef } = createReplyToFirstScenario();

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "#c123",
        content: "Explicit",
        threadTs: "9999999999.999999",
      },
      cfg,
      context,
    );

    expect(hasRepliedRef.value).toBe(true);
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first marks hasRepliedRef even when threadTs is explicit", async () => {
    const { cfg, context, hasRepliedRef } = createReplyToFirstScenario();

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Explicit",
        threadTs: "9999999999.999999",
      },
      cfg,
      context,
    );

    expectLastSlackSend("Explicit", "9999999999.999999");
    expect(hasRepliedRef.value).toBe(true);
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first without hasRepliedRef does not thread", async () => {
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "No ref" },
      slackConfig(),
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "first",
      },
    );
    expectLastSlackSend("No ref");
  });

  it("does not auto-inject threadTs when replyToMode=off", async () => {
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "No thread" },
      slackConfig(),
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "off",
      },
    );
    expectLastSlackSend("No thread");
  });

  it("does not auto-inject threadTs when sending to different channel", async () => {
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C999", content: "Other channel" },
      slackConfig(),
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expect(sendSlackMessage).toHaveBeenCalledWith(
      "channel:C999",
      "Other channel",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: undefined,
        threadTs: undefined,
        blocks: undefined,
      }),
    );
  });

  it("explicit threadTs overrides context threadTs", async () => {
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Explicit wins",
        threadTs: "9999999999.999999",
      },
      slackConfig(),
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Explicit wins", "9999999999.999999");
  });

  it("handles channel target without prefix when replyToMode=all", async () => {
    await handleSlackAction(
      { action: "sendMessage", to: "C123", content: "Bare target" },
      slackConfig(),
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expect(sendSlackMessage).toHaveBeenCalledWith(
      "C123",
      "Bare target",
      expect.objectContaining({
        cfg: expect.any(Object),
        mediaUrl: undefined,
        threadTs: "1111111111.111111",
        blocks: undefined,
      }),
    );
  });

  it("adds normalized timestamps to readMessages payloads", async () => {
    readSlackMessages.mockResolvedValueOnce({
      messages: [{ ts: "1712345678.123456", text: "hi" }],
      hasMore: false,
    });

    const result = await handleSlackAction(
      { action: "readMessages", channelId: "C1" },
      slackConfig(),
    );

    expect(result).toMatchObject({
      details: {
        ok: true,
        hasMore: false,
        messages: [
          expect.objectContaining({
            ts: "1712345678.123456",
            timestampMs: 1712345678123,
          }),
        ],
      },
    });
  });

  it("passes threadId through to readSlackMessages", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    await handleSlackAction(
      { action: "readMessages", channelId: "C1", threadId: "1712345678.123456" },
      slackConfig(),
    );

    expect(readSlackMessages).toHaveBeenCalledWith(
      "C1",
      expect.objectContaining({
        cfg: expect.any(Object),
        threadId: "1712345678.123456",
        limit: undefined,
        before: undefined,
        after: undefined,
      }),
    );
  });

  it("passes messageId through to readSlackMessages", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    await handleSlackAction(
      {
        action: "readMessages",
        channelId: "C1",
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
      },
      slackConfig(),
    );

    expect(readSlackMessages).toHaveBeenCalledWith(
      "C1",
      expect.objectContaining({
        cfg: expect.any(Object),
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
      }),
    );
  });

  it("adds normalized timestamps to pin payloads", async () => {
    listSlackPins.mockResolvedValueOnce([{ message: { ts: "1712345678.123456", text: "pin" } }]);

    const result = await handleSlackAction({ action: "listPins", channelId: "C1" }, slackConfig());

    expect(result).toMatchObject({
      details: {
        ok: true,
        pins: [
          {
            message: expect.objectContaining({
              ts: "1712345678.123456",
              timestampMs: 1712345678123,
            }),
          },
        ],
      },
    });
  });

  it("uses user token for reads when available", async () => {
    const token = await resolveReadToken(
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
            userToken: "xoxp-user",
          },
        },
      }),
    );
    expect(token).toBe("xoxp-user");
  });

  it("falls back to bot token for reads when user token missing", async () => {
    const token = await resolveReadToken(
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
          },
        },
      }),
    );
    expect(token).toBeUndefined();
  });

  it("uses bot token for writes when userTokenReadOnly is true", async () => {
    const token = await resolveSendToken(
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
            userToken: "xoxp-user",
            userTokenReadOnly: true,
          },
        },
      }),
    );
    expect(token).toBeUndefined();
  });

  it("allows user token writes when bot token is missing", async () => {
    const token = await resolveSendToken({
      channels: {
        slack: {
          accounts: {
            default: {
              userToken: "xoxp-user",
              userTokenReadOnly: false,
            },
          },
        },
      },
    } as OpenClawConfig);
    expect(token).toBe("xoxp-user");
  });

  it("returns all emojis when no limit is provided", async () => {
    listSlackEmojis.mockResolvedValueOnce({
      ok: true,
      emoji: { party: "https://example.com/party.png", wave: "https://example.com/wave.png" },
    });

    const result = await handleSlackAction({ action: "emojiList" }, slackConfig());

    expect(result).toMatchObject({
      details: {
        ok: true,
        emojis: {
          emoji: { party: "https://example.com/party.png", wave: "https://example.com/wave.png" },
        },
      },
    });
  });

  it("applies limit to emoji-list results", async () => {
    listSlackEmojis.mockResolvedValueOnce({
      ok: true,
      emoji: {
        wave: "https://example.com/wave.png",
        party: "https://example.com/party.png",
        tada: "https://example.com/tada.png",
      },
    });

    const result = await handleSlackAction({ action: "emojiList", limit: 2 }, slackConfig());

    expect(result).toMatchObject({
      details: {
        ok: true,
        emojis: {
          emoji: {
            party: "https://example.com/party.png",
            tada: "https://example.com/tada.png",
          },
        },
      },
    });
  });
});
