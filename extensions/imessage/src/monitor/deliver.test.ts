import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageIMessageMock = vi.hoisted(() =>
  vi.fn().mockImplementation(async (_to: string, message: string) => ({
    messageId: "imsg-1",
    sentText: message,
  })),
);
const chunkTextWithModeMock = vi.hoisted(() => vi.fn((text: string) => [text]));
const resolveChunkModeMock = vi.hoisted(() => vi.fn(() => "length"));
const convertMarkdownTablesMock = vi.hoisted(() => vi.fn((text: string) => text));
const resolveMarkdownTableModeMock = vi.hoisted(() => vi.fn(() => "code"));

vi.mock("../send.js", () => ({
  sendMessageIMessage: (to: string, message: string, opts?: unknown) =>
    sendMessageIMessageMock(to, message, opts),
}));

vi.mock("./deliver.runtime.js", () => ({
  resolveMarkdownTableMode: vi.fn(() => resolveMarkdownTableModeMock()),
  chunkTextWithMode: (text: string) => chunkTextWithModeMock(text),
  resolveChunkMode: vi.fn(() => resolveChunkModeMock()),
  convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
}));

let deliverReplies: typeof import("./deliver.js").deliverReplies;

describe("deliverReplies", () => {
  const IMESSAGE_TEST_CFG = { channels: { imessage: { accounts: { default: {} } } } };
  const runtime = { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;
  const client = {} as Awaited<ReturnType<typeof import("../client.js").createIMessageRpcClient>>;

  beforeAll(async () => {
    ({ deliverReplies } = await import("./deliver.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    chunkTextWithModeMock.mockImplementation((text: string) => [text]);
  });

  it("propagates payload replyToId through all text chunks", async () => {
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    await deliverReplies({
      cfg: IMESSAGE_TEST_CFG,
      replies: [{ text: "first|second", replyToId: "reply-1" }],
      target: "chat_id:10",
      client,
      accountId: "default",
      runtime,
      maxBytes: 4096,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      1,
      "chat_id:10",
      "first",
      expect.objectContaining({
        client,
        config: IMESSAGE_TEST_CFG,
        maxBytes: 4096,
        accountId: "default",
        replyToId: "reply-1",
      }),
    );
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      2,
      "chat_id:10",
      "second",
      expect.objectContaining({
        client,
        config: IMESSAGE_TEST_CFG,
        maxBytes: 4096,
        accountId: "default",
        replyToId: "reply-1",
      }),
    );
  });

  it("propagates payload replyToId through media sends", async () => {
    await deliverReplies({
      cfg: IMESSAGE_TEST_CFG,
      replies: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-2",
        },
      ],
      target: "chat_id:20",
      client,
      accountId: "acct-2",
      runtime,
      maxBytes: 8192,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      1,
      "chat_id:20",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
        client,
        config: IMESSAGE_TEST_CFG,
        maxBytes: 8192,
        accountId: "acct-2",
        replyToId: "reply-2",
      }),
    );
    expect(sendMessageIMessageMock).toHaveBeenNthCalledWith(
      2,
      "chat_id:20",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/b.jpg",
        client,
        config: IMESSAGE_TEST_CFG,
        maxBytes: 8192,
        accountId: "acct-2",
        replyToId: "reply-2",
      }),
    );
  });

  it("records outbound text and message ids in sent-message cache (post-send only)", async () => {
    // Fix for #47830: remember() is called ONLY after each chunk is sent,
    // never with the full un-chunked text before sending begins.
    // Pre-send population widened the false-positive window in self-chat.
    const remember = vi.fn();
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));
    sendMessageIMessageMock
      .mockResolvedValueOnce({ messageId: "imsg-1", sentText: "first" })
      .mockResolvedValueOnce({ messageId: "imsg-2", sentText: "second" });

    await deliverReplies({
      cfg: IMESSAGE_TEST_CFG,
      replies: [{ text: "first|second" }],
      target: "chat_id:30",
      client,
      accountId: "acct-3",
      runtime,
      maxBytes: 2048,
      textLimit: 4000,
      sentMessageCache: { remember },
    });

    // Only the two per-chunk post-send calls — no pre-send full-text call.
    expect(remember).toHaveBeenCalledTimes(2);
    expect(remember).toHaveBeenCalledWith("acct-3:chat_id:30", {
      text: "first",
      messageId: "imsg-1",
    });
    expect(remember).toHaveBeenCalledWith("acct-3:chat_id:30", {
      text: "second",
      messageId: "imsg-2",
    });
  });

  it("records the actual sent placeholder for media-only replies", async () => {
    const remember = vi.fn();
    sendMessageIMessageMock.mockResolvedValueOnce({
      messageId: "imsg-media-1",
      sentText: "<media:image>",
    });

    await deliverReplies({
      cfg: IMESSAGE_TEST_CFG,
      replies: [{ mediaUrls: ["https://example.com/a.jpg"] }],
      target: "chat_id:40",
      client,
      accountId: "acct-4",
      runtime,
      maxBytes: 2048,
      textLimit: 4000,
      sentMessageCache: { remember },
    });

    expect(remember).toHaveBeenCalledWith("acct-4:chat_id:40", {
      text: "<media:image>",
      messageId: "imsg-media-1",
    });
  });
});
