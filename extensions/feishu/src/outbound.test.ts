import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() => vi.fn(async () => false));
const shouldSuppressFeishuTextForVoiceMediaMock = vi.hoisted(
  () => (params: { mediaUrl?: string; audioAsVoice?: boolean }) =>
    params.audioAsVoice === true || /\.(?:ogg|opus)(?:[?#]|$)/i.test(params.mediaUrl ?? ""),
);

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
  shouldSuppressFeishuTextForVoiceMedia: shouldSuppressFeishuTextForVoiceMediaMock,
}));

vi.mock("./send.js", () => ({
  editMessageFeishu: vi.fn(),
  getMessageFeishu: vi.fn(),
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
  sendStructuredCardFeishu: sendStructuredCardFeishuMock,
  resolveFeishuCardTemplate: (template?: string) =>
    new Set([
      "blue",
      "green",
      "red",
      "orange",
      "purple",
      "indigo",
      "wathet",
      "turquoise",
      "yellow",
      "grey",
      "carmine",
      "violet",
      "lime",
    ]).has(template ?? "")
      ? template
      : undefined,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("./comment-reaction.js", () => ({
  cleanupAmbientCommentTypingReaction: cleanupAmbientCommentTypingReactionMock,
}));

import { feishuPlugin } from "./channel.js";
import { feishuOutbound } from "./outbound.js";
import { createFeishuSendReceipt } from "./send-result.js";

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

type FeishuSendText = NonNullable<typeof feishuOutbound.sendText>;
type FeishuMessageAdapter = NonNullable<typeof feishuPlugin.message>;
type FeishuMessageSender = NonNullable<FeishuMessageAdapter["send"]>;

function requireFeishuSendText(): FeishuSendText {
  const sendText = feishuOutbound.sendText;
  if (!sendText) {
    throw new Error("Expected Feishu outbound sendText");
  }
  return sendText;
}

function requireFeishuMessageAdapter(): FeishuMessageAdapter {
  const adapter = feishuPlugin.message;
  if (!adapter) {
    throw new Error("Expected Feishu message adapter");
  }
  return adapter;
}

function requireFeishuTextSender(
  adapter: FeishuMessageAdapter,
): NonNullable<FeishuMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected Feishu message adapter text sender");
  }
  return text;
}

function requireFeishuMediaSender(
  adapter: FeishuMessageAdapter,
): NonNullable<FeishuMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected Feishu message adapter media sender");
  }
  return media;
}

const sendText = requireFeishuSendText();
const emptyConfig: ClawdbotConfig = {};
const cardRenderConfig: ClawdbotConfig = {
  channels: {
    feishu: {
      renderMode: "card",
    },
  },
};

afterAll(() => {
  vi.doUnmock("./media.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./client.js");
  vi.doUnmock("./drive.js");
  vi.doUnmock("./comment-reaction.js");
  vi.resetModules();
});

function resetOutboundMocks() {
  vi.clearAllMocks();
  sendMessageFeishuMock.mockResolvedValue({ messageId: "text_msg" });
  sendCardFeishuMock.mockResolvedValue({ messageId: "native_card_msg" });
  sendMarkdownCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendStructuredCardFeishuMock.mockResolvedValue({ messageId: "card_msg" });
  sendMediaFeishuMock.mockResolvedValue({ messageId: "media_msg" });
  deliverCommentThreadTextMock.mockResolvedValue({
    delivery_mode: "reply_comment",
    reply_id: "reply_msg",
  });
  cleanupAmbientCommentTypingReactionMock.mockResolvedValue(false);
}

