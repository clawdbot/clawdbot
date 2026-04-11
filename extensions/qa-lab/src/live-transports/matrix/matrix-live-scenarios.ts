import { randomUUID } from "node:crypto";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../shared/live-transport-scenarios.js";
import { createMatrixQaClient, type MatrixQaObservedEvent } from "./matrix-driver-client.js";

export type MatrixQaScenarioId =
  | "matrix-thread-follow-up"
  | "matrix-thread-isolation"
  | "matrix-top-level-reply-shape"
  | "matrix-reaction-notification"
  | "matrix-restart-resume"
  | "matrix-mention-gating"
  | "matrix-allowlist-block";

export type MatrixQaScenarioDefinition = LiveTransportScenarioDefinition<MatrixQaScenarioId>;

export type MatrixQaReplyArtifact = {
  bodyPreview?: string;
  eventId: string;
  mentions?: MatrixQaObservedEvent["mentions"];
  relatesTo?: MatrixQaObservedEvent["relatesTo"];
  sender?: string;
  tokenMatched?: boolean;
};

export type MatrixQaCanaryArtifact = {
  driverEventId: string;
  reply: MatrixQaReplyArtifact;
  token: string;
};

export type MatrixQaScenarioArtifacts = {
  actorUserId?: string;
  driverEventId?: string;
  expectedNoReplyWindowMs?: number;
  reactionEmoji?: string;
  reactionEventId?: string;
  reactionTargetEventId?: string;
  reply?: MatrixQaReplyArtifact;
  restartSignal?: string;
  rootEventId?: string;
  threadDriverEventId?: string;
  threadReply?: MatrixQaReplyArtifact;
  threadRootEventId?: string;
  threadToken?: string;
  token?: string;
  topLevelDriverEventId?: string;
  topLevelReply?: MatrixQaReplyArtifact;
  topLevelToken?: string;
  triggerBody?: string;
};

export type MatrixQaScenarioExecution = {
  artifacts?: MatrixQaScenarioArtifacts;
  details: string;
};

type MatrixQaActorId = "driver" | "observer";

type MatrixQaSyncState = Partial<Record<MatrixQaActorId, string>>;

type MatrixQaScenarioContext = {
  baseUrl: string;
  canary?: MatrixQaCanaryArtifact;
  driverAccessToken: string;
  driverUserId: string;
  observedEvents: MatrixQaObservedEvent[];
  observerAccessToken: string;
  observerUserId: string;
  restartGateway?: () => Promise<void>;
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
};

const NO_REPLY_WINDOW_MS = 8_000;

export const MATRIX_QA_SCENARIOS: MatrixQaScenarioDefinition[] = [
  {
    id: "matrix-thread-follow-up",
    standardId: "thread-follow-up",
    timeoutMs: 60_000,
    title: "Matrix thread follow-up reply",
  },
  {
    id: "matrix-thread-isolation",
    standardId: "thread-isolation",
    timeoutMs: 75_000,
    title: "Matrix top-level reply stays out of prior thread",
  },
  {
    id: "matrix-top-level-reply-shape",
    standardId: "top-level-reply-shape",
    timeoutMs: 45_000,
    title: "Matrix top-level reply keeps replyToMode off",
  },
  {
    id: "matrix-reaction-notification",
    standardId: "reaction-observation",
    timeoutMs: 45_000,
    title: "Matrix reactions on bot replies are observed",
  },
  {
    id: "matrix-restart-resume",
    standardId: "restart-resume",
    timeoutMs: 60_000,
    title: "Matrix lane resumes cleanly after gateway restart",
  },
  {
    id: "matrix-mention-gating",
    standardId: "mention-gating",
    timeoutMs: NO_REPLY_WINDOW_MS,
    title: "Matrix room message without mention does not trigger",
  },
  {
    id: "matrix-allowlist-block",
    standardId: "allowlist-block",
    timeoutMs: NO_REPLY_WINDOW_MS,
    title: "Matrix allowlist blocks non-driver replies",
  },
];

export const MATRIX_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  alwaysOnStandardScenarioIds: ["canary"],
  scenarios: MATRIX_QA_SCENARIOS,
});

export function findMatrixQaScenarios(ids?: string[]) {
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Matrix",
    scenarios: MATRIX_QA_SCENARIOS,
  });
}

