import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";

const sendModuleMocks = vi.hoisted(() => {
  const loadConfigMock = vi.fn(() => ({}));
  const resolveTextChunkLimitMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => number
  >(() => 4000);
  const resolveChunkModeMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => string
  >(() => "length");
  const chunkMarkdownTextWithModeMock = vi.fn((text: string) => (text ? [text] : []));
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const prepareMatrixSingleText = vi.fn(
    (text: string, opts: { cfg?: unknown; accountId?: string } = {}) => {
      const trimmedText = text.trim();
      const convertedText = convertMarkdownTablesMock(trimmedText);
      const singleEventLimit = Math.min(
        resolveTextChunkLimitMock(opts.cfg ?? {}, "matrix", opts.accountId),
        4000,
      );
      return {
        trimmedText,
        convertedText,
        singleEventLimit,
        fitsInSingleEvent: convertedText.length <= singleEventLimit,
      };
    },
  );
  const sendSingleTextMessageMatrix = vi.fn(
    async (
      roomId: string,
      text: string,
      opts: {
        client?: {
          sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<string>;
        };
        cfg?: unknown;
        accountId?: string;
        msgtype?: string;
        includeMentions?: boolean;
        live?: boolean;
      } = {},
    ) => {
      const prepared = prepareMatrixSingleText(text, {
        cfg: opts.cfg,
        accountId: opts.accountId,
      });
      if (!prepared.trimmedText) {
        throw new Error("Matrix single-message send requires text");
      }
      if (!prepared.fitsInSingleEvent) {
        throw new Error("Matrix single-message text exceeds limit");
      }
      const content: Record<string, unknown> = {
        msgtype: opts.msgtype ?? "m.text",
        body: prepared.convertedText,
      };
      if (opts.live) {
        content["org.matrix.msc4357.live"] = {};
      }
      const eventId = await opts.client?.sendMessage(roomId, content);
      return {
        messageId: eventId ?? "unknown",
        roomId,
        primaryMessageId: eventId ?? "unknown",
        messageIds: eventId ? [eventId] : [],
      };
    },
  );
  const editMessageMatrix = vi.fn(
    async (
      roomId: string,
      originalEventId: string,
      newText: string,
      opts: {
        client?: {
          sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<string>;
        };
        msgtype?: string;
        live?: boolean;
      } = {},
    ) => {
      const convertedText = convertMarkdownTablesMock(newText);
      const newContent: Record<string, unknown> = {
        msgtype: opts.msgtype ?? "m.text",
        body: convertedText,
      };
      if (opts.live) {
        newContent["org.matrix.msc4357.live"] = {};
      }
      const content: Record<string, unknown> = {
        ...newContent,
        body: `* ${convertedText}`,
        "m.new_content": newContent,
        "m.relates_to": {
          rel_type: "m.replace",
          event_id: originalEventId,
        },
      };
      if (opts.live) {
        content["org.matrix.msc4357.live"] = {};
      }
      return (await opts.client?.sendMessage(roomId, content)) ?? "";
    },
  );
  return {
    chunkMarkdownTextWithModeMock,
    convertMarkdownTablesMock,
    editMessageMatrix,
    loadConfigMock,
    prepareMatrixSingleText,
    resolveChunkModeMock,
    resolveTextChunkLimitMock,
    sendSingleTextMessageMatrix,
  };
});

const {
  chunkMarkdownTextWithModeMock,
  convertMarkdownTablesMock,
  loadConfigMock,
  resolveChunkModeMock,
  resolveTextChunkLimitMock,
} = sendModuleMocks;