function sendMessageCall(index = 0): Record<string, any> | undefined {
  const calls = sendMessageFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendMediaCall(index = 0): Record<string, any> | undefined {
  const calls = sendMediaFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendCardCall(index = 0): Record<string, any> | undefined {
  const calls = sendCardFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendStructuredCardCall(index = 0): Record<string, any> | undefined {
  const calls = sendStructuredCardFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function sendMarkdownCardCall(index = 0): Record<string, any> | undefined {
  const calls = sendMarkdownCardFeishuMock.mock.calls as unknown as Array<[Record<string, any>]>;
  return calls[index]?.[0];
}

function commentThreadParams(index = 0): Record<string, any> | undefined {
  const calls = deliverCommentThreadTextMock.mock.calls as unknown as Array<
    [unknown, Record<string, any>]
  >;
  return calls[index]?.[1];
}

function cleanupReactionCall(index = 0): Record<string, any> | undefined {
  const calls = cleanupAmbientCommentTypingReactionMock.mock.calls as unknown as Array<
    [Record<string, any>]
  >;
  return calls[index]?.[0];
}

function expectFeishuResult(result: unknown, messageId: string) {
  const typedResult = result as { channel?: string; messageId?: string } | undefined;
  expect(typedResult?.channel).toBe("feishu");
  expect(typedResult?.messageId).toBe(messageId);
}

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    sendMessageFeishuMock.mockResolvedValue({
      messageId: "feishu-text-1",
      chatId: "chat-1",
      receipt: createFeishuSendReceipt({
        messageId: "feishu-text-1",
        chatId: "chat-1",
        kind: "text",
      }),
    });
    sendMediaFeishuMock.mockResolvedValue({
      messageId: "feishu-media-1",
      chatId: "chat-1",
      receipt: createFeishuSendReceipt({
        messageId: "feishu-media-1",
        chatId: "chat-1",
        kind: "media",
      }),
    });
    const adapter = requireFeishuMessageAdapter();
    const adapterSendText = requireFeishuTextSender(adapter);
    const adapterSendMedia = requireFeishuMediaSender(adapter);

    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "feishu",
      adapter,
      proofs: {
        text: async () => {
          const result = await adapterSendText({
            cfg: emptyConfig,
            to: "chat:chat-1",
            text: "hello",
            accountId: "default",
          });
          expect(sendMessageCall()?.to).toBe("chat:chat-1");
          expect(sendMessageCall()?.text).toBe("hello");
          expect(sendMessageCall()?.accountId).toBe("default");
          expect(result.receipt.platformMessageIds).toEqual(["feishu-text-1"]);
        },
        media: async () => {
          const result = await adapterSendMedia({
            cfg: emptyConfig,
            to: "chat:chat-1",
            text: "",
            mediaUrl: "https://example.com/image.png",
            accountId: "default",
          });
          expect(sendMediaCall()?.to).toBe("chat:chat-1");
          expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/image.png");
          expect(sendMediaCall()?.accountId).toBe("default");
          expect(result.receipt.platformMessageIds).toEqual(["feishu-media-1"]);
        },
      },
    });
    expect(proofs.some((proof) => proof.capability === "text" && proof.status === "verified")).toBe(
      true,
    );
    expect(
      proofs.some((proof) => proof.capability === "media" && proof.status === "verified"),
    ).toBe(true);
  });

  it("chunks outbound text without requiring Feishu runtime initialization", () => {
    const chunker = feishuOutbound.chunker;
    if (!chunker) {
      throw new Error("feishuOutbound.chunker missing");
    }

    expect(chunker("hello world", 5)).toEqual(["hello", "world"]);
  });

  async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-outbound-"));
    const file = path.join(dir, `sample${ext}`);
    await fs.writeFile(file, "image-data");
    return { dir, file };
  }

  it("sends an absolute existing local image path as media", async () => {
    const { dir, file } = await createTmpImage();
    try {
      const result = await sendText({
        cfg: emptyConfig,
        to: "chat_1",
        text: file,
        accountId: "main",
        mediaLocalRoots: [dir],
      });

      expect(sendMediaCall()?.to).toBe("chat_1");
      expect(sendMediaCall()?.mediaUrl).toBe(file);
      expect(sendMediaCall()?.accountId).toBe("main");
      expect(sendMediaCall()?.mediaLocalRoots).toEqual([dir]);
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expectFeishuResult(result, "media_msg");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps non-path text on the text-send path", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "please upload /tmp/example.png",
      accountId: "main",
    });

    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("please upload /tmp/example.png");
    expect(sendMessageCall()?.accountId).toBe("main");
  });

  it("falls back to plain text if local-image media send fails", async () => {
    const { dir, file } = await createTmpImage();
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));
    try {
      await sendText({
        cfg: emptyConfig,
        to: "chat_1",
        text: file,
        accountId: "main",
      });

      expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
      expect(sendMessageCall()?.to).toBe("chat_1");
      expect(sendMessageCall()?.text).toBe(file);
      expect(sendMessageCall()?.accountId).toBe("main");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses markdown cards when renderMode=card", async () => {
    const result = await sendText({
      cfg: cardRenderConfig,
      to: "chat_1",
      text: "| a | b |\n| - | - |",
      accountId: "main",
    });

    expect(sendStructuredCardCall()?.to).toBe("chat_1");
    expect(sendStructuredCardCall()?.text).toBe("| a | b |\n| - | - |");
    expect(sendStructuredCardCall()?.accountId).toBe("main");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "card_msg");
  });

  it("forwards replyToId as replyToMessageId on sendText", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "hello",
      replyToId: "om_reply_1",
      accountId: "main",
    });

    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("hello");
    expect(sendMessageCall()?.replyToMessageId).toBe("om_reply_1");
    expect(sendMessageCall()?.accountId).toBe("main");
  });

  it("falls back to threadId when replyToId is empty on sendText", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "hello",
      replyToId: " ",
      threadId: "om_thread_2",
      accountId: "main",
    });

    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("hello");
    expect(sendMessageCall()?.replyToMessageId).toBe("om_thread_2");
    expect(sendMessageCall()?.replyInThread).toBe(true);
    expect(sendMessageCall()?.accountId).toBe("main");
  });
});

