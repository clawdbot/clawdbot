import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import {
  advanceMatrixQaActorCursor,
  assertNoSutReplyWindow,
  createMatrixQaDriverScenarioClient,
  primeMatrixQaActorCursor,
  type MatrixQaActorId,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export function buildMatrixQaReactionDetailLines(params: {
  actorUserId?: string;
  observedReactionKey?: string;
  reactionEmoji: string;
  reactionEventId: string;
  reactionTargetEventId: string;
}) {
  return [
    `reaction event: ${params.reactionEventId}`,
    `reaction target: ${params.reactionTargetEventId}`,
    `reaction emoji: ${params.reactionEmoji}`,
    ...(params.actorUserId ? [`reaction sender: ${params.actorUserId}`] : []),
    ...(params.observedReactionKey ? [`observed reaction key: ${params.observedReactionKey}`] : []),
  ];
}

function requireMatrixQaReactionTargetEventId(
  reactionTargetEventId: string | undefined,
  scenarioLabel: string,
) {
  const normalizedReactionTargetEventId = reactionTargetEventId?.trim();
  if (!normalizedReactionTargetEventId) {
    throw new Error(`${scenarioLabel} requires a canary reply event id`);
  }
  return normalizedReactionTargetEventId;
}

export async function observeReactionScenario(params: {
  actorId: MatrixQaActorId;
  actorUserId: string;
  accessToken: string;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  reactionEmoji?: string;
  reactionTargetEventId: string;
  roomId: string;
  syncState: MatrixQaSyncState;
  syncStreams?: MatrixQaScenarioContext["syncStreams"];
  timeoutMs: number;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    syncState: params.syncState,
    syncStreams: params.syncStreams,
  });
  const reactionEmoji = params.reactionEmoji ?? "👍";
  const reactionEventId = await client.sendReaction({
    emoji: reactionEmoji,
    messageId: params.reactionTargetEventId,
    roomId: params.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.actorUserId &&
      event.type === "m.reaction" &&
      event.eventId === reactionEventId &&
      event.reaction?.eventId === params.reactionTargetEventId &&
      event.reaction?.key === reactionEmoji,
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  return {
    actorId: params.actorId,
    actorUserId: params.actorUserId,
    event: matched.event,
    reactionEmoji,
    reactionEventId,
    reactionTargetEventId: params.reactionTargetEventId,
    since: matched.since,
    startSince,
  };
}

export function buildMatrixQaReactionArtifacts(params: {
  actorUserId?: string;
  expectedNoReplyWindowMs?: number;
  reaction: Awaited<ReturnType<typeof observeReactionScenario>>;
}) {
  return {
    ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
    ...(params.expectedNoReplyWindowMs === undefined
      ? {}
      : { expectedNoReplyWindowMs: params.expectedNoReplyWindowMs }),
    reactionEmoji: params.reaction.reactionEmoji,
    reactionEventId: params.reaction.reactionEventId,
    reactionTargetEventId: params.reaction.reactionTargetEventId,
  };
}

export async function runReactionNotificationScenario(context: MatrixQaScenarioContext) {
  const reactionTargetEventId = requireMatrixQaReactionTargetEventId(
    context.canary?.reply.eventId,
    "Matrix reaction scenario",
  );
  const result = await observeReactionScenario({
    actorId: "driver",
    actorUserId: context.driverUserId,
    accessToken: context.driverAccessToken,
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    reactionTargetEventId,
    roomId: context.roomId,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
    timeoutMs: context.timeoutMs,
  });
  return {
    artifacts: buildMatrixQaReactionArtifacts({ reaction: result }),
    details: buildMatrixQaReactionDetailLines({
      actorUserId: result.actorUserId,
      observedReactionKey: result.event.reaction?.key,
      reactionEmoji: result.reactionEmoji,
      reactionEventId: result.reactionEventId,
      reactionTargetEventId: result.reactionTargetEventId,
    }).join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runReactionNotAReplyScenario(context: MatrixQaScenarioContext) {
  const reactionTargetEventId = requireMatrixQaReactionTargetEventId(
    context.canary?.reply.eventId,
    "Matrix reaction no-reply scenario",
  );
  const reaction = await observeReactionScenario({
    actorId: "driver",
    actorUserId: context.driverUserId,
    accessToken: context.driverAccessToken,
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    reactionTargetEventId,
    roomId: context.roomId,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
    timeoutMs: context.timeoutMs,
  });
  const client = createMatrixQaDriverScenarioClient(context);
  const { noReplyWindowMs } = await assertNoSutReplyWindow({
    actorId: reaction.actorId,
    client,
    context,
    roomId: context.roomId,
    since: reaction.since,
    startSince: reaction.startSince,
    unexpectedLines: [
      `reaction target: ${reaction.reactionTargetEventId}`,
      `reaction event: ${reaction.reactionEventId}`,
    ],
    unexpectedMessage: `unexpected SUT reply after reaction from ${context.driverUserId}`,
  });
  return {
    artifacts: buildMatrixQaReactionArtifacts({
      actorUserId: context.driverUserId,
      expectedNoReplyWindowMs: noReplyWindowMs,
      reaction,
    }),
    details: [
      ...buildMatrixQaReactionDetailLines({
        reactionEmoji: reaction.reactionEmoji,
        reactionEventId: reaction.reactionEventId,
        reactionTargetEventId: reaction.reactionTargetEventId,
      }),
      `waited ${noReplyWindowMs}ms with no SUT reply`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runReactionRedactionObservedScenario(context: MatrixQaScenarioContext) {
  const reactionTargetEventId = requireMatrixQaReactionTargetEventId(
    context.canary?.reply.eventId,
    "Matrix reaction redaction scenario",
  );
  const reaction = await observeReactionScenario({
    actorId: "driver",
    actorUserId: context.driverUserId,
    accessToken: context.driverAccessToken,
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    reactionTargetEventId,
    roomId: context.roomId,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
    timeoutMs: context.timeoutMs,
  });
  const client = createMatrixQaDriverScenarioClient(context);
  const redactionEventId = await client.redactEvent({
    eventId: reaction.reactionEventId,
    reason: "matrix qa reaction removal",
    roomId: context.roomId,
  });
  const redaction = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.roomId === context.roomId &&
      event.eventId === redactionEventId &&
      event.sender === context.driverUserId &&
      event.kind === "redaction",
    roomId: context.roomId,
    since: reaction.since,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: reaction.actorId,
    syncState: context.syncState,
    nextSince: redaction.since,
    startSince: reaction.startSince,
  });
  return {
    artifacts: {
      ...buildMatrixQaReactionArtifacts({ reaction }),
      redactionEventId,
    },
    details: [
      ...buildMatrixQaReactionDetailLines({
        reactionEmoji: reaction.reactionEmoji,
        reactionEventId: reaction.reactionEventId,
        reactionTargetEventId: reaction.reactionTargetEventId,
      }),
      `redaction event: ${redactionEventId}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
