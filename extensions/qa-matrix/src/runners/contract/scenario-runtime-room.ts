import { randomUUID } from "node:crypto";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import {
  MATRIX_QA_BLOCK_ROOM_KEY,
  MATRIX_QA_HOMESERVER_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_RESTART_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-catalog.js";
import {
  assertThreadReplyArtifact,
  assertTopLevelReplyArtifact,
  advanceMatrixQaActorCursor,
  buildMatrixBlockStreamingPrompt,
  buildMatrixQuietStreamingPrompt,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  createMatrixQaScenarioClient,
  isMatrixQaMessageLikeKind,
  NO_REPLY_WINDOW_MS,
  primeMatrixQaActorCursor,
  runConfigurableTopLevelScenario,
  runDriverTopLevelMentionScenario,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  runTopLevelMentionScenario,
  waitForMembershipEvent,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime-shared.js";
import type { MatrixQaCanaryArtifact, MatrixQaScenarioExecution } from "./scenario-types.js";

async function runThreadScenario(params: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.driverAccessToken,
    actorId: "driver",
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const rootBody = `thread root ${randomUUID().slice(0, 8)}`;
  const rootEventId = await client.sendTextMessage({
    body: rootBody,
    roomId: params.roomId,
  });
  const token = `MATRIX_QA_THREAD_${randomUUID().slice(0, 8).toUpperCase()}`;
  const driverEventId = await client.sendTextMessage({
    body: buildMentionPrompt(params.sutUserId, token),
    mentionUserIds: [params.sutUserId],
    replyToEventId: rootEventId,
    roomId: params.roomId,
    threadRootEventId: rootEventId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      event.type === "m.room.message" &&
      (event.body ?? "").includes(token) &&
      event.relatesTo?.relType === "m.thread" &&
      event.relatesTo.eventId === rootEventId,
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: params.syncState,
    nextSince: matched.since,
    startSince,
  });
  return {
    driverEventId,
    reply: buildMatrixReplyArtifact(matched.event, token),
    rootEventId,
    token,
  };
}

export async function runMatrixQaCanary(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
}): Promise<{
  driverEventId: string;
  reply: MatrixQaCanaryArtifact["reply"];
  token: string;
}> {
  const canary = await runDriverTopLevelMentionScenario({
    baseUrl: params.baseUrl,
    driverAccessToken: params.driverAccessToken,
    observedEvents: params.observedEvents,
    roomId: params.roomId,
    syncState: params.syncState,
    sutUserId: params.sutUserId,
    timeoutMs: params.timeoutMs,
    tokenPrefix: "MATRIX_QA_CANARY",
  });
  assertTopLevelReplyArtifact("canary reply", canary.reply);
  return canary;
}

export async function runThreadFollowUpScenario(context: MatrixQaScenarioContext) {
  const result = await runThreadScenario(context);
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.rootEventId,
    label: "thread reply",
  });
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      rootEventId: result.rootEventId,
      token: result.token,
    },
    details: [
      `root event: ${result.rootEventId}`,
      `driver thread event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runThreadIsolationScenario(context: MatrixQaScenarioContext) {
  const threadPhase = await runThreadScenario(context);
  assertThreadReplyArtifact(threadPhase.reply, {
    expectedRootEventId: threadPhase.rootEventId,
    label: "thread isolation reply",
  });
  const topLevelPhase = await runDriverTopLevelMentionScenario({
    baseUrl: context.baseUrl,
    driverAccessToken: context.driverAccessToken,
    observedEvents: context.observedEvents,
    roomId: context.roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_TOPLEVEL",
  });
  assertTopLevelReplyArtifact("top-level follow-up reply", topLevelPhase.reply);
  return {
    artifacts: {
      threadDriverEventId: threadPhase.driverEventId,
      threadReply: threadPhase.reply,
      threadRootEventId: threadPhase.rootEventId,
      threadToken: threadPhase.token,
      topLevelDriverEventId: topLevelPhase.driverEventId,
      topLevelReply: topLevelPhase.reply,
      topLevelToken: topLevelPhase.token,
    },
    details: [
      `thread root event: ${threadPhase.rootEventId}`,
      `thread driver event: ${threadPhase.driverEventId}`,
      ...buildMatrixReplyDetails("thread reply", threadPhase.reply),
      `top-level driver event: ${topLevelPhase.driverEventId}`,
      ...buildMatrixReplyDetails("top-level reply", topLevelPhase.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runTopLevelReplyShapeScenario(context: MatrixQaScenarioContext) {
  const result = await runDriverTopLevelMentionScenario({
    baseUrl: context.baseUrl,
    driverAccessToken: context.driverAccessToken,
    observedEvents: context.observedEvents,
    roomId: context.roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_TOPLEVEL",
  });
  assertTopLevelReplyArtifact("top-level reply", result.reply);
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      token: result.token,
    },
    details: [
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runRoomThreadReplyOverrideScenario(context: MatrixQaScenarioContext) {
  const result = await runConfigurableTopLevelScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    replyPredicate: (event, params) =>
      event.relatesTo?.relType === "m.thread" && event.relatesTo?.eventId === params.driverEventId,
    roomId: context.roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_ROOM_THREAD",
  });
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.driverEventId,
    label: "room thread override reply",
  });
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runObserverAllowlistOverrideScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: context.observerAccessToken,
    actorId: "observer",
    baseUrl: context.baseUrl,
    syncState: context.syncState,
  });
  const token = `MATRIX_QA_OBSERVER_ALLOWLIST_${randomUUID().slice(0, 8).toUpperCase()}`;
  const body = buildMentionPrompt(context.sutUserId, token);
  const driverEventId = await client.sendTextMessage({
    body,
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.sender === context.sutUserId &&
      event.type === "m.room.message" &&
      event.relatesTo === undefined &&
      typeof event.body === "string" &&
      event.body.trim().length > 0,
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "observer",
    syncState: context.syncState,
    nextSince: matched.since,
    startSince,
  });
  const reply = buildMatrixReplyArtifact(matched.event, token);
  return {
    artifacts: {
      actorUserId: context.observerUserId,
      driverEventId,
      reply,
      token,
      triggerBody: body,
    },
    details: [
      `trigger sender: ${context.observerUserId}`,
      `driver event: ${driverEventId}`,
      ...buildMatrixReplyDetails("reply", reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runQuietStreamingPreviewScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    syncState: context.syncState,
  });
  const finalText = `MATRIX_QA_QUIET_STREAM_${randomUUID().slice(0, 8).toUpperCase()} preview complete`;
  const triggerBody = buildMatrixQuietStreamingPrompt(context.sutUserId, finalText);
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
      event.kind === "notice",
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const finalized = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.sender === context.sutUserId &&
      isMatrixQaMessageLikeKind(event.kind) &&
      event.relatesTo?.relType === "m.replace" &&
      event.relatesTo.eventId === preview.event.eventId &&
      event.body === finalText,
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
  const finalReply = buildMatrixReplyArtifact(finalized.event, finalText);
  return {
    artifacts: {
      driverEventId,
      previewBodyPreview: preview.event.body?.slice(0, 200),
      previewEventId: preview.event.eventId,
      reply: finalReply,
      token: finalText,
      triggerBody,
    },
    details: [
      `driver event: ${driverEventId}`,
      `preview event: ${preview.event.eventId}`,
      `preview kind: ${preview.event.kind}`,
      `preview body: ${preview.event.body ?? "<none>"}`,
      `final reply relation: ${finalized.event.relatesTo?.relType ?? "<none>"}`,
      `final reply target: ${finalized.event.relatesTo?.eventId ?? "<none>"}`,
      ...buildMatrixReplyDetails("final reply", finalReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runBlockStreamingScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_BLOCK_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    syncState: context.syncState,
  });
  const firstText = `MATRIX_QA_BLOCK_ONE_${randomUUID().slice(0, 8).toUpperCase()}`;
  const secondText = `MATRIX_QA_BLOCK_TWO_${randomUUID().slice(0, 8).toUpperCase()}`;
  const triggerBody = buildMatrixBlockStreamingPrompt(context.sutUserId, firstText, secondText);
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId,
  });
  const firstBlock = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.sender === context.sutUserId &&
      isMatrixQaMessageLikeKind(event.kind) &&
      (event.body ?? "").includes(firstText) &&
      !(event.body ?? "").includes(secondText),
    roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const secondBlock = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === roomId &&
      event.sender === context.sutUserId &&
      isMatrixQaMessageLikeKind(event.kind) &&
      (event.body ?? "").includes(secondText),
    roomId,
    since: firstBlock.since,
    timeoutMs: context.timeoutMs,
  });
  if (firstBlock.event.eventId === secondBlock.event.eventId) {
    throw new Error(
      "Matrix block streaming scenario reused one event instead of preserving blocks",
    );
  }
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: secondBlock.since,
    startSince,
  });
  return {
    artifacts: {
      blockEventIds: [firstBlock.event.eventId, secondBlock.event.eventId],
      driverEventId,
      reply: buildMatrixReplyArtifact(secondBlock.event, secondText),
      roomId,
      token: secondText,
      triggerBody,
    },
    details: [
      `room id: ${roomId}`,
      `driver event: ${driverEventId}`,
      `block one event: ${firstBlock.event.eventId}`,
      `block two event: ${secondBlock.event.eventId}`,
      `block one kind: ${firstBlock.event.kind}`,
      `block two kind: ${secondBlock.event.kind}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runRoomAutoJoinInviteScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    syncState: context.syncState,
  });
  const dynamicRoomId = await client.createPrivateRoom({
    inviteUserIds: [context.observerUserId, context.sutUserId],
    name: `Matrix QA AutoJoin ${randomUUID().slice(0, 8)}`,
  });
  const joinResult = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === dynamicRoomId &&
      event.type === "m.room.member" &&
      event.stateKey === context.sutUserId &&
      event.membership === "join",
    roomId: dynamicRoomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const joinEvent = joinResult.event;
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: joinResult.since,
    startSince,
  });

  const result = await runTopLevelMentionScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    roomId: dynamicRoomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_AUTOJOIN",
  });
  assertTopLevelReplyArtifact("auto-join room reply", result.reply);

  return {
    artifacts: {
      driverEventId: result.driverEventId,
      joinedRoomId: dynamicRoomId,
      membershipJoinEventId: joinEvent.eventId,
      reply: result.reply,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `joined room id: ${dynamicRoomId}`,
      `join event: ${joinEvent.eventId}`,
      `driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runMembershipLossScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEMBERSHIP_ROOM_KEY);
  const driverClient = createMatrixQaScenarioClient({
    accessToken: context.driverAccessToken,
    baseUrl: context.baseUrl,
  });
  const sutClient = createMatrixQaScenarioClient({
    accessToken: context.sutAccessToken,
    baseUrl: context.baseUrl,
  });

  await driverClient.kickUserFromRoom({
    reason: "matrix qa membership loss",
    roomId,
    userId: context.sutUserId,
  });
  const leaveEvent = await waitForMembershipEvent({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    membership: "leave",
    observedEvents: context.observedEvents,
    roomId,
    stateKey: context.sutUserId,
    syncState: context.syncState,
    timeoutMs: context.timeoutMs,
  });

  const noReplyToken = `MATRIX_QA_MEMBERSHIP_LOSS_${randomUUID().slice(0, 8).toUpperCase()}`;
  await runNoReplyExpectedScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    actorUserId: context.driverUserId,
    baseUrl: context.baseUrl,
    body: buildMentionPrompt(context.sutUserId, noReplyToken),
    mentionUserIds: [context.sutUserId],
    observedEvents: context.observedEvents,
    roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: Math.min(NO_REPLY_WINDOW_MS, context.timeoutMs),
    token: noReplyToken,
  });

  await driverClient.inviteUserToRoom({
    roomId,
    userId: context.sutUserId,
  });
  await waitForMembershipEvent({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    membership: "invite",
    observedEvents: context.observedEvents,
    roomId,
    stateKey: context.sutUserId,
    syncState: context.syncState,
    timeoutMs: context.timeoutMs,
  });
  await sutClient.joinRoom(roomId);
  const joinEvent = await waitForMembershipEvent({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    membership: "join",
    observedEvents: context.observedEvents,
    roomId,
    stateKey: context.sutUserId,
    syncState: context.syncState,
    timeoutMs: context.timeoutMs,
  });

  const recovered = await runTopologyScopedTopLevelScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    actorUserId: context.driverUserId,
    context,
    roomKey: MATRIX_QA_MEMBERSHIP_ROOM_KEY,
    tokenPrefix: "MATRIX_QA_MEMBERSHIP_RETURN",
  });

  return {
    artifacts: {
      ...recovered.artifacts,
      membershipJoinEventId: joinEvent.eventId,
      membershipLeaveEventId: leaveEvent.eventId,
      recoveredDriverEventId: recovered.artifacts?.driverEventId,
      recoveredReply: recovered.artifacts?.reply,
    },
    details: [
      `room key: ${MATRIX_QA_MEMBERSHIP_ROOM_KEY}`,
      `room id: ${roomId}`,
      `leave event: ${leaveEvent.eventId}`,
      `join event: ${joinEvent.eventId}`,
      recovered.details,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runReactionNotificationScenario(context: MatrixQaScenarioContext) {
  const reactionTargetEventId = context.canary?.reply.eventId?.trim();
  if (!reactionTargetEventId) {
    throw new Error("Matrix reaction scenario requires a canary reply event id");
  }
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    syncState: context.syncState,
  });
  const reactionEmoji = "👍";
  const reactionEventId = await client.sendReaction({
    emoji: reactionEmoji,
    messageId: reactionTargetEventId,
    roomId: context.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.sender === context.driverUserId &&
      event.type === "m.reaction" &&
      event.eventId === reactionEventId &&
      event.reaction?.eventId === reactionTargetEventId &&
      event.reaction?.key === reactionEmoji,
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: matched.since,
    startSince,
  });
  return {
    artifacts: {
      reactionEmoji,
      reactionEventId,
      reactionTargetEventId,
    },
    details: [
      `reaction event: ${reactionEventId}`,
      `reaction target: ${reactionTargetEventId}`,
      `reaction emoji: ${reactionEmoji}`,
      `observed reaction key: ${matched.event.reaction?.key ?? "<none>"}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runHomeserverRestartResumeScenario(context: MatrixQaScenarioContext) {
  if (!context.interruptTransport) {
    throw new Error("Matrix homeserver restart scenario requires a transport interruption hook");
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_HOMESERVER_ROOM_KEY);
  await context.interruptTransport();
  const resumed = await runDriverTopLevelMentionScenario({
    baseUrl: context.baseUrl,
    driverAccessToken: context.driverAccessToken,
    observedEvents: context.observedEvents,
    roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_HOMESERVER",
  });
  assertTopLevelReplyArtifact("post-homeserver-restart reply", resumed.reply);
  return {
    artifacts: {
      driverEventId: resumed.driverEventId,
      reply: resumed.reply,
      roomId,
      token: resumed.token,
      transportInterruption: "homeserver-restart",
    },
    details: [
      `room id: ${roomId}`,
      "transport interruption: homeserver-restart",
      `driver event: ${resumed.driverEventId}`,
      ...buildMatrixReplyDetails("reply", resumed.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runRestartResumeScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGateway) {
    throw new Error("Matrix restart scenario requires a gateway restart callback");
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_RESTART_ROOM_KEY);
  await context.restartGateway();
  const result = await runDriverTopLevelMentionScenario({
    baseUrl: context.baseUrl,
    driverAccessToken: context.driverAccessToken,
    observedEvents: context.observedEvents,
    roomId,
    syncState: context.syncState,
    sutUserId: context.sutUserId,
    timeoutMs: context.timeoutMs,
    tokenPrefix: "MATRIX_QA_RESTART",
  });
  assertTopLevelReplyArtifact("post-restart reply", result.reply);
  return {
    artifacts: {
      driverEventId: result.driverEventId,
      reply: result.reply,
      restartSignal: "SIGUSR1",
      roomId,
      token: result.token,
    },
    details: [
      `room id: ${roomId}`,
      "restart signal: SIGUSR1",
      `post-restart driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
