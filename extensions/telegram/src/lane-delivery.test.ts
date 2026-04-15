import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import {
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery.js";

const HELLO_FINAL = "Hello final";

function createHarness(params?: {
  answerMessageId?: number;
  draftMaxChars?: number;
  answerMessageIdAfterStop?: number;
  answerStream?: DraftLaneState["stream"];
  answerHasStreamedMessage?: boolean;
  answerLastPartialText?: string;
}) {
  const answer =
    params?.answerStream ?? createTestDraftStream({ messageId: params?.answerMessageId });
  const reasoning = createTestDraftStream();
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: {
      stream: answer,
      lastPartialText: params?.answerLastPartialText ?? "",
      hasStreamedMessage: params?.answerHasStreamedMessage ?? false,
    },
    reasoning: {
      stream: reasoning as DraftLaneState["stream"],
      lastPartialText: "",
      hasStreamedMessage: false,
    },
  };
  const sendPayload = vi.fn().mockResolvedValue(true);
  const flushDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.flush();
  });
  const stopDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    if (lane === lanes.answer && params?.answerMessageIdAfterStop !== undefined) {
      (answer as { setMessageId?: (value: number | undefined) => void }).setMessageId?.(
        params.answerMessageIdAfterStop,
      );
    }
    await lane.stream?.stop();
  });
  const editPreview = vi.fn().mockResolvedValue(undefined);
  const deletePreviewMessage = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const markDelivered = vi.fn();
  const activePreviewLifecycleByLane = { answer: "transient", reasoning: "transient" } as const;
  const retainPreviewOnCleanupByLane = { answer: false, reasoning: false } as const;
  const archivedAnswerPreviews: Array<{
    messageId: number;
    textSnapshot: string;
    deleteIfUnused?: boolean;
  }> = [];

  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    archivedAnswerPreviews,
    activePreviewLifecycleByLane: { ...activePreviewLifecycleByLane },
    retainPreviewOnCleanupByLane: { ...retainPreviewOnCleanupByLane },
    draftMaxChars: params?.draftMaxChars ?? 4_096,
    applyTextToPayload: (payload: ReplyPayload, text: string) => ({ ...payload, text }),
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    editPreview,
    deletePreviewMessage,
    log,
    markDelivered,
  });

  return {
    deliverLaneText,
    lanes,
    answer: {
      stream: answer,
      setMessageId: (answer as { setMessageId?: (value: number | undefined) => void }).setMessageId,
    },
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    editPreview,
    deletePreviewMessage,
    log,
    markDelivered,
    archivedAnswerPreviews,
  };
}

async function deliverFinalAnswer(harness: ReturnType<typeof createHarness>, text: string) {
  return harness.deliverLaneText({
    laneName: "answer",
    text,
    payload: { text },
    infoKind: "final",
  });
}

async function expectFinalPreviewRetained(params: {
  harness: ReturnType<typeof createHarness>;
  text?: string;
  expectedLogSnippet?: string;
}) {
  const result = await deliverFinalAnswer(params.harness, params.text ?? HELLO_FINAL);
  expect(result.kind).toBe("preview-retained");
  expect(params.harness.sendPayload).not.toHaveBeenCalled();
  if (params.expectedLogSnippet) {
    expect(params.harness.log).toHaveBeenCalledWith(
      expect.stringContaining(params.expectedLogSnippet),
    );
  }
}

function seedArchivedAnswerPreview(harness: ReturnType<typeof createHarness>) {
  harness.archivedAnswerPreviews.push({
    messageId: 5555,
    textSnapshot: "Partial streaming...",
    deleteIfUnused: true,
  });
}

async function expectFinalEditFallbackToSend(params: {
  harness: ReturnType<typeof createHarness>;
  text: string;
  expectedLogSnippet: string;
}) {
  const result = await deliverFinalAnswer(params.harness, params.text);
  expect(result.kind).toBe("sent");
  expect(params.harness.editPreview).toHaveBeenCalledTimes(1);
  expect(params.harness.sendPayload).toHaveBeenCalledWith(
    expect.objectContaining({ text: params.text }),
  );
  expect(params.harness.log).toHaveBeenCalledWith(
    expect.stringContaining(params.expectedLogSnippet),
  );
}

function expectPreviewFinalized(
  result: LaneDeliveryResult,
): Extract<LaneDeliveryResult, { kind: "preview-finalized" }>["delivery"] {
  expect(result.kind).toBe("preview-finalized");
  if (result.kind !== "preview-finalized") {
    throw new Error(`expected preview-finalized, got ${result.kind}`);
  }
  return result.delivery;
}

