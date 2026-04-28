import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import type { MatrixClient } from "../sdk.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "mx-1" }));
const chunkMatrixTextMock = vi.hoisted(() =>
  vi.fn((text: string, _opts?: unknown) => ({
    trimmedText: text.trim(),
    convertedText: text,
    singleEventLimit: 4000,
    fitsInSingleEvent: true,
    chunks: text ? [text] : [],
  })),
);

vi.mock("../send.js", () => ({
  chunkMatrixText: (text: string, opts?: unknown) => chunkMatrixTextMock(text, opts),
  sendMessageMatrix: (to: string, message: string, opts?: unknown) =>
    sendMessageMatrixMock(to, message, opts),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";

describe("deliverMatrixReplies", () => {
  const cfg = { channels: { matrix: {} } };
  const loadConfigMock = vi.fn(() => ({}));
  const resolveMarkdownTableModeMock = vi.fn<(params: unknown) => string>(() => "code");
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const resolveChunkModeMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => string
  >(() => "length");
  const chunkMarkdownTextWithModeMock = vi.fn((text: string) => [text]);

  const runtimeStub = {
    config: {
      current: () => loadConfigMock(),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: (params: unknown) => resolveMarkdownTableModeMock(params),
        convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
        resolveChunkMode: (cfg: unknown, channel: unknown, accountId?: unknown) =>
          resolveChunkModeMock(cfg, channel, accountId),
        chunkMarkdownTextWithMode: (text: string) => chunkMarkdownTextWithModeMock(text),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    setMatrixRuntime(runtimeStub);
    chunkMatrixTextMock.mockReset().mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text ? [text] : [],
    }));
  });

  it("keeps replyToId on first reply only when replyToMode=first", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text.split("|"),
    }));

    await deliverMatrixReplies({
      cfg,
      replies: [
        { text: "first-a|first-b", replyToId: "reply-1" },
        { text: "second", replyToId: "reply-2" },
      ],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "first",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: undefined }),
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-1", threadId: undefined }),
    );
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: undefined }),
    );
  });

  it("keeps replyToId on every reply when replyToMode=all", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-media",
          audioAsVoice: true,
        },
        { text: "plain", replyToId: "reply-text" },
      ],
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "all",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendMessageMatrixMock.mock.calls[0]).toEqual([
      "room:2",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
        replyToId: "reply-media",
      }),
    ]);
    expect(sendMessageMatrixMock.mock.calls[1]).toEqual([
      "room:2",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/b.jpg",
        mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
        replyToId: "reply-media",
      }),
    ]);
    expect(sendMessageMatrixMock.mock.calls[2]?.[2]).toEqual(
      expect.objectContaining({ replyToId: "reply-text" }),
    );
  });

  it("suppresses replyToId when threadId is set", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text.split("|"),
    }));

    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "hello|thread", replyToId: "reply-thread" }],
      roomId: "room:3",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "all",
      threadId: "thread-77",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMatrixMock.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: "thread-77" }),
    );
    expect(sendMessageMatrixMock.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ replyToId: undefined, threadId: "thread-77" }),
    );
  });

  it("suppresses reasoning-only text before Matrix sends", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        { text: "Reasoning:\n_hidden_" },
        { text: "<think>still hidden</think>" },
        { text: "Visible answer" },
      ],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:5",
      "Visible answer",
      expect.objectContaining({ cfg }),
    );
  });

  it("uses supplied cfg for chunking and send delivery without reloading runtime config", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              chunkMode: "newline",
            },
          },
        },
      },
    };
    loadConfigMock.mockImplementation(() => {
      throw new Error("deliverMatrixReplies should not reload runtime config when cfg is provided");
    });

    await deliverMatrixReplies({
      cfg: explicitCfg,
      replies: [{ text: "hello", replyToId: "reply-1" }],
      roomId: "room:4",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "all",
      accountId: "ops",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(chunkMatrixTextMock).toHaveBeenCalledWith("hello", {
      cfg: explicitCfg,
      accountId: "ops",
      tableMode: "code",
    });
    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:4",
      "hello",
      expect.objectContaining({
        cfg: explicitCfg,
        accountId: "ops",
        replyToId: "reply-1",
      }),
    );
  });

  it("passes raw media captions through to sendMessageMatrix without pre-converting them", async () => {
    convertMarkdownTablesMock.mockImplementation((text: string) => `converted:${text}`);

    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "caption", mediaUrl: "https://example.com/a.jpg" }],
      roomId: "room:6",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledWith(
      "room:6",
      "caption",
      expect.objectContaining({
        mediaUrl: "https://example.com/a.jpg",
      }),
    );
  });
});
