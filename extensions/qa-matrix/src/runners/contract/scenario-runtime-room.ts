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
  buildMatrixPartialStreamingPrompt,
  buildMatrixQuietStreamingPrompt,
  buildMatrixQaToken,
  buildMatrixToolProgressErrorPrompt,
  buildMatrixToolProgressMentionSafetyPrompt,
  buildMatrixToolProgressPrompt,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  doesMatrixQaReplyBodyMatchToken,
  createMatrixQaDriverScenarioClient,
  createMatrixQaScenarioClient,
  isMatrixQaExactMarkerReply,
  isMatrixQaMessageLikeKind,
  primeMatrixQaActorCursor,
  primeMatrixQaDriverScenarioClient,
  resolveMatrixQaNoReplyWindowMs,
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
  const body = event.body ?? "";
  if (MATRIX_SUBAGENT_THREAD_HOOK_ERROR_RE.test(body)) {
    throw new Error(`Matrix subagent thread spawn hit missing hook error: ${body || "<empty>"}`);
  }
  if (/\bsessions_spawn failed:/i.test(body)) {
    throw new Error(`Matrix subagent thread spawn failed: ${body || "<empty>"}`);
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
    `${context.sutUserId} Call sessions_spawn now for this QA check.`,
    `Use task="Finish with exactly ${childToken}."`,
    "Use label=matrix-thread-subagent thread=true mode=session runTimeoutSeconds=60.",
    "Do not send the child token from this parent session.",
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
    timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
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
  return runMatrixStreamingPreviewScenario(context, {
    expectedPreviewKind: "notice",
    finalText: `MATRIX_QA_QUIET_STREAM_${randomUUID().slice(0, 8).toUpperCase()} preview complete`,
    label: "quiet streaming",
    triggerBodyBuilder: buildMatrixQuietStreamingPrompt,
  });
}

