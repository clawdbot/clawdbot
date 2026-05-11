import { describe, expect, it, vi } from "vitest";

const streamInstances = vi.hoisted(
  () =>
    [] as Array<{
      hasContent: boolean;
      isFinalized: boolean;
      isFailed: boolean;
      streamedLength: number;
      messageId?: string;
      previewStreamId?: string;
      sendInformativeUpdate: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      replaceInformativeWithFinal: ReturnType<typeof vi.fn>;
      finalize: ReturnType<typeof vi.fn>;
    }>,
);

vi.mock("./streaming-message.js", () => ({
  TeamsHttpStream: class {
    hasContent = false;
    isFinalized = false;
    isFailed = false;
    streamedLength = 0;
    messageId: string | undefined;
    previewStreamId = "preview-stream";
    sendInformativeUpdate = vi.fn(async () => {});
    update = vi.fn(function (
      this: { hasContent: boolean; isFailed: boolean; streamedLength: number },
      payloadText?: string,
    ) {
      if ((payloadText?.length ?? 0) > 4000) {
        this.hasContent = false;
        this.isFailed = true;
        this.streamedLength = 0;
        return;
      }
      this.hasContent = true;
      this.streamedLength = payloadText?.length ?? 0;
    });
    replaceInformativeWithFinal = vi.fn(async function (
      this: {
        hasContent: boolean;
        isFailed: boolean;
        isFinalized: boolean;
        streamedLength: number;
        messageId?: string;
        update: (payloadText?: string) => void;
      },
      payloadText: string,
    ) {
      this.update(payloadText);
      if (this.isFailed) {
        return false;
      }
      this.isFinalized = true;
      this.messageId = "final-message";
      return this.hasContent;
    });
    finalize = vi.fn(async function (this: { isFinalized: boolean; messageId?: string }) {
      this.isFinalized = true;
      this.messageId = "final-message";
    });

    constructor() {
      streamInstances.push(this as never);
    }
  },
}));

import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

