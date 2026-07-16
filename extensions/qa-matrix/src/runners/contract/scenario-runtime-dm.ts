import { randomUUID } from "node:crypto";
import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-catalog.js";
import {
  assertThreadReplyArtifact,
  assertTopLevelReplyArtifact,
  buildExactMarkerPrompt,
  buildMatrixNoticeArtifact,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  createMatrixQaScenarioClient,
  NO_REPLY_WINDOW_MS,
  advanceMatrixQaActorCursor,
  runConfigurableTopLevelScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

async function runDmSharedSessionFlow(params: {
  context: MatrixQaScenarioContext;
  expectNotice: boolean;
}) {
  const firstRoomId = resolveMatrixQaScenarioRoomId(params.context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const secondRoomId = resolveMatrixQaScenarioRoomId(
    params.context,
    MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  );

  const firstResult = await runConfigurableTopLevelScenario({
    accessToken: params.context.driverAccessToken,
    actorId: "driver",
    baseUrl: params.context.baseUrl,
    observedEvents: params.context.observedEvents,
    roomId: firstRoomId,
    syncState: params.context.syncState,
    sutUserId: params.context.sutUserId,
    timeoutMs: params.context.timeoutMs,
    tokenPrefix: "MATRIX_QA_DM_PRIMARY",
    withMention: false,
  });
  assertTopLevelReplyArtifact("primary DM reply", firstResult.reply);

  const replyClient = createMatrixQaScenarioClient({
    accessToken: params.context.driverAccessToken,
    baseUrl: params.context.baseUrl,
  });
  const noticeClient = createMatrixQaScenarioClient({
    accessToken: params.context.driverAccessToken,
    baseUrl: params.context.baseUrl,
  });
  const [replySince, noticeSince] = await Promise.all([
    replyClient.primeRoom(),
    noticeClient.primeRoom(),
  ]);
  if (!replySince || !noticeSince) {
    throw new Error("Matrix DM session scenario could not prime room cursors");
  }

  const secondToken = `MATRIX_QA_DM_SECONDARY_${randomUUID().slice(0, 8).toUpperCase()}`;
  const secondBody = buildExactMarkerPrompt(secondToken);
  const secondDriverEventId = await replyClient.sendTextMessage({
    body: secondBody,
    roomId: secondRoomId,
  });

  const [replyResult, noticeResult] = await Promise.all([
    replyClient.waitForRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: (event) =>
        event.roomId === secondRoomId &&
        event.sender === params.context.sutUserId &&
        event.type === "m.room.message" &&
        event.kind === "message" &&
        (event.body ?? "").includes(secondToken),
      roomId: secondRoomId,
      since: replySince,
      timeoutMs: params.context.timeoutMs,
    }),
    noticeClient.waitForOptionalRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: (event) =>
        event.roomId === secondRoomId &&
        event.sender === params.context.sutUserId &&
        event.kind === "notice" &&
        typeof event.body === "string" &&
        event.body.includes("channels.matrix.dm.sessionScope"),
      roomId: secondRoomId,
      since: noticeSince,
      timeoutMs: Math.min(NO_REPLY_WINDOW_MS, params.context.timeoutMs),
    }),
  ]);

  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: params.context.syncState,
    nextSince: replyResult.since,
    startSince: replySince,
  });

  const secondReply = buildMatrixReplyArtifact(replyResult.event, secondToken);
  assertTopLevelReplyArtifact("secondary DM reply", secondReply);
  const noticeArtifact = noticeResult.matched
    ? buildMatrixNoticeArtifact(noticeResult.event)
    : undefined;

  if (params.expectNotice && !noticeArtifact) {
    throw new Error(
      "Matrix shared DM session scenario did not emit the expected cross-room notice",
    );
  }
  if (!params.expectNotice && noticeArtifact) {
    throw new Error(
      "Matrix per-room DM session scenario unexpectedly emitted a shared-session notice",
    );
  }

  return {
    firstRoomId,
    noticeArtifact,
    secondBody,
    secondDriverEventId,
    secondReply,
    secondRoomId,
    secondToken,
  };
}

export async function runDmThreadReplyOverrideScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  const result = await runConfigurableTopLevelScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    replyPredicate: (event, params) =>
      event.relatesTo?.relType === "m.thread" && event.relatesTo?.eventId === params.driverEventId,
    roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_DM_THREAD",
    withMention: false,
  });
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.driverEventId,
    label: "DM thread override reply",
  });
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      roomKey: MATRIX_QA_DRIVER_DM_ROOM_KEY,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `room key: ${MATRIX_QA_DRIVER_DM_ROOM_KEY}`,
      `room id: ${roomId}`,
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runDmSharedSessionNoticeScenario(context: MatrixQaScenarioContext) {
  const result = await runDmSharedSessionFlow({
    context,
    expectNotice: true,
  });
  return {
    artifacts: {
      driverEventId: result.secondDriverEventId,
      noticeBodyPreview: result.noticeArtifact?.bodyPreview,
      noticeEventId: result.noticeArtifact?.eventId,
      reply: result.secondReply,
      roomKey: MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
      token: result.secondToken,
      triggerBody: result.secondBody,
    },
    details: [
      `primary room id: ${result.firstRoomId}`,
      `secondary room id: ${result.secondRoomId}`,
      `secondary driver event: ${result.secondDriverEventId}`,
      `notice event: ${result.noticeArtifact?.eventId ?? "<none>"}`,
      `notice preview: ${result.noticeArtifact?.bodyPreview ?? "<none>"}`,
      ...buildMatrixReplyDetails("secondary reply", result.secondReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runDmPerRoomSessionOverrideScenario(context: MatrixQaScenarioContext) {
  const result = await runDmSharedSessionFlow({
    context,
    expectNotice: false,
  });
  return {
    artifacts: {
      driverEventId: result.secondDriverEventId,
      reply: result.secondReply,
      roomKey: MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
      token: result.secondToken,
      triggerBody: result.secondBody,
    },
    details: [
      `primary room id: ${result.firstRoomId}`,
      `secondary room id: ${result.secondRoomId}`,
      `secondary driver event: ${result.secondDriverEventId}`,
      "shared-session notice: suppressed",
      ...buildMatrixReplyDetails("secondary reply", result.secondReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
