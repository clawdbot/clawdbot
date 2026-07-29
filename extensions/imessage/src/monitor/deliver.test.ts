// Imessage tests cover deliver plugin behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
let createIMessageEchoCachingSend: typeof import("./deliver.js").createIMessageEchoCachingSend;

describe("deliverReplies", () => {
  const IMESSAGE_TEST_CFG = { channels: { imessage: { accounts: { default: {} } } } };
  const runtime = { log: vi.fn(), error: vi.fn() } as unknown as RuntimeEnv;

  beforeAll(async () => {
    ({ createIMessageEchoCachingSend, deliverReplies } = await import("./deliver.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    chunkTextWithModeMock.mockImplementation((text: string) => [text]);
  });

  afterAll(() => {
    vi.doUnmock("../send.js");
    vi.doUnmock("./deliver.runtime.js");
    vi.resetModules();
  });

  it("sends monitor text chunks without reusing the watch rpc client", async () => {
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));

    await deliverReplies({
      cfg: IMESSAGE_TEST_CFG,
      replies: [{ text: "first|second", replyToId: "reply-1" }],
      target: "chat_id:10",
      accountId: "default",
      runtime,
      maxBytes: 4096,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock.mock.calls).toStrictEqual([
      [
        "chat_id:10",
        "first",
        expect.objectContaining({
          config: IMESSAGE_TEST_CFG,
          maxBytes: 4096,
          accountId: "default",
          replyToId: "reply-1",
        }),
      ],
      [
        "chat_id:10",
        "second",
        expect.objectContaining({
          config: IMESSAGE_TEST_CFG,
          maxBytes: 4096,
          accountId: "default",
          replyToId: "reply-1",
        }),
      ],
    ]);
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
      accountId: "acct-2",
      runtime,
      maxBytes: 8192,
      textLimit: 4000,
    });

    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageIMessageMock.mock.calls).toStrictEqual([
      [
        "chat_id:20",
        "caption",
        expect.objectContaining({
          config: IMESSAGE_TEST_CFG,
          mediaUrl: "https://example.com/a.jpg",
          maxBytes: 8192,
          accountId: "acct-2",
          replyToId: "reply-2",
        }),
      ],
      [
        "chat_id:20",
        "",
        expect.objectContaining({
          config: IMESSAGE_TEST_CFG,
          mediaUrl: "https://example.com/b.jpg",
          maxBytes: 8192,
          accountId: "acct-2",
          replyToId: "reply-2",
        }),
      ],
    ]);
  });

  it("records durable outbound sends in the sent-message cache", async () => {
    const remember = vi.fn();
    const send = createIMessageEchoCachingSend({
      accountId: "acct-5",
      sentMessageCache: { remember },
    });
    sendMessageIMessageMock.mockResolvedValueOnce({
      messageId: "imsg-durable-1",
      sentText: "durable hello",
    });

    await send("chat_id:50", "durable hello", {
      config: IMESSAGE_TEST_CFG,
      accountId: "acct-ignored",
    });

    expect(sendMessageIMessageMock.mock.calls).toStrictEqual([
      [
        "chat_id:50",
        "durable hello",
        expect.objectContaining({
          config: IMESSAGE_TEST_CFG,
          accountId: "acct-ignored",
        }),
      ],
    ]);
    expect(remember).toHaveBeenCalledWith("acct-5:chat_id:50", {
      text: "durable hello",
      messageId: "imsg-durable-1",
    });
  });

  it("sanitizes durable outbound text before sending", async () => {
    const remember = vi.fn();
    const send = createIMessageEchoCachingSend({
      accountId: "acct-6",
      sentMessageCache: { remember },
    });
    sendMessageIMessageMock.mockResolvedValueOnce({
      messageId: "imsg-durable-2",
      sentText: "Visible reply",
    });

    await send("chat_id:60", "<thinking>hidden</thinking>\nVisible reply\nassistant:", {
      config: IMESSAGE_TEST_CFG,
      accountId: "acct-ignored",
    });

    expect(sendMessageIMessageMock.mock.calls).toStrictEqual([
      [
        "chat_id:60",
        "Visible reply",
        expect.objectContaining({
          config: IMESSAGE_TEST_CFG,
          accountId: "acct-ignored",
        }),
      ],
    ]);
    expect(remember).toHaveBeenCalledWith("acct-6:chat_id:60", {
      text: "Visible reply",
      messageId: "imsg-durable-2",
    });
  });

  it("records outbound text and message ids in sent-message cache after send", async () => {
    // Fix for #47830: monitor cache population remains per chunk, never the
    // full un-chunked text before sending begins.
    const remember = vi.fn();
    chunkTextWithModeMock.mockImplementation((text: string) => text.split("|"));
    sendMessageIMessageMock
      .mockResolvedValueOnce({ messageId: "imsg-1", sentText: "first" })
      .mockResolvedValueOnce({ messageId: "imsg-2", sentText: "second" });

    await deliverReplies({
      cfg: IMESSAGE_TEST_CFG,
      replies: [{ text: "first|second" }],
      target: "chat_id:30",
      accountId: "acct-3",
      runtime,
      maxBytes: 2048,
      textLimit: 4000,
      sentMessageCache: { remember },
    });

    expect(remember).toHaveBeenCalledTimes(2);
    expect(remember.mock.calls).toStrictEqual([
      ["acct-3:chat_id:30", { text: "first", messageId: "imsg-1" }],
      ["acct-3:chat_id:30", { text: "second", messageId: "imsg-2" }],
    ]);
    expect(remember).not.toHaveBeenCalledWith("acct-3:chat_id:30", {
      text: "first|second",
    });
  });

  it("records the internal echo key for media-only replies", async () => {
    const remember = vi.fn();
    sendMessageIMessageMock.mockResolvedValueOnce({
      messageId: "imsg-media-1",
      sentText: "",
      echoMedia: { contentType: "image/jpeg", kind: "image" },
    });

    await deliverReplies({
      cfg: IMESSAGE_TEST_CFG,
      replies: [{ mediaUrls: ["https://example.com/a.jpg"] }],
      target: "chat_id:40",
      accountId: "acct-4",
      runtime,
      maxBytes: 2048,
      textLimit: 4000,
      sentMessageCache: { remember },
    });

    expect(remember).toHaveBeenCalledWith("acct-4:chat_id:40", {
      media: { contentType: "image/jpeg", kind: "image" },
      messageId: "imsg-media-1",
    });
  });
});
