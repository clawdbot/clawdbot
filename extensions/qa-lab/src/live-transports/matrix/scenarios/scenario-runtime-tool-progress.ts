// QA Lab Matrix plugin module implements tool-progress scenarios.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  advanceMatrixQaActorCursor,
  buildMatrixQaToken,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMatrixToolProgressCommandPrompt,
  buildMatrixToolProgressErrorPrompt,
  buildMatrixToolProgressMentionSafetyPrompt,
  buildMatrixToolProgressPrompt,
  buildMatrixToolProgressTaskContent,
  doesMatrixQaReplyBodyMatchToken,
  isMatrixQaMessageLikeKind,
  MATRIX_QA_TOOL_PROGRESS_TASK_FILENAME,
  primeMatrixQaDriverScenarioClient,
  truncateMatrixQaPreview,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import {
  assertMatrixQaToolProgressMentionsInert,
  buildMatrixQaToolProgressFinalTimeoutMessage,
  buildMatrixQaToolProgressTimeoutMessage,
  findMatrixQaUnexpectedWorkingEvents,
  hasMatrixQaToolProgressPreviewLine,
} from "./scenario-runtime-tool-progress-diagnostics.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

async function runMatrixToolProgressScenario(
  context: MatrixQaScenarioContext,
  params: {
    expectedPreviewKind: MatrixQaObservedEvent["kind"];
    finalText: string;
    allowFinalOnly?: boolean;
    allowFinalBeforeProgress?: boolean;
    allowFinalReplacementAsCompletion?: boolean;
    allowTopLevelFinalWithProgress?: boolean;
    label: string;
    allowGenericProgressLine?: boolean;
    mentionSafety?: boolean;
    progressPattern: RegExp;
    rejectProgressBodyPattern?: RegExp;
    rejectProgressBodyMessage?: string;
    triggerBodyBuilder: (sutUserId: string, finalText: string) => string;
  },
) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const startObservedIndex = context.observedEvents.length;
  await writeMatrixToolProgressTaskFile(context, params.finalText);
  const triggerBody = params.triggerBodyBuilder(context.sutUserId, params.finalText);
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const matchesExpectedProgress = (body: string | undefined) =>
    params.progressPattern.test(body ?? "") ||
    (params.allowGenericProgressLine === true && hasMatrixQaToolProgressPreviewLine(body));
  const getPreviewRootEventId = (event: MatrixQaObservedEvent) =>
    event.relatesTo?.relType === "m.replace" && event.relatesTo.eventId
      ? event.relatesTo.eventId
      : event.eventId;
  const isFinalReply = (event: MatrixQaObservedEvent) =>
    event.roomId === context.roomId &&
    event.sender === context.sutUserId &&
    event.type === "m.room.message" &&
    event.relatesTo === undefined &&
    isMatrixQaMessageLikeKind(event.kind) &&
    doesMatrixQaReplyBodyMatchToken(event, params.finalText);
  const isExpectedProgressKind = (event: MatrixQaObservedEvent) =>
    event.kind === params.expectedPreviewKind ||
    (params.allowTopLevelFinalWithProgress === true &&
      isMatrixQaMessageLikeKind(event.kind) &&
      matchesExpectedProgress(event.body));
  const isProgressEvent = (event: MatrixQaObservedEvent) =>
    event.roomId === context.roomId &&
    event.sender === context.sutUserId &&
    isExpectedProgressKind(event) &&
    (matchesExpectedProgress(event.body) || event.relatesTo === undefined);
  const isProgressProofEvent = (event: MatrixQaObservedEvent) =>
    event.roomId === context.roomId &&
    event.sender === context.sutUserId &&
    isExpectedProgressKind(event) &&
    matchesExpectedProgress(event.body);
  const isProgressReplacement = (event: MatrixQaObservedEvent, previewRootEventId: string) =>
    event.roomId === context.roomId &&
    event.sender === context.sutUserId &&
    event.kind === params.expectedPreviewKind &&
    event.relatesTo?.relType === "m.replace" &&
    event.relatesTo.eventId === previewRootEventId &&
    matchesExpectedProgress(event.body);
  const isFinalReplacement = (event: MatrixQaObservedEvent, previewRootEventId: string) =>
    event.roomId === context.roomId &&
    event.sender === context.sutUserId &&
    isMatrixQaMessageLikeKind(event.kind) &&
    event.relatesTo?.relType === "m.replace" &&
    event.relatesTo.eventId === previewRootEventId &&
    doesMatrixQaReplyBodyMatchToken(event, params.finalText);
  const throwProgressTimeout = (err: unknown, previewEventId: string): never => {
    throw new Error(
      buildMatrixQaToolProgressTimeoutMessage({
        cause: err,
        events: context.observedEvents,
        expectedPreviewKind: params.expectedPreviewKind,
        previewEventId,
        roomId: context.roomId,
        startIndex: startObservedIndex,
        sutUserId: context.sutUserId,
      }),
    );
  };
  const preview = await client
    .waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        isProgressEvent(event) ||
        ((params.allowFinalOnly === true ||
          params.allowFinalBeforeProgress === true ||
          params.allowTopLevelFinalWithProgress === true) &&
          isFinalReply(event)),
      roomId: context.roomId,
      since: startSince,
      timeoutMs: context.timeoutMs,
    })
    .catch((err: unknown) => throwProgressTimeout(err, "<not observed>"));
  if (isFinalReply(preview.event)) {
    if (
      (params.allowFinalBeforeProgress === true ||
        params.allowTopLevelFinalWithProgress === true) &&
      params.allowFinalOnly !== true
    ) {
      const progressAfterFinal = await client
        .waitForRoomEvent({
          observedEvents: context.observedEvents,
          predicate: isProgressProofEvent,
          roomId: context.roomId,
          since: preview.since,
          timeoutMs: context.timeoutMs,
        })
        .catch((err: unknown) => throwProgressTimeout(err, "<not observed>"));
      const progressPreviewEventId = getPreviewRootEventId(progressAfterFinal.event);
      const unexpectedWorkingEvents = findMatrixQaUnexpectedWorkingEvents({
        events: context.observedEvents,
        finalEventId: preview.event.eventId,
        previewEventId: progressPreviewEventId,
        startIndex: startObservedIndex,
        sutUserId: context.sutUserId,
      });
      if (unexpectedWorkingEvents.length > 0) {
        throw new Error(
          `Matrix tool progress leaked outside preview event: ${unexpectedWorkingEvents.map((event) => `${event.eventId}:${event.body ?? ""}`).join("; ")}`,
        );
      }
      if (params.mentionSafety) {
        assertMatrixQaToolProgressMentionsInert(progressAfterFinal.event);
      }
      advanceMatrixQaActorCursor({
        actorId: "driver",
        syncState: context.syncState,
        nextSince: progressAfterFinal.since,
        startSince,
      });
      const finalReply = buildMatrixReplyArtifact(preview.event, params.finalText);
      return {
        artifacts: {
          driverEventId,
          previewBodyPreview: truncateMatrixQaPreview(progressAfterFinal.event.body),
          previewEventId: progressPreviewEventId,
          previewFormattedBodyPreview: truncateMatrixQaPreview(
            progressAfterFinal.event.formattedBody,
          ),
          previewMentions: progressAfterFinal.event.mentions,
          reply: finalReply,
          token: params.finalText,
          triggerBody,
        },
        details: [
          `driver event: ${driverEventId}`,
          `scenario: ${params.label}`,
          `preview event: ${progressPreviewEventId}`,
          `preview kind: ${progressAfterFinal.event.kind}`,
          `preview body: ${progressAfterFinal.event.body ?? "<none>"}`,
          "final reply relation: <none>; final delivered before observable tool-progress failure",
          ...buildMatrixReplyDetails("final reply", finalReply),
        ].join("\n"),
      } satisfies MatrixQaScenarioExecution;
    }

    if (params.allowFinalOnly === true) {
      const unexpectedWorkingEvents = findMatrixQaUnexpectedWorkingEvents({
        events: context.observedEvents,
        finalEventId: preview.event.eventId,
        startIndex: startObservedIndex,
        sutUserId: context.sutUserId,
      });
      if (unexpectedWorkingEvents.length > 0) {
        throw new Error(
          `Matrix tool progress leaked outside preview event: ${unexpectedWorkingEvents.map((event) => `${event.eventId}:${event.body ?? ""}`).join("; ")}`,
        );
      }
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
          "preview event: <none>; final delivered before observable tool-progress preview",
          ...buildMatrixReplyDetails("final reply", finalReply),
        ].join("\n"),
      } satisfies MatrixQaScenarioExecution;
    }
  }
  const previewRootEventId = getPreviewRootEventId(preview.event);
  const isProgressProofForPreview = (event: MatrixQaObservedEvent) =>
    isProgressReplacement(event, previewRootEventId) ||
    (params.allowTopLevelFinalWithProgress === true && isProgressProofEvent(event));
  let topLevelFinalBeforeProgress: typeof preview | undefined;
  let finalReplacementBeforeProgress: typeof preview | undefined;
  let progress = preview;
  if (!matchesExpectedProgress(preview.event.body)) {
    const progressOrFinal = await client
      .waitForRoomEvent({
        observedEvents: context.observedEvents,
        predicate: (event) =>
          isProgressProofForPreview(event) ||
          (params.allowFinalReplacementAsCompletion === true &&
            isFinalReplacement(event, previewRootEventId)) ||
          (params.allowTopLevelFinalWithProgress === true && isFinalReply(event)),
        roomId: context.roomId,
        since: preview.since,
        timeoutMs: context.timeoutMs,
      })
      .catch((err: unknown) => throwProgressTimeout(err, previewRootEventId));
    if (
      params.allowFinalReplacementAsCompletion === true &&
      isFinalReplacement(progressOrFinal.event, previewRootEventId)
    ) {
      finalReplacementBeforeProgress = progressOrFinal;
      progress = progressOrFinal;
    } else if (isFinalReply(progressOrFinal.event)) {
      topLevelFinalBeforeProgress = progressOrFinal;
      progress = await client
        .waitForRoomEvent({
          observedEvents: context.observedEvents,
          predicate: isProgressProofForPreview,
          roomId: context.roomId,
          since: progressOrFinal.since,
          timeoutMs: context.timeoutMs,
        })
        .catch((err: unknown) => throwProgressTimeout(err, previewRootEventId));
    } else {
      progress = progressOrFinal;
    }
  }

  if (params.mentionSafety) {
    assertMatrixQaToolProgressMentionsInert(progress.event);
  }
  if (
    params.rejectProgressBodyPattern &&
    params.rejectProgressBodyPattern.test(progress.event.body ?? "")
  ) {
    throw new Error(
      `${params.rejectProgressBodyMessage ?? "Matrix tool progress preview body matched a rejected pattern"}: ${progress.event.body ?? "<none>"}`,
    );
  }

  const finalized =
    topLevelFinalBeforeProgress ??
    finalReplacementBeforeProgress ??
    (await client
      .waitForRoomEvent({
        observedEvents: context.observedEvents,
        predicate: (event) =>
          event.roomId === context.roomId &&
          event.sender === context.sutUserId &&
          isMatrixQaMessageLikeKind(event.kind) &&
          doesMatrixQaReplyBodyMatchToken(event, params.finalText) &&
          ((event.relatesTo?.relType === "m.replace" &&
            event.relatesTo.eventId === previewRootEventId) ||
            (params.allowTopLevelFinalWithProgress === true && event.relatesTo === undefined)),
        roomId: context.roomId,
        since: progress.since,
        timeoutMs: context.timeoutMs,
      })
      .catch((err: unknown) => {
        throw new Error(
          buildMatrixQaToolProgressFinalTimeoutMessage({
            cause: err,
            events: context.observedEvents,
            previewEventId: previewRootEventId,
            roomId: context.roomId,
            startIndex: startObservedIndex,
            sutUserId: context.sutUserId,
            token: params.finalText,
          }),
        );
      }));
  const unexpectedWorkingEvents = findMatrixQaUnexpectedWorkingEvents({
    events: context.observedEvents,
    finalEventId: finalized.event.eventId,
    previewEventId: previewRootEventId,
    startIndex: startObservedIndex,
    sutUserId: context.sutUserId,
  });
  if (unexpectedWorkingEvents.length > 0) {
    throw new Error(
      `Matrix tool progress leaked outside preview event: ${unexpectedWorkingEvents.map((event) => `${event.eventId}:${event.body ?? ""}`).join("; ")}`,
    );
  }
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: topLevelFinalBeforeProgress ? progress.since : finalized.since,
    startSince,
  });
  const finalReply = buildMatrixReplyArtifact(finalized.event, params.finalText);
  return {
    artifacts: {
      driverEventId,
      previewBodyPreview: truncateMatrixQaPreview(progress.event.body),
      previewEventId: previewRootEventId,
      previewFormattedBodyPreview: truncateMatrixQaPreview(progress.event.formattedBody),
      previewMentions: progress.event.mentions,
      reply: finalReply,
      token: params.finalText,
      triggerBody,
    },
    details: [
      `driver event: ${driverEventId}`,
      `scenario: ${params.label}`,
      `preview event: ${preview.event.eventId}`,
      `preview kind: ${progress.event.kind}`,
      `preview body: ${progress.event.body ?? "<none>"}`,
      `preview mentions: ${JSON.stringify(progress.event.mentions ?? {})}`,
      `final reply relation: ${finalized.event.relatesTo?.relType ?? "<none>"}`,
      `final reply target: ${finalized.event.relatesTo?.eventId ?? "<none>"}`,
      ...buildMatrixReplyDetails("final reply", finalReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function writeMatrixToolProgressTaskFile(
  context: MatrixQaScenarioContext,
  finalText: string,
) {
  if (!context.gatewayWorkspaceDir) {
    return;
  }
  await writeFile(
    path.join(context.gatewayWorkspaceDir, MATRIX_QA_TOOL_PROGRESS_TASK_FILENAME),
    `${buildMatrixToolProgressTaskContent(finalText)}\n`,
    "utf8",
  );
}

export async function runToolProgressPreviewScenario(context: MatrixQaScenarioContext) {
  return runMatrixToolProgressScenario(context, {
    expectedPreviewKind: "notice",
    finalText: buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS"),
    label: "tool progress preview",
    allowFinalOnly: true,
    allowGenericProgressLine: true,
    progressPattern: /\b(?:tool:\s*)?read\s*:\s*from\b|\btool:\s*read\b/i,
    triggerBodyBuilder: buildMatrixToolProgressPrompt,
  });
}

export async function runToolProgressCommandPreviewScenario(context: MatrixQaScenarioContext) {
  return runMatrixToolProgressScenario(context, {
    expectedPreviewKind: "notice",
    finalText: buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS_COMMAND"),
    label: "tool progress command preview",
    allowFinalReplacementAsCompletion: true,
    progressPattern: /\bcompleted\b|\bexit\s+0\b/i,
    rejectProgressBodyPattern:
      /`(?![^`]*\bcompleted\b)[^`]*(?:matrix-command-progress-start|print text\s*→\s*run sleep 2)[^`]*`/i,
    rejectProgressBodyMessage: "Matrix command progress kept stale command text after completion",
    triggerBodyBuilder: buildMatrixToolProgressCommandPrompt,
  });
}

export async function runToolProgressErrorScenario(context: MatrixQaScenarioContext) {
  return runMatrixToolProgressScenario(context, {
    expectedPreviewKind: "notice",
    finalText: buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS_ERROR"),
    label: "tool progress error",
    allowGenericProgressLine: true,
    allowTopLevelFinalWithProgress: true,
    progressPattern:
      /\b(?:read|show)\s*:?\s*(?:from\s+)?\S*missing-matrix-tool-progress-target\.txt\b/i,
    triggerBodyBuilder: buildMatrixToolProgressErrorPrompt,
  });
}

export async function runToolProgressMentionSafetyScenario(context: MatrixQaScenarioContext) {
  return runMatrixToolProgressScenario(context, {
    expectedPreviewKind: "message",
    finalText: buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS_MENTION_SAFE"),
    label: "tool progress mention safety",
    allowFinalBeforeProgress: true,
    mentionSafety: true,
    progressPattern: /@room|@alice:matrix-qa\.test|!room:matrix-qa\.test/i,
    triggerBodyBuilder: buildMatrixToolProgressMentionSafetyPrompt,
  });
}

export async function runToolProgressPreviewOptOutScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const startObservedIndex = context.observedEvents.length;
  const finalText = buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS_OPTOUT");
  await writeMatrixToolProgressTaskFile(context, finalText);
  const triggerBody = buildMatrixToolProgressPrompt(context.sutUserId);
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const finalized = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.sender === context.sutUserId &&
      isMatrixQaMessageLikeKind(event.kind) &&
      event.body === finalText,
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const unexpectedPreviewProgressEvents = context.observedEvents
    .slice(startObservedIndex)
    .filter(
      (event) =>
        event.sender === context.sutUserId &&
        event.type === "m.room.message" &&
        event.eventId !== finalized.event.eventId &&
        /^Working\.\.\.\n-/i.test(event.body ?? ""),
    );
  if (unexpectedPreviewProgressEvents.length > 0) {
    throw new Error(
      `Matrix tool-progress opt-out still emitted preview progress: ${unexpectedPreviewProgressEvents.map((event) => `${event.eventId}:${event.body ?? ""}`).join("; ")}`,
    );
  }
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: finalized.since,
    startSince,
  });
  const finalReply = buildMatrixReplyArtifact(finalized.event, finalText);
  return {
    artifacts: {
      driverEventId,
      reply: finalReply,
      token: finalText,
      triggerBody,
    },
    details: [
      `driver event: ${driverEventId}`,
      "scenario: tool progress preview opt-out",
      "preview progress events: 0",
      ...buildMatrixReplyDetails("final reply", finalReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
