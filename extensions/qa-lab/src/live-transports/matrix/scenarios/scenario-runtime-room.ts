// QA Lab Matrix plugin module implements scenario runtime room behavior.
import { randomUUID } from "node:crypto";
import {
  MATRIX_QA_BLOCK_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-contract.js";
import {
  buildMatrixQaReactionArtifacts,
  buildMatrixQaReactionDetailLines,
  observeReactionScenario,
} from "./scenario-runtime-reaction.js";
import {
  assertThreadReplyArtifact,
  advanceMatrixQaActorCursor,
  buildMatrixBlockStreamingPrompt,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  createMatrixQaDriverScenarioClient,
  createMatrixQaScenarioClient,
  isMatrixQaMessageLikeKind,
  primeMatrixQaDriverScenarioClient,
  resolveMatrixQaNoReplyWindowMs,
  runAssertedDriverTopLevelScenario,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  waitForMembershipEvent,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import { buildMatrixQaThreadDetailLines, runThreadScenario } from "./scenario-runtime-thread.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export {
  runMatrixQaCanary,
  runObserverAllowlistOverrideScenario,
  runRoomThreadReplyOverrideScenario,
  runSubagentThreadSpawnScenario,
  runThreadFollowUpScenario,
  runThreadIsolationScenario,
  runThreadNestedReplyShapeScenario,
  runThreadRootPreservationScenario,
  runTopLevelReplyShapeScenario,
} from "./scenario-runtime-thread.js";
export {
  runPartialStreamingPreviewScenario,
  runQuietStreamingPreviewScenario,
} from "./scenario-runtime-streaming-preview.js";

export {
  runToolProgressCommandPreviewScenario,
  runToolProgressErrorScenario,
  runToolProgressMentionSafetyScenario,
  runToolProgressPreviewOptOutScenario,
  runToolProgressPreviewScenario,
} from "./scenario-runtime-tool-progress.js";
export async function runBlockStreamingScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_BLOCK_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
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
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
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

  const result = await runAssertedDriverTopLevelScenario({
    context,
    label: "auto-join room reply",
    roomId: dynamicRoomId,
    tokenPrefix: "MATRIX_QA_AUTOJOIN",
  });

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

async function restoreMembershipLossRoom(params: {
  context: MatrixQaScenarioContext;
  driverClient: ReturnType<typeof createMatrixQaDriverScenarioClient>;
  roomId: string;
  sutClient: ReturnType<typeof createMatrixQaScenarioClient>;
}) {
  await params.driverClient.inviteUserToRoom({
    roomId: params.roomId,
    userId: params.context.sutUserId,
  });
  await waitForMembershipEvent({
    accessToken: params.context.driverAccessToken,
    actorId: "driver",
    baseUrl: params.context.baseUrl,
    membership: "invite",
    observedEvents: params.context.observedEvents,
    roomId: params.roomId,
    stateKey: params.context.sutUserId,
    syncState: params.context.syncState,
    syncStreams: params.context.syncStreams,
    timeoutMs: params.context.timeoutMs,
  });
  await params.sutClient.joinRoom(params.roomId);
  return await waitForMembershipEvent({
    accessToken: params.context.driverAccessToken,
    actorId: "driver",
    baseUrl: params.context.baseUrl,
    membership: "join",
    observedEvents: params.context.observedEvents,
    roomId: params.roomId,
    stateKey: params.context.sutUserId,
    syncState: params.context.syncState,
    syncStreams: params.context.syncStreams,
    timeoutMs: params.context.timeoutMs,
  });
}

async function ensureMembershipLossRoomRestored(params: {
  driverClient: ReturnType<typeof createMatrixQaDriverScenarioClient>;
  roomId: string;
  sutClient: ReturnType<typeof createMatrixQaScenarioClient>;
  sutUserId: string;
}) {
  try {
    await params.sutClient.joinRoom(params.roomId);
    return;
  } catch {
    // A kicked member needs an invite; an already joined member succeeds above.
  }
  await params.driverClient.inviteUserToRoom({
    roomId: params.roomId,
    userId: params.sutUserId,
  });
  await params.sutClient.joinRoom(params.roomId);
}

export async function runMembershipLossScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEMBERSHIP_ROOM_KEY);
  const { client: driverClient } = await primeMatrixQaDriverScenarioClient(context);
  const sutClient = createMatrixQaScenarioClient({
    accessToken: context.sutAccessToken,
    baseUrl: context.baseUrl,
  });
  let membershipRestored = false;
  let outcome:
    | { execution: MatrixQaScenarioExecution; kind: "success" }
    | { error: unknown; kind: "failure" };

  try {
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
      syncStreams: context.syncStreams,
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
      syncStreams: context.syncStreams,
      sutUserId: context.sutUserId,
      timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
      token: noReplyToken,
    });

    const joinEvent = await restoreMembershipLossRoom({
      context,
      driverClient,
      roomId,
      sutClient,
    });
    membershipRestored = true;
    const recovered = await runTopologyScopedTopLevelScenario({
      accessToken: context.driverAccessToken,
      actorId: "driver",
      actorUserId: context.driverUserId,
      context,
      roomKey: MATRIX_QA_MEMBERSHIP_ROOM_KEY,
      tokenPrefix: "MATRIX_QA_MEMBERSHIP_RETURN",
    });

    outcome = {
      execution: {
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
      },
      kind: "success",
    };
  } catch (error) {
    outcome = { error, kind: "failure" };
  }

  // Arm cleanup before the kick: a lost response can still mean the kick applied.
  if (!membershipRestored) {
    try {
      await ensureMembershipLossRoomRestored({
        driverClient,
        roomId,
        sutClient,
        sutUserId: context.sutUserId,
      });
    } catch (cleanupError) {
      if (outcome.kind === "failure") {
        const combinedFailure = new AggregateError(
          [outcome.error, cleanupError],
          "Matrix membership-loss scenario and membership restoration both failed",
          { cause: cleanupError },
        );
        throw combinedFailure;
      }
      throw cleanupError;
    }
  }

  if (outcome.kind === "failure") {
    throw outcome.error;
  }
  return outcome.execution;
}

export async function runReactionThreadedScenario(context: MatrixQaScenarioContext) {
  const thread = await runThreadScenario(context, {
    createNestedReply: true,
    tokenPrefix: "MATRIX_QA_REACTION_THREAD",
  });
  assertThreadReplyArtifact(thread.reply, {
    expectedRootEventId: thread.rootEventId,
    label: "threaded reaction reply",
  });
  const reaction = await observeReactionScenario({
    actorId: "driver",
    actorUserId: context.driverUserId,
    accessToken: context.driverAccessToken,
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    reactionTargetEventId: thread.reply.eventId,
    roomId: context.roomId,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: reaction.actorId,
    syncState: context.syncState,
    nextSince: reaction.since,
    startSince: reaction.startSince,
  });
  return {
    artifacts: {
      driverEventId: thread.driverEventId,
      ...buildMatrixQaReactionArtifacts({ reaction }),
      reply: thread.reply,
      rootEventId: thread.rootEventId,
      token: thread.token,
    },
    details: [
      ...buildMatrixQaThreadDetailLines({
        result: thread,
        includeNestedTrigger: true,
        extraLines: [`thread reply event: ${thread.reply.eventId}`],
        replyLabel: "thread reply",
      }),
      ...buildMatrixQaReactionDetailLines({
        reactionEmoji: reaction.reactionEmoji,
        reactionEventId: reaction.reactionEventId,
        reactionTargetEventId: reaction.reactionTargetEventId,
      }),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