describe("feishuOutbound.sendPayload native cards", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  async function createTmpImage(ext = ".png"): Promise<{ dir: string; file: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-payload-"));
    const file = path.join(dir, `sample${ext}`);
    await fs.writeFile(file, "image-data");
    return { dir, file };
  }

  it("renders presentation-only payloads into Feishu channelData cards for core delivery", async () => {
    const presentation: MessagePresentation = {
      title: "Approval",
      tone: "success",
      blocks: [
        { type: "text", text: "Approve the request?" },
        {
          type: "buttons",
          buttons: [
            { label: "Approve", value: "/approve req_1 allow-once", style: "success" as const },
          ],
        },
      ],
    };
    const payload = { presentation };
    const rendered = await feishuOutbound.renderPresentation?.({
      payload,
      presentation,
      ctx: {
        cfg: emptyConfig,
        to: "chat_1",
        text: "",
        accountId: "main",
        payload,
      },
    });

    if (!rendered) {
      throw new Error("expected Feishu presentation renderer to return a payload");
    }
    expect(rendered.text).toBe("Approval\n\nApprove the request?\n\n- Approve");
    const renderedChannelData = rendered.channelData as
      | { feishu?: { card?: Record<string, any> } }
      | undefined;
    const renderedCard = renderedChannelData?.feishu?.card;
    expect(renderedCard?.schema).toBe("2.0");
    expect(renderedCard?.header).toEqual({
      title: { tag: "plain_text", content: "Approval" },
      template: "green",
    });
    expect(renderedCard?.body?.elements?.[0]).toEqual({
      tag: "markdown",
      content: "Approve the request?",
    });
    expect(
      renderedCard?.body?.elements?.some((element: { tag?: string }) => element.tag === "action"),
    ).toBe(true);
    const { presentation: _presentation, ...coreRenderedPayload } = rendered;
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: coreRenderedPayload.text ?? "",
      accountId: "main",
      payload: coreRenderedPayload,
    });

    expect(sendCardCall()?.to).toBe("chat_1");
    expect(sendCardCall()?.card?.header).toEqual({
      title: { tag: "plain_text", content: "Approval" },
      template: "green",
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "native_card_msg");
  });

  it("sends interactive button payloads as native Feishu cards", async () => {
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "Choose an action",
      accountId: "main",
      payload: {
        text: "Choose an action",
        interactive: {
          blocks: [
            { type: "text", text: "Approve the request?" },
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "/approve req_1 allow-once", style: "success" },
                { label: "Deny", value: "/approve req_1 deny", style: "danger" },
              ],
            },
          ],
        },
      },
    });

    expect(sendCardCall()?.cfg).toBe(emptyConfig);
    expect(sendCardCall()?.to).toBe("chat_1");
    expect(sendCardCall()?.accountId).toBe("main");
    const card = sendCardFeishuMock.mock.calls[0][0].card;
    expect(card.schema).toBe("2.0");
    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "Choose an action" });
    expect(card.body.elements[1]).toEqual({
      tag: "markdown",
      content: "Approve the request?",
    });
    const actionElement = card.body.elements.find(
      (element: { tag?: string }) => element.tag === "action",
    );
    expect(actionElement?.actions[0]?.text).toEqual({ tag: "plain_text", content: "Approve" });
    expect(actionElement?.actions[0]?.type).toBe("primary");
    expect(actionElement?.actions[0]?.value?.oc).toBe("ocf1");
    expect(actionElement?.actions[0]?.value?.k).toBe("quick");
    expect(actionElement?.actions[0]?.value?.q).toBe("/approve req_1 allow-once");
    expect(actionElement?.actions[1]?.text).toEqual({ tag: "plain_text", content: "Deny" });
    expect(actionElement?.actions[1]?.type).toBe("danger");
    expect(actionElement?.actions[1]?.value?.oc).toBe("ocf1");
    expect(actionElement?.actions[1]?.value?.k).toBe("quick");
    expect(actionElement?.actions[1]?.value?.q).toBe("/approve req_1 deny");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "native_card_msg");
  });

  it("escapes generated markdown card text and drops unsafe button URLs", async () => {
    await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: 'Choose <at id="ou_1">',
      accountId: "main",
      payload: {
        text: 'Choose <at id="ou_1">',
        presentation: {
          blocks: [
            { type: "context", text: '</font><at id="ou_2">Injected</at>' },
            {
              type: "buttons",
              buttons: [
                { label: "Open", url: "https://example.com/path" },
                { label: "Bad", url: "javascript:alert(1)" },
              ],
            },
          ],
        },
      },
    });

    const card = sendCardFeishuMock.mock.calls[0][0].card;
    expect(card.body.elements[0]).toEqual({
      tag: "markdown",
      content: 'Choose &lt;at id="ou_1"&gt;',
    });
    expect(card.body.elements[1]).toEqual({
      tag: "markdown",
      content: "<font color='grey'>&lt;/font&gt;&lt;at id=\"ou_2\"&gt;Injected&lt;/at&gt;</font>",
    });
    const actionElement = card.body.elements.find(
      (element: { tag?: string }) => element.tag === "action",
    );
    expect(actionElement?.actions[0]?.text).toEqual({ tag: "plain_text", content: "Open" });
    expect(actionElement?.actions[0]?.url).toBe("https://example.com/path");
    expect(JSON.stringify(card)).not.toContain("javascript:");
  });

  it("normalizes caller-supplied native Feishu cards before sending", async () => {
    await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "fallback",
      accountId: "main",
      payload: {
        text: "fallback",
        channelData: {
          feishu: {
            card: {
              schema: "2.0",
              header: {
                title: { tag: "plain_text", content: "Unsafe card" },
                template: "not-a-template",
              },
              body: {
                elements: [
                  { tag: "img", img_key: "image-secret" },
                  { tag: "markdown", content: '<at id="ou_1">ping</at>' },
                  {
                    tag: "action",
                    actions: [
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "Bad link" },
                        url: "file:///etc/passwd",
                      },
                      {
                        tag: "button",
                        text: { tag: "plain_text", content: "Good link" },
                        url: "https://example.com",
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    });

    const card = sendCardFeishuMock.mock.calls[0][0].card;
    expect(card.header.template).toBe("blue");
    expect(card.body.elements).toEqual([
      { tag: "markdown", content: '&lt;at id="ou_1"&gt;ping&lt;/at&gt;' },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Good link" },
            type: "default",
            url: "https://example.com",
          },
        ],
      },
    ]);
    expect(JSON.stringify(card)).not.toContain("file://");
    expect(JSON.stringify(card)).not.toContain("image-secret");
  });

  it("sends payload media before final native cards", async () => {
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "See attached",
      accountId: "main",
      mediaLocalRoots: ["/tmp"],
      payload: {
        text: "See attached",
        mediaUrl: "/tmp/image.png",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", url: "https://example.com" }] }],
        },
      },
    });

    expect(sendMediaCall()?.to).toBe("chat_1");
    expect(sendMediaCall()?.mediaUrl).toBe("/tmp/image.png");
    expect(sendMediaCall()?.mediaLocalRoots).toEqual(["/tmp"]);
    expect(sendMediaCall()?.accountId).toBe("main");
    expect(sendCardCall()?.to).toBe("chat_1");
    expect(sendCardCall()?.accountId).toBe("main");
    expectFeishuResult(result, "native_card_msg");
  });

  it("keeps text/media fallback behavior for non-card payloads, including local image text", async () => {
    const { dir, file } = await createTmpImage();
    try {
      const result = await feishuOutbound.sendPayload?.({
        cfg: emptyConfig,
        to: "chat_1",
        text: file,
        accountId: "main",
        mediaLocalRoots: [dir],
        payload: { text: file },
      });

      expect(sendCardFeishuMock).not.toHaveBeenCalled();
      expect(sendMediaCall()?.to).toBe("chat_1");
      expect(sendMediaCall()?.mediaUrl).toBe(file);
      expect(sendMediaCall()?.mediaLocalRoots).toEqual([dir]);
      expect(sendMediaCall()?.accountId).toBe("main");
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expectFeishuResult(result, "media_msg");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to comment-thread text instead of sending native cards to document comments", async () => {
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "Review this",
      accountId: "main",
      payload: {
        text: "Review this",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "/approve req_1" }] }],
        },
      },
    });

    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(commentThreadParams()?.content).toBe("Review this\n\n- Approve");
    expectFeishuResult(result, "reply_msg");
  });
});

