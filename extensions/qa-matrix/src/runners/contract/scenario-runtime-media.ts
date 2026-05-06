import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { MATRIX_QA_MEDIA_ROOM_KEY, resolveMatrixQaScenarioRoomId } from "./scenario-catalog.js";
import {
  buildMatrixQaImageGenerationPrompt,
  buildMatrixQaImageUnderstandingPrompt,
  createMatrixQaSplitColorImagePng,
  hasMatrixQaExpectedColorReply,
  MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
  MATRIX_QA_MEDIA_TYPE_COVERAGE_CASES,
} from "./scenario-media-fixtures.js";
import {
  advanceMatrixQaActorCursor,
  assertNoSutReplyWindow,
  buildMatrixQaToken,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  isMatrixQaExactMarkerReply,
  isMatrixQaMessageLikeKind,
  primeMatrixQaActorCursor,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

function requireMatrixQaImageAttachment(event: MatrixQaObservedEvent, scenarioLabel: string) {
  if (event.msgtype !== "m.image" || event.attachment?.kind !== "image") {
    throw new Error(
      `${scenarioLabel} expected an m.image attachment but saw ${event.msgtype ?? "<none>"}`,
    );
  }
  return event.attachment;
}

function buildMatrixQaAttachmentDetailLines(params: {
  attachmentEvent: MatrixQaObservedEvent;
  label: string;
}) {
  return [
    `${params.label} event: ${params.attachmentEvent.eventId}`,
    `${params.label} msgtype: ${params.attachmentEvent.msgtype ?? "<none>"}`,
    `${params.label} attachment kind: ${params.attachmentEvent.attachment?.kind ?? "<none>"}`,
    `${params.label} attachment filename: ${params.attachmentEvent.attachment?.filename ?? "<none>"}`,
    `${params.label} body preview: ${params.attachmentEvent.body?.slice(0, 200) ?? "<none>"}`,
  ];
}

async function primeMatrixQaDriverMediaClient(context: MatrixQaScenarioContext) {
  return await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
  });
}

function buildMatrixQaMediaTypeCoveragePrompt(params: {
  label: string;
  sutUserId: string;
  token: string;
}) {
  return `${params.sutUserId} Matrix media type coverage (${params.label}): ignore the attachment content and reply with only this exact marker: ${params.token}`;
}

export async function runImageUnderstandingAttachmentScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEDIA_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverMediaClient(context);
  const triggerBody = buildMatrixQaImageUnderstandingPrompt(context.sutUserId);
  const driverEventId = await client.sendMediaMessage({
    body: triggerBody,
    buffer: createMatrixQaSplitColorImagePng(),
    contentType: "image/png",
    fileName: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
    kind: "image",
    mentionUserIds: [context.sutUserId],
    roomId,
  });
  const attachmentEvent = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.eventId === driverEventId &&
      event.sender === context.driverUserId &&
      event.attachment?.kind === "image" &&
      event.attachment.caption === triggerBody,
    roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.sender === context.sutUserId &&
      event.type === "m.room.message" &&
      event.relatesTo === undefined &&
      isMatrixQaMessageLikeKind(event.kind) &&
      hasMatrixQaExpectedColorReply(event.body),
    roomId,
    since: attachmentEvent.since,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: matched.since,
    startSince,
  });
  const reply = buildMatrixReplyArtifact(matched.event);
  return {
    artifacts: {
      attachmentCaptionPreview: attachmentEvent.event.attachment?.caption?.slice(0, 200),
      attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
      driverEventId,
      reply,
      roomId,
      triggerBody,
    },
    details: [
      `room id: ${roomId}`,
      `driver attachment event: ${driverEventId}`,
      `sent attachment filename: ${MATRIX_QA_IMAGE_ATTACHMENT_FILENAME}`,
      `sent attachment caption: ${attachmentEvent.event.attachment?.caption ?? "<none>"}`,
      ...buildMatrixReplyDetails("reply", reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runMediaTypeCoverageScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEDIA_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverMediaClient(context);
  const attachments: NonNullable<MatrixQaScenarioExecution["artifacts"]>["attachments"] = [];
  const replies: NonNullable<MatrixQaScenarioExecution["artifacts"]>["replies"] = [];
  const details = [`room id: ${roomId}`];
  let since = startSince;

  for (const mediaCase of MATRIX_QA_MEDIA_TYPE_COVERAGE_CASES) {
    const token = buildMatrixQaToken(mediaCase.tokenPrefix);
    const triggerBody = buildMatrixQaMediaTypeCoveragePrompt({
      label: mediaCase.label,
      sutUserId: context.sutUserId,
      token,
    });
    const driverEventId = await client.sendMediaMessage({
      body: triggerBody,
      buffer: mediaCase.createBuffer(),
      contentType: mediaCase.contentType,
      fileName: mediaCase.fileName,
      kind: mediaCase.kind,
      mentionUserIds: [context.sutUserId],
      roomId,
    });
    const attachmentEvent = await client.waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        event.roomId === roomId &&
        event.eventId === driverEventId &&
        event.sender === context.driverUserId &&
        event.msgtype === mediaCase.expectedMsgtype &&
        event.attachment?.kind === mediaCase.expectedAttachmentKind &&
        event.attachment.filename === mediaCase.fileName &&
        event.attachment.caption === triggerBody,
      roomId,
      since,
      timeoutMs: context.timeoutMs,
    });
    const matched = await client.waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        isMatrixQaExactMarkerReply(event, {
          roomId,
          sutUserId: context.sutUserId,
          token,
        }) && event.relatesTo === undefined,
      roomId,
      since: attachmentEvent.since,
      timeoutMs: context.timeoutMs,
    });
    since = matched.since ?? since;
    const reply = buildMatrixReplyArtifact(matched.event, token);
    attachments.push({
      eventId: driverEventId,
      filename: mediaCase.fileName,
      kind: attachmentEvent.event.attachment?.kind,
      label: mediaCase.label,
      msgtype: attachmentEvent.event.msgtype,
    });
    replies.push({
      eventId: reply.eventId,
      label: mediaCase.label,
      token,
      tokenMatched: reply.tokenMatched,
    });
    details.push(
      `${mediaCase.label} event: ${driverEventId}`,
      `${mediaCase.label} msgtype: ${attachmentEvent.event.msgtype ?? "<none>"}`,
      `${mediaCase.label} attachment kind: ${attachmentEvent.event.attachment?.kind ?? "<none>"}`,
      `${mediaCase.label} attachment filename: ${attachmentEvent.event.attachment?.filename ?? "<none>"}`,
      ...buildMatrixReplyDetails(`${mediaCase.label} reply`, reply),
    );
  }

  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: since,
    startSince,
  });
  return {
    artifacts: {
      attachments,
      replies,
      roomId,
    },
    details: details.join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runAttachmentOnlyIgnoredScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEDIA_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverMediaClient(context);
  const driverEventId = await client.sendMediaMessage({
    buffer: createMatrixQaSplitColorImagePng(),
    contentType: "image/png",
    fileName: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
    kind: "image",
    roomId,
  });
  const attachmentEvent = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.eventId === driverEventId &&
      event.sender === context.driverUserId &&
      event.attachment?.kind === "image" &&
      event.attachment.caption === undefined,
    roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const { noReplyWindowMs } = await assertNoSutReplyWindow({
    actorId: "driver",
    client,
    context,
    roomId,
    since: attachmentEvent.since,
    startSince,
    unexpectedMessage: "unexpected SUT reply to attachment-only group media",
  });
  return {
    artifacts: {
      attachmentFilename: MATRIX_QA_IMAGE_ATTACHMENT_FILENAME,
      driverEventId,
      expectedNoReplyWindowMs: noReplyWindowMs,
      roomId,
    },
    details: [
      `room id: ${roomId}`,
      `driver attachment event: ${driverEventId}`,
      `waited ${noReplyWindowMs}ms with no SUT reply`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runUnsupportedMediaSafeScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEDIA_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverMediaClient(context);
  const token = buildMatrixQaToken("MATRIX_QA_UNSUPPORTED_MEDIA");
  const triggerBody = `${context.sutUserId} Unsupported media QA check: ignore the attached text file and reply with only this exact marker: ${token}`;
  const driverEventId = await client.sendMediaMessage({
    body: triggerBody,
    buffer: Buffer.from("unsupported Matrix QA attachment body\n", "utf8"),
    contentType: "text/plain",
    fileName: "unsupported-matrix-qa.txt",
    kind: "file",
    mentionUserIds: [context.sutUserId],
    roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId,
        sutUserId: context.sutUserId,
        token,
      }) && event.relatesTo === undefined,
    roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: matched.since,
    startSince,
  });
  const reply = buildMatrixReplyArtifact(matched.event, token);
  return {
    artifacts: {
      attachmentFilename: "unsupported-matrix-qa.txt",
      attachmentKind: "file",
      driverEventId,
      reply,
      roomId,
      token,
      triggerBody,
    },
    details: [
      `room id: ${roomId}`,
      `driver file event: ${driverEventId}`,
      ...buildMatrixReplyDetails("reply", reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runGeneratedImageDeliveryScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEDIA_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverMediaClient(context);
  const triggerBody = buildMatrixQaImageGenerationPrompt(context.sutUserId);
  const driverEventIds: string[] = [];
  const isGeneratedImageEvent = (event: MatrixQaObservedEvent) =>
    event.roomId === roomId &&
    event.sender === context.sutUserId &&
    event.type === "m.room.message" &&
    event.relatesTo === undefined &&
    event.msgtype === "m.image" &&
    event.attachment?.kind === "image";
  let matched = await client.waitForOptionalRoomEvent({
    observedEvents: context.observedEvents,
    predicate: isGeneratedImageEvent,
    roomId,
    since: startSince,
    timeoutMs: 0,
  });
  for (let attempt = 1; !matched.matched && attempt <= 2; attempt += 1) {
    const driverEventId = await client.sendTextMessage({
      body: triggerBody,
      mentionUserIds: [context.sutUserId],
      roomId,
    });
    driverEventIds.push(driverEventId);
    matched = await client.waitForOptionalRoomEvent({
      observedEvents: context.observedEvents,
      predicate: isGeneratedImageEvent,
      roomId,
      since: matched.since ?? startSince,
      timeoutMs: context.timeoutMs,
    });
  }
  if (!matched.matched) {
    throw new Error(
      `timed out after ${context.timeoutMs}ms waiting for Matrix generated image after ${driverEventIds.length} attempt(s)`,
    );
  }
  const matchedEvent = matched.event;
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: matched.since,
    startSince,
  });
  const attachment = requireMatrixQaImageAttachment(
    matchedEvent,
    "Matrix generated image delivery scenario",
  );
  return {
    artifacts: {
      attachmentBodyPreview: matchedEvent.body?.slice(0, 200),
      attachmentEventId: matchedEvent.eventId,
      attachmentFilename: attachment.filename,
      attachmentKind: attachment.kind,
      attachmentMsgtype: matchedEvent.msgtype,
      driverEventId: driverEventIds[0],
      driverEventIds,
      roomId,
      triggerBody,
    },
    details: [
      `room id: ${roomId}`,
      `driver events: ${driverEventIds.join(", ")}`,
      ...buildMatrixQaAttachmentDetailLines({
        attachmentEvent: matchedEvent,
        label: "generated image",
      }),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
