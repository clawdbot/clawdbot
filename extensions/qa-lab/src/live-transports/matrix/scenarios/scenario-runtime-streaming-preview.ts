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

const MATRIX_REPLACEMENT_FAULT_RULE_ID = "matrix-streaming-replacement-failure";

export async function runStreamingReplacementRetentionScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.installFaultRule) {
    throw new Error("Matrix streaming replacement QA requires in-place fault injection");
  }
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const firstText = `@room ${buildMatrixStreamingPreviewFinalText("MATRIX_QA_RETAINED_DRAFT")}`;
  const firstToken = firstText.split(" ")[1]!;
  // Keep the first replacement unavailable throughout both turns. HTTP 400 is
  // terminal in the Matrix SDK; 503 would retry after a timed fault was removed.
  const faultRule = context.installFaultRule({
    id: MATRIX_REPLACEMENT_FAULT_RULE_ID,
    match: (request) =>
      request.bearerToken === context.sutAccessToken &&
      request.path.includes(`/rooms/${encodeURIComponent(context.roomId)}/send/m.room.message/`) &&
      request.body.includes(firstToken),
    response: () => ({
      body: { errcode: "M_UNKNOWN", error: "Matrix QA injected replacement failure" },
      status: 400,
    }),
  });
  try {
    const firstDriverEventId = await client.sendTextMessage({
      body: buildMatrixReplacementPrompt(context.sutUserId, firstText),
      mentionUserIds: [context.sutUserId],
      roomId: context.roomId,
    });
    const firstPreview = await client
      .waitForRoomEvent({
        observedEvents: context.observedEvents,
        predicate: (event) =>
          event.roomId === context.roomId &&
          event.sender === context.sutUserId &&
          isMatrixQaMessageLikeKind(event.kind) &&
          event.live === true,
        roomId: context.roomId,
        since: startSince,
        timeoutMs: context.timeoutMs,
      })
      .catch((error: unknown) => {
        throw new Error("Matrix replacement QA timed out waiting for the first draft", {
          cause: error,
        });
      });
    const firstDraftEventId = firstPreview.event.replacesEventId ?? firstPreview.event.eventId;
    const firstWindow = await client.waitForOptionalRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        event.roomId === context.roomId &&
        event.sender === context.sutUserId &&
        (event.redactsEventId === firstDraftEventId || event.body?.includes(firstToken) === true),
      roomId: context.roomId,
      since: firstPreview.since,
      timeoutMs: Math.min(8_000, context.timeoutMs),
    });
    if (firstWindow.matched) {
      throw new Error(`Matrix failed replacement did not retain draft ${firstDraftEventId}`);
    }
    if (faultRule.hits().length === 0) {
      throw new Error("Matrix replacement fault rule did not observe a replacement request");
    }

    const secondText = `@room ${buildMatrixStreamingPreviewFinalText("MATRIX_QA_SUPERSEDED_DRAFT")}`;
    const secondToken = secondText.split(" ")[1]!;
    const secondDriverEventId = await client.sendTextMessage({
      body: buildMatrixReplacementPrompt(context.sutUserId, secondText),
      mentionUserIds: [context.sutUserId],
      roomId: context.roomId,
    });
    const secondPreview = await client
      .waitForRoomEvent({
        observedEvents: context.observedEvents,
        predicate: (event) =>
          event.roomId === context.roomId &&
          event.sender === context.sutUserId &&
          isMatrixQaMessageLikeKind(event.kind) &&
          event.live === true &&
          event.eventId !== firstPreview.event.eventId,
        roomId: context.roomId,
        since: firstWindow.since,
        timeoutMs: context.timeoutMs,
      })
      .catch((error: unknown) => {
        throw new Error("Matrix replacement QA timed out waiting for the second draft", {
          cause: error,
        });
      });
    const secondDraftEventId = secondPreview.event.replacesEventId ?? secondPreview.event.eventId;
    const secondReply = await client
      .waitForRoomEvent({
        observedEvents: context.observedEvents,
        predicate: (event) =>
          event.roomId === context.roomId &&
          event.sender === context.sutUserId &&
          isMatrixQaMessageLikeKind(event.kind) &&
          event.body?.includes(secondToken) === true &&
          event.eventId !== secondDraftEventId &&
          event.live !== true &&
          event.replacesEventId === undefined,
        roomId: context.roomId,
        since: secondPreview.since,
        timeoutMs: context.timeoutMs,
      })
      .catch((error: unknown) => {
        throw new Error("Matrix replacement QA timed out waiting for the healthy replacement", {
          cause: error,
        });
      });
    const secondRedaction = await client
      .waitForRoomEvent({
        observedEvents: context.observedEvents,
        predicate: (event) =>
          event.roomId === context.roomId &&
          event.sender === context.sutUserId &&
          event.kind === "redaction",
        roomId: context.roomId,
        since: secondReply.since,
        timeoutMs: context.timeoutMs,
      })
      .catch((error: unknown) => {
        throw new Error("Matrix replacement QA timed out waiting for post-replacement redaction", {
          cause: error,
        });
      });
    if (secondRedaction.event.redactsEventId !== secondDraftEventId) {
      throw new Error(
        `Matrix healthy replacement redacted ${secondRedaction.event.redactsEventId ?? "<unknown>"} instead of its own draft ${secondDraftEventId}`,
      );
    }
    const duplicateRedaction = await client.waitForOptionalRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        event.roomId === context.roomId &&
        event.sender === context.sutUserId &&
        event.kind === "redaction",
      roomId: context.roomId,
      since: secondRedaction.since,
      timeoutMs: Math.min(8_000, context.timeoutMs),
    });
    if (duplicateRedaction.matched) {
      throw new Error(
        `Matrix healthy replacement emitted a second redaction ${duplicateRedaction.event.eventId}`,
      );
    }
    if (context.observedEvents.some((event) => event.redactsEventId === firstDraftEventId)) {
      throw new Error(`Matrix healthy turn redacted retained draft ${firstDraftEventId}`);
    }
    advanceMatrixQaActorCursor({
      actorId: "driver",
      syncState: context.syncState,
      nextSince: duplicateRedaction.since,
      startSince,
    });
    return {
      artifacts: {
        faultHitCount: faultRule.hits().length,
        faultRuleId: MATRIX_REPLACEMENT_FAULT_RULE_ID,
        firstDriverEventId,
        previewEventId: firstDraftEventId,
        redactionCount: 1,
        redactionEventId: secondRedaction.event.eventId,
        redactionTargetEventId: secondRedaction.event.redactsEventId,
        secondDriverEventId,
        secondReply: buildMatrixReplyArtifact(secondReply.event),
        secondToken,
      },
      details: [
        `retained draft event: ${firstDraftEventId}`,
        `replacement fault hits: ${faultRule.hits().length}`,
        `second draft event: ${secondDraftEventId}`,
        `second replacement event: ${secondReply.event.eventId}`,
        `second redaction event: ${secondRedaction.event.eventId}`,
        `second redaction target: ${secondRedaction.event.redactsEventId}`,
        "healthy replacement redaction count: 1",
      ].join("\n"),
    } satisfies MatrixQaScenarioExecution;
  } finally {
    faultRule.remove();
  }
}

function buildMatrixReplacementPrompt(sutUserId: string, finalText: string) {
  // This fixture emits a short preview separately before the oversized final;
  // generic partial streaming can finish before Matrix creates any draft.
  return `${sutUserId} Final-only marker streaming QA check: reply exactly \`${finalText}\`.`;
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
      event.replacesEventId === preview.event.eventId &&
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
      `final replacement target: ${finalized.event.replacesEventId ?? "<none>"}`,
      ...buildMatrixReplyDetails("final reply", finalReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