describe("feishuOutbound comment-thread routing", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("routes comment-thread text through deliverCommentThreadText", async () => {
    const result = await sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "handled in thread",
      accountId: "main",
    });

    expect(commentThreadParams()?.file_token).toBe("doxcn123");
    expect(commentThreadParams()?.file_type).toBe("docx");
    expect(commentThreadParams()?.comment_id).toBe("7623358762119646411");
    expect(commentThreadParams()?.content).toBe("handled in thread");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("routes comment-thread code-block replies through deliverCommentThreadText instead of IM cards", async () => {
    const result = await sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "```ts\nconst x = 1\n```",
      accountId: "main",
    });

    expect(commentThreadParams()?.file_token).toBe("doxcn123");
    expect(commentThreadParams()?.file_type).toBe("docx");
    expect(commentThreadParams()?.comment_id).toBe("7623358762119646411");
    expect(commentThreadParams()?.content).toBe("```ts\nconst x = 1\n```");
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("routes comment-thread replies through deliverCommentThreadText even when renderMode=card", async () => {
    const result = await sendText({
      cfg: cardRenderConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "handled in thread",
      accountId: "main",
    });

    expect(commentThreadParams()?.file_token).toBe("doxcn123");
    expect(commentThreadParams()?.file_type).toBe("docx");
    expect(commentThreadParams()?.comment_id).toBe("7623358762119646411");
    expect(commentThreadParams()?.content).toBe("handled in thread");
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("falls back to a text-only comment reply for media payloads", async () => {
    const result = await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "see attachment",
      mediaUrl: "https://example.com/file.png",
      accountId: "main",
    });

    expect(commentThreadParams()?.content).toBe("see attachment\n\nhttps://example.com/file.png");
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "reply_msg");
  });

  it("preserves comment-thread routing when deliverCommentThreadText falls back to add_comment", async () => {
    deliverCommentThreadTextMock.mockResolvedValueOnce({
      delivery_mode: "add_comment",
      comment_id: "comment_msg",
      reply_id: "reply_from_add_comment",
    });

    const result = await sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "whole-comment follow-up",
      accountId: "main",
    });

    expect(commentThreadParams()?.file_token).toBe("doxcn123");
    expect(commentThreadParams()?.file_type).toBe("docx");
    expect(commentThreadParams()?.comment_id).toBe("7623358762119646411");
    expect(commentThreadParams()?.content).toBe("whole-comment follow-up");
    expectFeishuResult(result, "reply_from_add_comment");
  });

  it("does not wait for ambient comment typing cleanup before sending comment-thread replies", async () => {
    let resolveCleanup: ((value: boolean) => void) | undefined;
    cleanupAmbientCommentTypingReactionMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    const sendPromise = sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "handled in thread",
      replyToId: "reply_ambient_1",
      accountId: "main",
    });

    const status = await raceWithNextMacrotask(sendPromise.then(() => "done"));

    expect(status).toBe("done");
    expect(deliverCommentThreadTextMock).toHaveBeenCalled();
    const cleanupCall = cleanupReactionCall();
    if (!cleanupCall?.client) {
      throw new Error("Expected cleanup reaction client");
    }
    expect(cleanupCall.deliveryContext).toEqual({
      channel: "feishu",
      to: "comment:docx:doxcn123:7623358762119646411",
      threadId: "reply_ambient_1",
    });

    resolveCleanup?.(false);
    await sendPromise;
  });
});

