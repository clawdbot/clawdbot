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

function sendOptions(index: number): Record<string, unknown> {
  const options = sendMessageMatrixMock.mock.calls[index]?.[2];
  if (!options || typeof options !== "object") {
    throw new Error(`Expected send options at call ${index}`);
  }
  return options as Record<string, unknown>;
}

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
    expect(sendOptions(0).replyToId).toBe("reply-1");
    expect(sendOptions(0).threadId).toBeUndefined();
    expect(sendOptions(1).replyToId).toBe("reply-1");
    expect(sendOptions(1).threadId).toBeUndefined();
    expect(sendOptions(2).replyToId).toBeUndefined();
    expect(sendOptions(2).threadId).toBeUndefined();
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
    expect(sendMessageMatrixMock.mock.calls[0]?.[0]).toBe("room:2");
    expect(sendMessageMatrixMock.mock.calls[0]?.[1]).toBe("caption");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
    expect(sendOptions(0).mediaLocalRoots).toEqual(["/tmp/openclaw-matrix-test"]);
    expect(sendOptions(0).replyToId).toBe("reply-media");
    expect(sendMessageMatrixMock.mock.calls[1]?.[0]).toBe("room:2");
    expect(sendMessageMatrixMock.mock.calls[1]?.[1]).toBe("");
    expect(sendOptions(1).mediaUrl).toBe("https://example.com/b.jpg");
    expect(sendOptions(1).mediaLocalRoots).toEqual(["/tmp/openclaw-matrix-test"]);
    expect(sendOptions(1).replyToId).toBe("reply-media");
    expect(sendOptions(2).replyToId).toBe("reply-text");
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
    expect(sendOptions(0).replyToId).toBeUndefined();
    expect(sendOptions(0).threadId).toBe("thread-77");
    expect(sendOptions(1).replyToId).toBeUndefined();
    expect(sendOptions(1).threadId).toBe("thread-77");
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
    expect(sendMessageMatrixMock.mock.calls[0]?.[0]).toBe("room:5");
    expect(sendMessageMatrixMock.mock.calls[0]?.[1]).toBe("Visible answer");
    expect(sendOptions(0).cfg).toBe(cfg);
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
    expect(sendMessageMatrixMock.mock.calls[0]?.[0]).toBe("room:4");
    expect(sendMessageMatrixMock.mock.calls[0]?.[1]).toBe("hello");
    expect(sendOptions(0).cfg).toBe(explicitCfg);
    expect(sendOptions(0).accountId).toBe("ops");
    expect(sendOptions(0).replyToId).toBe("reply-1");
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

    expect(sendMessageMatrixMock.mock.calls[0]?.[0]).toBe("room:6");
    expect(sendMessageMatrixMock.mock.calls[0]?.[1]).toBe("caption");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
  });
});