describe("createTeamsReplyStreamController", () => {
  function createController() {
    streamInstances.length = 0;
    return createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
    });
  }

  it("suppresses fallback for first text segment that was streamed", async () => {
    const ctrl = createController();
    ctrl.onPartialReply({ text: "Hello world" });

    const result = await ctrl.preparePayload({ text: "Hello world" });
    expect(result).toBeUndefined();
  });

  it("when stream fails after partial delivery, fallback sends only remaining text", async () => {
    const ctrl = createController();
    const fullText = "a".repeat(4000) + "b".repeat(200);

    ctrl.onPartialReply({ text: fullText });
    streamInstances[0].hasContent = false;
    streamInstances[0].isFailed = true;
    streamInstances[0].isFinalized = true;
    streamInstances[0].streamedLength = 4000;

    const result = await ctrl.preparePayload({ text: fullText });
    expect(result).toEqual({ text: "b".repeat(200) });
  });

  it("when stream fails before sending content, fallback sends full text", async () => {
    const ctrl = createController();
    const fullText = "Failure at first chunk";

    ctrl.onPartialReply({ text: fullText });
    streamInstances[0].hasContent = false;
    streamInstances[0].isFailed = true;
    streamInstances[0].isFinalized = true;
    streamInstances[0].streamedLength = 0;

    const result = await ctrl.preparePayload({ text: fullText });
    expect(result).toEqual({ text: fullText });
  });

  it("allows fallback delivery for second text segment after tool calls", async () => {
    const ctrl = createController();

    // First text segment: streaming tokens arrive
    ctrl.onPartialReply({ text: "First segment" });

    // First segment complete: preparePayload suppresses (stream handled it)
    const result1 = await ctrl.preparePayload({ text: "First segment" });
    expect(result1).toBeUndefined();

    // Tool calls happen... then second text segment arrives via deliver()
    // preparePayload should allow fallback delivery for this segment
    const result2 = await ctrl.preparePayload({ text: "Second segment after tools" });
    expect(result2).toEqual({ text: "Second segment after tools" });
  });

  it("finalizes the stream when suppressing first segment", async () => {
    const ctrl = createController();
    ctrl.onPartialReply({ text: "Streamed text" });

    await ctrl.preparePayload({ text: "Streamed text" });
    await ctrl.finalize();

    expect(streamInstances[0]?.finalize).toHaveBeenCalled();
    expect(ctrl.liveState().phase).toBe("finalized");
    expect(ctrl.liveState().receipt?.primaryPlatformMessageId).toBe("final-message");
  });

  it("uses fallback even when onPartialReply fires after stream finalized", async () => {
    const ctrl = createController();

    // First text segment: streaming tokens arrive
    ctrl.onPartialReply({ text: "First segment" });

    // First segment complete: preparePayload suppresses and finalizes stream
    const result1 = await ctrl.preparePayload({ text: "First segment" });
    expect(result1).toBeUndefined();
    expect(streamInstances[0]?.isFinalized).toBe(true);

    // Post-tool partial replies fire again (stream.update is a no-op since finalized)
    ctrl.onPartialReply({ text: "Second segment" });

    // Must still use fallback because stream is finalized and can't deliver
    const result2 = await ctrl.preparePayload({ text: "Second segment" });
    expect(result2).toEqual({ text: "Second segment" });
  });

  it("delivers all segments across 3+ tool call rounds", async () => {
    const ctrl = createController();

    // Round 1: text → tool
    ctrl.onPartialReply({ text: "Segment 1" });
    await expect(ctrl.preparePayload({ text: "Segment 1" })).resolves.toBeUndefined();

    // Round 2: text → tool
    ctrl.onPartialReply({ text: "Segment 2" });
    const r2 = await ctrl.preparePayload({ text: "Segment 2" });
    expect(r2).toEqual({ text: "Segment 2" });

    // Round 3: final text
    ctrl.onPartialReply({ text: "Segment 3" });
    const r3 = await ctrl.preparePayload({ text: "Segment 3" });
    expect(r3).toEqual({ text: "Segment 3" });
  });

  it("passes media+text payload through fully after stream finalized", async () => {
    const ctrl = createController();

    // First segment streamed and finalized
    ctrl.onPartialReply({ text: "Streamed text" });
    await ctrl.preparePayload({ text: "Streamed text" });

    // Second segment has both text and media — should pass through fully
    const result = await ctrl.preparePayload({
      text: "Post-tool text with image",
      mediaUrl: "https://example.com/tool-output.png",
    });
    expect(result).toEqual({
      text: "Post-tool text with image",
      mediaUrl: "https://example.com/tool-output.png",
    });
  });

  it("still strips text from media payloads when stream handled text", async () => {
    const ctrl = createController();
    ctrl.onPartialReply({ text: "Some text" });

    const result = await ctrl.preparePayload({
      text: "Some text",
      mediaUrl: "https://example.com/image.png",
    });
    expect(result).toEqual({
      text: undefined,
      mediaUrl: "https://example.com/image.png",
    });
  });

  it("falls back to normal delivery when progress final streaming fails", async () => {
    streamInstances.length = 0;
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: { streaming: { mode: "progress" } } as never,
    });
    await ctrl.noteProgressWork({ toolName: "exec" });
    await ctrl.noteProgressWork();
    const fullText = "x".repeat(4200);

    const result = await ctrl.preparePayload({ text: fullText });

    expect(result).toEqual({ text: fullText });
    expect(streamInstances[0]?.replaceInformativeWithFinal).toHaveBeenCalledWith(fullText);
  });

  it("records lifecycle receipt when progress final streaming succeeds", async () => {
    streamInstances.length = 0;
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: { streaming: { mode: "progress" } } as never,
    });
    await ctrl.noteProgressWork({ toolName: "exec" });
    await ctrl.noteProgressWork();

    await expect(ctrl.preparePayload({ text: "complete final answer" })).resolves.toBeUndefined();

    expect(ctrl.liveState().phase).toBe("finalized");
    expect(ctrl.liveState().receipt?.primaryPlatformMessageId).toBe("final-message");
  });

  it("falls back with full text when progress final send fails after streaming text", async () => {
    streamInstances.length = 0;
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: { streaming: { mode: "progress" } } as never,
    });
    await ctrl.onReplyStart();
    streamInstances[0].replaceInformativeWithFinal.mockImplementationOnce(
      async function (this: {
        hasContent: boolean;
        isFailed: boolean;
        isFinalized: boolean;
        streamedLength: number;
      }) {
        this.hasContent = true;
        this.isFailed = true;
        this.isFinalized = true;
        this.streamedLength = 12;
        return false;
      },
    );

    const result = await ctrl.preparePayload({ text: "complete final answer" });

    expect(result).toEqual({ text: "complete final answer" });
  });

  it("honors disabled Teams progress labels", async () => {
    streamInstances.length = 0;
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: { streaming: { mode: "progress", progress: { label: false } } } as never,
    });

    await ctrl.onReplyStart();

    expect(streamInstances).toHaveLength(1);
    expect(streamInstances[0]?.sendInformativeUpdate).not.toHaveBeenCalled();
  });

  it("streams compact Teams progress lines when tool progress is enabled", async () => {
    streamInstances.length = 0;
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
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

    expect(ctrl.shouldSuppressDefaultToolProgressMessages()).toBe(true);
    expect(ctrl.shouldStreamPreviewToolProgress()).toBe(true);
    expect(streamInstances[0]?.sendInformativeUpdate).toHaveBeenLastCalledWith(
      "Working\n- tool: search\n- tool: exec",
    );
  });

  it("suppresses Teams default progress messages without stream lines when tool progress is disabled", async () => {
    streamInstances.length = 0;
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: {
        streaming: {
          mode: "progress",
          progress: {
            toolProgress: false,
          },
        },
      } as never,
    });

    await ctrl.pushProgressLine("tool: search");

    expect(ctrl.shouldSuppressDefaultToolProgressMessages()).toBe(true);
    expect(ctrl.shouldStreamPreviewToolProgress()).toBe(false);
    expect(streamInstances[0]?.sendInformativeUpdate).not.toHaveBeenCalled();
  });

  it("does not start native streaming for Teams block mode", async () => {
    streamInstances.length = 0;
    const ctrl = createTeamsReplyStreamController({
      conversationType: "personal",
      context: { sendActivity: vi.fn(async () => ({ id: "a" })) } as never,
      feedbackLoopEnabled: false,
      log: { debug: vi.fn() } as never,
      msteamsConfig: { streaming: { mode: "block" } } as never,
    });

    await ctrl.onReplyStart();
    ctrl.onPartialReply({ text: "block partial" });

    expect(streamInstances).toHaveLength(0);
    await expect(ctrl.preparePayload({ text: "block final" })).resolves.toEqual({
      text: "block final",
    });
    expect(ctrl.hasStream()).toBe(false);
  });

  describe("isStreamActive", () => {
    it("returns false before any tokens arrive so typing keepalive can warm up", () => {
      const ctrl = createController();
      expect(ctrl.isStreamActive()).toBe(false);
    });

    it("returns false after the informative update but before tokens arrive", async () => {
      const ctrl = createController();
      await ctrl.onReplyStart();
      expect(ctrl.isStreamActive()).toBe(false);
    });

    it("returns true while the stream is actively receiving tokens", () => {
      const ctrl = createController();
      ctrl.onPartialReply({ text: "Streaming tokens" });
      expect(ctrl.isStreamActive()).toBe(true);
    });

    it("returns false after the stream is finalized between tool rounds", async () => {
      const ctrl = createController();

      ctrl.onPartialReply({ text: "First segment" });
      expect(ctrl.isStreamActive()).toBe(true);

      // First segment complete: stream is finalized so the typing keepalive
      // can resume during the tool chain that follows.
      await ctrl.preparePayload({ text: "First segment" });
      expect(ctrl.isStreamActive()).toBe(false);
    });

    it("returns false when the stream has failed", () => {
      const ctrl = createController();

      ctrl.onPartialReply({ text: "First segment" });
      expect(ctrl.isStreamActive()).toBe(true);

      streamInstances[0].isFailed = true;
      expect(ctrl.isStreamActive()).toBe(false);
    });

    it("returns false when conversationType is not personal", () => {
      streamInstances.length = 0;
      const ctrl = createTeamsReplyStreamController({
        conversationType: "channel",
        context: { sendActivity: vi.fn() } as never,
        feedbackLoopEnabled: false,
        log: { debug: vi.fn() } as never,
      });
      ctrl.onPartialReply({ text: "anything" });
      expect(ctrl.isStreamActive()).toBe(false);
    });
  });
});
