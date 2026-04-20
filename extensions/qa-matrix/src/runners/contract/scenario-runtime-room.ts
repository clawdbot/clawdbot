import { randomUUID } from "node:crypto";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import {
  MATRIX_QA_BLOCK_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-catalog.js";
import {
  buildMatrixQaReactionArtifacts,
  buildMatrixQaReactionDetailLines,
  observeReactionScenario,
} from "./scenario-runtime-reaction.js";
import {
  assertThreadReplyArtifact,
  assertTopLevelReplyArtifact,
  advanceMatrixQaActorCursor,
  buildMatrixBlockStreamingPrompt,
  buildMatrixQuietStreamingPrompt,
  buildMatrixQaToken,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  createMatrixQaDriverScenarioClient,
  createMatrixQaScenarioClient,
  isMatrixQaExactMarkerReply,
  isMatrixQaMessageLikeKind,
  NO_REPLY_WINDOW_MS,
  primeMatrixQaActorCursor,
  primeMatrixQaDriverScenarioClient,
  runAssertedDriverTopLevelScenario,
  runConfigurableTopLevelScenario,
  runDriverTopLevelMentionScenario,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  waitForMembershipEvent,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime-shared.js";
import type { MatrixQaCanaryArtifact, MatrixQaScenarioExecution } from "./scenario-types.js";

type MatrixQaThreadScenarioResult = Awaited<ReturnType<typeof runThreadScenario>>;

const MATRIX_SUBAGENT_THREAD_HOOK_ERROR_RE =
  /thread=true is unavailable because no channel plugin registered subagent_spawning hooks/i;
const MATRIX_QA_HOT_RELOAD_RESTART_DELAY_MS = 300_000;

function assertMatrixQaInReplyTarget(params: {
  actualEventId?: string;
  expectedEventId: string;
  label: string;
}) {
  if (params.actualEventId !== params.expectedEventId) {
    throw new Error(
      `${params.label} targeted ${params.actualEventId ?? "<none>"} instead of ${params.expectedEventId}`,
    );
  }
}

function requireMatrixQaNestedThreadEvent(
  nestedDriverEventId: string | undefined,
  scenarioLabel: string,
) {
  if (!nestedDriverEventId) {
    throw new Error(`${scenarioLabel} did not create a nested trigger`);
  }
  return nestedDriverEventId;
}

function buildMatrixQaThreadArtifacts(result: MatrixQaThreadScenarioResult) {
  return {
    driverEventId: result.driverEventId,
    reply: result.reply,
    rootEventId: result.rootEventId,
    token: result.token,
  };
}

function failIfMatrixSubagentThreadHookError(event: MatrixQaObservedEvent) {
  if (MATRIX_SUBAGENT_THREAD_HOOK_ERROR_RE.test(event.body ?? "")) {
    throw new Error(
      `Matrix subagent thread spawn hit missing hook error: ${event.body ?? "<empty>"}`,
    );
  }
}

function buildMatrixQaThreadDetailLines(params: {
  result: MatrixQaThreadScenarioResult;
  includeNestedTrigger?: boolean;
  extraLines?: string[];
  replyLabel?: string;
}) {
  return [
    `thread root event: ${params.result.rootEventId}`,
    ...(params.includeNestedTrigger && params.result.nestedDriverEventId
      ? [`nested trigger event: ${params.result.nestedDriverEventId}`]
      : []),
    `mention trigger event: ${params.result.driverEventId}`,
    ...(params.extraLines ?? []),
    ...buildMatrixReplyDetails(params.replyLabel ?? "reply", params.result.reply),
  ];
}

async function runThreadScenario(
  params: MatrixQaScenarioContext,
  options?: {
    createNestedReply?: boolean;
    tokenPrefix?: string;
  },
) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(params);
  const rootBody = `thread root ${randomUUID().slice(0, 8)}`;
  const rootEventId = await client.sendTextMessage({
    body: rootBody,
    roomId: params.roomId,
  });
  const nestedDriverEventId =
    options?.createNestedReply === true
      ? await client.sendTextMessage({
          body: `thread nested ${randomUUID().slice(0, 8)}`,
          replyToEventId: rootEventId,
          roomId: params.roomId,
          threadRootEventId: rootEventId,
        })
      : undefined;
  const triggerEventId = nestedDriverEventId ?? rootEventId;
  const token = buildMatrixQaToken(options?.tokenPrefix ?? "MATRIX_QA_THREAD");
  const driverEventId = await client.sendTextMessage({
    body: buildMentionPrompt(params.sutUserId, token),
    mentionUserIds: [params.sutUserId],
    replyToEventId: triggerEventId,
    roomId: params.roomId,
    threadRootEventId: rootEventId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId: params.roomId,
        sutUserId: params.sutUserId,
        token,
      }) &&
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
    nestedDriverEventId,
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
  syncStreams?: MatrixQaScenarioContext["syncStreams"];
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
    syncStreams: params.syncStreams,
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
    artifacts: buildMatrixQaThreadArtifacts(result),
    details: [
      `root event: ${result.rootEventId}`,
      `driver thread event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runThreadRootPreservationScenario(context: MatrixQaScenarioContext) {
  const result = await runThreadScenario(context, {
    createNestedReply: true,
    tokenPrefix: "MATRIX_QA_THREAD_ROOT",
  });
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.rootEventId,
    label: "thread root preservation reply",
  });
  requireMatrixQaNestedThreadEvent(
    result.nestedDriverEventId,
    "Matrix thread root preservation scenario",
  );
  return {
    artifacts: buildMatrixQaThreadArtifacts(result),
    details: buildMatrixQaThreadDetailLines({
      result,
      includeNestedTrigger: true,
      extraLines: [
        `reply thread root: ${result.reply.relatesTo?.eventId ?? "<none>"}`,
        `reply in_reply_to: ${result.reply.relatesTo?.inReplyToId ?? "<none>"}`,
      ],
    }).join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runThreadNestedReplyShapeScenario(context: MatrixQaScenarioContext) {
  const result = await runThreadScenario(context, {
    createNestedReply: true,
    tokenPrefix: "MATRIX_QA_THREAD_NESTED",
  });
  assertThreadReplyArtifact(result.reply, {
    expectedRootEventId: result.rootEventId,
    label: "thread nested reply",
  });
  requireMatrixQaNestedThreadEvent(
    result.nestedDriverEventId,
    "Matrix thread nested reply scenario",
  );
  assertMatrixQaInReplyTarget({
    actualEventId: result.reply.relatesTo?.inReplyToId,
    expectedEventId: result.rootEventId,
    label: "thread nested reply in_reply_to",
  });
  return {
    artifacts: buildMatrixQaThreadArtifacts(result),
    details: buildMatrixQaThreadDetailLines({
      result,
      includeNestedTrigger: true,
      extraLines: [
        `reply in_reply_to: ${result.reply.relatesTo?.inReplyToId ?? "<none>"}`,
        `expected fallback root: ${result.rootEventId}`,
      ],
    }).join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runThreadIsolationScenario(context: MatrixQaScenarioContext) {
  const threadPhase = await runThreadScenario(context);
  assertThreadReplyArtifact(threadPhase.reply, {
    expectedRootEventId: threadPhase.rootEventId,
    label: "thread isolation reply",
  });
  const topLevelPhase = await runAssertedDriverTopLevelScenario({
    context,
    label: "top-level follow-up reply",
    tokenPrefix: "MATRIX_QA_TOPLEVEL",
  });
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

export async function runSubagentThreadSpawnScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const childToken = buildMatrixQaToken("MATRIX_QA_SUBAGENT_CHILD");
  const triggerBody = [
    `${context.sutUserId} Use sessions_spawn for this QA check.`,
    `task="Reply exactly \`${childToken}\`. This is the marker."`,
    "label=matrix-thread-subagent thread=true mode=session runTimeoutSeconds=30",
  ].join(" ");
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const intro = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) => {
      failIfMatrixSubagentThreadHookError(event);
      return (
        event.roomId === context.roomId &&
        event.sender === context.sutUserId &&
        event.type === "m.room.message" &&
        isMatrixQaMessageLikeKind(event.kind) &&
        /\bsession active\b/i.test(event.body ?? "") &&
        /Messages here go directly to this session/i.test(event.body ?? "")
      );
    },
    roomId: context.roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  const completion = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) => {
      failIfMatrixSubagentThreadHookError(event);
      return (
        event.roomId === context.roomId &&
        event.sender === context.sutUserId &&
        event.type === "m.room.message" &&
        isMatrixQaMessageLikeKind(event.kind) &&
        (event.body ?? "").includes(childToken) &&
        event.relatesTo?.relType === "m.thread" &&
        event.relatesTo.eventId === intro.event.eventId
      );
    },
    roomId: context.roomId,
    since: intro.since,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: completion.since,
    startSince,
  });
  const subagentIntro = buildMatrixReplyArtifact(intro.event);
  const subagentCompletion = buildMatrixReplyArtifact(completion.event, childToken);
  return {
    artifacts: {
      driverEventId,
      subagentCompletion,
      subagentIntro,
      threadRootEventId: intro.event.eventId,
      threadToken: childToken,
      triggerBody,
    },
    details: [
      `driver event: ${driverEventId}`,
      `subagent thread root event: ${intro.event.eventId}`,
      ...buildMatrixReplyDetails("subagent intro", subagentIntro),
      ...buildMatrixReplyDetails("subagent completion", subagentCompletion),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runTopLevelReplyShapeScenario(context: MatrixQaScenarioContext) {
  const result = await runAssertedDriverTopLevelScenario({
    context,
    label: "top-level reply",
    tokenPrefix: "MATRIX_QA_TOPLEVEL",
  });
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
    syncStreams: context.syncStreams,
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
    observedEvents: context.observedEvents,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
  });
  const token = buildMatrixQaToken("MATRIX_QA_OBSERVER_ALLOWLIST");
  const body = buildMentionPrompt(context.sutUserId, token);
  const driverEventId = await client.sendTextMessage({
    body,
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId: context.roomId,
        sutUserId: context.sutUserId,
        token,
      }) && event.relatesTo === undefined,
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
  assertTopLevelReplyArtifact("observer allowlist reply", reply);
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

export async function runAllowlistHotReloadScenario(context: MatrixQaScenarioContext) {
  if (!context.patchGatewayConfig) {
    throw new Error("Matrix allowlist hot-reload scenario requires gateway config patching");
  }
  const accepted = await runTopologyScopedTopLevelScenario({
    accessToken: context.observerAccessToken,
    actorId: "observer",
    actorUserId: context.observerUserId,
    context,
    roomKey: context.topology.defaultRoomKey,
    tokenPrefix: "MATRIX_QA_GROUP_RELOAD_ACCEPTED",
  });
  const accountId = context.sutAccountId ?? "sut";

  await context.patchGatewayConfig(
    {
      channels: {
        matrix: {
          accounts: {
            [accountId]: {
              groupAllowFrom: [context.driverUserId],
            },
          },
        },
      },
      gateway: {
        // Isolate the Matrix handler's per-message config read from generic channel reload.
        reload: {
          mode: "off",
        },
      },
    },
    {
      restartDelayMs: MATRIX_QA_HOT_RELOAD_RESTART_DELAY_MS,
    },
  );

  const blockedToken = buildMatrixQaToken("MATRIX_QA_GROUP_RELOAD_REMOVED");
  const removed = await runNoReplyExpectedScenario({
    accessToken: context.observerAccessToken,
    actorId: "observer",
    actorUserId: context.observerUserId,
    baseUrl: context.baseUrl,
    body: buildMentionPrompt(context.sutUserId, blockedToken),
    mentionUserIds: [context.sutUserId],
    observedEvents: context.observedEvents,
    roomId: context.roomId,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
    sutUserId: context.sutUserId,
    replyPredicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId: context.roomId,
        sutUserId: context.sutUserId,
        token: blockedToken,
      }),
    timeoutMs: Math.min(NO_REPLY_WINDOW_MS, context.timeoutMs),
    token: blockedToken,
  });

  return {
    artifacts: {
      accepted: accepted.artifacts ?? {},
      blocked: removed.artifacts ?? {},
      driverEventId: accepted.artifacts?.driverEventId,
      secondDriverEventId: removed.artifacts?.driverEventId,
      firstReply: accepted.artifacts?.reply,
      token: accepted.artifacts?.token,
      triggerBody: accepted.artifacts?.triggerBody,
    },
    details: [
      "group allowlist before removal:",
      accepted.details,
      "group allowlist after hot reload removal:",
      removed.details,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runQuietStreamingPreviewScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
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

export async function runMembershipLossScenario(context: MatrixQaScenarioContext) {
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_MEMBERSHIP_ROOM_KEY);
  const driverClient = createMatrixQaDriverScenarioClient(context);
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
    syncStreams: context.syncStreams,
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
    syncStreams: context.syncStreams,
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