describe("feishuOutbound.sendText replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("forwards replyToId as replyToMessageId to sendMessageFeishu", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "hello",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("hello");
    expect(sendMessageCall()?.replyToMessageId).toBe("om_reply_target");
    expect(sendMessageCall()?.accountId).toBe("main");
  });

  it("forwards replyToId to sendStructuredCardFeishu when renderMode=card", async () => {
    await sendText({
      cfg: cardRenderConfig,
      to: "chat_1",
      text: "```code```",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendStructuredCardCall()?.replyToMessageId).toBe("om_reply_target");
  });

  it("does not pass replyToMessageId when replyToId is absent", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "hello",
      accountId: "main",
    });

    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("hello");
    expect(sendMessageCall()?.accountId).toBe("main");
    expect(sendMessageFeishuMock.mock.calls[0][0].replyToMessageId).toBeUndefined();
  });

  it("propagates threadId as replyInThread=true to sendMessageFeishu", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "topic reply",
      threadId: "om_topic_root",
      accountId: "main",
    });

    expect(sendMessageCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendMessageCall()?.replyInThread).toBe(true);
  });

  it("propagates threadId as replyInThread=true to sendStructuredCardFeishu when renderMode=card", async () => {
    await sendText({
      cfg: cardRenderConfig,
      to: "chat_1",
      text: "```code```",
      threadId: "om_topic_root",
      accountId: "main",
    });

    expect(sendStructuredCardCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendStructuredCardCall()?.replyInThread).toBe(true);
  });

  it("prefers replyToId over threadId for plain text (inline reply, no auto-thread)", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "inline reply",
      replyToId: "om_inline",
      threadId: "om_topic_root",
      accountId: "main",
    });

    expect(sendMessageCall()?.replyToMessageId).toBe("om_inline");
    expect(sendMessageCall()?.replyInThread).toBe(false);
  });
});

