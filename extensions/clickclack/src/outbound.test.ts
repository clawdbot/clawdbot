// Covers ClickClack outbound routing and sender-boundary assistant text sanitization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileClickClackUnknownSend,
  sendClickClackMedia,
  sendClickClackText,
} from "./outbound.js";
import type { CoreConfig } from "./types.js";

const createChannelMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createThreadReply = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg_out" })));
const createDirectConversation = vi.hoisted(() => vi.fn(async () => ({ id: "dm_1" })));
const createUpload = vi.hoisted(() => vi.fn(async () => ({ id: "upl_1" })));
const findUploadByNonce = vi.hoisted(() =>
  vi.fn(async () => undefined as { id: string; filename: string } | undefined),
);
const findMessageByNonce = vi.hoisted(() =>
  vi.fn(async () => undefined as { id: string; attachments?: Array<{ id: string }> } | undefined),
);
const attachUpload = vi.hoisted(() => vi.fn(async () => undefined));
const message = vi.hoisted(() =>
  vi.fn(async () => ({ id: "msg_out", attachments: [] as Array<{ id: string }> })),
);
const createClientOptions = vi.hoisted(() => vi.fn());
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/outbound-media", () => ({ loadOutboundMediaFromUrl }));

vi.mock("./accounts.js", () => ({
  resolveClickClackAccount: () => ({
    baseUrl: "https://clickclack.example",
    apiEndpoint: "http://127.0.0.1:8484",
    token: "test-token-placeholder",
    workspace: "wsp_1",
  }),
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: (options: unknown) => {
    createClientOptions(options);
    return {
      createChannelMessage,
      createThreadReply,
      createDirectMessage,
      createDirectConversation,
      createUpload,
      findUploadByNonce,
      findMessageByNonce,
      attachUpload,
      message,
    };
  },
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: async () => "wsp_1",
  resolveChannelId: async (_client: unknown, _workspaceId: string, id: string) => id,
}));

const cfg = {} as CoreConfig;

