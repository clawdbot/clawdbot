// Googlechat tests cover monitor.reply delivery plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";

const mocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
  uploadGoogleChatAttachment: vi.fn(),
}));

vi.mock("./api.js", () => ({
  deleteGoogleChatMessage: mocks.deleteGoogleChatMessage,
  isGoogleChatMessageResourceName: (value: string | undefined) =>
    typeof value === "string" && /^spaces\/[^/]+\/messages\/[^/]+$/.test(value),
  isGoogleChatThreadResourceName: (value: string | undefined) =>
    typeof value === "string" && /^spaces\/[^/]+\/threads\/[^/]+$/.test(value),
  sendGoogleChatMessage: mocks.sendGoogleChatMessage,
  updateGoogleChatMessage: mocks.updateGoogleChatMessage,
  uploadGoogleChatAttachment: mocks.uploadGoogleChatAttachment,
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

const config = {} as OpenClawConfig;

function createCore(params?: {
  chunks?: readonly string[];
  media?: { buffer: Buffer; contentType?: string; fileName?: string };
}) {
  return {
    channel: {
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params?.chunks ?? [text]),
      },
      media: {
        readRemoteMediaBuffer: vi.fn(async () => params?.media ?? { buffer: Buffer.from("image") }),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createRuntime() {
  return {
    error: vi.fn(),
    log: vi.fn(),
  } satisfies GoogleChatRuntimeEnv;
}

let deliverGoogleChatReply: typeof import("./monitor-reply-delivery.js").deliverGoogleChatReply;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ deliverGoogleChatReply } = await import("./monitor-reply-delivery.js"));
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("Google Chat reply delivery", () => {
  it("resends the first text chunk as a new message when typing update fails", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntime();
    const statusSink = vi.fn();
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(new Error("message not found"));
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/fallback" });

    await deliverGoogleChatReply({
      payload: { text: "first chunk\n\nsecond chunk", replyToId: "spaces/AAA/threads/root" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      statusSink,
      typingMessageName: "spaces/AAA/messages/typing",
      inboundMessageId: undefined,
      inboundThreadId: undefined,
    });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/AAA",
      text: "first chunk",
      thread: "spaces/AAA/threads/root",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/AAA",
      text: "second chunk",
      thread: "spaces/AAA/threads/root",
    });
    expect(statusSink).toHaveBeenCalledTimes(2);
    expect(runtime.error).toHaveBeenCalledWith(
      "Google Chat message send failed: Error: message not found",
    );
  });

  it("uses the inbound thread when replyToId resolves to the current Google Chat message resource", async () => {
    const core = createCore({ chunks: ["only chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/sent" });

    await deliverGoogleChatReply({
      payload: { text: "only chunk", replyToId: "spaces/AAA/messages/inbound" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      inboundMessageId: "spaces/AAA/messages/inbound",
      inboundThreadId: "spaces/AAA/threads/inbound-thread",
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "only chunk",
      thread: "spaces/AAA/threads/inbound-thread",
    });
  });

  it("does not map an arbitrary Google Chat message-resource replyTo onto the inbound thread", async () => {
    const core = createCore({ chunks: ["only chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/sent" });

    await deliverGoogleChatReply({
      payload: { text: "only chunk", replyToId: "spaces/AAA/messages/other" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      inboundMessageId: "spaces/AAA/messages/inbound",
      inboundThreadId: "spaces/AAA/threads/inbound-thread",
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread: undefined }),
    );
  });

  it("does not fall back to the inbound thread when no reply target is supplied", async () => {
    const core = createCore({ chunks: ["only chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/sent" });

    await deliverGoogleChatReply({
      payload: { text: "only chunk" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      inboundMessageId: undefined,
      inboundThreadId: "spaces/AAA/threads/inbound-thread",
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread: undefined }),
    );
  });

  it("does not fall back to the inbound thread for malformed reply targets", async () => {
    const core = createCore({ chunks: ["only chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/sent" });

    await deliverGoogleChatReply({
      payload: { text: "only chunk", replyToId: "spaces/AAA/not-a-thread/current" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      inboundMessageId: undefined,
      inboundThreadId: "spaces/AAA/threads/inbound-thread",
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread: undefined }),
    );
  });

  it("preserves an explicit thread-shaped replyToId over the inbound thread", async () => {
    const core = createCore({ chunks: ["only chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/sent" });

    await deliverGoogleChatReply({
      payload: { text: "only chunk", replyToId: "spaces/AAA/threads/explicit" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      inboundMessageId: undefined,
      inboundThreadId: "spaces/AAA/threads/inbound-thread",
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread: "spaces/AAA/threads/explicit" }),
    );
  });

  it("does not update a deleted typing message before sending media with a caption", async () => {
    const core = createCore({
      media: { buffer: Buffer.from("image"), contentType: "image/png", fileName: "reply.png" },
    });
    const runtime = createRuntime();
    mocks.deleteGoogleChatMessage.mockResolvedValue(undefined);
    mocks.uploadGoogleChatAttachment.mockResolvedValue({ attachmentUploadToken: "upload-token" });
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/media" });

    await deliverGoogleChatReply({
      payload: {
        text: "caption",
        mediaUrl: "https://example.invalid/reply.png",
        replyToId: "spaces/AAA/threads/root",
      },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      typingMessageName: "spaces/AAA/messages/typing",
      inboundMessageId: undefined,
      inboundThreadId: undefined,
    });

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "caption",
      thread: "spaces/AAA/threads/root",
      attachments: [{ attachmentUploadToken: "upload-token", contentName: "reply.png" }],
    });
  });

  it("drops malformed inbound thread fallbacks before the API boundary", async () => {
    const core = createCore({ chunks: ["only chunk"] });
    const runtime = createRuntime();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/sent" });

    await deliverGoogleChatReply({
      payload: { text: "only chunk", replyToId: "spaces/AAA/messages/inbound" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
      inboundMessageId: "spaces/AAA/messages/inbound",
      inboundThreadId: "spaces/AAA/messages/not-a-thread",
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "only chunk",
      thread: undefined,
    });
  });
});
