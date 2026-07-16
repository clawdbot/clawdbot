// QA Lab Matrix plugin module implements thread and reply scenarios.
import { randomUUID } from "node:crypto";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  assertThreadReplyArtifact,
  assertTopLevelReplyArtifact,
  advanceMatrixQaActorCursor,
  buildMatrixQaToken,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  isMatrixQaExactMarkerReply,
  isMatrixQaMessageLikeKind,
  primeMatrixQaActorCursor,
  primeMatrixQaDriverScenarioClient,
  runAssertedDriverTopLevelScenario,
  runConfigurableTopLevelScenario,
  runDriverTopLevelMentionScenario,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime-shared.js";
import type { MatrixQaCanaryArtifact, MatrixQaScenarioExecution } from "./scenario-types.js";

type MatrixQaThreadScenarioResult = Awaited<ReturnType<typeof runThreadScenario>>;

const MATRIX_SUBAGENT_THREAD_HOOK_ERROR_RE =
  /thread=true is unavailable because no channel plugin registered subagent_spawning hooks/i;

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

export function buildMatrixQaThreadDetailLines(params: {
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

export async function runThreadScenario(
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
  const spawnArgs = {
    task: `Finish with exactly ${childToken}.`,
    label: "matrix-thread-subagent",
    thread: true,
    mode: "session",
    runTimeoutSeconds: 120,
  };
  const triggerBody = [
    `${context.sutUserId} Run this exact OpenClaw Matrix thread-spawn QA check. Use tool calls, not prose.`,
    `Step 1: call sessions_spawn with exactly this JSON input: ${JSON.stringify(spawnArgs)}.`,
    'Step 2: after spawn returns status="accepted", wait for the child session reply in the spawned Matrix thread.',
    "Do not omit thread=true; the child must bind to this Matrix thread.",
    `Do not write ${childToken} in the parent response.`,
  ].join(" ");
  const introPromise = client.waitForRoomEvent({
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
  const driverEventId = await client.sendTextMessage({
    body: triggerBody,
    mentionUserIds: [context.sutUserId],
    roomId: context.roomId,
  });
  const intro = await introPromise;
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