vi.mock("./send.js", () => ({
  editMessageMatrix: sendModuleMocks.editMessageMatrix,
  prepareMatrixSingleText: sendModuleMocks.prepareMatrixSingleText,
  sendSingleTextMessageMatrix: sendModuleMocks.sendSingleTextMessageMatrix,
}));
const runtimeStub = {
  config: { loadConfig: () => loadConfigMock() },
  channel: {
    text: {
      resolveTextChunkLimit: (cfg: unknown, channel: unknown, accountId?: unknown) =>
        resolveTextChunkLimitMock(cfg, channel, accountId),
      resolveChunkMode: (cfg: unknown, channel: unknown, accountId?: unknown) =>
        resolveChunkModeMock(cfg, channel, accountId),
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string) => chunkMarkdownTextWithModeMock(text),
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
    },
  },
} as unknown as PluginRuntime;

let createMatrixDraftStream: typeof import("./draft-stream.js").createMatrixDraftStream;

const sendMessageMock = vi.fn();
const sendEventMock = vi.fn();
const joinedRoomsMock = vi.fn().mockResolvedValue([]);

function createMockClient() {
  sendMessageMock.mockReset().mockResolvedValue("$evt1");
  sendEventMock.mockReset().mockResolvedValue("$evt2");
  joinedRoomsMock.mockReset().mockResolvedValue(["!room:test"]);
  return {
    sendMessage: sendMessageMock,
    sendEvent: sendEventMock,
    getJoinedRooms: joinedRoomsMock,
    prepareForOneOff: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("./sdk.js").MatrixClient;
}

beforeAll(async () => {
  const runtimeModule = await import("../runtime.js");
  runtimeModule.setMatrixRuntime(runtimeStub);
  ({ createMatrixDraftStream } = await import("./draft-stream.js"));
});

describe("createMatrixDraftStream", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
    resolveTextChunkLimitMock.mockReset().mockReturnValue(4000);
    resolveChunkModeMock.mockReset().mockReturnValue("length");
    chunkMarkdownTextWithModeMock
      .mockReset()
      .mockImplementation((text: string) => (text ? [text] : []));
    convertMarkdownTablesMock.mockReset().mockImplementation((text: string) => text);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a normal text preview on first partial update", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("Hello");
    await stream.flush();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[1]).toMatchObject({
      msgtype: "m.text",
    });
    expect(stream.eventId()).toBe("$evt1");
  });

  it("sends quiet preview notices when quiet mode is enabled", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      mode: "quiet",
    });

    stream.update("Hello");
    await stream.flush();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[1]).toMatchObject({
      msgtype: "m.notice",
    });
    expect(sendMessageMock.mock.calls[0]?.[1]).not.toHaveProperty("m.mentions");
  });

  it("edits the message on subsequent quiet updates", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      mode: "quiet",
    });

    stream.update("Hello");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);

    // Advance past throttle window so the next update fires immediately.
    vi.advanceTimersByTime(1000);

    stream.update("Hello world");
    await stream.flush();

    // First call = initial send, second call = edit (both go through sendMessage)
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1]?.[1]).toMatchObject({
      msgtype: "m.notice",
      "m.new_content": { msgtype: "m.notice" },
    });
  });

  it("coalesces rapid quiet updates within throttle window", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      mode: "quiet",
    });

    stream.update("A");
    stream.update("AB");
    stream.update("ABC");
    await stream.flush();

    // First update fires immediately (fresh throttle window), then AB/ABC
    // coalesce into a single edit with the latest text.
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[0][1]).toMatchObject({ body: "A" });
    // Edit uses "* <text>" prefix per Matrix m.replace spec.
    expect(sendMessageMock.mock.calls[1][1]).toMatchObject({ body: "* ABC" });
    expect(sendMessageMock.mock.calls[0][1]).toMatchObject({ msgtype: "m.notice" });
    expect(sendMessageMock.mock.calls[1][1]).toMatchObject({
      msgtype: "m.notice",
      "m.new_content": { msgtype: "m.notice" },
    });
  });

  it("skips no-op updates", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("Hello");
    await stream.flush();
    const callCount = sendMessageMock.mock.calls.length;

    vi.advanceTimersByTime(1000);

    // Same text again — should not send
    stream.update("Hello");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(callCount);
  });

  it("ignores updates after stop", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("Hello");
    await stream.stop();
    const callCount = sendMessageMock.mock.calls.length;

    stream.update("Ignored");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(callCount);
  });

  it("stop returns the event ID", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("Hello");
    const eventId = await stream.stop();
    expect(eventId).toBe("$evt1");
  });

  it("stop does not finalize live drafts on its own", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      mode: "partial",
    });

    stream.update("Hello");
    await stream.stop();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[1]).toHaveProperty("org.matrix.msc4357.live");
  });

  it("finalizeLive clears the live marker at most once", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      mode: "partial",
    });

    stream.update("Hello");
    await stream.stop();

    await stream.finalizeLive();
    await stream.finalizeLive();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls[1]?.[1]).not.toHaveProperty("org.matrix.msc4357.live");
  });

  it("marks live finalize failures for normal final delivery fallback", async () => {
    sendMessageMock.mockResolvedValueOnce("$evt1").mockRejectedValueOnce(new Error("rate limited"));

    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      mode: "partial",
    });

    stream.update("Hello");
    await stream.stop();

    await expect(stream.finalizeLive()).resolves.toBe(false);
    expect(stream.mustDeliverFinalNormally()).toBe(true);
  });

  it("reset allows reuse for next block", async () => {
    sendMessageMock.mockResolvedValueOnce("$first").mockResolvedValueOnce("$second");

    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      mode: "quiet",
    });

    stream.update("Block 1");
    await stream.stop();
    expect(stream.eventId()).toBe("$first");

    stream.reset();
    expect(stream.eventId()).toBeUndefined();

    stream.update("Block 2");
    await stream.stop();
    expect(stream.eventId()).toBe("$second");
  });

  it("stops retrying after send failure", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("network error"));

    const log = vi.fn();
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      log,
    });

    stream.update("Hello");
    await stream.flush();

    // Should have logged the failure
    expect(log).toHaveBeenCalledWith(expect.stringContaining("send/edit failed"));

    vi.advanceTimersByTime(1000);

    // Further updates should not attempt sends (stream is stopped)
    stream.update("More text");
    await stream.flush();

    // Only the initial failed attempt
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(stream.eventId()).toBeUndefined();
  });

  it("skips empty/whitespace text", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("   ");
    await stream.flush();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("stops on edit failure mid-stream", async () => {
    sendMessageMock
      .mockResolvedValueOnce("$evt1") // initial send succeeds
      .mockRejectedValueOnce(new Error("rate limited")); // edit fails

    const log = vi.fn();
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      log,
    });

    stream.update("Hello");
    await stream.flush();
    expect(stream.eventId()).toBe("$evt1");

    vi.advanceTimersByTime(1000);

    stream.update("Hello world");
    await stream.flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("send/edit failed"));

    vi.advanceTimersByTime(1000);

    // Stream should be stopped — further updates are ignored
    stream.update("More text");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("bypasses newline chunking for the draft preview message", async () => {
    resolveChunkModeMock.mockReturnValue("newline");
    chunkMarkdownTextWithModeMock.mockImplementation((text: string) => text.split("\n"));

    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("line 1\nline 2");
    await stream.flush();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[1]).toMatchObject({ body: "line 1\nline 2" });
  });

  it("falls back to normal delivery when preview text exceeds one Matrix event", async () => {
    const log = vi.fn();
    resolveTextChunkLimitMock.mockReturnValue(5);
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      log,
    });

    stream.update("123456");
    await stream.flush();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(stream.eventId()).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("preview exceeded single-event limit"),
    );
  });

  it("uses converted Matrix text when checking the single-event preview limit", async () => {
    const log = vi.fn();
    resolveTextChunkLimitMock.mockReturnValue(5);
    convertMarkdownTablesMock.mockImplementation(() => "123456");
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      log,
    });

    stream.update("1234");
    await stream.flush();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("preview exceeded single-event limit"),
    );
  });
});