export async function runPartialStreamingPreviewScenario(context: MatrixQaScenarioContext) {
  return runMatrixStreamingPreviewScenario(context, {
    expectedPreviewKind: "message",
    finalText: `MATRIX_QA_PARTIAL_STREAM_${randomUUID().slice(0, 8).toUpperCase()} preview complete`,
    label: "partial streaming",
    triggerBodyBuilder: buildMatrixPartialStreamingPrompt,
  });
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
      event.kind === params.expectedPreviewKind &&
      event.relatesTo === undefined,
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
      previewFormattedBodyPreview: preview.event.formattedBody?.slice(0, 200),
      previewBodyPreview: preview.event.body?.slice(0, 200),
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
      `final reply relation: ${finalized.event.relatesTo?.relType ?? "<none>"}`,
      `final reply target: ${finalized.event.relatesTo?.eventId ?? "<none>"}`,
      ...buildMatrixReplyDetails("final reply", finalReply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

function findMatrixQaUnexpectedWorkingEvents(params: {
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

function assertMatrixQaToolProgressMentionsInert(event: MatrixQaObservedEvent) {
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

function hasMatrixQaToolProgressPreviewLine(body: string | undefined) {
  return Boolean(
    body?.split(/\r?\n/).some((line) => /^\s*(?:[-*•]\s+`?[^`\s][^`]*`?|`[^`]+`)\s*$/u.test(line)),
  );
}

function truncateMatrixQaToolProgressBody(body: string | undefined) {
  if (!body) {
    return "<none>";
  }
  return body.length <= 240 ? body : `${body.slice(0, 237)}...`;
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

function buildMatrixQaToolProgressTimeoutMessage(params: {
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
  const candidateDetails =
    candidates.length === 0
      ? ["observed preview candidates: <none>"]
      : ["observed preview candidates:", ...candidates.map(describeMatrixQaToolProgressCandidate)];
  return [
    params.cause instanceof Error
      ? params.cause.message
      : `Matrix tool progress wait failed: ${String(params.cause)}`,
    `preview event: ${params.previewEventId}`,
    ...candidateDetails,
  ].join("\n");
}

function buildMatrixQaToolProgressFinalTimeoutMessage(params: {
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

async function runMatrixToolProgressScenario(
  context: MatrixQaScenarioContext,
  params: {
    expectedPreviewKind: MatrixQaObservedEvent["kind"];
    finalText: string;
    label: string;
    allowGenericProgressLine?: boolean;
    mentionSafety?: boolean;
    progressPattern: RegExp;
    triggerBodyBuilder: (sutUserId: string, finalText: string) => string;
  },
) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const startObservedIndex = context.observedEvents.length;
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
  const preview = await client
    .waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        event.roomId === context.roomId &&
        event.sender === context.sutUserId &&
        event.kind === params.expectedPreviewKind &&
        (event.relatesTo === undefined ||
          (event.relatesTo.relType === "m.replace" && matchesExpectedProgress(event.body))),
      roomId: context.roomId,
      since: startSince,
      timeoutMs: context.timeoutMs,
    })
    .catch((err: unknown) => {
      throw new Error(
        buildMatrixQaToolProgressTimeoutMessage({
          cause: err,
          events: context.observedEvents,
          expectedPreviewKind: params.expectedPreviewKind,
          previewEventId: "<not observed>",
          roomId: context.roomId,
          startIndex: startObservedIndex,
          sutUserId: context.sutUserId,
        }),
      );
    });
  const previewRootEventId = getPreviewRootEventId(preview.event);
  const progress = matchesExpectedProgress(preview.event.body)
    ? preview
    : await client
        .waitForRoomEvent({
          observedEvents: context.observedEvents,
          predicate: (event) =>
            event.roomId === context.roomId &&
            event.sender === context.sutUserId &&
            event.kind === params.expectedPreviewKind &&
            event.relatesTo?.relType === "m.replace" &&
            event.relatesTo.eventId === previewRootEventId &&
            matchesExpectedProgress(event.body),
          roomId: context.roomId,
          since: preview.since,
          timeoutMs: context.timeoutMs,
        })
        .catch((err: unknown) => {
          throw new Error(
            buildMatrixQaToolProgressTimeoutMessage({
              cause: err,
              events: context.observedEvents,
              expectedPreviewKind: params.expectedPreviewKind,
              previewEventId: previewRootEventId,
              roomId: context.roomId,
              startIndex: startObservedIndex,
              sutUserId: context.sutUserId,
            }),
          );
        });

  if (params.mentionSafety) {
    assertMatrixQaToolProgressMentionsInert(progress.event);
  }

  const finalized = await client
    .waitForRoomEvent({
      observedEvents: context.observedEvents,
      predicate: (event) =>
        event.roomId === context.roomId &&
        event.sender === context.sutUserId &&
        isMatrixQaMessageLikeKind(event.kind) &&
        event.relatesTo?.relType === "m.replace" &&
        event.relatesTo.eventId === previewRootEventId &&
        doesMatrixQaReplyBodyMatchToken(event, params.finalText),
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
    });
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
    nextSince: finalized.since,
    startSince,
  });
  const finalReply = buildMatrixReplyArtifact(finalized.event, params.finalText);
  return {
    artifacts: {
      driverEventId,
      previewBodyPreview: progress.event.body?.slice(0, 200),
      previewEventId: previewRootEventId,
      previewFormattedBodyPreview: progress.event.formattedBody?.slice(0, 200),
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

export async function runToolProgressPreviewScenario(context: MatrixQaScenarioContext) {
  return runMatrixToolProgressScenario(context, {
    expectedPreviewKind: "notice",
    finalText: buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS"),
    label: "tool progress preview",
    allowGenericProgressLine: true,
    progressPattern: /\b(?:tool:\s*)?read\s*:\s*from\b|\btool:\s*read\b/i,
    triggerBodyBuilder: buildMatrixToolProgressPrompt,
  });
}

export async function runToolProgressErrorScenario(context: MatrixQaScenarioContext) {
  return runMatrixToolProgressScenario(context, {
    expectedPreviewKind: "notice",
    finalText: buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS_ERROR"),
    label: "tool progress error",
    allowGenericProgressLine: true,
    progressPattern: /\bread\s*:?\s*from\s+\S*missing-matrix-tool-progress-target\.txt\b/i,
    triggerBodyBuilder: buildMatrixToolProgressErrorPrompt,
  });
}

export async function runToolProgressMentionSafetyScenario(context: MatrixQaScenarioContext) {
  return runMatrixToolProgressScenario(context, {
    expectedPreviewKind: "message",
    finalText: buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS_MENTION_SAFE"),
    label: "tool progress mention safety",
    mentionSafety: true,
    progressPattern: /@room|@alice:matrix-qa\.test|!room:matrix-qa\.test/i,
    triggerBodyBuilder: buildMatrixToolProgressMentionSafetyPrompt,
  });
}

export async function runToolProgressPreviewOptOutScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const startObservedIndex = context.observedEvents.length;
  const finalText = buildMatrixQaToken("MATRIX_QA_TOOL_PROGRESS_OPTOUT");
  const triggerBody = buildMatrixToolProgressPrompt(context.sutUserId, finalText);
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
    timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
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