describe("createLaneTextDeliverer", () => {
  it("finalizes text-only replies by editing an existing preview message", async () => {
    const harness = createHarness({ answerMessageId: 999 });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(expectPreviewFinalized(result)).toEqual({ content: HELLO_FINAL, messageId: 999 });
    expect(harness.editPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        laneName: "answer",
        messageId: 999,
        text: HELLO_FINAL,
        context: "final",
      }),
    );
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
  });

  it("primes stop-created previews with final text before editing", async () => {
    const harness = createHarness({ answerMessageIdAfterStop: 777 });
    harness.lanes.answer.lastPartialText = "no";

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "no problem",
      payload: { text: "no problem" },
      infoKind: "final",
    });

    expect(expectPreviewFinalized(result)).toEqual({ content: "no problem", messageId: 777 });
    expect(harness.answer.stream?.update).toHaveBeenCalledWith("no problem");
    expect(harness.editPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        laneName: "answer",
        messageId: 777,
        text: "no problem",
      }),
    );
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("keeps stop-created preview when follow-up final edit fails", async () => {
    const harness = createHarness({ answerMessageIdAfterStop: 777 });
    harness.editPreview.mockRejectedValue(new Error("500: edit failed after stop flush"));

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Short final",
      payload: { text: "Short final" },
      infoKind: "final",
    });

    expect(result.kind).toBe("preview-retained");
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("failed after stop flush; keeping existing preview"),
    );
  });

  it("treats 'message is not modified' preview edit errors as delivered", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.editPreview.mockRejectedValue(
      new Error(
        "400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    );

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(expectPreviewFinalized(result)).toEqual({ content: HELLO_FINAL, messageId: 999 });
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining('edit returned "message is not modified"; treating as delivered'),
    );
  });

  it("retains preview when an existing preview final edit fails with ambiguous error", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    // Plain Error with no error_code → ambiguous, prefer incomplete over duplicate
    harness.editPreview.mockRejectedValue(new Error("500: preview edit failed"));

    await expectFinalPreviewRetained({
      harness,
      expectedLogSnippet: "ambiguous error; keeping existing preview to avoid duplicate",
    });
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
  });

  it("falls back when Telegram reports the current final edit target missing", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.editPreview.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    await expectFinalEditFallbackToSend({
      harness,
      text: "Hello final",
      expectedLogSnippet: "edit target missing with no alternate preview; falling back",
    });
  });

  it("falls back to sendPayload when the final edit fails before reaching Telegram", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    harness.editPreview.mockRejectedValue(err);

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: HELLO_FINAL }),
    );
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("failed before reaching Telegram; falling back"),
    );
  });

  it("keeps preview when the final edit times out after the request may have landed", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.editPreview.mockRejectedValue(new Error("timeout: request timed out after 30000ms"));

    await expectFinalPreviewRetained({
      harness,
      expectedLogSnippet: "may have landed despite network error; keeping existing preview",
    });
  });

  it("falls back to normal delivery when stop-created preview has no message id", async () => {
    const harness = createHarness();

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Short final",
      payload: { text: "Short final" },
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Short final" }),
    );
  });

  it("keeps existing preview when final text regresses", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.lastPartialText = "Recovered final answer.";

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Recovered final answer",
      payload: { text: "Recovered final answer" },
      infoKind: "final",
    });

    expect(expectPreviewFinalized(result)).toEqual({
      content: "Recovered final answer.",
      messageId: 999,
    });
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal delivery when final text exceeds preview edit limit", async () => {
    const harness = createHarness({ answerMessageId: 999, draftMaxChars: 20 });
    const longText = "x".repeat(50);

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: longText,
      payload: { text: longText },
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith(expect.objectContaining({ text: longText }));
    expect(harness.log).toHaveBeenCalledWith(expect.stringContaining("preview final too long"));
  });

  it("materializes DM draft streaming final even when text is unchanged", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft", messageId: 321 });
    answerStream.materialize.mockResolvedValue(321);
    answerStream.update.mockImplementation(() => {});
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Hello final",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello final",
      payload: { text: "Hello final" },
      infoKind: "final",
    });

    expect(expectPreviewFinalized(result)).toEqual({ content: "Hello final", messageId: 321 });
    expect(harness.flushDraftLane).toHaveBeenCalled();
    expect(answerStream.materialize).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("materializes DM draft streaming final when revision changes", async () => {
    let previewRevision = 3;
    const answerStream = createTestDraftStream({ previewMode: "draft", messageId: 654 });
    answerStream.materialize.mockResolvedValue(654);
    answerStream.previewRevision.mockImplementation(() => previewRevision);
    answerStream.update.mockImplementation(() => {});
    answerStream.flush.mockImplementation(async () => {
      previewRevision += 1;
    });
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Final answer",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Final answer",
      payload: { text: "Final answer" },
      infoKind: "final",
    });

    expect(expectPreviewFinalized(result)).toEqual({ content: "Final answer", messageId: 654 });
    expect(answerStream.materialize).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal send when draft materialize returns no message id", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    answerStream.materialize.mockResolvedValue(undefined);
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Hello final",
    });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expect(answerStream.materialize).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: HELLO_FINAL }),
    );
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("draft preview materialize produced no message id"),
    );
  });

  it("does not use DM draft final shortcut for media payloads", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Image incoming",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Image incoming",
      payload: { text: "Image incoming", mediaUrl: "file:///tmp/example.png" },
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Image incoming", mediaUrl: "file:///tmp/example.png" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
  });

  it("does not use DM draft final shortcut when inline buttons are present", async () => {
    const answerStream = createTestDraftStream({ previewMode: "draft" });
    const harness = createHarness({
      answerStream: answerStream as DraftLaneState["stream"],
      answerHasStreamedMessage: true,
      answerLastPartialText: "Choose one",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Choose one",
      payload: { text: "Choose one" },
      previewButtons: [[{ text: "OK", callback_data: "ok" }]],
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Choose one" }),
    );
    expect(harness.markDelivered).not.toHaveBeenCalled();
  });

  // ── Duplicate message regression tests ──────────────────────────────────
  // During final delivery, only ambiguous post-connect failures keep the
  // preview. Definite non-delivery falls back to a real send.

  it("retains preview on ambiguous API error during final", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    // Plain Error with no error_code → ambiguous, prefer incomplete over duplicate
    harness.editPreview.mockRejectedValue(new Error("500: Internal Server Error"));

    await expectFinalPreviewRetained({ harness });
    expect(harness.editPreview).toHaveBeenCalledTimes(1);
  });

  it("falls back when an archived preview edit target is missing and no alternate preview exists", async () => {
    const harness = createHarness();
    seedArchivedAnswerPreview(harness);
    harness.editPreview.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    const result = await deliverFinalAnswer(harness, "Complete final answer");

    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Complete final answer" }),
    );
    expect(result.kind).toBe("sent");
    expect(harness.deletePreviewMessage).toHaveBeenCalledWith(5555);
  });

  it("keeps the active preview when an archived final edit target is missing", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    seedArchivedAnswerPreview(harness);
    harness.editPreview.mockRejectedValue(new Error("400: Bad Request: message to edit not found"));

    const result = await deliverFinalAnswer(harness, "Complete final answer");

    expect(harness.editPreview).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(result.kind).toBe("preview-retained");
    expect(harness.log).toHaveBeenCalledWith(
      expect.stringContaining("edit target missing; keeping alternate preview without fallback"),
    );
  });

  it("keeps the archived preview when the final text regresses", async () => {
    const harness = createHarness();
    harness.archivedAnswerPreviews.push({
      messageId: 5555,
      textSnapshot: "Recovered final answer.",
      deleteIfUnused: true,
    });

    const result = await deliverFinalAnswer(harness, "Recovered final answer");

    expect(expectPreviewFinalized(result)).toEqual({
      content: "Recovered final answer.",
      messageId: 5555,
    });
    expect(harness.editPreview).not.toHaveBeenCalled();
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("falls back on 4xx client rejection with error_code during final", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const err = Object.assign(new Error("403: Forbidden"), { error_code: 403 });
    harness.editPreview.mockRejectedValue(err);

    await expectFinalEditFallbackToSend({
      harness,
      text: "Hello final",
      expectedLogSnippet: "rejected by Telegram (client error); falling back",
    });
  });

  it("retains preview on 502 with error_code during final (ambiguous server error)", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const err = Object.assign(new Error("502: Bad Gateway"), { error_code: 502 });
    harness.editPreview.mockRejectedValue(err);

    await expectFinalPreviewRetained({
      harness,
      expectedLogSnippet: "ambiguous error; keeping existing preview to avoid duplicate",
    });
  });

  it("falls back when the first preview send may have landed without a message id", async () => {
    const stream = createTestDraftStream();
    stream.sendMayHaveLanded.mockReturnValue(true);
    const harness = createHarness({ answerStream: stream });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: HELLO_FINAL }),
    );
  });

  it("retains when sendMayHaveLanded is true and a prior preview was visible", async () => {
    // Stream has a messageId (visible preview) but loses it after stop
    const stream = createTestDraftStream({ messageId: 999 });
    stream.sendMayHaveLanded.mockReturnValue(true);
    const harness = createHarness({
      answerStream: stream,
      answerHasStreamedMessage: true,
    });
    // Simulate messageId lost after stop (e.g. forceNewMessage or timeout)
    harness.stopDraftLane.mockImplementation(async (lane: DraftLaneState) => {
      stream.setMessageId(undefined);
      await lane.stream?.stop();
    });

    await expectFinalPreviewRetained({
      harness,
      expectedLogSnippet: "preview send may have landed despite missing message id",
    });
  });

  it("deletes consumed boundary previews after fallback final send", async () => {
    const harness = createHarness();
    harness.archivedAnswerPreviews.push({
      messageId: 4444,
      textSnapshot: "Boundary preview",
      deleteIfUnused: false,
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Final with media",
      payload: { text: "Final with media", mediaUrl: "file:///tmp/example.png" },
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Final with media", mediaUrl: "file:///tmp/example.png" }),
    );
    expect(harness.deletePreviewMessage).toHaveBeenCalledWith(4444);
  });
});