describe("feishuOutbound.sendMedia replyToId forwarding", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("forwards replyToId to sendMediaFeishu", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_reply_target");
    expect(sendMediaCall()?.replyInThread).toBe(false);
  });

  it("forwards threadId as replyInThread=true to sendMediaFeishu", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "",
      mediaUrl: "https://example.com/image.png",
      threadId: "om_topic_root",
      accountId: "main",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendMediaCall()?.replyInThread).toBe(true);
  });

  it("prefers replyToId over threadId (inline reply) when both are set", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_inline",
      threadId: "om_topic_root",
      accountId: "main",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_inline");
    expect(sendMediaCall()?.replyInThread).toBe(false);
  });

  it("treats whitespace-only replyToId as absent for replyInThread (falls back to threadId)", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "",
      mediaUrl: "https://example.com/image.png",
      replyToId: "   ",
      threadId: "om_topic_root",
      accountId: "main",
    });

    expect(sendMediaCall()?.replyToMessageId).toBe("om_topic_root");
    expect(sendMediaCall()?.replyInThread).toBe(true);
  });

  it("forwards audioAsVoice to sendMediaFeishu", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
      accountId: "main",
    });

    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.mp3");
    expect(sendMediaCall()?.audioAsVoice).toBe(true);
  });

  it("suppresses duplicate text when sending voice media", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
      accountId: "main",
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.mp3");
    expect(sendMediaCall()?.audioAsVoice).toBe(true);
  });

  it("sends skipped voice text when voice media degrades to a file attachment", async () => {
    sendMediaFeishuMock.mockResolvedValueOnce({
      messageId: "file_msg",
      voiceIntentDegradedToFile: true,
    });

    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
      accountId: "main",
    });

    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.mp3");
    expect(sendMediaCall()?.audioAsVoice).toBe(true);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageCall()?.text).toBe("spoken reply");
  });

  it("suppresses duplicate text for native voice media without audioAsVoice", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.ogg?download=1",
      accountId: "main",
    });

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/reply.ogg?download=1");
  });

  it("keeps captions for regular audio file attachments", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "caption text",
      mediaUrl: "https://example.com/song.mp3",
      accountId: "main",
    });

    expect(sendMessageCall()?.text).toBe("caption text");
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/song.mp3");
  });

  it("keeps skipped voice text in the upload failure fallback", async () => {
    sendMediaFeishuMock.mockRejectedValueOnce(new Error("upload failed"));

    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "spoken reply",
      mediaUrl: "https://example.com/reply.mp3",
      audioAsVoice: true,
      accountId: "main",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageCall()?.text).toBe("spoken reply\n\n📎 https://example.com/reply.mp3");
  });

  it("forwards replyToId to text caption send", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "caption text",
      mediaUrl: "https://example.com/image.png",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendMessageCall()?.replyToMessageId).toBe("om_reply_target");
  });
});