export function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with only this exact marker: ${token}`;
}

function buildExactMarkerPrompt(token: string) {
  return `reply with only this exact marker: ${token}`;
}

function buildMatrixReplyArtifact(
  event: MatrixQaObservedEvent,
  token?: string,
): MatrixQaReplyArtifact {
  const replyBody = event.body?.trim();
  return {
    bodyPreview: replyBody?.slice(0, 200),
    eventId: event.eventId,
    mentions: event.mentions,
    relatesTo: event.relatesTo,
    sender: event.sender,
    ...(token ? { tokenMatched: replyBody === token } : {}),
  };
}

export function buildMatrixReplyDetails(label: string, artifact: MatrixQaReplyArtifact) {
  return [
    `${label} event: ${artifact.eventId}`,
    `${label} token matched: ${
      artifact.tokenMatched === undefined ? "n/a" : artifact.tokenMatched ? "yes" : "no"
    }`,
    `${label} rel_type: ${artifact.relatesTo?.relType ?? "<none>"}`,
    `${label} in_reply_to: ${artifact.relatesTo?.inReplyToId ?? "<none>"}`,
    `${label} is_falling_back: ${artifact.relatesTo?.isFallingBack === true ? "true" : "false"}`,
  ];
}

function assertTopLevelReplyArtifact(label: string, artifact: MatrixQaReplyArtifact) {
  if (!artifact.tokenMatched) {
    throw new Error(`${label} did not contain the expected token`);
  }
  if (artifact.relatesTo !== undefined) {
    throw new Error(`${label} unexpectedly included relation metadata`);
  }
}

function assertThreadReplyArtifact(
  artifact: MatrixQaReplyArtifact,
  params: {
    expectedRootEventId: string;
    label: string;
  },
) {
  if (!artifact.tokenMatched) {
    throw new Error(`${params.label} did not contain the expected token`);
  }
  if (artifact.relatesTo?.relType !== "m.thread") {
    throw new Error(`${params.label} did not use m.thread`);
  }
  if (artifact.relatesTo.eventId !== params.expectedRootEventId) {
    throw new Error(
      `${params.label} targeted ${artifact.relatesTo.eventId ?? "<none>"} instead of ${params.expectedRootEventId}`,
    );
  }
  if (artifact.relatesTo.isFallingBack !== true) {
    throw new Error(`${params.label} did not set is_falling_back`);
  }
  if (!artifact.relatesTo.inReplyToId) {
    throw new Error(`${params.label} did not set m.in_reply_to`);
  }
}

function readMatrixQaSyncCursor(syncState: MatrixQaSyncState, actorId: MatrixQaActorId) {
  return syncState[actorId];
}

function writeMatrixQaSyncCursor(
  syncState: MatrixQaSyncState,
  actorId: MatrixQaActorId,
  since?: string,
) {
  if (since) {
    syncState[actorId] = since;
  }
}

async function primeMatrixQaActorCursor(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  syncState: MatrixQaSyncState;
}) {
  const client = createMatrixQaClient({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
  });
  const existingSince = readMatrixQaSyncCursor(params.syncState, params.actorId);
  if (existingSince) {
    return { client, startSince: existingSince };
  }
  const startSince = await client.primeRoom();
  if (!startSince) {
    throw new Error(`Matrix ${params.actorId} /sync prime did not return a next_batch cursor`);
  }
  return { client, startSince };
}

function advanceMatrixQaActorCursor(params: {
  actorId: MatrixQaActorId;
  syncState: MatrixQaSyncState;
  nextSince?: string;
  startSince: string;
}) {
  writeMatrixQaSyncCursor(params.syncState, params.actorId, params.nextSince ?? params.startSince);
}

async function runTopLevelMentionScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const token = `${params.tokenPrefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
  const body =
    params.withMention === false
      ? buildExactMarkerPrompt(token)
      : buildMentionPrompt(params.sutUserId, token);
  const driverEventId = await client.sendTextMessage({
    body,
    ...(params.withMention === false ? {} : { mentionUserIds: [params.sutUserId] }),
    roomId: params.roomId,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      event.type === "m.room.message" &&
      (event.body ?? "").includes(token) &&
      event.relatesTo === undefined,
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: params.actorId,
    syncState: params.syncState,
    nextSince: matched.since,
    startSince,
  });
  return {
    body,
    driverEventId,
    reply: buildMatrixReplyArtifact(matched.event, token),
    since: matched.since,
    token,
  };
}

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
    since: matched.since,
    token,
  };
}

