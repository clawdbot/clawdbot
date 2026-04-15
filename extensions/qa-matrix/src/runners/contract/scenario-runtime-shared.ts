import { randomUUID } from "node:crypto";
import { createMatrixQaClient } from "../../substrate/client.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { type MatrixQaProvisionedTopology } from "../../substrate/topology.js";
import { resolveMatrixQaScenarioRoomId } from "./scenario-catalog.js";
import type {
  MatrixQaCanaryArtifact,
  MatrixQaReplyArtifact,
  MatrixQaScenarioExecution,
} from "./scenario-types.js";

export type MatrixQaActorId = "driver" | "observer";

export type MatrixQaSyncState = Partial<Record<MatrixQaActorId, string>>;

export type MatrixQaScenarioContext = {
  baseUrl: string;
  canary?: MatrixQaCanaryArtifact;
  driverAccessToken: string;
  driverUserId: string;
  observedEvents: MatrixQaObservedEvent[];
  observerAccessToken: string;
  observerUserId: string;
  restartGateway?: () => Promise<void>;
  roomId: string;
  interruptTransport?: () => Promise<void>;
  sutAccessToken: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  topology: MatrixQaProvisionedTopology;
};

export const NO_REPLY_WINDOW_MS = 8_000;

export function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with only this exact marker: ${token}`;
}

export function buildExactMarkerPrompt(token: string) {
  return `reply with only this exact marker: ${token}`;
}

export function buildMatrixQuietStreamingPrompt(sutUserId: string, text: string) {
  return `${sutUserId} Matrix quiet streaming QA check: reply exactly \`${text}\`.`;
}

export function buildMatrixBlockStreamingPrompt(
  sutUserId: string,
  firstText: string,
  secondText: string,
) {
  return [
    sutUserId,
    "Matrix block streaming QA check:",
    "emit exactly two assistant message blocks in order.",
    `First exact marker: \`${firstText}\`.`,
    `Second exact marker: \`${secondText}\`.`,
  ].join(" ");
}

export function isMatrixQaMessageLikeKind(kind: MatrixQaObservedEvent["kind"]) {
  return kind === "message" || kind === "notice";
}

export function buildMatrixReplyArtifact(
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

export function buildMatrixNoticeArtifact(event: MatrixQaObservedEvent) {
  return {
    bodyPreview: event.body?.trim().slice(0, 200),
    eventId: event.eventId,
    sender: event.sender,
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

export function assertTopLevelReplyArtifact(label: string, artifact: MatrixQaReplyArtifact) {
  if (!artifact.tokenMatched) {
    throw new Error(`${label} did not contain the expected token`);
  }
  if (artifact.relatesTo !== undefined) {
    throw new Error(`${label} unexpectedly included relation metadata`);
  }
}

export function assertThreadReplyArtifact(
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

export function readMatrixQaSyncCursor(syncState: MatrixQaSyncState, actorId: MatrixQaActorId) {
  return syncState[actorId];
}

export function writeMatrixQaSyncCursor(
  syncState: MatrixQaSyncState,
  actorId: MatrixQaActorId,
  since?: string,
) {
  if (since) {
    syncState[actorId] = since;
  }
}

export async function primeMatrixQaActorCursor(params: {
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

export function advanceMatrixQaActorCursor(params: {
  actorId: MatrixQaActorId;
  syncState: MatrixQaSyncState;
  nextSince?: string;
  startSince: string;
}) {
  writeMatrixQaSyncCursor(params.syncState, params.actorId, params.nextSince ?? params.startSince);
}

export function createMatrixQaScenarioClient(params: { accessToken: string; baseUrl: string }) {
  return createMatrixQaClient({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
  });
}

export async function runConfigurableTopLevelScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  replyPredicate?: (
    event: MatrixQaObservedEvent,
    params: { driverEventId: string; token: string },
  ) => boolean;
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
      (params.replyPredicate?.(event, { driverEventId, token }) ?? event.relatesTo === undefined),
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
    token,
  };
}

export async function runTopLevelMentionScenario(params: {
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
  return await runConfigurableTopLevelScenario(params);
}

export async function runDriverTopLevelMentionScenario(params: {
  baseUrl: string;
  driverAccessToken: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  sutUserId: string;
  timeoutMs: number;
  tokenPrefix: string;
}) {
  return await runTopLevelMentionScenario({
    accessToken: params.driverAccessToken,
    actorId: "driver",
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    roomId: params.roomId,
    syncState: params.syncState,
    sutUserId: params.sutUserId,
    timeoutMs: params.timeoutMs,
    tokenPrefix: params.tokenPrefix,
  });
}

export async function waitForMembershipEvent(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  membership: "invite" | "join" | "leave";
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  stateKey: string;
  syncState: MatrixQaSyncState;
  timeoutMs: number;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    syncState: params.syncState,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.type === "m.room.member" &&
      event.stateKey === params.stateKey &&
      event.membership === params.membership,
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
  return matched.event;
}

export async function runTopologyScopedTopLevelScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  actorUserId: string;
  context: MatrixQaScenarioContext;
  roomKey: string;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  const roomId = resolveMatrixQaScenarioRoomId(params.context, params.roomKey);
  const result = await runTopLevelMentionScenario({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.context.baseUrl,
    observedEvents: params.context.observedEvents,
    roomId,
    syncState: params.context.syncState,
    sutUserId: params.context.sutUserId,
    timeoutMs: params.context.timeoutMs,
    tokenPrefix: params.tokenPrefix,
    withMention: params.withMention,
  });
  assertTopLevelReplyArtifact(`reply in ${params.roomKey}`, result.reply);
  return {
    artifacts: {
      actorUserId: params.actorUserId,
      driverEventId: result.driverEventId,
      reply: result.reply,
      roomKey: params.roomKey,
      token: result.token,
      triggerBody: result.body,
    },
    details: [
      `room key: ${params.roomKey}`,
      `room id: ${roomId}`,
      `driver event: ${result.driverEventId}`,
      `trigger sender: ${params.actorUserId}`,
      ...buildMatrixReplyDetails("reply", result.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runNoReplyExpectedScenario(params: {
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
