// Telegram tests cover lane delivery plugin behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTelegramDraftStream } from "./draft-stream.js";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";
import { renderTelegramHtmlText, telegramHtmlToPlainTextFallback } from "./format.js";
import {
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
} from "./lane-delivery.js";
import {
  createTelegramPromptContextProjectionSequence,
  type TelegramPromptContextProjectionSequence,
} from "./prompt-context-projection.js";

const HELLO_FINAL = "Hello final";
type PromptContextRecord = Parameters<
  typeof createTelegramPromptContextProjectionSequence
>[0]["record"];

function createHarness(params?: {
  answerMessageId?: number;
  answerStream?: DraftLaneState["stream"] | null;
  resolveFinalTextCandidate?: (params: {
    finalText: string;
    laneName: LaneName;
  }) => string | undefined;
}) {
  const answer =
    params?.answerStream === null
      ? undefined
      : (params?.answerStream ?? createTestDraftStream({ messageId: params?.answerMessageId }));
  const reasoning = createTestDraftStream();
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: {
      stream: answer,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
      retainedPromptContextPages: [],
    },
    reasoning: {
      stream: reasoning,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
      retainedPromptContextPages: [],
    },
  };
  const sendPayload = vi.fn().mockResolvedValue(true);
  const flushDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.flush();
  });
  const stopDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.stop();
  });
  const clearDraftLane = vi.fn().mockImplementation(async (lane: DraftLaneState) => {
    await lane.stream?.clear();
  });
  const editStreamMessage = vi.fn().mockResolvedValue(undefined);
  const recordPromptContextPreview = vi.fn<PromptContextRecord>().mockResolvedValue(true);
  const createPromptContextSequence = () =>
    createTelegramPromptContextProjectionSequence({ record: recordPromptContextPreview });
  const log = vi.fn();
  const markDelivered = vi.fn();

  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    applyTextToPayload: (payload: ReplyPayload, text: string) => ({ ...payload, text }),
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    clearDraftLane,
    editStreamMessage,
    createPromptContextSequence,
    resolveFinalTextCandidate: params?.resolveFinalTextCandidate,
    log,
    markDelivered,
  });

  return {
    deliverLaneText,
    lanes,
    answer,
    reasoning,
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    clearDraftLane,
    editStreamMessage,
    recordPromptContextPreview,
    log,
    markDelivered,
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

function createProjectionSequence(
  record: PromptContextRecord,
): TelegramPromptContextProjectionSequence {
  return createTelegramPromptContextProjectionSequence({
    source: { transcriptMessageId: "assistant-1" },
    record,
  });
}

async function deliverProjectedFinalAnswer(
  harness: ReturnType<typeof createHarness>,
  text: string,
) {
  return harness.deliverLaneText({
    laneName: "answer",
    text,
    payload: { text },
    infoKind: "final",
    promptContextSequence: createProjectionSequence(harness.recordPromptContextPreview),
  });
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

function expectRecordedPreview(
  recordPromptContextPreview: ReturnType<typeof vi.fn>,
  index: number,
  params: { messageId?: number; text: string; partIndex: number; finalPart: boolean },
) {
  expect(recordPromptContextPreview.mock.calls[index]?.[0]).toEqual({
    messageId: params.messageId ?? 999,
    text: params.text,
    projection: {
      transcriptMessageId: "assistant-1",
      partIndex: params.partIndex,
      finalPart: params.finalPart,
    },
  });
}

function expectSentPayload(
  harness: ReturnType<typeof createHarness>,
  payload: ReplyPayload,
  durable: boolean,
) {
  expect(harness.sendPayload).toHaveBeenCalledWith(
    payload,
    expect.objectContaining({
      durable,
      promptContextSequence: expect.any(Object),
    }),
  );
}

describe("createLaneTextDeliverer", () => {
  it("finalizes text-only replies in the active stream message", async () => {
    const harness = createHarness({ answerMessageId: 999 });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(HELLO_FINAL);
    expect(delivery.messageId).toBe(999);
    expect(delivery.receipt?.primaryPlatformMessageId).toBe("999");
    expect(harness.answer?.update).toHaveBeenCalledWith(HELLO_FINAL);
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("streams block and final text through the same lane", async () => {
    const harness = createHarness({ answerMessageId: 999 });

    const blockResult = await harness.deliverLaneText({
      laneName: "answer",
      text: "working",
      payload: { text: "working" },
      infoKind: "block",
    });
    const finalResult = await deliverFinalAnswer(harness, "done");

    expect(blockResult.kind).toBe("preview-updated");
    const delivery = expectPreviewFinalized(finalResult);
    expect(delivery.content).toBe("done");
    expect(delivery.messageId).toBe(999);
    expect(harness.answer?.update).toHaveBeenNthCalledWith(1, "working");
    expect(harness.answer?.update).toHaveBeenNthCalledWith(2, "done");
    expect(harness.flushDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(2);
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("keeps reasoning block text in an updatable draft lane", async () => {
    const harness = createHarness();
    harness.reasoning.setMessageId(777);

    const result = await harness.deliverLaneText({
      laneName: "reasoning",
      text: "Checking source",
      payload: { text: "Checking source", isReasoning: true },
      infoKind: "block",
    });

    expect(result.kind).toBe("preview-updated");
    expect(harness.reasoning.update).toHaveBeenCalledWith("Checking source");
    expect(harness.flushDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.stopDraftLane).not.toHaveBeenCalled();
    expect(harness.lanes.reasoning.finalized).toBe(false);
  });

  it("uses normal final delivery when the stream edit leaves stale text", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("working");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "done");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("done");
    expect(harness.clearDraftLane).toHaveBeenCalledTimes(1);
    expectSentPayload(harness, { text: "done" }, true);
    expect(harness.markDelivered).not.toHaveBeenCalled();
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("keeps media fallback non-durable when materializing an intermediate preview", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "visible block",
      payload: { text: "visible block", mediaUrls: ["file:///site-a.png"] },
      infoKind: "block",
      finalizePreview: true,
      durable: false,
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe("visible block");
    expectSentPayload(harness, { mediaUrls: ["file:///site-a.png"] }, false);
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("does not use final transcript recovery when materializing an intermediate block preview", async () => {
    const previousBlock =
      "Here is the complete block preview with enough stable prefix text before the ellipsis...";
    const nextAssistantBlock =
      "Here is the complete block preview with enough stable prefix text before the ellipsis and later assistant continuation text.";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue(nextAssistantBlock);
    const harness = createHarness({
      answerStream: answer,
      resolveFinalTextCandidate: () => nextAssistantBlock,
    });
    harness.lanes.answer.lastPartialText = previousBlock;
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: previousBlock,
      payload: { text: previousBlock },
      infoKind: "block",
      finalizePreview: true,
      durable: false,
    });

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith(previousBlock);
    expect(answer.update).not.toHaveBeenCalledWith(nextAssistantBlock);
    expect(harness.clearDraftLane).toHaveBeenCalledTimes(1);
    expectSentPayload(harness, { text: previousBlock }, false);
    expect(harness.sendPayload).not.toHaveBeenCalledWith(
      { text: nextAssistantBlock },
      expect.anything(),
    );
  });

  it("keeps block delivery in the draft lane when delivered text is stale", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("working");
    const harness = createHarness({ answerStream: answer });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "done",
      payload: { text: "done" },
      infoKind: "block",
    });

    expect(result.kind).toBe("preview-updated");
    expect(answer.update).toHaveBeenCalledWith("done");
    expect(harness.flushDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.clearDraftLane).not.toHaveBeenCalled();
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
    expect(harness.lanes.answer.finalized).toBe(false);
  });

  it("discards an unmaterialized block preview before falling back to normal delivery", async () => {
    const answer = createTestDraftStream();
    const harness = createHarness({ answerStream: answer });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "short",
      payload: { text: "short" },
      infoKind: "block",
    });

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("short");
    expect(harness.flushDraftLane).toHaveBeenCalledTimes(1);
    expect(answer.discard).toHaveBeenCalledTimes(1);
    expect(harness.clearDraftLane).not.toHaveBeenCalled();
    expectSentPayload(harness, { text: "short" }, false);
    expect(harness.markDelivered).not.toHaveBeenCalled();
    expect(harness.lanes.answer.lastPartialText).toBe("");
    expect(harness.lanes.answer.hasStreamedMessage).toBe(false);
    expect(harness.lanes.answer.finalized).toBe(false);
  });

  it("resets the stream after discarding an unmaterialized block preview", async () => {
    const answerRef: { current?: ReturnType<typeof createTestDraftStream> } = {};
    const answer = createTestDraftStream({
      stopUpdatesOnDiscard: true,
      onUpdate: (text) => {
        if (text.startsWith("tool progress")) {
          answerRef.current?.setMessageId(1001);
        }
      },
    });
    answerRef.current = answer;
    const harness = createHarness({ answerStream: answer });

    const blockResult = await harness.deliverLaneText({
      laneName: "answer",
      text: "short",
      payload: { text: "short" },
      infoKind: "block",
    });
    const progressResult = await harness.deliverLaneText({
      laneName: "answer",
      text: "tool progress after fallback",
      payload: { text: "tool progress after fallback" },
      infoKind: "tool",
    });

    expect(blockResult.kind).toBe("sent");
    expect(progressResult.kind).toBe("preview-updated");
    expect(answer.discard).toHaveBeenCalledTimes(1);
    expect(answer.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answer.update).toHaveBeenNthCalledWith(2, "tool progress after fallback");
    expect(harness.sendPayload).toHaveBeenCalledTimes(1);
    expectSentPayload(harness, { text: "short" }, false);
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("keeps a longer partial preview when the final payload is an ellipsis-truncated snapshot", async () => {
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue(fullAnswer);
    answer.currentMessageSnapshot.mockReturnValue({ text: fullAnswer, sourceText: fullAnswer });
    const harness = createHarness({
      answerStream: answer,
      resolveFinalTextCandidate: () => fullAnswer,
    });

    const result = await deliverFinalAnswer(harness, truncatedFinal);

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(fullAnswer);
    expect(delivery.messageId).toBe(999);
    expect(answer.update).not.toHaveBeenCalledWith(truncatedFinal);
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("keeps a longer delivered stream preview when transcript lookup misses", async () => {
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue(fullAnswer);
    answer.currentMessageSnapshot.mockReturnValue({ text: fullAnswer, sourceText: fullAnswer });
    const harness = createHarness({ answerStream: answer });
    harness.lanes.answer.lastPartialText = fullAnswer;
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await deliverFinalAnswer(harness, truncatedFinal);

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(fullAnswer);
    expect(answer.update).not.toHaveBeenCalledWith(truncatedFinal);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("keeps a longer pending partial preview before it is delivered", async () => {
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    let deliveredText = "";
    const answer = createTestDraftStream({
      messageId: 999,
      onStop: () => {
        deliveredText = fullAnswer;
      },
    });
    answer.lastDeliveredText.mockImplementation(() => deliveredText);
    const harness = createHarness({
      answerStream: answer,
      resolveFinalTextCandidate: () => fullAnswer,
    });

    answer.update(fullAnswer);
    harness.lanes.answer.lastPartialText = fullAnswer;
    harness.lanes.answer.hasStreamedMessage = true;
    const result = await deliverFinalAnswer(harness, truncatedFinal);

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(fullAnswer);
    expect(answer.update).not.toHaveBeenCalledWith(truncatedFinal);
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("materializes a pending retained preview before reading the message id", async () => {
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    let deliveredText = "";
    const answer: ReturnType<typeof createTestDraftStream> = createTestDraftStream({
      onStop: () => {
        answer.setMessageId(999);
        deliveredText = fullAnswer;
      },
    });
    answer.lastDeliveredText.mockImplementation(() => deliveredText);
    const harness = createHarness({
      answerStream: answer,
      resolveFinalTextCandidate: () => fullAnswer,
    });

    answer.update(fullAnswer);
    harness.lanes.answer.lastPartialText = fullAnswer;
    harness.lanes.answer.hasStreamedMessage = true;
    const result = await deliverFinalAnswer(harness, truncatedFinal);

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(fullAnswer);
    expect(delivery.messageId).toBe(999);
    expect(answer.update).not.toHaveBeenCalledWith(truncatedFinal);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back when the retained pending preview does not land", async () => {
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console.";
    const truncatedFinal = "Ja. Hier nochmal sauber Schritt fuer Schritt...";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("older preview");
    const harness = createHarness({
      answerStream: answer,
      resolveFinalTextCandidate: () => fullAnswer,
    });
    harness.lanes.answer.lastPartialText = fullAnswer;
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await deliverFinalAnswer(harness, truncatedFinal);

    expect(result.kind).toBe("sent");
    expect(harness.clearDraftLane).toHaveBeenCalledTimes(1);
    expectSentPayload(harness, { text: truncatedFinal }, true);
  });

  it("uses the canonical final when the shorter final has no truncation marker", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("Hello world");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "Hello");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("Hello");
    expectSentPayload(harness, { text: "Hello" }, true);
  });

  it("uses the canonical final when the shorter final intentionally ends with ellipsis", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("Let's leave it... and continue");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "Let's leave it...");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("Let's leave it...");
    expectSentPayload(harness, { text: "Let's leave it..." }, true);
  });

  it("uses the canonical final when an intentional ellipsis replaces a longer draft", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("I don't know the answer");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "I don't know...");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("I don't know...");
    expectSentPayload(harness, { text: "I don't know..." }, true);
  });

  it("uses the canonical final when an internal segment ends with ellipsis", async () => {
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    const answer = createTestDraftStream({ messageId: 999 });
    const harness = createHarness({ answerStream: answer });
    harness.lanes.answer.lastPartialText = "Hello retained preview";

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello... world",
      payload: { text: "Hello... world" },
      infoKind: "final",
      buttons,
      promptContextSequence: createProjectionSequence(harness.recordPromptContextPreview),
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe("Hello... world");
    expect(answer.update).toHaveBeenCalledWith("Hello... world");
    expect(harness.editStreamMessage).toHaveBeenCalledWith({
      laneName: "answer",
      messageId: 999,
      text: "Hello... world",
      buttons,
    });
    expectRecordedPreview(harness.recordPromptContextPreview, 0, {
      text: "Hello... world",
      partIndex: 0,
      finalPart: true,
    });
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal delivery when no stream exists", async () => {
    const harness = createHarness({ answerStream: null });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expectSentPayload(harness, { text: HELLO_FINAL }, true);
    expect(harness.clearDraftLane).not.toHaveBeenCalled();
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("keeps streamed final text in place when late media arrives", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: { text: "photo", mediaUrl: "https://example.com/a.png" },
      infoKind: "final",
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe("photo");
    expect(delivery.messageId).toBe(999);
    expect(harness.clearDraftLane).not.toHaveBeenCalled();
    expect(harness.answer?.clear).not.toHaveBeenCalled();
    expect(harness.answer?.update).toHaveBeenCalledWith("photo");
    expect(harness.stopDraftLane).toHaveBeenCalledTimes(1);
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/a.png",
      },
      true,
    );
    expect(harness.sendPayload).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ afterAcceptedDraft: true }),
    );
  });

  it("uses normal media final delivery when no preview has streamed", async () => {
    const harness = createHarness({ answerMessageId: 999 });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: { text: "photo", mediaUrl: "https://example.com/a.png" },
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.clearDraftLane).toHaveBeenCalledTimes(1);
    expectSentPayload(
      harness,
      {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
      },
      true,
    );
  });

  it("uses normal media final delivery when no stream exists", async () => {
    const harness = createHarness({ answerStream: null });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: { text: "photo", mediaUrl: "https://example.com/a.png" },
      infoKind: "final",
    });

    expect(result.kind).toBe("sent");
    expect(harness.clearDraftLane).not.toHaveBeenCalled();
    expectSentPayload(
      harness,
      {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
      },
      true,
    );
  });

  it("strips rich fallback content from late media follow-up", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
        presentation: {
          title: "Photo",
          blocks: [{ type: "text", text: "Visible fallback" }],
        },
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
        },
        btw: { question: "side question" },
      },
      infoKind: "final",
    });

    expectPreviewFinalized(result);
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/a.png",
      },
      true,
    );
  });

  it("keeps text on late voice media so blocked voice sends can fall back", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "resolved voice fallback",
      payload: {
        text: "stale voice fallback",
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
      },
      infoKind: "final",
    });

    expectPreviewFinalized(result);
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
        spokenText: "resolved voice fallback",
      },
      true,
    );
  });

  it("uses retained final preview text for late voice media fallback", async () => {
    const fullAnswer =
      "A longer transcript-backed answer that has enough continuation text to avoid falling back to the truncated snapshot.";
    const truncatedFinal = "A longer transcript-backed answer that has enough...";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue(fullAnswer);
    answer.currentMessageSnapshot.mockReturnValue({ text: fullAnswer, sourceText: fullAnswer });
    const harness = createHarness({
      answerStream: answer,
      resolveFinalTextCandidate: () => fullAnswer,
    });
    harness.lanes.answer.hasStreamedMessage = true;

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: truncatedFinal,
      payload: {
        text: truncatedFinal,
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
      },
      infoKind: "final",
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(fullAnswer);
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
        spokenText: fullAnswer,
      },
      true,
    );
  });

  it("keeps inline buttons on the streamed text instead of late media", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;
    const buttons = [[{ text: "OK", callback_data: "ok" }]];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons, effect: "spark" }, other: true },
      },
      infoKind: "final",
      buttons,
    });

    expectPreviewFinalized(result);
    expect(harness.editStreamMessage).toHaveBeenCalledWith({
      laneName: "answer",
      messageId: 999,
      text: "photo",
      buttons,
    });
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { effect: "spark" }, other: true },
      },
      true,
    );
  });

  it("keeps inline buttons on late media when the stream button edit fails", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;
    harness.editStreamMessage.mockRejectedValueOnce(new Error("400: button rejected"));
    const buttons = [[{ text: "OK", callback_data: "ok" }]];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons, effect: "spark" }, other: true },
      },
      infoKind: "final",
      buttons,
    });

    expectPreviewFinalized(result);
    expect(harness.log).toHaveBeenCalledWith(
      "telegram: answer stream button edit failed: Error: 400: button rejected",
    );
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons, effect: "spark" }, other: true },
      },
      true,
    );
  });

  it("preserves derived inline buttons on late media when the stream button edit fails", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.hasStreamedMessage = true;
    harness.editStreamMessage.mockRejectedValueOnce(new Error("400: button rejected"));
    const buttons = [[{ text: "OK", callback_data: "ok" }]];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "photo",
      payload: {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
        },
      },
      infoKind: "final",
      buttons,
    });

    expectPreviewFinalized(result);
    expectSentPayload(
      harness,
      {
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons } },
      },
      true,
    );
  });

  it("records the exact rendered draft pages in Telegram message order", async () => {
    let nextMessageId = 997;
    const renderedMessages = new Map<number, string>();
    const retainedPages: Array<{ messageId: number; text: string }> = [];
    const visibleText = (html: string) => html.replaceAll("&lt;", "<");
    const api = {
      sendMessage: vi.fn(async (_chatId: string, html: string) => {
        const messageId = nextMessageId++;
        renderedMessages.set(messageId, visibleText(html));
        return { message_id: messageId };
      }),
      editMessageText: vi.fn(async (_chatId: string, messageId: number, html: string) => {
        renderedMessages.set(messageId, visibleText(html));
        return { message_id: messageId };
      }),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const answer = createTelegramDraftStream({
      api: api as never,
      chatId: "123",
      maxChars: 10,
      throttleMs: 250,
      renderText: (text) => ({ text: text.replaceAll("<", "&lt;"), parseMode: "HTML" }),
      onRetainedPage: (page) => {
        retainedPages.push({ messageId: page.messageId, text: page.textSnapshot });
      },
    });
    const harness = createHarness({ answerStream: answer });
    harness.lanes.answer.retainedPromptContextPages = retainedPages;
    const fullAnswer = "a<a<a<a<a<a<a<a<a";

    const result = await deliverProjectedFinalAnswer(harness, fullAnswer);

    const delivery = expectPreviewFinalized(result);
    const concretePages = [...renderedMessages.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([messageId, text]) => ({ messageId, text }));
    const recordedPages = harness.recordPromptContextPreview.mock.calls.map(([record]) => ({
      messageId: record.messageId,
      text: record.text,
    }));
    expect(concretePages.length).toBeGreaterThan(1);
    expect(recordedPages).toEqual(concretePages);
    expect(recordedPages.map((page) => page.text).join("")).toBe(fullAnswer);
    expect(
      harness.recordPromptContextPreview.mock.calls.map(([record]) => record.projection),
    ).toEqual(
      concretePages.map((_page, partIndex) => ({
        transcriptMessageId: "assistant-1",
        partIndex,
        finalPart: partIndex === concretePages.length - 1,
      })),
    );
    expect(delivery.messageId).toBe(concretePages.at(-1)?.messageId);
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("falls back with only the unsent suffix after retained pages are rate-limited", async () => {
    vi.useFakeTimers();
    try {
      const attempts: string[] = [];
      const api = {
        sendMessage: vi.fn(async (_chatId: string, text: string) => {
          attempts.push(text);
          if (attempts.length > 1) {
            throw Object.assign(new Error("429: retry after 1"), {
              error_code: 429,
              parameters: { retry_after: 1 },
            });
          }
          return { message_id: 997 };
        }),
        editMessageText: vi.fn().mockResolvedValue(true),
        deleteMessage: vi.fn().mockResolvedValue(true),
      };
      const retainedPages: Array<{ messageId: number; text: string }> = [];
      const answer = createTelegramDraftStream({
        api: api as never,
        chatId: "123",
        maxChars: 10,
        throttleMs: 250,
        renderText: (text) => ({ text: renderTelegramHtmlText(text), parseMode: "HTML" }),
        onRetainedPage: (page) => {
          retainedPages.push({ messageId: page.messageId, text: page.textSnapshot });
        },
      });
      const fullAnswer = "1234567890`<b>x</b>`";
      const renderedSuffix = "<code>&lt;b&gt;x&lt;/b&gt;</code>";
      answer.update(fullAnswer);
      await answer.flush();
      expect(attempts).toEqual(["1234567890"]);

      const harness = createHarness({ answerStream: answer });
      harness.lanes.answer.retainedPromptContextPages = retainedPages;
      harness.sendPayload.mockImplementationOnce(async (fallbackPayload, options) => {
        await options?.promptContextSequence?.accept({
          messageId: 998,
          text: telegramHtmlToPlainTextFallback(fallbackPayload.text ?? ""),
        });
        await options?.promptContextSequence?.finish();
        return true;
      });
      const deliveryPromise = deliverProjectedFinalAnswer(harness, fullAnswer);

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual(["1234567890", renderedSuffix]);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual(["1234567890", renderedSuffix]);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toEqual(["1234567890", renderedSuffix, renderedSuffix]);
      await vi.advanceTimersByTimeAsync(999);
      expect(attempts).toEqual(["1234567890", renderedSuffix, renderedSuffix]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await deliveryPromise;

      expect(result.kind).toBe("sent");
      expect(attempts).toEqual(["1234567890", renderedSuffix, renderedSuffix, renderedSuffix]);
      expectRecordedPreview(harness.recordPromptContextPreview, 0, {
        messageId: 997,
        text: "1234567890",
        partIndex: 0,
        finalPart: false,
      });
      expectRecordedPreview(harness.recordPromptContextPreview, 1, {
        messageId: 998,
        text: "<b>x</b>",
        partIndex: 1,
        finalPart: true,
      });
      expect(harness.recordPromptContextPreview).toHaveBeenCalledTimes(2);
      expect(harness.sendPayload).toHaveBeenCalledWith(
        { text: renderedSuffix },
        expect.objectContaining({
          afterAcceptedDraft: true,
          textMode: "html",
        }),
      );
      expect(api.deleteMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records retained overflow pages before the exact active final preview", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.currentMessageSnapshot.mockReturnValue({
      text: "visible chunk2",
      sourceText: "source chunk2",
    });
    const harness = createHarness({ answerStream: answer });
    harness.lanes.answer.hasStreamedMessage = true;
    harness.lanes.answer.retainedPromptContextPages = [
      { messageId: 997, text: "chunk0" },
      { messageId: 998, text: "chunk1" },
    ];

    await deliverProjectedFinalAnswer(harness, "chunk0chunk1source chunk2");

    expectRecordedPreview(harness.recordPromptContextPreview, 0, {
      messageId: 997,
      text: "chunk0",
      partIndex: 0,
      finalPart: false,
    });
    expectRecordedPreview(harness.recordPromptContextPreview, 1, {
      messageId: 998,
      text: "chunk1",
      partIndex: 1,
      finalPart: false,
    });
    expectRecordedPreview(harness.recordPromptContextPreview, 2, {
      text: "visible chunk2",
      partIndex: 2,
      finalPart: true,
    });
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("does not carry unbound retained pages into a later projected final", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.retainedPromptContextPages = [{ messageId: 997, text: "unbound page" }];

    await deliverFinalAnswer(harness, "unbound final");
    expect(harness.lanes.answer.retainedPromptContextPages).toEqual([]);
    expect(harness.recordPromptContextPreview.mock.calls).toEqual([
      [{ messageId: 997, text: "unbound page" }],
      [{ messageId: 999, text: "unbound final" }],
    ]);

    await deliverProjectedFinalAnswer(harness, "projected final");

    expect(harness.recordPromptContextPreview).toHaveBeenCalledTimes(3);
    expectRecordedPreview(harness.recordPromptContextPreview, 2, {
      text: "projected final",
      partIndex: 0,
      finalPart: true,
    });
  });

  it("never finalizes after a retained page fails to enter the prompt cache", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    harness.lanes.answer.retainedPromptContextPages = [{ messageId: 998, text: "part0" }];
    harness.recordPromptContextPreview.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await harness.deliverLaneText({
      laneName: "answer",
      text: "part1",
      payload: { text: "part1" },
      infoKind: "final",
      promptContextSequence: createProjectionSequence(harness.recordPromptContextPreview),
    });

    expectRecordedPreview(harness.recordPromptContextPreview, 0, {
      messageId: 998,
      text: "part0",
      partIndex: 0,
      finalPart: false,
    });
    expectRecordedPreview(harness.recordPromptContextPreview, 1, {
      text: "part1",
      partIndex: 1,
      finalPart: false,
    });
  });

  it("uses the exact active draft page for button edits and prompt context", async () => {
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    const answer = createTestDraftStream({ messageId: 999 });
    answer.currentMessageSnapshot.mockReturnValue({
      text: "visible tail",
      sourceText: "<b>rendered tail</b>",
      sourceTextMode: "html",
    });
    const harness = createHarness({ answerStream: answer });
    harness.lanes.answer.hasStreamedMessage = true;
    harness.lanes.answer.retainedPromptContextPages = [{ messageId: 998, text: "visible prefix" }];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "visible prefix**markdown tail**",
      payload: {
        text: "visible prefix**markdown tail**",
        channelData: { telegram: { buttons } },
      },
      infoKind: "final",
      buttons,
      promptContextSequence: createProjectionSequence(harness.recordPromptContextPreview),
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.buttonsAttached).toBe(true);
    expect(harness.editStreamMessage).toHaveBeenCalledWith({
      laneName: "answer",
      messageId: 999,
      text: "<b>rendered tail</b>",
      textMode: "html",
      buttons,
    });
    expectRecordedPreview(harness.recordPromptContextPreview, 0, {
      messageId: 998,
      text: "visible prefix",
      partIndex: 0,
      finalPart: false,
    });
    expectRecordedPreview(harness.recordPromptContextPreview, 1, {
      text: "visible tail",
      partIndex: 1,
      finalPart: true,
    });
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("retains the streamed message when stop may have landed without a message id", async () => {
    const answer = createTestDraftStream();
    answer.sendMayHaveLanded.mockReturnValue(true);
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("preview-retained");
    expect(answer.update).toHaveBeenCalledWith(HELLO_FINAL);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("attaches buttons to the stream message without sending a second reply", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: HELLO_FINAL,
      payload: { text: HELLO_FINAL, channelData: { telegram: { buttons } } },
      infoKind: "final",
      buttons,
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(HELLO_FINAL);
    expect(delivery.messageId).toBe(999);
    expect(harness.editStreamMessage).toHaveBeenCalledWith({
      laneName: "answer",
      messageId: 999,
      text: HELLO_FINAL,
      buttons,
    });
    expect(harness.sendPayload).not.toHaveBeenCalled();
  });

  it("keeps the stream delivery when button attachment fails", async () => {
    const harness = createHarness({ answerMessageId: 999 });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    harness.editStreamMessage.mockRejectedValue(new Error("400: button rejected"));

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: HELLO_FINAL,
      payload: { text: HELLO_FINAL, channelData: { telegram: { buttons } } },
      infoKind: "final",
      buttons,
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe(HELLO_FINAL);
    expect(delivery.messageId).toBe(999);
    expect(harness.sendPayload).not.toHaveBeenCalled();
    expect(harness.log).toHaveBeenCalledWith(
      "telegram: answer stream button edit failed: Error: 400: button rejected",
    );
  });
});
