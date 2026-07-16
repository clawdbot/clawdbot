// Msteams tests cover reply stream controller plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

type StreamCloseResult = { id: string } | undefined;

function makeStream() {
  return {
    emit: vi.fn(),
    update: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn<() => Promise<StreamCloseResult>>(async () => ({ id: "stream-final" })),
    canceled: false,
  };
}

function makeContext(stream?: ReturnType<typeof makeStream>) {
  return { activity: { type: "message" }, stream } as never;
}

function makeController(
  opts: { conversationType?: string; stream?: ReturnType<typeof makeStream> } = {},
) {
  const stream = opts.stream;
  return createTeamsReplyStreamController({
    conversationType: opts.conversationType ?? "personal",
    context: makeContext(stream),
    feedbackLoopEnabled: false,
  });
}

describe("createTeamsReplyStreamController", () => {
  it("emits chunks via stream.emit when tokens arrive", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "hello" });
    expect(stream.emit).toHaveBeenCalledWith("hello");
  });

  it("emits only the delta when openclaw sends cumulative text on each chunk", () => {
    // openclaw's reply pipeline calls onPartialReply with the cumulative
    // text-so-far on every chunk. The SDK's HttpStream APPENDS each emit() to
    // its internal text buffer (this.text += activity.text). Without delta
    // conversion, the SDK accumulates "chunk1 + chunk2 + chunk3" and the user
    // sees the message duplicated on each progress update (real bug observed
    // 2026-05-06: a sonnet rendered with each line repeated alongside the
    // previous full state).
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "Here's one for you:\nThe morning" });
    ctrl.onPartialReply({ text: "Here's one for you:\nThe morning light" });
    ctrl.onPartialReply({ text: "Here's one for you:\nThe morning light breaks" });
    expect(stream.emit).toHaveBeenNthCalledWith(1, "Here's one for you:\nThe morning");
    expect(stream.emit).toHaveBeenNthCalledWith(2, " light");
    expect(stream.emit).toHaveBeenNthCalledWith(3, " breaks");
  });

  it("keeps the next chunk after cumulative trailing whitespace is normalized", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "Intro\n\n " });
    ctrl.onPartialReply({ text: "Intro\n\nNext" });

    expect(stream.emit).toHaveBeenNthCalledWith(1, "Intro\n\n ");
    expect(stream.emit).toHaveBeenNthCalledWith(2, "Next");
  });

  it("falls back and closes the stream for non-whitespace rewrites", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "abcde" });
    ctrl.onPartialReply({ text: "abXYZ" });

    expect(stream.emit).toHaveBeenCalledTimes(1);
    expect(stream.emit).toHaveBeenCalledWith("abcde");
    expect(ctrl.preparePayload({ text: "abXYZ" })).toEqual({ text: "abXYZ" });
    await ctrl.finalize();
    expect(stream.clearText).toHaveBeenCalledTimes(1);
    expect(stream.close).toHaveBeenCalled();
  });

  it("ignores duplicate or out-of-order partial replies that don't extend the text", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "abcdef" });
    ctrl.onPartialReply({ text: "abc" }); // shorter — could be edit-in-place semantics
    ctrl.onPartialReply({ text: "abcdef" }); // back to known length
    expect(stream.emit).toHaveBeenCalledTimes(1);
    expect(stream.emit).toHaveBeenCalledWith("abcdef");
  });

  it("does not touch native stream on reply start before text or progress work", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    await ctrl.onReplyStart();
    await ctrl.onReplyStart();

    expect(stream.update).not.toHaveBeenCalled();
    expect(stream.emit).not.toHaveBeenCalled();
    expect(ctrl.preparePayload({ text: "tool-only response" })).toEqual({
      text: "tool-only response",
    });
    await ctrl.finalize();
    expect(stream.close).not.toHaveBeenCalled();
  });

  it("suppresses block delivery when text was streamed", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed" })).toBeUndefined();
  });

  it("strips text but keeps media when text was streamed and payload has media", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed", mediaUrl: "https://x/y.png" })).toEqual({
      text: undefined,
      mediaUrl: "https://x/y.png",
    });
  });

  it("allows fallback delivery for second text segment after tool calls", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "First segment" });
    expect(ctrl.preparePayload({ text: "First segment" })).toBeUndefined();

    const result = ctrl.preparePayload({ text: "Second segment after tools" });
    expect(result).toEqual({ text: "Second segment after tools" });
  });

  it("uses fallback even when onPartialReply fires after stream finalization is pending", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "First segment" });
    expect(ctrl.preparePayload({ text: "First segment" })).toBeUndefined();

    ctrl.onPartialReply({ text: "Second segment" });
    expect(stream.emit).toHaveBeenCalledTimes(1);
    expect(ctrl.preparePayload({ text: "Second segment" })).toEqual({ text: "Second segment" });
  });

  it("delivers all later segments across 3+ tool call rounds", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "Segment 1" });
    expect(ctrl.preparePayload({ text: "Segment 1" })).toBeUndefined();

    ctrl.onPartialReply({ text: "Segment 2" });
    expect(ctrl.preparePayload({ text: "Segment 2" })).toEqual({ text: "Segment 2" });

    ctrl.onPartialReply({ text: "Segment 3" });
    expect(ctrl.preparePayload({ text: "Segment 3" })).toEqual({ text: "Segment 3" });
  });

  it("passes media+text payload through fully after stream finalization is pending", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "Streamed text" });
    expect(ctrl.preparePayload({ text: "Streamed text" })).toBeUndefined();

    expect(
      ctrl.preparePayload({
        text: "Post-tool text with image",
        mediaUrl: "https://example.com/tool-output.png",
      }),
    ).toEqual({
      text: "Post-tool text with image",
      mediaUrl: "https://example.com/tool-output.png",
    });
  });

  it("drops the payload after the stream is canceled (e.g. user Stop)", () => {
    // After the user presses Stop in Teams, the streamed prefix is already
    // visible. Returning the full payload here would render as a SECOND
    // message containing everything — defeating the cancel intent.
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    expect(ctrl.preparePayload({ text: "partial complete" })).toBeUndefined();
  });

  it("drops the payload even when it carries media after cancel", () => {
    // Cancel honored consistently — no leftover media bubble lands either.
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    expect(
      ctrl.preparePayload({ text: "partial complete", mediaUrl: "https://x/y.png" }),
    ).toBeUndefined();
  });

  it("falls back to block delivery when no tokens were streamed", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    expect(ctrl.preparePayload({ text: "tool-only response" })).toEqual({
      text: "tool-only response",
    });
  });

  it("closes the stream in finalize after streamed text payload was suppressed", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed" })).toBeUndefined();
    await expect(ctrl.finalize()).resolves.toBeUndefined();
    expect(stream.close).toHaveBeenCalled();
  });

  it("returns suppressed final payload when stream close produces no final activity", async () => {
    const stream = makeStream();
    stream.close.mockResolvedValueOnce(undefined);
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed final" })).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({ text: "streamed final" });
  });

  it("returns text-only fallback when stream close no-ops after media already queued", async () => {
    const stream = makeStream();
    stream.close.mockResolvedValueOnce(undefined);
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed final", mediaUrl: "https://x/y.png" })).toEqual({
      text: undefined,
      mediaUrl: "https://x/y.png",
    });

    await expect(ctrl.finalize()).resolves.toEqual({
      text: "streamed final",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("returns suppressed final payload when stream close throws", async () => {
    const stream = makeStream();
    stream.close.mockRejectedValueOnce(new Error("close failed"));
    const ctrl = makeController({ stream });

    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed final" })).toBeUndefined();

    await expect(ctrl.finalize()).resolves.toEqual({ text: "streamed final" });
  });

  it("does not close the stream in finalize when no tokens were emitted", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    await ctrl.finalize();
    expect(stream.close).not.toHaveBeenCalled();
  });

  it("streams compact Teams progress lines when tool progress is enabled", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    try {
      const ctrl = createTeamsReplyStreamController({
        conversationType: "personal",
        context: makeContext(stream),
        feedbackLoopEnabled: false,
        log: { debug: vi.fn() } as never,
        msteamsConfig: {
          streaming: {
            mode: "progress",
            progress: {
              label: "Working",
              maxLines: 3,
            },
          },
        } as never,
      });

      await ctrl.pushProgressLine("tool: search");
      await ctrl.pushProgressLine("tool: exec");
      expect(stream.update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);

      expect(stream.update).toHaveBeenLastCalledWith("Working\n\n- tool: search\n- tool: exec");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the pending progress gate at finalize so no stale card posts after close", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    try {
      const ctrl = createTeamsReplyStreamController({
        conversationType: "personal",
        context: makeContext(stream),
        feedbackLoopEnabled: false,
        log: { debug: vi.fn() } as never,
        msteamsConfig: {
          streaming: { mode: "progress", progress: { label: "Working" } },
        } as never,
      });

      // One work event schedules the delayed start; the turn finishes first.
      await ctrl.pushProgressLine("tool: search");
      ctrl.preparePayload({ text: "done" });
      await ctrl.finalize();
      expect(stream.update).not.toHaveBeenCalled();

      // The gate timer must be dead: firing it against the closed stream
      // would post a fresh stale "working" card below the final answer.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stream.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses block delivery when progress final text is emitted to the stream", () => {
    const stream = makeStream();
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: makeContext(stream),
      feedbackLoopEnabled: false,
      msteamsConfig: { streaming: { mode: "progress" } } as never,
    });

    expect(ctrl.preparePayload({ text: "complete final answer" })).toBeUndefined();
    expect(stream.emit).toHaveBeenCalledWith("complete final answer");
  });

  it("falls back to normal delivery when progress final streaming fails", () => {
    const stream = makeStream();
    stream.emit.mockImplementation(() => {
      throw new Error("progress final failed");
    });
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: makeContext(stream),
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: { streaming: { mode: "progress" } } as never,
    });

    expect(ctrl.preparePayload({ text: "complete final answer" })).toEqual({
      text: "complete final answer",
    });
  });

  it("does not close a canceled stream in finalize", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    await ctrl.finalize();
    expect(stream.close).not.toHaveBeenCalled();
  });

  describe("StreamCancelledError handling", () => {
    function makeCancelError(): Error {
      const err = new Error("stream canceled");
      err.name = "StreamCancelledError";
      return err;
    }

    it("swallows StreamCancelledError thrown from stream.emit (Stop button race)", () => {
      const stream = makeStream();
      stream.emit.mockImplementation(() => {
        throw makeCancelError();
      });
      const ctrl = makeController({ stream });
      // Must not throw — the SDK throws this synchronously when _canceled
      // flipped between our pre-check and the emit call (or when no pre-check
      // happens at all). An uncaught throw here crashes the gateway process
      // since it surfaces as an unhandled promise rejection in async paths.
      expect(() => ctrl.onPartialReply({ text: "after stop" })).not.toThrow();
    });

    it("swallows StreamCancelledError thrown from progress stream.update", async () => {
      const stream = makeStream();
      stream.update.mockImplementation(() => {
        throw makeCancelError();
      });
      const ctrl = createTeamsReplyStreamController({
        conversationType: "personal",
        context: makeContext(stream),
        feedbackLoopEnabled: false,
        msteamsConfig: { streaming: { mode: "progress" } } as never,
      });
      await expect(ctrl.noteProgressWork({ toolName: "exec" })).resolves.toBeUndefined();
    });

    it("swallows StreamCancelledError thrown from stream.emit during finalize", async () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "partial" });
      // Cancel after we've started streaming, then make the final emit throw.
      stream.emit.mockImplementation(() => {
        throw makeCancelError();
      });
      // Must not throw — finalize's pre-check on stream.canceled may miss
      // the cancellation that happens between check and emit.
      await expect(ctrl.finalize()).resolves.toBeUndefined();
    });

    it("latches streamFailed (and does not throw) on non-cancel errors from stream.emit", () => {
      const stream = makeStream();
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      const ctrl = makeController({ stream });
      // Must not propagate — the rest of the reply pipeline needs to keep
      // running so preparePayload can fall back to block delivery.
      expect(() => ctrl.onPartialReply({ text: "boom" })).not.toThrow();
      // Stream is no longer considered active once it has failed.
      expect(ctrl.isStreamActive()).toBe(false);
    });

    it("falls back to block delivery when stream.emit fails after tokens were emitted", () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      // First chunk succeeds — tokensEmitted goes true.
      ctrl.onPartialReply({ text: "hello" });
      expect(stream.emit).toHaveBeenCalledTimes(1);
      // Second chunk fails for a non-cancel reason.
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      ctrl.onPartialReply({ text: "hello world" });
      // Without the streamFailed latch, preparePayload would suppress the
      // payload because tokens were emitted; the user would see only "hello".
      // With the latch, block delivery sends the full final reply.
      const result = ctrl.preparePayload({ text: "hello world final" });
      expect(result).toEqual(expect.objectContaining({ text: "hello world final" }));
    });

    it("preserves the no-duplicate behavior for the active streamed segment", () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "hello" });
      // No failure — preparePayload should still suppress block delivery for
      // the active streamed segment so the streamed text isn't duplicated.
      expect(ctrl.preparePayload({ text: "hello world" })).toBeUndefined();
    });

    it("swallows non-cancel errors from stream.close during finalize", async () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "partial" });
      expect(ctrl.preparePayload({ text: "partial final" })).toBeUndefined();
      stream.close.mockImplementation(async () => {
        throw new Error("close failed");
      });
      // Finalize must not propagate; it returns the retained payload so the
      // dispatcher can fall back to normal Teams delivery.
      await expect(ctrl.finalize()).resolves.toEqual({ text: "partial final" });
    });

    it("treats post-cancel stream as inactive without further emit attempts", () => {
      const stream = makeStream();
      stream.emit.mockImplementationOnce(() => {
        throw makeCancelError();
      });
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "first chunk after stop" });
      // Subsequent partial replies should short-circuit and not call emit
      // again (the SDK would throw on every call once canceled).
      ctrl.onPartialReply({ text: "second chunk" });
      ctrl.onPartialReply({ text: "third chunk" });
      expect(stream.emit).toHaveBeenCalledTimes(1);
      expect(ctrl.isStreamActive()).toBe(false);
    });
  });

  describe("non-personal conversation", () => {
    it("does not stream in channels — onPartialReply is a no-op", () => {
      const stream = makeStream();
      const ctrl = makeController({ conversationType: "channel", stream });
      ctrl.onPartialReply({ text: "anything" });
      expect(stream.emit).not.toHaveBeenCalled();
    });

    it("hasStream returns false for channels", () => {
      const ctrl = makeController({ conversationType: "channel", stream: makeStream() });
      expect(ctrl.hasStream()).toBe(false);
    });

    it("preparePayload returns payload unchanged for channels", () => {
      const ctrl = makeController({ conversationType: "channel", stream: makeStream() });
      expect(ctrl.preparePayload({ text: "hi" })).toEqual({ text: "hi" });
    });
  });

  describe("isStreamActive", () => {
    it("returns false before any tokens arrive", () => {
      expect(makeController({ stream: makeStream() }).isStreamActive()).toBe(false);
    });

    it("returns true while receiving tokens", () => {
      const ctrl = makeController({ stream: makeStream() });
      ctrl.onPartialReply({ text: "tokens" });
      expect(ctrl.isStreamActive()).toBe(true);
    });

    it("returns false when stream is canceled", () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "tokens" });
      stream.canceled = true;
      expect(ctrl.isStreamActive()).toBe(false);
    });

    it("returns false for non-personal conversations", () => {
      const ctrl = makeController({ conversationType: "channel", stream: makeStream() });
      ctrl.onPartialReply({ text: "tokens" });
      expect(ctrl.isStreamActive()).toBe(false);
    });
  });
});
