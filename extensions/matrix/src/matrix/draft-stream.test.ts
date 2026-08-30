import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
// Matrix tests cover draft stream plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MATRIX_PREVIEW_PROTOCOL_KEY } from "./preview-protocol.js";

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
    (
      text: string,
      opts: { cfg?: unknown; accountId?: string; preserveWhitespace?: boolean } = {},
    ) => {
      const trimmedText = opts.preserveWhitespace ? text : text.trim();
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
        extraContent?: Record<string, unknown>;
      } = {},
    ) => {
      const prepared = prepareMatrixSingleText(text, {
        cfg: opts.cfg,
        accountId: opts.accountId,
        preserveWhitespace: true,
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
        ...opts.extraContent,
      };
      if (opts.live) {
        content["org.matrix.msc4357.live"] = {};
      }
      const eventId = await opts.client?.sendMessage(roomId, content);
      return {
        messageId: eventId ?? "unknown",
        roomId,
        primaryMessageId: eventId ?? "unknown",
        receipt: {
          ...(eventId ? { primaryPlatformMessageId: eventId } : {}),
          platformMessageIds: eventId ? [eventId] : [],
          parts: eventId ? [{ platformMessageId: eventId, kind: "text" as const, index: 0 }] : [],
          sentAt: 123,
        },
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
        extraContent?: Record<string, unknown>;
      } = {},
    ) => {
      const convertedText = convertMarkdownTablesMock(newText);
      const newContent: Record<string, unknown> = {
        msgtype: opts.msgtype ?? "m.text",
        body: convertedText,
        ...opts.extraContent,
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
        ...opts.extraContent,
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
  config: {
    current: () => loadConfigMock(),
  },
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

function sentContentAt(callIndex: number): Record<string, unknown> {
  const content = sendMessageMock.mock.calls[callIndex]?.[1];
  if (!content || typeof content !== "object") {
    throw new Error(`Expected sent content at call ${callIndex}`);
  }
  return content as Record<string, unknown>;
}

function expectLogContaining(log: ReturnType<typeof vi.fn>, fragment: string): void {
  expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(fragment);
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
    sendModuleMocks.editMessageMatrix.mockClear();
    sendModuleMocks.sendSingleTextMessageMatrix.mockClear();
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
    expect(sentContentAt(0).msgtype).toBe("m.text");
    expect(sendModuleMocks.sendSingleTextMessageMatrix.mock.calls[0]?.[2]).toMatchObject({
      includeMentions: false,
      live: true,
      msgtype: "m.text",
    });
    expect(stream.eventId()).toBe("$evt1");
  });

  it("emits one correlated progress-to-answer protocol through finalization", async () => {
    sendMessageMock
      .mockReset()
      .mockResolvedValueOnce("$root")
      .mockResolvedValueOnce("$edit-1")
      .mockResolvedValueOnce("$edit-final");
    const onUpdate = vi.fn();
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      protocol: {
        triggerEventId: "$trigger",
        createResponseId: () => "response-fixed",
        onUpdate,
      },
    });

    stream.setKind("progress");
    stream.update("Working");
    await stream.flush();
    const initial = sentContentAt(0);
    expect(initial[MATRIX_PREVIEW_PROTOCOL_KEY]).toEqual({
      v: 1,
      responseId: "response-fixed",
      triggerEventId: "$trigger",
      state: "in-progress",
      revision: 0,
      kind: "progress",
    });
    expect(initial).toHaveProperty("org.matrix.msc4357.live");

    vi.advanceTimersByTime(1000);
    stream.setKind("answer");
    stream.update("Draft answer");
    await stream.flush();
    const partialEdit = sentContentAt(1);
    const partialNewContent = partialEdit["m.new_content"] as Record<string, unknown>;
    expect(partialEdit[MATRIX_PREVIEW_PROTOCOL_KEY]).toEqual(
      partialNewContent[MATRIX_PREVIEW_PROTOCOL_KEY],
    );
    expect(partialEdit[MATRIX_PREVIEW_PROTOCOL_KEY]).toMatchObject({
      state: "in-progress",
      revision: 1,
      kind: "answer",
    });
    expect(partialEdit).toHaveProperty("org.matrix.msc4357.live");
    expect(partialNewContent).toHaveProperty("org.matrix.msc4357.live");

    await expect(stream.finalize("Final answer")).resolves.toBe(true);
    const finalEdit = sentContentAt(2);
    const finalNewContent = finalEdit["m.new_content"] as Record<string, unknown>;
    expect(finalEdit[MATRIX_PREVIEW_PROTOCOL_KEY]).toEqual(
      finalNewContent[MATRIX_PREVIEW_PROTOCOL_KEY],
    );
    expect(finalEdit[MATRIX_PREVIEW_PROTOCOL_KEY]).toMatchObject({
      state: "final",
      revision: 2,
      kind: "answer",
    });
    expect(finalEdit).not.toHaveProperty("org.matrix.msc4357.live");
    expect(finalNewContent).not.toHaveProperty("org.matrix.msc4357.live");
    expect(onUpdate.mock.calls.map((call) => call[0])).toMatchObject([
      { originalEventId: "$root", sourceEventId: "$root" },
      { originalEventId: "$root", sourceEventId: "$edit-1" },
      { originalEventId: "$root", sourceEventId: "$edit-final" },
    ]);
  });

  it("marks an abandoned preview terminally and never exposes later updates", async () => {
    sendMessageMock.mockReset().mockResolvedValueOnce("$root").mockResolvedValueOnce("$abandoned");
    const onUpdate = vi.fn();
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      protocol: {
        triggerEventId: "$trigger",
        createResponseId: () => "response-abandoned",
        onUpdate,
      },
    });
    stream.update("Draft");
    await stream.flush();
    await stream.abandon();

    const abandoned = sentContentAt(1);
    const abandonedNewContent = abandoned["m.new_content"] as Record<string, unknown>;
    expect(abandoned[MATRIX_PREVIEW_PROTOCOL_KEY]).toEqual(
      abandonedNewContent[MATRIX_PREVIEW_PROTOCOL_KEY],
    );
    expect(abandoned[MATRIX_PREVIEW_PROTOCOL_KEY]).toMatchObject({
      state: "abandoned",
      revision: 1,
    });
    expect(abandoned).not.toHaveProperty("org.matrix.msc4357.live");
    stream.update("NO_REPLY");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("does not reclassify an accepted final when protocol observation fails", async () => {
    sendMessageMock.mockReset().mockResolvedValueOnce("$root").mockResolvedValueOnce("$final");
    const log = vi.fn();
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
      log,
      protocol: {
        triggerEventId: "$trigger",
        onUpdate: vi.fn().mockRejectedValue(new Error("observer unavailable")),
      },
    });
    stream.update("Draft");
    await stream.flush();
    await expect(stream.finalize("Final")).resolves.toBe(true);
    expect(stream.mustDeliverFinalNormally()).toBe(false);
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expectLogContaining(log, "protocol observation failed after accepted send");
  });

  it("tracks the provider-visible prepared draft content", async () => {
    convertMarkdownTablesMock.mockImplementation((text: string) => `prepared:${text}`);
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("raw table");
    await stream.flush();

    expect(stream.content()).toBe("prepared:raw table");
  });

  it("preserves indented code through draft sends, edits, and final comparisons", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });
    const firstMarkdown = "    @room";

    stream.update(`${firstMarkdown}  `);
    await stream.flush();

    expect(sentContentAt(0).body).toBe(firstMarkdown);
    expect(stream.content()).toBe(firstMarkdown);
    expect(stream.matchesPreparedText(`${firstMarkdown}  `)).toBe(true);
    expect(stream.matchesPreparedText("@room")).toBe(false);

    vi.advanceTimersByTime(1000);
    const editedMarkdown = "    @alice:example.org";
    stream.update(editedMarkdown);
    await stream.flush();

    expect(sendModuleMocks.editMessageMatrix.mock.lastCall?.[2]).toBe(editedMarkdown);
    expect(stream.content()).toBe(editedMarkdown);
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
    expect(sentContentAt(0).msgtype).toBe("m.notice");
    expect(sentContentAt(0)).not.toHaveProperty("m.mentions");
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
    expect(sentContentAt(1).msgtype).toBe("m.notice");
    expect(sentContentAt(1)["m.new_content"]).toEqual({
      msgtype: "m.notice",
      body: "Hello world",
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
    expect(sentContentAt(0).body).toBe("A");
    // Edit uses "* <text>" prefix per Matrix m.replace spec.
    expect(sentContentAt(1).body).toBe("* ABC");
    expect(sentContentAt(0).msgtype).toBe("m.notice");
    expect(sentContentAt(1).msgtype).toBe("m.notice");
    expect(sentContentAt(1)["m.new_content"]).toEqual({ msgtype: "m.notice", body: "ABC" });
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
    expect(sendMessageMock.mock.calls.at(0)?.[1]).toHaveProperty("org.matrix.msc4357.live");
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
    expect(sendMessageMock.mock.calls.at(1)?.[1]).not.toHaveProperty("org.matrix.msc4357.live");
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
    expectLogContaining(log, "send/edit failed");

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
    expectLogContaining(log, "send/edit failed");

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
    expect(sentContentAt(0).body).toBe("line 1\nline 2");
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
    expectLogContaining(log, "preview exceeded single-event limit");
  });

  it("discardPending cancels pending updates without creating another preview event", async () => {
    const stream = createMatrixDraftStream({
      roomId: "!room:test",
      client,
      cfg: {} as import("../types.js").CoreConfig,
    });

    stream.update("First draft");
    await stream.flush();
    stream.update("Pending draft");
    await stream.discardPending();
    await stream.flush();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendModuleMocks.editMessageMatrix).not.toHaveBeenCalled();
    expect(stream.eventId()).toBe("$evt1");
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
    expectLogContaining(log, "preview exceeded single-event limit");
  });
});
