import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function requireArray(value: unknown, label: string): unknown[] {
    expect(Array.isArray(value)).toBe(true);
    if (!Array.isArray(value)) {
      throw new Error(`${label} was not an array`);
    }
    return value;
  }

  function requireMockCall(
    source: { mock: { calls: unknown[][] } },
    label: string,
    index = 0,
  ): unknown[] {
    const call = source.mock.calls[index];
    if (!call) {
      throw new Error(`missing ${label} call ${index + 1}`);
    }
    return call;
  }

  function requireMockArg(
    source: { mock: { calls: unknown[][] } },
    label: string,
    callIndex: number,
    argIndex: number,
  ): unknown {
    return requireMockCall(source, label, callIndex)[argIndex];
  }

  function requireRecordArg(
    source: { mock: { calls: unknown[][] } },
    label: string,
    callIndex: number,
    argIndex: number,
  ): Record<string, unknown> {
    return requireRecord(
      requireMockArg(source, label, callIndex, argIndex),
      `${label} call ${callIndex + 1} argument ${argIndex + 1}`,
    );
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function requireSlackSendCall(index: number) {
    const call = sendSlackMessage.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing Slack send call ${index + 1}`);
    }
    return call;
  }

  function expectSlackSendCall(
    index: number,
    target: string,
    content: string,
    optionFields: Record<string, unknown>,
  ) {
    const [actualTarget, actualContent, options] = requireSlackSendCall(index);
    expect(actualTarget).toBe(target);
    expect(actualContent).toBe(content);
    expectRecordFields(requireRecord(options, "Slack send options"), optionFields);
    return requireRecord(options, "Slack send options");
  }

  function expectLastSlackSend(content: string, cfg: OpenClawConfig, threadTs?: string) {
    expectSlackSendCall(sendSlackMessage.mock.calls.length - 1, "channel:C123", content, {
      cfg,
      mediaUrl: undefined,
      threadTs,
      blocks: undefined,
    });
  }

  function requireDetails(result: Awaited<ReturnType<typeof handleSlackAction>>) {
    return requireRecord(result.details, "action result details");
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
    expectLastSlackSend("Second", params.cfg);
  }

  async function resolveReadToken(cfg: OpenClawConfig): Promise<string | undefined> {
    readSlackMessages.mockClear();
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });
    await handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg);
    const token = requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1).token;
    return typeof token === "string" ? token : undefined;
  }

  async function resolveSendToken(cfg: OpenClawConfig): Promise<string | undefined> {
    sendSlackMessage.mockClear();
    await handleSlackAction({ action: "sendMessage", to: "channel:C1", content: "Hello" }, cfg);
    const token = requireRecordArg(sendSlackMessage, "sendSlackMessage", 0, 2).token;
    return typeof token === "string" ? token : undefined;
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
    const cfg = slackConfig();
    const result = await handleSlackAction(
      {
        action: "react",
        channelId,
        messageId: "123.456",
        emoji: "✅",
      },
      cfg,
    );
    expect(reactSlackMessage).toHaveBeenCalledWith("C1", "123.456", "✅", { cfg });
    expect(JSON.parse((result.content?.[0] as { type: "text"; text: string }).text)).toEqual({
      ok: true,
      added: "✅",
    });
  });

  it("removes reactions on empty emoji", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "",
      },
      cfg,
    );
    expect(removeOwnSlackReactions).toHaveBeenCalledWith("C1", "123.456", { cfg });
  });

  it("removes reactions when remove flag set", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "✅",
        remove: true,
      },
      cfg,
    );
    expect(removeSlackReaction).toHaveBeenCalledWith("C1", "123.456", "✅", { cfg });
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
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
      },
      cfg,
    );
    expectSlackSendCall(0, "channel:C123", "Hello thread", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1234567890.123456",
      blocks: undefined,
    });
  });

  it("passes replyBroadcast to sendSlackMessage for thread replies", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
        replyBroadcast: true,
      },
      cfg,
    );
    expectSlackSendCall(0, "channel:C123", "Hello thread", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1234567890.123456",
      replyBroadcast: true,
      blocks: undefined,
    });
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
    expect(requireMockArg(downloadSlackFile, "downloadSlackFile", 0, 0)).toBe("F123");
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).maxBytes).toBe(
      20 * 1024 * 1024,
    );
    expect(requireDetails(result).ok).toBe(false);
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

    expect(requireMockArg(downloadSlackFile, "downloadSlackFile", 0, 0)).toBe("F123");
    expectRecordFields(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1), {
      channelId: "C1",
      threadId: "123.456",
    });
    expect(requireDetails(result).ok).toBe(false);
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
    const firstContent = requireRecord(result.content[0], "first content item");
    expect(firstContent.type).toBe("text");
    expect(String(firstContent.text)).toContain("/tmp/openclaw-media/report.pdf");
    expect(result.content.map((entry) => entry.type)).not.toContain("image");
    const details = requireDetails(result);
    expectRecordFields(details, {
      ok: true,
      fileId: "F123",
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
    });
    expect(details.media).toEqual({
      mediaUrl: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
    });
  });

  it("forwards resolved botToken to action functions instead of relying on config re-read", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    await handleSlackAction({ action: "downloadFile", fileId: "F123" }, slackConfig());
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("tok");
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
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("xoxp-user");
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
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "",
        blocks,
      },
      cfg,
    );
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: expectedBlocks,
    });
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
    const cfg = slackConfig();
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
      cfg,
    );

    expectSlackSendCall(0, "user:U123", "fresh report", {
      cfg,
      mediaUrl: "/tmp/report.png",
      threadTs: "111.222",
      uploadFileName: "report-final.png",
      uploadTitle: "Report Final",
    });
  });

  it("rejects replyBroadcast for uploadFile", async () => {
    await expect(
      handleSlackAction(
        {
          action: "uploadFile",
          to: "channel:C123",
          filePath: "/tmp/report.txt",
          threadTs: "111.222",
          replyBroadcast: true,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
  });

  it("sends media before a separate blocks message", async () => {
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123" });
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123" });

    const cfg = slackConfig();
    const result = await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "hello",
        mediaUrl: "https://example.com/file.png",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
      cfg,
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      mediaUrl: "https://example.com/file.png",
      threadTs: undefined,
    });
    expect(requireRecordArg(sendSlackMessage, "sendSlackMessage", 0, 2)).not.toHaveProperty(
      "blocks",
    );
    expectSlackSendCall(1, "channel:C123", "hello", {
      cfg,
      blocks: [{ type: "divider" }],
      threadTs: undefined,
    });
    expect(requireRecordArg(sendSlackMessage, "sendSlackMessage", 1, 2)).not.toHaveProperty(
      "mediaUrl",
    );
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
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "editMessage",
        channelId: "C123",
        messageId: "123.456",
        content: "",
        blocks,
      },
      cfg,
    );
    const editCall = requireMockCall(editSlackMessage, "editSlackMessage");
    expect(editCall[0]).toBe("C123");
    expect(editCall[1]).toBe("123.456");
    expect(editCall[2]).toBe("");
    expectRecordFields(requireRecordArg(editSlackMessage, "editSlackMessage", 0, 3), {
      cfg,
      blocks: expectedBlocks,
    });
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
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Threaded reply",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Threaded reply", cfg, "1111111111.111111");
  });

  it.each([
    { name: "topLevel true", patch: { topLevel: true } },
    { name: "threadTs null", patch: { threadTs: null } },
  ] as const)("does not auto-inject threadTs for $name", async (testCase) => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Channel root",
        ...testCase.patch,
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Channel root", cfg);
  });

  it("replyToMode=first threads first message then stops", async () => {
    const { cfg, context } = createReplyToFirstScenario();

    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "First" },
      cfg,
      context,
    );

    expectLastSlackSend("First", cfg, "1111111111.111111");
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

    expectLastSlackSend("Explicit", cfg, "9999999999.999999");
    expect(hasRepliedRef.value).toBe(true);
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first without hasRepliedRef does not thread", async () => {
    const cfg = slackConfig();
    await handleSlackAction({ action: "sendMessage", to: "channel:C123", content: "No ref" }, cfg, {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first",
    });
    expectLastSlackSend("No ref", cfg);
  });

  it("does not auto-inject threadTs when replyToMode=off", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "No thread" },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "off",
      },
    );
    expectLastSlackSend("No thread", cfg);
  });

  it("does not auto-inject threadTs when sending to different channel", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C999", content: "Other channel" },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectSlackSendCall(0, "channel:C999", "Other channel", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("explicit threadTs overrides context threadTs", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Explicit wins",
        threadTs: "9999999999.999999",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Explicit wins", cfg, "9999999999.999999");
  });

  it("handles channel target without prefix when replyToMode=all", async () => {
    const cfg = slackConfig();
    await handleSlackAction({ action: "sendMessage", to: "C123", content: "Bare target" }, cfg, {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "all",
    });
    expectSlackSendCall(0, "C123", "Bare target", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1111111111.111111",
      blocks: undefined,
    });
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

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.hasMore).toBe(false);
    const messages = requireArray(details.messages, "read messages");
    expectRecordFields(requireRecord(messages[0], "first message"), {
      ts: "1712345678.123456",
      timestampMs: 1712345678123,
    });
  });

  it("passes threadId through to readSlackMessages", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig();
    await handleSlackAction(
      { action: "readMessages", channelId: "C1", threadId: "1712345678.123456" },
      cfg,
    );

    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C1");
    expectRecordFields(requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1), {
      cfg,
      threadId: "1712345678.123456",
      limit: undefined,
      before: undefined,
      after: undefined,
    });
  });

  it("passes messageId through to readSlackMessages", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "readMessages",
        channelId: "C1",
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
      },
      cfg,
    );

    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C1");
    expectRecordFields(requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1), {
      cfg,
      threadId: "1712345678.123456",
      messageId: "1712345678.654321",
    });
  });

  it("adds normalized timestamps to pin payloads", async () => {
    listSlackPins.mockResolvedValueOnce([{ message: { ts: "1712345678.123456", text: "pin" } }]);

    const result = await handleSlackAction({ action: "listPins", channelId: "C1" }, slackConfig());

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    const pins = requireArray(details.pins, "pins");
    const firstPin = requireRecord(pins[0], "first pin");
    expectRecordFields(requireRecord(firstPin.message, "first pin message"), {
      ts: "1712345678.123456",
      timestampMs: 1712345678123,
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

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.emojis).toEqual({
      ok: true,
      emoji: { party: "https://example.com/party.png", wave: "https://example.com/wave.png" },
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

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.emojis).toEqual({
      ok: true,
      emoji: {
        party: "https://example.com/party.png",
        tada: "https://example.com/tada.png",
      },
    });
  });
});
