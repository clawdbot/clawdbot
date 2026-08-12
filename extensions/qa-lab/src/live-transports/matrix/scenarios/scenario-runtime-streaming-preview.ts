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

const MATRIX_QA_FINAL_SEND_FAULT_RULE_ID = "matrix-qa-final-send-unavailable";

/**
 * A streamed draft is the only visible copy of the reply until its replacement lands, so a
 * failed final send must leave it standing. The mention-bearing final answer is what forces
 * the normal-delivery path that supersedes the draft.
 */
export async function runDraftRetainedOnFailedFinalDeliveryScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.installFaultRule) {
    throw new Error("Matrix draft retention QA scenario requires in-place fault injection");
  }
  const token = `MATRIX_QA_DRAFT_RETAIN_${randomUUID().slice(0, 8).toUpperCase()}`;
  const finalText = [
    `${token} preview complete.`,
    `${token} paging ${context.driverUserId} for the deploy review.`,
  ].join(" ");
  const triggerBody = buildMatrixPartialStreamingPrompt(context.sutUserId, finalText);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
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
      isMatrixQaMessageLikeKind(event.kind),
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  // Arm the fault only once the draft is on screen, so every subsequent room send by the
  // gateway fails. Matching the payload instead would depend on how the final answer happens
  // to render, which makes "no fault fired" indistinguishable from "delivery succeeded".
  const faultRule = context.installFaultRule({
    id: MATRIX_QA_FINAL_SEND_FAULT_RULE_ID,
    match: (request) =>
      request.method === "PUT" &&
      request.path.includes("/send/m.room.message") &&
      request.bearerToken === context.sutAccessToken,
    response: () => ({
      body: { errcode: "M_UNKNOWN", error: "QA injected final-delivery failure" },
      status: 500,
    }),
  });
  try {
    const redaction = await client.waitForOptionalRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        event.roomId === context.roomId &&
        event.kind === "redaction" &&
        event.redactsEventId === preview.event.eventId,
      roomId: context.roomId,
      since: preview.since,
      // The gateway retries the faulted send before settling, so the window must outlast
      // that backoff; a short window would read a late redaction as "draft retained".
      timeoutMs: context.timeoutMs,
    });
    const faultHits = faultRule
      .hits()
      .filter((hit) => hit.ruleId === MATRIX_QA_FINAL_SEND_FAULT_RULE_ID);
    const replacement = context.observedEvents.find(
      (event) =>
        event.roomId === context.roomId &&
        event.sender === context.sutUserId &&
        isMatrixQaMessageLikeKind(event.kind) &&
        event.eventId !== preview.event.eventId,
    );
    if (redaction.matched) {
      // Losing the draft only counts as the defect when nothing replaced it. A replacement
      // here means a send beat the fault installation, which is a harness race, not a bug.
      if (replacement) {
        throw new Error(
          [
            "Matrix QA scenario could not arm the fault before the replacement landed; rerun.",
            `draft event: ${preview.event.eventId}`,
            `replacement event: ${replacement.eventId}`,
            `post-draft send fault hits: ${faultHits.length}`,
          ].join("\n"),
        );
      }
      throw new Error(
        [
          "Matrix redacted the streamed draft even though no replacement delivery could succeed.",
          `draft event: ${preview.event.eventId}`,
          `redaction event: ${redaction.event.eventId}`,
          `draft body: ${preview.event.body ?? "<none>"}`,
          `post-draft send fault hits: ${faultHits.length}`,
        ].join("\n"),
      );
    }
    if (faultHits.length === 0) {
      const sutEvents = context.observedEvents
        .filter((event) => event.roomId === context.roomId && event.sender === context.sutUserId)
        .map(
          (event) =>
            `  ${event.kind} ${event.eventId}${event.replacesEventId ? ` replaces=${event.replacesEventId}` : ""}${event.redactsEventId ? ` redacts=${event.redactsEventId}` : ""} body=${truncateMatrixQaPreview(event.body) ?? "<none>"}`,
        );
      throw new Error(
        [
          "Matrix QA fault rule never intercepted a post-draft send; the scenario did not exercise the failure path.",
          `draft event: ${preview.event.eventId}`,
          `draft body: ${preview.event.body ?? "<none>"}`,
          `final text sent to model: ${finalText}`,
          "observed SUT events:",
          ...sutEvents,
        ].join("\n"),
      );
    }
    advanceMatrixQaActorCursor({
      actorId: "driver",
      syncState: context.syncState,
      nextSince: redaction.since,
      startSince,
    });
    return {
      artifacts: {
        driverEventId,
        faultedEndpoint: "PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message",
        faultHitCount: faultHits.length,
        faultRuleId: MATRIX_QA_FINAL_SEND_FAULT_RULE_ID,
        previewBodyPreview: truncateMatrixQaPreview(preview.event.body),
        previewEventId: preview.event.eventId,
        token,
        triggerBody,
      },
      details: [
        `driver event: ${driverEventId}`,
        "scenario: draft retained when the final send fails",
        `injected fault: HTTP 500 on every gateway room send after the draft (${faultHits.length} hit${faultHits.length === 1 ? "" : "s"})`,
        `draft event: ${preview.event.eventId}`,
        `draft kind: ${preview.event.kind}`,
        `draft body: ${preview.event.body ?? "<none>"}`,
        "draft redacted after failed final delivery: no",
        "observed SUT events:",
        ...context.observedEvents
          .filter((event) => event.roomId === context.roomId && event.sender === context.sutUserId)
          .map(
            (event) =>
              `  ${event.kind} ${event.eventId}${event.replacesEventId ? ` replaces=${event.replacesEventId}` : ""}${event.redactsEventId ? ` redacts=${event.redactsEventId}` : ""} body=${truncateMatrixQaPreview(event.body) ?? "<none>"}`,
          ),
      ].join("\n"),
    } satisfies MatrixQaScenarioExecution;
  } finally {
    faultRule.remove();
  }
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