describe("feishuOutbound.sendMedia renderMode", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("uses markdown cards for captions when renderMode=card", async () => {
    const result = await feishuOutbound.sendMedia?.({
      cfg: cardRenderConfig,
      to: "chat_1",
      text: "| a | b |\n| - | - |",
      mediaUrl: "https://example.com/image.png",
      accountId: "main",
    });

    expect(sendMarkdownCardCall()?.to).toBe("chat_1");
    expect(sendMarkdownCardCall()?.text).toBe("| a | b |\n| - | - |");
    expect(sendMarkdownCardCall()?.accountId).toBe("main");
    expect(sendMediaCall()?.to).toBe("chat_1");
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/image.png");
    expect(sendMediaCall()?.accountId).toBe("main");
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expectFeishuResult(result, "media_msg");
  });

  it("uses threadId fallback as replyToMessageId on sendMedia", async () => {
    await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      threadId: "om_thread_1",
      accountId: "main",
    });

    expect(sendMediaCall()?.to).toBe("chat_1");
    expect(sendMediaCall()?.mediaUrl).toBe("https://example.com/image.png");
    expect(sendMediaCall()?.replyToMessageId).toBe("om_thread_1");
    expect(sendMediaCall()?.accountId).toBe("main");
    expect(sendMessageCall()?.to).toBe("chat_1");
    expect(sendMessageCall()?.text).toBe("caption");
    expect(sendMessageCall()?.replyToMessageId).toBe("om_thread_1");
    expect(sendMessageCall()?.accountId).toBe("main");
  });
});
