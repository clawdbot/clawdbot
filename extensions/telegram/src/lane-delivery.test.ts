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
  answerStream?: DraftLaneState["stream"] | null;
  draftMaxChars?: number;
  splitFinalTextForStream?: (text: string) => readonly string[];
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
    },
    reasoning: {
      stream: reasoning,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
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
  const log = vi.fn();
  const markDelivered = vi.fn();

  const deliverLaneText = createLaneTextDeliverer({
    lanes,
    draftMaxChars: params?.draftMaxChars ?? 4_096,
    applyTextToPayload: (payload: ReplyPayload, text: string) => ({ ...payload, text }),
    splitFinalTextForStream: params?.splitFinalTextForStream,
    sendPayload,
    flushDraftLane,
    stopDraftLane,
    clearDraftLane,
    editStreamMessage,
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
  });

  it("uses normal final delivery when the stream edit leaves stale text", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("working");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "done");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("done");
    expect(harness.clearDraftLane).toHaveBeenCalledTimes(1);
    expect(harness.sendPayload).toHaveBeenCalledWith({ text: "done" }, { durable: true });
    expect(harness.markDelivered).not.toHaveBeenCalled();
    expect(harness.lanes.answer.finalized).toBe(true);
  });

  it("keeps a longer partial preview when the final payload is an ellipsis-truncated snapshot", async () => {
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue(fullAnswer);
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
    let answer: ReturnType<typeof createTestDraftStream>;
    let deliveredText = "";
    answer = createTestDraftStream({
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
    expect(harness.sendPayload).toHaveBeenCalledWith({ text: truncatedFinal }, { durable: true });
  });

  it("uses the canonical final when the shorter final has no truncation marker", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("Hello world");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "Hello");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("Hello");
    expect(harness.sendPayload).toHaveBeenCalledWith({ text: "Hello" }, { durable: true });
  });

  it("uses the canonical final when the shorter final intentionally ends with ellipsis", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("Let's leave it... and continue");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "Let's leave it...");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("Let's leave it...");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      { text: "Let's leave it..." },
      { durable: true },
    );
  });

  it("uses the canonical final when an intentional ellipsis replaces a longer draft", async () => {
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("I don't know the answer");
    const harness = createHarness({ answerStream: answer });

    const result = await deliverFinalAnswer(harness, "I don't know...");

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("I don't know...");
    expect(harness.sendPayload).toHaveBeenCalledWith(
      { text: "I don't know..." },
      { durable: true },
    );
  });

  it("uses the canonical split final when only the first chunk ends with ellipsis", async () => {
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    const answer = createTestDraftStream({ messageId: 999 });
    const harness = createHarness({
      answerStream: answer,
      draftMaxChars: 10,
      splitFinalTextForStream: () => ["Hello...", " world"],
    });
    harness.lanes.answer.lastPartialText = "Hello retained preview";

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello... world",
      payload: { text: "Hello... world" },
      infoKind: "final",
      buttons,
    });

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe("Hello... world");
    expect(answer.update).toHaveBeenCalledWith("Hello...");
    expect(harness.editStreamMessage).toHaveBeenCalledWith({
      laneName: "answer",
      messageId: 999,
      text: "Hello...",
      buttons,
    });
    expect(harness.sendPayload).toHaveBeenCalledWith({ text: " world" });
    expect(harness.markDelivered).toHaveBeenCalledTimes(1);
  });

  it("uses normal final delivery when retained preview is too long for button edit", async () => {
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue("Hello retained preview");
    const harness = createHarness({
      answerStream: answer,
      draftMaxChars: 10,
      resolveFinalTextCandidate: () => "Hello retained preview",
    });

    const result = await harness.deliverLaneText({
      laneName: "answer",
      text: "Hello...",
      payload: { text: "Hello..." },
      infoKind: "final",
      buttons,
    });

    expect(result.kind).toBe("sent");
    expect(answer.update).toHaveBeenCalledWith("Hello...");
    expect(harness.editStreamMessage).not.toHaveBeenCalled();
    expect(harness.sendPayload).toHaveBeenCalledWith({ text: "Hello..." }, { durable: true });
  });

  it("falls back to normal delivery when no stream exists", async () => {
    const harness = createHarness({ answerStream: null });

    const result = await deliverFinalAnswer(harness, HELLO_FINAL);

    expect(result.kind).toBe("sent");
    expect(harness.sendPayload).toHaveBeenCalledWith({ text: HELLO_FINAL }, { durable: true });
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        mediaUrl: "https://example.com/a.png",
      },
      { durable: true },
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
      },
      { durable: true },
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        text: "photo",
        mediaUrl: "https://example.com/a.png",
      },
      { durable: true },
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        mediaUrl: "https://example.com/a.png",
      },
      { durable: true },
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
        spokenText: "resolved voice fallback",
      },
      { durable: true },
    );
  });

  it("uses retained final preview text for late voice media fallback", async () => {
    const fullAnswer =
      "A longer transcript-backed answer that has enough continuation text to avoid falling back to the truncated snapshot.";
    const truncatedFinal = "A longer transcript-backed answer that has enough...";
    const answer = createTestDraftStream({ messageId: 999 });
    answer.lastDeliveredText.mockReturnValue(fullAnswer);
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        mediaUrl: "https://example.com/note.ogg",
        audioAsVoice: true,
        spokenText: fullAnswer,
      },
      { durable: true },
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { effect: "spark" }, other: true },
      },
      { durable: true },
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons, effect: "spark" }, other: true },
      },
      { durable: true },
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
    expect(harness.sendPayload).toHaveBeenCalledWith(
      {
        mediaUrl: "https://example.com/a.png",
        channelData: { telegram: { buttons } },
      },
      { durable: true },
    );
  });

  it("streams the first long final chunk and sends follow-up chunks", async () => {
    const harness = createHarness({
      answerMessageId: 999,
      draftMaxChars: 5,
      splitFinalTextForStream: () => ["Hello", " world", " again"],
    });

    const result = await deliverFinalAnswer(harness, "Hello world again");

    const delivery = expectPreviewFinalized(result);
    expect(delivery.content).toBe("Hello world again");
    expect(delivery.messageId).toBe(999);
    expect(harness.answer?.update).toHaveBeenCalledWith("Hello");
    expect(harness.sendPayload).toHaveBeenCalledTimes(2);
    expect(harness.sendPayload).toHaveBeenNthCalledWith(1, { text: " world" });
    expect(harness.sendPayload).toHaveBeenNthCalledWith(2, { text: " again" });
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
