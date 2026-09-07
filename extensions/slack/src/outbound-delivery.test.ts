// Slack tests cover outbound delivery plugin behavior.
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  addTestHook,
  createEmptyPluginRegistry,
  createOutboundTestPlugin,
  createTestRegistry,
  initializeGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
  type PluginHookRegistration,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSendTestClient } from "./blocks.test-helpers.js";
import * as clientDelivery from "./client-delivery.js";
import { slackOutbound } from "./outbound-adapter.js";
import { sendMessageSlack } from "./send.js";
import { clearSlackThreadParticipationCache } from "./sent-thread-cache.js";

const sendMessageSlackMock = vi.hoisted(() => vi.fn());

vi.mock("./send.runtime.js", () => ({
  sendMessageSlack: sendMessageSlackMock,
}));

const cfg: OpenClawConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      accounts: {
        default: {
          botToken: "xoxb-default",
          appToken: "xapp-default",
        },
      },
    },
  },
};

describe("slack outbound shared hook wiring", () => {
  beforeEach(() => {
    sendMessageSlackMock.mockReset();
    sendMessageSlackMock.mockResolvedValue({ messageId: "m1", channelId: "C123" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: createOutboundTestPlugin({ id: "slack", outbound: slackOutbound }),
          source: "test",
        },
      ]),
    );
    resetGlobalHookRunner();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearSlackThreadParticipationCache();
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
  });

  describe.each([
    {
      name: "raw blocks",
      content: { channelData: { slack: { blocks: [{ type: "divider" }] } } },
      expectedText: "Caption",
      hasBlocks: true,
    },
    {
      name: "oversized presentation fallback",
      content: { text: undefined, presentation: { title: "x".repeat(151), blocks: [] } },
      expectedText: "x".repeat(151),
      hasBlocks: false,
    },
  ])("media followed by $name", ({ content, expectedText, hasBlocks }) => {
    it.each([
      { name: "mediaUrl", media: { mediaUrl: "https://example.com/a.png" } },
      { name: "singleton mediaUrls", media: { mediaUrls: ["https://example.com/a.png"] } },
      {
        name: "mediaUrls list",
        media: { mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"] },
      },
    ])("uploads $name only once before finalization", async ({ media }) => {
      const mediaUrls = media.mediaUrls ?? [media.mediaUrl];
      const client = createSlackSendTestClient();
      const upload = vi
        .spyOn(clientDelivery, "uploadSlackFile")
        .mockImplementation(async (opts) => {
          await opts.onPlatformSendDispatch?.();
          return `F${mediaUrls.indexOf(opts.mediaUrl) + 1}`;
        });
      sendMessageSlackMock.mockImplementation(
        async (to: string, text: string, opts: Parameters<typeof sendMessageSlack>[2]) =>
          await sendMessageSlack(to, text, { ...opts, client }),
      );
      const payload: ReplyPayload = { text: "Caption", ...media, ...content };

      const result = await sendDurableMessageBatch({
        cfg,
        channel: "slack",
        to: "C123",
        payloads: [payload],
        accountId: "default",
        replyToId: "1712000000.000001",
      });

      expect(upload.mock.calls.map(([opts]) => opts.mediaUrl)).toEqual(mediaUrls);
      assert(result.status === "sent", "error" in result ? String(result.error) : result.status);
      expect(sendMessageSlackMock).toHaveBeenCalledTimes(mediaUrls.length + 1);
      const finalOptions = sendMessageSlackMock.mock.calls.at(-1)?.[2];
      expect(finalOptions).not.toHaveProperty("mediaUrl");
      expect(Boolean(finalOptions.blocks)).toBe(hasBlocks);
      expect(client.chat.postMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: expectedText, thread_ts: "1712000000.000001" }),
      );
      expect(upload.mock.calls.every(([opts]) => opts.threadTs === "1712000000.000001")).toBe(true);
      expect(result.results[0]?.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
        ...mediaUrls.map((_url, index) => `F${index + 1}`),
        "171234.567",
      ]);
    });
  });

  it("delivers a valid field-rich section through the outbound adapter", async () => {
    const client = createSlackSendTestClient();
    sendMessageSlackMock.mockImplementation(
      async (to: string, text: string, opts: Parameters<typeof sendMessageSlack>[2]) =>
        await sendMessageSlack(to, text, { ...opts, client }),
    );
    const fields = ["Alpha", "Beta", "Gamma"].map((label) => ({
      type: "plain_text",
      text: label.padEnd(1_500, "."),
    }));
    const blocks = [{ type: "section", fields }];

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ channelData: { slack: { blocks } } }],
      accountId: "default",
    });

    assert(result.status === "sent", "error" in result ? String(result.error) : result.status);
    expect(client.chat.postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        blocks,
        text: fields.map((field) => field.text).join("\n"),
        mrkdwn: false,
      }),
    );
    expect(result.results[0]?.receipt?.platformMessageIds).toEqual(["171234.567"]);
  });

  it("preserves a field-rich section and every receipt when native table delivery falls back", async () => {
    const client = createSlackSendTestClient();
    client.chat.postMessage
      .mockRejectedValueOnce({ data: { error: "invalid_blocks" } })
      .mockResolvedValueOnce({ ts: "171234.1" })
      .mockResolvedValueOnce({ ts: "171234.2" });
    sendMessageSlackMock.mockImplementation(
      async (to: string, text: string, opts: Parameters<typeof sendMessageSlack>[2]) =>
        await sendMessageSlack(to, text, { ...opts, client }),
    );
    const fields = ["Alpha", "Beta", "Gamma"].map((label) => ({
      type: "plain_text",
      text: label.padEnd(1_500, "."),
    }));
    const section = { type: "section", fields };
    const footer = { type: "section", text: { type: "plain_text", text: "End of report" } };
    const blocks = [
      section,
      {
        type: "data_table",
        caption: "Pipeline",
        rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
      },
      footer,
    ];

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ channelData: { slack: { blocks } } }],
      accountId: "default",
    });

    assert(result.status === "sent", "error" in result ? String(result.error) : result.status);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    expect(client.chat.postMessage.mock.calls[1]?.[0]).toMatchObject({
      blocks: [section],
      text: fields.map((field) => field.text).join("\n"),
      mrkdwn: false,
    });
    expect(client.chat.postMessage.mock.calls[2]?.[0]).toMatchObject({
      blocks: [
        { type: "section", text: { type: "plain_text", text: "Pipeline (table)\nAccount\nAcme" } },
        footer,
      ],
      text: "Pipeline (table)\nAccount\nAcme\n\nEnd of report",
      mrkdwn: false,
    });
    expect(result.results[0]?.receipt?.platformMessageIds).toEqual(["171234.1", "171234.2"]);
  });

  it("fires message_sending once with shared routing fields", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue(undefined);
    addTestHook({
      registry: hookRegistry,
      pluginId: "test-plugin",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      {
        to: "C123",
        content: "hello",
        replyToId: "1712000000.000001",
        metadata: {
          channel: "slack",
          accountId: "default",
          mediaUrls: [],
        },
      },
      {
        channelId: "slack",
        accountId: "default",
        conversationId: "C123",
      },
    );
    expect(sendMessageSlackMock).toHaveBeenCalledTimes(1);
  });

  it("passes replyToId as Slack threadTs for threaded outbound delivery", async () => {
    await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "hello",
      expect.objectContaining({
        cfg,
        threadTs: "1712000000.000001",
        accountId: "default",
        onDeliveryResult: expect.any(Function),
      }),
    );
  });

  it("respects cancel from the shared hook without a second adapter pass", async () => {
    const hookRegistry = createEmptyPluginRegistry();
    const handler = vi.fn().mockResolvedValue({ cancel: true });
    addTestHook({
      registry: hookRegistry,
      pluginId: "test-plugin",
      hookName: "message_sending",
      handler: handler as PluginHookRegistration["handler"],
    });
    initializeGlobalHookRunner(hookRegistry);

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "hello" }],
      accountId: "default",
      replyToId: "1712000000.000001",
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sendMessageSlackMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "suppressed", results: [] });
  });
});
