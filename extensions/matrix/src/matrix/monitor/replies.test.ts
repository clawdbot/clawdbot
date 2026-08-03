// Matrix tests cover replies plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import type { MatrixClient } from "../sdk.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());
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

let nextMessageId = 0;

async function resolveMockMatrixSend(_to: string, message: string, opts?: Record<string, unknown>) {
  nextMessageId += 1;
  const messageId = `mx-${nextMessageId}`;
  const mediaUrl = typeof opts?.mediaUrl === "string" ? opts.mediaUrl : "unknown";
  const content = message || `media:${mediaUrl}`;
  const result = {
    messageId,
    roomId: "room:1",
    primaryMessageId: messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    content,
  };
  const onDeliveryResult = opts?.onDeliveryResult;
  if (typeof onDeliveryResult === "function") {
    await onDeliveryResult(result);
  }
  return result;
}

function sendCall(index: number) {
  const call = sendMessageMatrixMock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected send call at index ${index}`);
  }
  return call;
}

function sendOptions(index: number): Record<string, unknown> {
  const options = sendCall(index)[2];
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
        resolveChunkMode: (cfgLocal: unknown, channel: unknown, accountId?: unknown) =>
          resolveChunkModeMock(cfgLocal, channel, accountId),
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
    nextMessageId = 0;
    sendMessageMatrixMock.mockReset().mockImplementation(resolveMockMatrixSend);
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

  it("shares the first reply across separately dispatched, chunked payloads", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text.split("|"),
    }));
    const hasRepliedRef = { value: false };
    const delivery = {
      cfg,
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "first" as const,
      replyToId: "reply-1",
      hasRepliedRef,
    };

    await deliverMatrixReplies({ ...delivery, replies: [{ text: "first-a|first-b" }] });
    await deliverMatrixReplies({ ...delivery, replies: [{ text: "second" }] });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendOptions(0).replyToId).toBe("reply-1");
    expect(sendOptions(1).replyToId).toBe("reply-1");
    expect(sendOptions(2).replyToId).toBeUndefined();
    expect(hasRepliedRef.value).toBe(true);
  });

  it("does not consume the first reply when Matrix delivery fails", async () => {
    const hasRepliedRef = { value: false };
    const delivery = {
      cfg,
      replies: [{ text: "retry me" }],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "first" as const,
      replyToId: "reply-1",
      hasRepliedRef,
    };
    sendMessageMatrixMock.mockRejectedValueOnce(new Error("Matrix unavailable"));

    await expect(deliverMatrixReplies(delivery)).rejects.toThrow("Matrix unavailable");
    expect(hasRepliedRef.value).toBe(false);

    await expect(deliverMatrixReplies(delivery)).resolves.toMatchObject({
      visibleReplySent: true,
    });
    expect(sendOptions(0).replyToId).toBe("reply-1");
    expect(sendOptions(1).replyToId).toBe("reply-1");
    expect(hasRepliedRef.value).toBe(true);
  });

  it("returns ordered provider receipts and visible content for a chunked reply", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text.split("|"),
    }));

    const result = await deliverMatrixReplies({
      cfg,
      replies: [{ text: "first|second" }],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(result).toMatchObject({
      messageIds: ["mx-1", "mx-2"],
      visibleReplySent: true,
      content: "first\nsecond",
    });
    expect(result.receipt?.primaryPlatformMessageId).toBe("mx-1");
  });

  it("preserves the accepted prefix when a later Matrix event fails", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text.split("|"),
    }));
    let sendCount = 0;
    sendMessageMatrixMock.mockImplementation(async (...args: unknown[]) => {
      sendCount += 1;
      if (sendCount === 2) {
        throw new Error("second event failed");
      }
      return await resolveMockMatrixSend(
        String(args[0]),
        String(args[1]),
        args[2] as Record<string, unknown> | undefined,
      );
    });

    const error = await deliverMatrixReplies({
      cfg,
      replies: [{ text: "first|second", replyToId: "reply-1" }],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "first",
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        messageIds: ["mx-1"],
        visibleReplySent: true,
        content: "first",
      },
    });
  });

  it("returns an explicit non-visible result when every reply is suppressed", async () => {
    const result = await deliverMatrixReplies({
      cfg,
      replies: [{ text: "<think>hidden</think>" }],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(result).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
  });

  it("preserves native thread fallback after the first reply has been consumed", async () => {
    const hasRepliedRef = { value: true };

    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "thread follow-up" }],
      roomId: "room:3",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "first",
      replyToId: "reply-thread",
      threadId: "thread-77",
      hasRepliedRef,
    });

    expect(sendOptions(0).replyToId).toBe("reply-thread");
    expect(sendOptions(0).threadId).toBe("thread-77");
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
    expect(sendCall(0)[0]).toBe("room:2");
    expect(sendCall(0)[1]).toBe("caption");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
    expect(sendOptions(0).mediaLocalRoots).toEqual(["/tmp/openclaw-matrix-test"]);
    expect(sendOptions(0).replyToId).toBe("reply-media");
    expect(sendCall(1)[0]).toBe("room:2");
    expect(sendCall(1)[1]).toBe("");
    expect(sendOptions(1).mediaUrl).toBe("https://example.com/b.jpg");
    expect(sendOptions(1).mediaLocalRoots).toEqual(["/tmp/openclaw-matrix-test"]);
    expect(sendOptions(1).replyToId).toBe("reply-media");
    expect(sendOptions(2).replyToId).toBe("reply-text");
  });

  it("keeps replyToId when threadId is set so Matrix can send fallback metadata", async () => {
    chunkMatrixTextMock.mockImplementation((text: string) => ({
      trimmedText: text.trim(),
      convertedText: text,
      singleEventLimit: 4000,
      fitsInSingleEvent: true,
      chunks: text.split("|"),
    }));

    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "hello|thread" }],
      roomId: "room:3",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
      threadId: "thread-77",
      replyToId: "reply-thread",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendOptions(0).replyToId).toBe("reply-thread");
    expect(sendOptions(0).threadId).toBe("thread-77");
    expect(sendOptions(1).replyToId).toBe("reply-thread");
    expect(sendOptions(1).threadId).toBe("thread-77");
  });

  it("suppresses reasoning-only text before Matrix sends", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        { text: "Reasoning:\n_hidden_" },
        { text: "<think>still hidden</think>" },
        { text: "<mm:think>MiniMax private reasoning</mm:think>" },
        { text: "<mm:thought>MiniMax private thought</mm:thought>" },
        { text: "<antml:thinking>Anthropic private reasoning</antml:thinking>" },
        { text: "Visible answer" },
      ],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[0]).toBe("room:5");
    expect(sendCall(0)[1]).toBe("Visible answer");
    expect(sendOptions(0).cfg).toBe(cfg);
  });

  it("delivers literal reasoning tags inside Markdown code", async () => {
    const text = "Use `<mm:think>example</mm:think>` literally.";

    await deliverMatrixReplies({
      cfg,
      replies: [{ text }],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[1]).toBe(text);
  });

  it("strips namespaced reasoning while delivering visible Matrix replies", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        { text: "<mm:think>MiniMax private reasoning</mm:think>Visible MiniMax answer" },
        { text: "<antml:thinking>Anthropic private reasoning</antml:thinking>Visible answer" },
        { text: "<br>Visible HTML answer<mm:think>MiniMax private reasoning</mm:think>" },
        { text: "Visible safe answer<mm:think>unfinished private reasoning" },
        { text: "Visible answer<think>old reasoning</think><think>unfinished private reasoning" },
        { text: "<thinking>private reasoning</think>Visible alias answer" },
        { text: "<final>Visible final answer" },
      ],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(7);
    expect(sendCall(0)[1]).toBe("Visible MiniMax answer");
    expect(sendCall(1)[1]).toBe("Visible answer");
    expect(sendCall(2)[1]).toBe("<br>Visible HTML answer");
    expect(sendCall(3)[1]).toBe("Visible safe answer");
    expect(sendCall(4)[1]).toBe("Visible answer");
    expect(sendCall(5)[1]).toBe("Visible alias answer");
    expect(sendCall(6)[1]).toBe("Visible final answer");
  });

  it("preserves significant whitespace in visible Markdown replies", async () => {
    const text = "    indented Markdown code\n\nVisible line with a hard break  \nnext line";

    await deliverMatrixReplies({
      cfg,
      replies: [{ text }],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[1]).toBe(text);
    expect(chunkMatrixTextMock).toHaveBeenCalledWith(
      text,
      expect.objectContaining({ preserveWhitespace: true }),
    );
  });

  it("delivers Matrix media without a reasoning-only caption", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "<mm:think>MiniMax private reasoning</mm:think>",
          mediaUrl: "https://example.com/a.jpg",
        },
      ],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      textLimit: 4000,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[1]).toBe("");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
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
      preserveWhitespace: true,
    });
    expect(sendCall(0)[0]).toBe("room:4");
    expect(sendCall(0)[1]).toBe("hello");
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

    expect(sendCall(0)[0]).toBe("room:6");
    expect(sendCall(0)[1]).toBe("caption");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
  });
});
