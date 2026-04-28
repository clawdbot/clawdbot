import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendStructuredCardFeishuMock = vi.hoisted(() => vi.fn());
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const cleanupAmbientCommentTypingReactionMock = vi.hoisted(() => vi.fn(async () => false));

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./send.js", () => ({
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

import { feishuOutbound } from "./outbound.js";
const sendText = feishuOutbound.sendText!;
const emptyConfig: ClawdbotConfig = {};
const cardRenderConfig: ClawdbotConfig = {
  channels: {
    feishu: {
      renderMode: "card",
    },
  },
};

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

describe("feishuOutbound.sendText local-image auto-convert", () => {
  beforeEach(() => {
    resetOutboundMocks();
  });

  it("chunks outbound text without requiring Feishu runtime initialization", () => {
    const chunker = feishuOutbound.chunker;
    if (!chunker) {
      throw new Error("feishuOutbound.chunker missing");
    }

    expect(() => chunker("hello world", 5)).not.toThrow();
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

      expect(sendMediaFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          mediaUrl: file,
          accountId: "main",
          mediaLocalRoots: [dir],
        }),
      );
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ channel: "feishu", messageId: "media_msg" }),
      );
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
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "please upload /tmp/example.png",
        accountId: "main",
      }),
    );
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
      expect(sendMessageFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          text: file,
          accountId: "main",
        }),
      );
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

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "| a | b |\n| - | - |",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "card_msg" }));
  });

  it("forwards replyToId as replyToMessageId on sendText", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "hello",
      replyToId: "om_reply_1",
      accountId: "main",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        replyToMessageId: "om_reply_1",
        accountId: "main",
      }),
    );
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

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        replyToMessageId: "om_thread_2",
        accountId: "main",
      }),
    );
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

    expect(rendered).toEqual(
      expect.objectContaining({
        text: "Approval\n\nApprove the request?\n\n- Approve",
        channelData: {
          feishu: {
            card: expect.objectContaining({
              schema: "2.0",
              header: {
                title: { tag: "plain_text", content: "Approval" },
                template: "green",
              },
              body: {
                elements: expect.arrayContaining([
                  { tag: "markdown", content: "Approve the request?" },
                  expect.objectContaining({ tag: "action" }),
                ]),
              },
            }),
          },
        },
      }),
    );

    if (!rendered) {
      throw new Error("expected Feishu presentation renderer to return a payload");
    }
    const { presentation: _presentation, ...coreRenderedPayload } = rendered;
    const result = await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: coreRenderedPayload.text ?? "",
      accountId: "main",
      payload: coreRenderedPayload,
    });

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        card: expect.objectContaining({
          header: {
            title: { tag: "plain_text", content: "Approval" },
            template: "green",
          },
        }),
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ channel: "feishu", messageId: "native_card_msg" }),
    );
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

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: emptyConfig,
        to: "chat_1",
        accountId: "main",
      }),
    );
    const card = sendCardFeishuMock.mock.calls[0][0].card;
    expect(card).toEqual(
      expect.objectContaining({
        schema: "2.0",
        body: {
          elements: expect.arrayContaining([
            { tag: "markdown", content: "Choose an action" },
            { tag: "markdown", content: "Approve the request?" },
            expect.objectContaining({
              tag: "action",
              actions: [
                expect.objectContaining({
                  text: { tag: "plain_text", content: "Approve" },
                  type: "primary",
                  value: expect.objectContaining({
                    oc: "ocf1",
                    k: "quick",
                    q: "/approve req_1 allow-once",
                  }),
                }),
                expect.objectContaining({
                  text: { tag: "plain_text", content: "Deny" },
                  type: "danger",
                  value: expect.objectContaining({
                    oc: "ocf1",
                    k: "quick",
                    q: "/approve req_1 deny",
                  }),
                }),
              ],
            }),
          ]),
        },
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ channel: "feishu", messageId: "native_card_msg" }),
    );
  });

  it("escapes generated markdown card text and drops unsafe button URLs", async () => {
    await feishuOutbound.sendPayload?.({
      cfg: emptyConfig,
      to: "chat_1",
      text: "Choose <at id=\"ou_1\">",
      accountId: "main",
      payload: {
        text: "Choose <at id=\"ou_1\">",
        presentation: {
          blocks: [
            { type: "context", text: "</font><at id=\"ou_2\">Injected</at>" },
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
    expect(card.body.elements).toEqual(
      expect.arrayContaining([
        { tag: "markdown", content: "Choose &lt;at id=\"ou_1\"&gt;" },
        {
          tag: "markdown",
          content: "<font color='grey'>&lt;/font&gt;&lt;at id=\"ou_2\"&gt;Injected&lt;/at&gt;</font>",
        },
        {
          tag: "action",
          actions: [
            expect.objectContaining({
              text: { tag: "plain_text", content: "Open" },
              url: "https://example.com/path",
            }),
          ],
        },
      ]),
    );
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
                  { tag: "markdown", content: "<at id=\"ou_1\">ping</at>" },
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
      { tag: "markdown", content: "&lt;at id=\"ou_1\"&gt;ping&lt;/at&gt;" },
      {
        tag: "action",
        actions: [
          expect.objectContaining({
            text: { tag: "plain_text", content: "Good link" },
            url: "https://example.com",
          }),
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

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp"],
        accountId: "main",
      }),
    );
    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        accountId: "main",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ channel: "feishu", messageId: "native_card_msg" }),
    );
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
      expect(sendMediaFeishuMock).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "chat_1",
          mediaUrl: file,
          mediaLocalRoots: [dir],
          accountId: "main",
        }),
      );
      expect(sendMessageFeishuMock).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({ channel: "feishu", messageId: "media_msg" }),
      );
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
    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: "Review this\n\n- Approve",
      }),
    );
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
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

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file_token: "doxcn123",
        file_type: "docx",
        comment_id: "7623358762119646411",
        content: "handled in thread",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
  });

  it("routes comment-thread code-block replies through deliverCommentThreadText instead of IM cards", async () => {
    const result = await sendText({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "```ts\nconst x = 1\n```",
      accountId: "main",
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file_token: "doxcn123",
        file_type: "docx",
        comment_id: "7623358762119646411",
        content: "```ts\nconst x = 1\n```",
      }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
  });

  it("routes comment-thread replies through deliverCommentThreadText even when renderMode=card", async () => {
    const result = await sendText({
      cfg: cardRenderConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "handled in thread",
      accountId: "main",
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file_token: "doxcn123",
        file_type: "docx",
        comment_id: "7623358762119646411",
        content: "handled in thread",
      }),
    );
    expect(sendStructuredCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
  });

  it("falls back to a text-only comment reply for media payloads", async () => {
    const result = await feishuOutbound.sendMedia?.({
      cfg: emptyConfig,
      to: "comment:docx:doxcn123:7623358762119646411",
      text: "see attachment",
      mediaUrl: "https://example.com/file.png",
      accountId: "main",
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: "see attachment\n\nhttps://example.com/file.png",
      }),
    );
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "reply_msg" }));
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

    expect(deliverCommentThreadTextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        file_token: "doxcn123",
        file_type: "docx",
        comment_id: "7623358762119646411",
        content: "whole-comment follow-up",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "feishu",
        messageId: "reply_from_add_comment",
      }),
    );
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

    const status = await Promise.race([
      sendPromise.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(status).toBe("done");
    expect(deliverCommentThreadTextMock).toHaveBeenCalled();
    expect(cleanupAmbientCommentTypingReactionMock).toHaveBeenCalledWith({
      client: expect.anything(),
      deliveryContext: {
        channel: "feishu",
        to: "comment:docx:doxcn123:7623358762119646411",
        threadId: "reply_ambient_1",
      },
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

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        replyToMessageId: "om_reply_target",
        accountId: "main",
      }),
    );
  });

  it("forwards replyToId to sendStructuredCardFeishu when renderMode=card", async () => {
    await sendText({
      cfg: cardRenderConfig,
      to: "chat_1",
      text: "```code```",
      replyToId: "om_reply_target",
      accountId: "main",
    });

    expect(sendStructuredCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
  });

  it("does not pass replyToMessageId when replyToId is absent", async () => {
    await sendText({
      cfg: emptyConfig,
      to: "chat_1",
      text: "hello",
      accountId: "main",
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "hello",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock.mock.calls[0][0].replyToMessageId).toBeUndefined();
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

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
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

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/reply.mp3",
        audioAsVoice: true,
      }),
    );
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

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_reply_target",
      }),
    );
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

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "| a | b |\n| - | - |",
        accountId: "main",
      }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "https://example.com/image.png",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ channel: "feishu", messageId: "media_msg" }));
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

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        mediaUrl: "https://example.com/image.png",
        replyToMessageId: "om_thread_1",
        accountId: "main",
      }),
    );
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat_1",
        text: "caption",
        replyToMessageId: "om_thread_1",
        accountId: "main",
      }),
    );
  });
});
