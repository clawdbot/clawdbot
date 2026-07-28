// QA Lab Matrix tool-progress diagnostics preserve actionable failure evidence.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import { isMatrixQaMessageLikeKind } from "./scenario-runtime-shared.js";

export function findMatrixQaUnexpectedWorkingEvents(params: {
  events: MatrixQaObservedEvent[];
  finalEventId?: string;
  previewEventId?: string;
  startIndex: number;
  sutUserId: string;
}) {
  return params.events.slice(params.startIndex).filter((event) => {
    if (event.sender !== params.sutUserId || event.type !== "m.room.message") {
      return false;
    }
    if (!/\bWorking\b/i.test(event.body ?? "")) {
      return false;
    }
    if (event.eventId === params.previewEventId || event.eventId === params.finalEventId) {
      return false;
    }
    return event.relatesTo?.eventId !== params.previewEventId;
  });
}

export function assertMatrixQaToolProgressMentionsInert(event: MatrixQaObservedEvent) {
  const mentions = event.mentions;
  if (mentions?.room || (mentions?.userIds?.length ?? 0) > 0) {
    throw new Error(
      `Matrix tool-progress preview emitted active mentions: ${JSON.stringify(mentions)}`,
    );
  }
  if (/matrix\.to/i.test(event.formattedBody ?? "")) {
    throw new Error(
      `Matrix tool-progress preview linked Matrix mentions: ${event.formattedBody ?? "<none>"}`,
    );
  }
  if (
    !/<code>[^<]*(?:@room|@alice:matrix-qa\.test|!room:matrix-qa\.test)/i.test(
      event.formattedBody ?? "",
    )
  ) {
    throw new Error(
      `Matrix tool-progress preview did not preserve mention-looking text inside code: ${event.formattedBody ?? "<none>"}`,
    );
  }
}

export function hasMatrixQaToolProgressPreviewLine(body: string | undefined) {
  return Boolean(
    body?.split(/\r?\n/).some((line) => /^\s*(?:[-*•]\s+`?[^`\s][^`]*`?|`[^`]+`)\s*$/u.test(line)),
  );
}

function truncateMatrixQaToolProgressBody(body: string | undefined) {
  if (!body) {
    return "<none>";
  }
  return body.length <= 240 ? body : `${truncateUtf16Safe(body, 237)}...`;
}

function describeMatrixQaToolProgressCandidate(event: MatrixQaObservedEvent) {
  const relation = event.relatesTo?.relType
    ? `${event.relatesTo.relType}:${event.relatesTo.eventId ?? "<none>"}`
    : "<none>";
  return [
    `${event.eventId} kind=${event.kind}`,
    `relation=${relation}`,
    `body=${JSON.stringify(truncateMatrixQaToolProgressBody(event.body))}`,
  ].join(" ");
}

export function buildMatrixQaToolProgressTimeoutMessage(params: {
  cause: unknown;
  events: MatrixQaObservedEvent[];
  expectedPreviewKind: MatrixQaObservedEvent["kind"];
  previewEventId: string;
  roomId: string;
  startIndex: number;
  sutUserId: string;
}) {
  const candidates = params.events
    .slice(params.startIndex)
    .filter((event) => {
      if (
        event.roomId !== params.roomId ||
        event.sender !== params.sutUserId ||
        event.type !== "m.room.message" ||
        event.kind !== params.expectedPreviewKind
      ) {
        return false;
      }
      return (
        event.eventId === params.previewEventId ||
        event.relatesTo?.eventId === params.previewEventId ||
        event.body !== undefined
      );
    })
    .slice(-8);
  const messageCandidates =
    candidates.length === 0
      ? params.events
          .slice(params.startIndex)
          .filter(
            (event) =>
              event.roomId === params.roomId &&
              event.sender === params.sutUserId &&
              event.type === "m.room.message" &&
              isMatrixQaMessageLikeKind(event.kind),
          )
          .slice(-8)
      : [];
  const candidateDetails =
    candidates.length === 0
      ? ["observed preview candidates: <none>"]
      : ["observed preview candidates:", ...candidates.map(describeMatrixQaToolProgressCandidate)];
  const messageCandidateDetails =
    messageCandidates.length === 0
      ? []
      : [
          "observed message candidates:",
          ...messageCandidates.map(describeMatrixQaToolProgressCandidate),
        ];
  return [
    params.cause instanceof Error
      ? params.cause.message
      : `Matrix tool progress wait failed: ${String(params.cause)}`,
    `preview event: ${params.previewEventId}`,
    ...candidateDetails,
    ...messageCandidateDetails,
  ].join("\n");
}

export function buildMatrixQaToolProgressFinalTimeoutMessage(params: {
  cause: unknown;
  events: MatrixQaObservedEvent[];
  previewEventId: string;
  roomId: string;
  startIndex: number;
  sutUserId: string;
  token: string;
}) {
  const candidates = params.events
    .slice(params.startIndex)
    .filter((event) => {
      if (
        event.roomId !== params.roomId ||
        event.sender !== params.sutUserId ||
        event.type !== "m.room.message" ||
        !isMatrixQaMessageLikeKind(event.kind)
      ) {
        return false;
      }
      return event.relatesTo?.eventId === params.previewEventId;
    })
    .slice(-8);
  const candidateDetails =
    candidates.length === 0
      ? ["observed final candidates: <none>"]
      : ["observed final candidates:", ...candidates.map(describeMatrixQaToolProgressCandidate)];
  return [
    params.cause instanceof Error
      ? params.cause.message
      : `Matrix tool progress final wait failed: ${String(params.cause)}`,
    `preview event: ${params.previewEventId}`,
    `expected token: ${params.token}`,
    ...candidateDetails,
  ].join("\n");
}