async function runNoReplyExpectedScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  actorUserId: string;
  baseUrl: string;
  body: string;
  mentionUserIds?: string[];
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  token: string;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const driverEventId = await client.sendTextMessage({
    body: params.body,
    ...(params.mentionUserIds ? { mentionUserIds: params.mentionUserIds } : {}),
    roomId: params.roomId,
  });
  const result = await client.waitForOptionalRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.sutUserId &&
      event.type === "m.room.message",
    roomId: params.roomId,
    since: startSince,
    timeoutMs: params.timeoutMs,
  });
  if (result.matched) {
    const unexpectedReply = buildMatrixReplyArtifact(result.event, params.token);
    throw new Error(
      [
        `unexpected SUT reply from ${params.sutUserId}`,
        `trigger sender: ${params.actorUserId}`,
        ...buildMatrixReplyDetails("unexpected reply", unexpectedReply),
      ].join("\n"),
    );
  }
  advanceMatrixQaActorCursor({
    actorId: params.actorId,
    syncState: params.syncState,
    nextSince: result.since,
    startSince,
  });
  return {
    artifacts: {
      actorUserId: params.actorUserId,
      driverEventId,
      expectedNoReplyWindowMs: params.timeoutMs,
      token: params.token,
      triggerBody: params.body,
    },
    details: [
      `trigger event: ${driverEventId}`,
      `trigger sender: ${params.actorUserId}`,
      `waited ${params.timeoutMs}ms with no SUT reply`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

async function runReactionNotificationScenario(context: MatrixQaScenarioContext) {
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

async function runRestartResumeScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGateway) {
    throw new Error("Matrix restart scenario requires a gateway restart callback");
  }
  await context.restartGateway();
  const result = await runTopLevelMentionScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    roomId: context.roomId,
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
      token: result.token,
    },
    details: [
      "restart signal: SIGUSR1",
      `post-restart driver event: ${result.driverEventId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runMatrixQaCanary(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
}) {
  const canary = await runTopLevelMentionScenario({
    accessToken: params.driverAccessToken,
    actorId: "driver",
    baseUrl: params.baseUrl,
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

export async function runMatrixQaScenario(
  scenario: MatrixQaScenarioDefinition,
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  switch (scenario.id) {
    case "matrix-thread-follow-up": {
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
      };
    }
    case "matrix-thread-isolation": {
      const threadPhase = await runThreadScenario(context);
      assertThreadReplyArtifact(threadPhase.reply, {
        expectedRootEventId: threadPhase.rootEventId,
        label: "thread isolation reply",
      });
      const topLevelPhase = await runTopLevelMentionScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        baseUrl: context.baseUrl,
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
      };
    }
    case "matrix-top-level-reply-shape": {
      const result = await runTopLevelMentionScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        baseUrl: context.baseUrl,
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
      };
    }
    case "matrix-reaction-notification":
      return await runReactionNotificationScenario(context);
    case "matrix-restart-resume":
      return await runRestartResumeScenario(context);
    case "matrix-mention-gating": {
      const token = `MATRIX_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return await runNoReplyExpectedScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        baseUrl: context.baseUrl,
        body: buildExactMarkerPrompt(token),
        observedEvents: context.observedEvents,
        roomId: context.roomId,
        syncState: context.syncState,
        sutUserId: context.sutUserId,
        timeoutMs: context.timeoutMs,
        token,
      });
    }
    case "matrix-allowlist-block": {
      const token = `MATRIX_QA_ALLOWLIST_${randomUUID().slice(0, 8).toUpperCase()}`;
      return await runNoReplyExpectedScenario({
        accessToken: context.observerAccessToken,
        actorId: "observer",
        actorUserId: context.observerUserId,
        baseUrl: context.baseUrl,
        body: buildMentionPrompt(context.sutUserId, token),
        mentionUserIds: [context.sutUserId],
        observedEvents: context.observedEvents,
        roomId: context.roomId,
        syncState: context.syncState,
        sutUserId: context.sutUserId,
        timeoutMs: context.timeoutMs,
        token,
      });
    }
    default: {
      const exhaustiveScenarioId: never = scenario.id;
      return exhaustiveScenarioId;
    }
  }
}

export const __testing = {
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixReplyDetails,
  buildMatrixReplyArtifact,
  buildMentionPrompt,
  findMatrixQaScenarios,
  readMatrixQaSyncCursor,
  writeMatrixQaSyncCursor,
};
