// QA Lab Matrix plugin module implements streaming preview scenarios.
import { randomUUID } from "node:crypto";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  advanceMatrixQaActorCursor,
  buildMatrixPartialStreamingPrompt,
  buildMatrixQuietStreamingPrompt,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  doesMatrixQaReplyBodyMatchToken,
  isMatrixQaMessageLikeKind,
  primeMatrixQaDriverScenarioClient,
  truncateMatrixQaPreview,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runQuietStreamingPreviewScenario(context: MatrixQaScenarioContext) {
  return runMatrixStreamingPreviewScenario(context, {
    expectedPreviewKind: "notice",
    finalText: buildMatrixStreamingPreviewFinalText("MATRIX_QA_QUIET_STREAM"),
    label: "quiet streaming",
    triggerBodyBuilder: buildMatrixQuietStreamingPrompt,
  });
}

export async function runPartialStreamingPreviewScenario(context: MatrixQaScenarioContext) {
  return runMatrixStreamingPreviewScenario(context, {
    expectedPreviewKind: "message",
    finalText: buildMatrixStreamingPreviewFinalText("MATRIX_QA_PARTIAL_STREAM"),
    label: "partial streaming",
    triggerBodyBuilder: buildMatrixPartialStreamingPrompt,
  });
}

function buildMatrixStreamingPreviewFinalText(prefix: string) {
  const token = `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
  return [
    `${token} preview complete.`,
    `${token} alpha segment confirms the draft stream started before final delivery.`,
    `${token} beta segment keeps the exact final answer long enough for preview updates.`,
    `${token} omega segment marks the finalized Matrix QA reply.`,
  ].join(" ");
}

async function runMatrixStreamingPreviewScenario(
  context: MatrixQaScenarioContext,
  params: {
    expectedPreviewKind: MatrixQaObservedEvent["kind"];
    finalText: string;
    label: string;
    triggerBodyBuilder: (sutUserId: string, finalText: string) => string;
  },
) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const triggerBody = params.triggerBodyBuilder(context.sutUserId, params.finalText);
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const preview = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.sender === context.sutUserId &&
      event.relatesTo === undefined &&
      (event.kind === params.expectedPreviewKind ||
        (isMatrixQaMessageLikeKind(event.kind) &&
          doesMatrixQaReplyBodyMatchToken(event, params.finalText))),
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  if (doesMatrixQaReplyBodyMatchToken(preview.event, params.finalText)) {
    advanceMatrixQaActorCursor({
      actorId: "driver",
      syncState: context.syncState,
      nextSince: preview.since,
      startSince,
    });
    const finalReply = buildMatrixReplyArtifact(preview.event, params.finalText);
    return {
      artifacts: {
        driverEventId,
        previewEventId: undefined,
        reply: finalReply,
        token: params.finalText,
        triggerBody,
      },
      details: [
        `driver event: ${driverEventId}`,
        `scenario: ${params.label}`,
        "preview event: <none>; final delivered without draft replacement",
        ...buildMatrixReplyDetails("final reply", finalReply),
      ].join("\n"),
    } satisfies MatrixQaScenarioExecution;
  }
  const finalized = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.sender === context.sutUserId &&
      isMatrixQaMessageLikeKind(event.kind) &&
      event.relatesTo?.relType === "m.replace" &&
      event.relatesTo.eventId === preview.event.eventId &&
      event.body === params.finalText,
    roomId: context.roomId,
    since: preview.since,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: finalized.since,
    startSince,
  });
  const finalReply = buildMatrixReplyArtifact(finalized.event, params.finalText);
  return {
    artifacts: {
      driverEventId,
      previewFormattedBodyPreview: truncateMatrixQaPreview(preview.event.formattedBody),
      previewBodyPreview: truncateMatrixQaPreview(preview.event.body),
      previewEventId: preview.event.eventId,
      previewMentions: preview.event.mentions,
      reply: finalReply,
      token: params.finalText,
      triggerBody,
    },
    details: [
      `driver event: ${driverEventId}`,
      `scenario: ${params.label}`,
      `preview event: ${preview.event.eventId}`,
      `preview kind: ${preview.event.kind}`,
      `preview body: ${preview.event.body ?? "<none>"}`,
      `final reply relation: ${finalized.event.relatesTo?.relType ?? "<none>"}`,
      `final reply target: ${finalized.event.relatesTo?.eventId ?? "<none>"}`,
      ...buildMatrixReplyDetails("final reply", finalReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