describe("sendClickClackText routing", () => {
  beforeEach(() => {
    createChannelMessage.mockClear();
    createThreadReply.mockClear();
    createDirectMessage.mockClear();
    createDirectConversation.mockClear();
    createUpload.mockClear();
    findUploadByNonce.mockClear();
    findMessageByNonce.mockClear();
    attachUpload.mockClear();
    message.mockClear();
    createClientOptions.mockClear();
    loadOutboundMediaFromUrl.mockReset();
  });

  it("sanitizes a top-level channel quote-reply", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      replyToId: "msg_root",
    });

    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "Done.",
      expect.objectContaining({ quotedMessageId: "msg_root" }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("posts a plain channel message when there is no reply context", async () => {
    await sendClickClackText({ cfg, to: "channel:general", text: "hi" });

    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "hi",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("uses the inbound correlation id for outbound ClickClack HTTP calls", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "hi",
      correlationId: "fakeco.case_1",
    });

    expect(createClientOptions).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:8484",
      token: "test-token-placeholder",
      correlationId: "fakeco.case_1",
    });
  });

  it("sanitizes replies inside a genuine thread", async () => {
    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      threadId: "msg_thread_root",
      replyToId: "msg_root",
    });

    expect(createThreadReply).toHaveBeenCalledWith("msg_thread_root", "Done.", expect.anything());
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("threads when the target itself names a thread", async () => {
    await sendClickClackText({ cfg, to: "thread:msg_root", text: "hi" });

    expect(createThreadReply).toHaveBeenCalledWith("msg_root", "hi", expect.anything());
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("sanitizes leaked tool XML in a DM quote-reply", async () => {
    await sendClickClackText({
      cfg,
      to: "dm:usr_1",
      text: '<tool_call>{"name":"exec"}</tool_call>Deploy finished.',
      replyToId: "msg_root",
    });

    expect(createDirectMessage).toHaveBeenCalledWith(
      "dm_1",
      "Deploy finished.",
      expect.objectContaining({ quotedMessageId: "msg_root" }),
    );
    expect(createThreadReply).not.toHaveBeenCalled();
  });

  it("suppresses replies containing only internal scaffolding", async () => {
    await expect(
      sendClickClackText({
        cfg,
        to: "channel:general",
        text: "⚠️ 🛠️ `search repos (agent)` failed",
      }),
    ).resolves.toBeUndefined();

    expect(createClientOptions).not.toHaveBeenCalled();
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(createThreadReply).not.toHaveBeenCalled();
    expect(createDirectConversation).not.toHaveBeenCalled();
    expect(createDirectMessage).not.toHaveBeenCalled();
  });

  it("marks dispatch immediately before a durable text platform write", async () => {
    const order: string[] = [];
    const onPlatformSendDispatch = vi.fn(async () => {
      order.push("dispatch");
    });
    createChannelMessage.mockImplementationOnce(async () => {
      order.push("message");
      return { id: "msg_out" };
    });

    await sendClickClackText({
      cfg,
      to: "channel:general",
      text: "durable",
      deliveryQueueId: "queue-text",
      deliveryPartIndex: 0,
      onPlatformSendDispatch,
    });

    expect(order).toEqual(["dispatch", "message"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "durable",
      expect.objectContaining({
        nonce: "openclaw-text:4a171ee0c18d243d8d3c510320ab1b1d317afd95b0204abec18312e57307fb24",
      }),
    );
  });
});

describe("sendClickClackMedia", () => {
  beforeEach(() => {
    createChannelMessage.mockClear();
    createThreadReply.mockClear();
    createDirectMessage.mockClear();
    createDirectConversation.mockClear();
    createUpload.mockReset().mockResolvedValue({ id: "upl_1" });
    findUploadByNonce.mockReset().mockResolvedValue(undefined);
    findMessageByNonce.mockReset().mockResolvedValue(undefined);
    attachUpload.mockReset().mockResolvedValue(undefined);
    message.mockReset().mockResolvedValue({ id: "msg_out", attachments: [] });
    createClientOptions.mockClear();
    loadOutboundMediaFromUrl.mockReset().mockResolvedValue({
      buffer: Buffer.from("const proof = true;"),
      contentType: "text/typescript",
      fileName: "viewer-proof.ts",
    });
  });

  it("preserves filename and MIME while uploading before channel delivery", async () => {
    const order: string[] = [];
    createUpload.mockImplementationOnce(async () => {
      order.push("upload");
      return { id: "upl_1" };
    });
    createChannelMessage.mockImplementationOnce(async () => {
      order.push("message");
      return { id: "msg_out" };
    });
    attachUpload.mockImplementationOnce(async () => {
      order.push("attach");
    });
    const mediaReadFile = vi.fn();

    const messageId = await sendClickClackMedia({
      cfg,
      to: "channel:general",
      text: "Artifact proof",
      mediaUrl: "/workspace/viewer-proof.ts",
      mediaLocalRoots: ["/workspace"],
      mediaReadFile,
    });

    expect(loadOutboundMediaFromUrl).toHaveBeenCalledWith("/workspace/viewer-proof.ts", {
      maxBytes: 64 * 1024 * 1024,
      mediaAccess: undefined,
      mediaLocalRoots: ["/workspace"],
      mediaReadFile,
    });
    expect(createUpload).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      buffer: Buffer.from("const proof = true;"),
      filename: "viewer-proof.ts",
      contentType: "text/typescript",
    });
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "Artifact proof",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
    expect(order).toEqual(["upload", "message", "attach"]);
    expect(messageId).toBe("msg_out");
  });

  it("uses the filename as the minimal media-only body and routes DMs", async () => {
    const messageId = await sendClickClackMedia({
      cfg,
      to: "dm:usr_1",
      text: "",
      mediaUrl: "https://files.example/viewer-proof.ts",
    });

    expect(createDirectConversation).toHaveBeenCalledWith("wsp_1", ["usr_1"]);
    expect(createDirectMessage).toHaveBeenCalledWith(
      "dm_1",
      "viewer-proof.ts",
      expect.objectContaining({ quotedMessageId: undefined }),
    );
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
    expect(messageId).toBe("msg_out");
  });

  it("routes explicit thread targets before attaching the upload", async () => {
    await sendClickClackMedia({
      cfg,
      to: "thread:msg_root",
      text: "Thread artifact",
      mediaUrl: "/workspace/viewer-proof.ts",
    });

    expect(createThreadReply).toHaveBeenCalledWith(
      "msg_root",
      "Thread artifact",
      expect.anything(),
    );
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
  });

  it("rejects oversized media before creating a ClickClack client or upload", async () => {
    loadOutboundMediaFromUrl.mockRejectedValueOnce(new Error("media exceeds 67108864 bytes"));

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Too large",
        mediaUrl: "/workspace/oversized.bin",
      }),
    ).rejects.toThrow("media exceeds 67108864 bytes");

    expect(createClientOptions).not.toHaveBeenCalled();
    expect(createUpload).not.toHaveBeenCalled();
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("retries attachment association with the same upload and message", async () => {
    attachUpload.mockRejectedValueOnce(new Error("attachment response lost"));

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
      }),
    ).resolves.toBe("msg_out");

    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(attachUpload).toHaveBeenCalledTimes(2);
    expect(attachUpload).toHaveBeenNthCalledWith(1, "msg_out", "upl_1");
    expect(attachUpload).toHaveBeenNthCalledWith(2, "msg_out", "upl_1");
  });

  it("accepts a persisted attachment when the success response was lost", async () => {
    attachUpload.mockRejectedValueOnce(new Error("attachment response lost"));
    message.mockResolvedValueOnce({ id: "msg_out", attachments: [{ id: "upl_1" }] });

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
      }),
    ).resolves.toBe("msg_out");

    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledWith("msg_out");
    expect(attachUpload).toHaveBeenCalledTimes(1);
  });

  it("reuses durable upload and message nonces across queue retries", async () => {
    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
        deliveryQueueId: "queue-1",
        deliveryPartIndex: 0,
      }),
    ).resolves.toBe("msg_out");

    expect(createUpload).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      buffer: Buffer.from("const proof = true;"),
      filename: "viewer-proof.ts",
      contentType: "text/typescript",
      nonce: "openclaw-upload:59191af0ade27fb1ed08162b9eed248d0b62f878fba7da53d16e32cacf34f6a1",
    });
    expect(createChannelMessage).toHaveBeenCalledWith(
      "general",
      "Artifact proof",
      expect.objectContaining({
        nonce: "openclaw-media:59191af0ade27fb1ed08162b9eed248d0b62f878fba7da53d16e32cacf34f6a1",
      }),
    );
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_1");
  });

  it("reuses a persisted durable upload without another multipart write", async () => {
    findUploadByNonce.mockResolvedValueOnce({
      id: "upl_existing",
      filename: "viewer-proof.ts",
    });

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
        deliveryQueueId: "queue-1",
        deliveryPartIndex: 0,
      }),
    ).resolves.toBe("msg_out");

    expect(createUpload).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(attachUpload).toHaveBeenCalledWith("msg_out", "upl_existing");
  });

  it("marks dispatch once before upload-first durable delivery", async () => {
    const order: string[] = [];
    const onPlatformSendDispatch = vi.fn(async () => {
      order.push("dispatch");
    });
    createUpload.mockImplementationOnce(async () => {
      order.push("upload");
      return { id: "upl_1", filename: "viewer-proof.ts" };
    });
    createChannelMessage.mockImplementationOnce(async () => {
      order.push("message");
      return { id: "msg_out" };
    });

    await sendClickClackMedia({
      cfg,
      to: "channel:general",
      text: "Artifact proof",
      mediaUrl: "/workspace/viewer-proof.ts",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 0,
      onPlatformSendDispatch,
    });

    expect(order).toEqual(["dispatch", "upload", "message"]);
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
  });

  it("rejects a durable send without a stable part index before reading media", async () => {
    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
        deliveryQueueId: "queue-1",
      }),
    ).rejects.toThrow("requires a stable delivery part index");

    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    expect(createClientOptions).not.toHaveBeenCalled();
  });

  it("still rejects when attachment association and its bounded retry both fail", async () => {
    attachUpload.mockRejectedValue(new Error("attachment rejected"));

    await expect(
      sendClickClackMedia({
        cfg,
        to: "channel:general",
        text: "Artifact proof",
        mediaUrl: "/workspace/viewer-proof.ts",
      }),
    ).rejects.toThrow("attachment rejected");

    expect(createUpload).toHaveBeenCalledTimes(1);
    expect(createChannelMessage).toHaveBeenCalledTimes(1);
    expect(attachUpload).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileClickClackUnknownSend", () => {
  beforeEach(() => {
    createChannelMessage.mockClear();
    createThreadReply.mockClear();
    createDirectMessage.mockClear();
    createDirectConversation.mockClear();
    createUpload.mockClear();
    findUploadByNonce.mockReset().mockResolvedValue(undefined);
    findMessageByNonce.mockReset().mockResolvedValue(undefined);
    attachUpload.mockReset().mockResolvedValue(undefined);
    message.mockReset().mockResolvedValue({ id: "msg_out", attachments: [] });
    createClientOptions.mockClear();
    loadOutboundMediaFromUrl.mockClear();
  });

  it("reconciles a text send only when its durable message exists", async () => {
    findMessageByNonce.mockResolvedValueOnce({ id: "msg_text" });

    const result = await reconcileClickClackUnknownSend({
      cfg,
      queueId: "queue-text",
      channel: "clickclack",
      to: "channel:general",
      enqueuedAt: 1,
      retryCount: 0,
      payloads: [{ text: "recovered text" }],
      renderedBatchPlan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 0,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [{ index: 0, kinds: ["text"], text: "recovered text", mediaUrls: [] }],
      },
    });

    expect(result.status).toBe("sent");
    expect(findMessageByNonce).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      nonce: "openclaw-text:4a171ee0c18d243d8d3c510320ab1b1d317afd95b0204abec18312e57307fb24",
    });
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(createUpload).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    if (result.status === "sent") {
      expect(result.receipt.platformMessageIds).toEqual(["msg_text"]);
    }
  });

  it("replays text through the normal sender when no durable message exists", async () => {
    const result = await reconcileClickClackUnknownSend({
      cfg,
      queueId: "queue-text",
      channel: "clickclack",
      to: "channel:general",
      enqueuedAt: 1,
      retryCount: 0,
      payloads: [{ text: "recovered text" }],
    });

    expect(result).toEqual({ status: "not_sent" });
    expect(createChannelMessage).not.toHaveBeenCalled();
  });

  it("proves media was not sent when its durable message is absent", async () => {
    const result = await reconcileClickClackUnknownSend({
      cfg,
      queueId: "queue-media",
      channel: "clickclack",
      to: "channel:general",
      enqueuedAt: 1,
      retryCount: 0,
      payloads: [{ text: "proof", mediaUrl: "/workspace/proof.ts" }],
      renderedBatchPlan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 1,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [
          {
            index: 0,
            kinds: ["text", "media"],
            text: "proof",
            mediaUrls: ["/workspace/proof.ts"],
          },
        ],
      },
    });

    expect(result).toEqual({ status: "not_sent" });
    expect(findUploadByNonce).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      nonce: "openclaw-upload:b7ec5953ddec187b357faecde36f1abf0ef8590b1cda47c199c562b9e2e24432",
    });
    expect(findMessageByNonce).toHaveBeenCalledWith({
      workspaceId: "wsp_1",
      nonce: "openclaw-media:b7ec5953ddec187b357faecde36f1abf0ef8590b1cda47c199c562b9e2e24432",
    });
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
  });

  it("replays normally when uploads exist but messages do not", async () => {
    findUploadByNonce
      .mockResolvedValueOnce({ id: "upl_first", filename: "first.png" })
      .mockResolvedValueOnce({ id: "upl_second", filename: "second.png" });

    const result = await reconcileClickClackUnknownSend({
      cfg,
      queueId: "queue-media",
      channel: "clickclack",
      to: "channel:general",
      enqueuedAt: 1,
      retryCount: 0,
      effectiveReplyToId: "msg_source",
      replyToMode: "first",
      payloads: [{ text: "proof", mediaUrls: ["/workspace/first.png", "/workspace/second.png"] }],
      renderedBatchPlan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 2,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [
          {
            index: 0,
            kinds: ["text", "media"],
            text: "proof",
            mediaUrls: ["/workspace/first.png", "/workspace/second.png"],
          },
        ],
      },
    });

    expect(result).toEqual({ status: "not_sent" });
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).not.toHaveBeenCalled();
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
  });

  it("repairs attachments only after every nonce-keyed message exists", async () => {
    findUploadByNonce
      .mockResolvedValueOnce({ id: "upl_first", filename: "first.png" })
      .mockResolvedValueOnce({ id: "upl_second", filename: "second.png" });
    findMessageByNonce
      .mockResolvedValueOnce({ id: "msg_first", attachments: [] })
      .mockResolvedValueOnce({ id: "msg_second", attachments: [{ id: "upl_second" }] });

    const result = await reconcileClickClackUnknownSend({
      cfg,
      queueId: "queue-media",
      channel: "clickclack",
      to: "channel:general",
      enqueuedAt: 1,
      retryCount: 0,
      effectiveReplyToId: "msg_source",
      payloads: [{ text: "proof", mediaUrls: ["/workspace/first.png", "/workspace/second.png"] }],
      renderedBatchPlan: {
        payloadCount: 1,
        textCount: 1,
        mediaCount: 2,
        voiceCount: 0,
        presentationCount: 0,
        interactiveCount: 0,
        channelDataCount: 0,
        items: [
          {
            index: 0,
            kinds: ["text", "media"],
            text: "proof",
            mediaUrls: ["/workspace/first.png", "/workspace/second.png"],
          },
        ],
      },
    });

    expect(result.status).toBe("sent");
    expect(createChannelMessage).not.toHaveBeenCalled();
    expect(attachUpload).toHaveBeenCalledExactlyOnceWith("msg_first", "upl_first");
    expect(loadOutboundMediaFromUrl).not.toHaveBeenCalled();
    if (result.status === "sent") {
      expect(result.receipt.platformMessageIds).toEqual(["msg_first", "msg_second"]);
    }
  });

  it("refuses to acknowledge a message whose nonce-keyed upload is missing", async () => {
    findMessageByNonce.mockResolvedValueOnce({ id: "msg_orphan", attachments: [] });

    const result = await reconcileClickClackUnknownSend({
      cfg,
      queueId: "queue-media",
      channel: "clickclack",
      to: "channel:general",
      enqueuedAt: 1,
      retryCount: 0,
      payloads: [{ text: "proof", mediaUrl: "/workspace/proof.ts" }],
    });

    expect(result).toEqual({
      status: "unresolved",
      error: "ClickClack message msg_orphan exists without its nonce-keyed upload",
      retryable: false,
    });
    expect(attachUpload).not.toHaveBeenCalled();
  });
});
