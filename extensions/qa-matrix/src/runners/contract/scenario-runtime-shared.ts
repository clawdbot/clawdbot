import { randomUUID } from "node:crypto";
import { createMatrixQaClient, type MatrixQaRoomObserver } from "../../substrate/client.js";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { createMatrixQaRoomObserver } from "../../substrate/sync.js";
import { type MatrixQaProvisionedTopology } from "../../substrate/topology.js";
import { resolveMatrixQaScenarioRoomId } from "./scenario-catalog.js";
import type {
  MatrixQaCanaryArtifact,
  MatrixQaReplyArtifact,
  MatrixQaScenarioExecution,
} from "./scenario-types.js";

export type MatrixQaActorId = "driver" | "observer";

export type MatrixQaSyncState = Partial<Record<MatrixQaActorId, string>>;
export type MatrixQaSyncStreams = Partial<Record<MatrixQaActorId, MatrixQaRoomObserver>>;

export type MatrixQaScenarioContext = {
  baseUrl: string;
  canary?: MatrixQaCanaryArtifact;
  driverAccessToken: string;
  driverDeviceId?: string;
  driverPassword?: string;
  driverUserId: string;
  observedEvents: MatrixQaObservedEvent[];
  observerAccessToken: string;
  observerDeviceId?: string;
  observerPassword?: string;
  observerUserId: string;
  gatewayRuntimeEnv?: NodeJS.ProcessEnv;
  gatewayStateDir?: string;
  gatewayCall?: (
    method: string,
    params?: Record<string, unknown>,
    opts?: { expectFinal?: boolean; timeoutMs?: number },
  ) => Promise<unknown>;
  outputDir?: string;
  registrationToken?: string;
  restartGateway?: () => Promise<void>;
  restartGatewayAfterStateMutation?: (
    mutateState: (context: { stateDir: string }) => Promise<void>,
    opts?: { timeoutMs?: number; waitAccountId?: string },
  ) => Promise<void>;
  restartGatewayWithQueuedMessage?: (queueMessage: () => Promise<void>) => Promise<void>;
  roomId: string;
  interruptTransport?: () => Promise<void>;
  sutAccessToken: string;
  sutAccountId?: string;
  sutDeviceId?: string;
  sutPassword?: string;
  syncState: MatrixQaSyncState;
  syncStreams?: MatrixQaSyncStreams;
  sutUserId: string;
  timeoutMs: number;
  topology: MatrixQaProvisionedTopology;
  patchGatewayConfig?: (
    patch: Record<string, unknown>,
    opts?: { restartDelayMs?: number },
  ) => Promise<void>;
  waitGatewayAccountReady?: (accountId: string, opts?: { timeoutMs?: number }) => Promise<void>;
};

const NO_REPLY_WINDOW_MS = 8_000;
const NO_REPLY_WINDOW_ENV = "OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS";

export function resolveMatrixQaNoReplyWindowMs(timeoutMs: number) {
  const raw = process.env[NO_REPLY_WINDOW_ENV];
  const parsed = raw === undefined ? NO_REPLY_WINDOW_MS : Number(raw);
  const windowMs = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : NO_REPLY_WINDOW_MS;
  return Math.min(windowMs, timeoutMs);
}

export function buildMentionPrompt(sutUserId: string, token: string) {
  return `${sutUserId} reply with only this exact marker: ${token}`;
}

export function buildExactMarkerPrompt(token: string) {
  return `reply with only this exact marker: ${token}`;
}

export function buildMatrixQaToken(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function buildMatrixQuietStreamingPrompt(sutUserId: string, text: string) {
  return `${sutUserId} Quiet streaming QA check: reply exactly \`${text}\`.`;
}

export function buildMatrixPartialStreamingPrompt(sutUserId: string, text: string) {
  return `${sutUserId} Partial streaming QA check: reply exactly \`${text}\`.`;
}

export function buildMatrixToolProgressPrompt(sutUserId: string, text: string) {
  return [
    `${sutUserId} Tool progress QA check: use the read tool exactly once on \`QA_KICKOFF_TASK.md\` before answering.`,
    `Do not read \`HEARTBEAT.md\` for this check.`,
    `After that read completes, reply with only this exact marker and no other text: \`${text}\`.`,
  ].join(" ");
}

export function buildMatrixToolProgressErrorPrompt(sutUserId: string, text: string) {
  return [
    `${sutUserId} Tool progress error QA check: read \`missing-matrix-tool-progress-target.txt\` before answering.`,
    `After the read fails, reply exactly \`${text}\`.`,
  ].join(" ");
}

export function buildMatrixToolProgressMentionSafetyPrompt(sutUserId: string, text: string) {
  return [
    `${sutUserId} Tool progress QA check: read \`matrix-progress-@room-@alice:matrix-qa.test-!room:matrix-qa.test.txt\` before answering.`,
    `After the read completes, reply exactly \`${text}\`.`,
  ].join(" ");
}

export function buildMatrixBlockStreamingPrompt(
  sutUserId: string,
  firstText: string,
  secondText: string,
) {
  return [
    `${sutUserId} Block streaming QA check: first reply with only this exact marker: \`${firstText}\`.`,
    "Then use the read tool exactly once on `QA_KICKOFF_TASK.md`.",
    `After that read completes, reply with only this exact marker: \`${secondText}\`.`,
  ].join("\n");
}

export function isMatrixQaMessageLikeKind(kind: MatrixQaObservedEvent["kind"]) {
  return kind === "message" || kind === "notice";
}

export function doesMatrixQaReplyBodyMatchToken(event: MatrixQaObservedEvent, token: string) {
  return event.body?.trim() === token;
}

export function isMatrixQaExactMarkerReply(
  event: MatrixQaObservedEvent,
  params: {
    roomId: string;
    sutUserId: string;
    token: string;
  },
) {
  return (
    event.roomId === params.roomId &&
    event.sender === params.sutUserId &&
    event.type === "m.room.message" &&
    isMatrixQaMessageLikeKind(event.kind) &&
    doesMatrixQaReplyBodyMatchToken(event, params.token)
  );
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
    ...(token ? { tokenMatched: doesMatrixQaReplyBodyMatchToken(event, token) } : {}),
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

function getOrCreateMatrixQaActorSyncStream(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  syncState: MatrixQaSyncState;
  syncStreams?: MatrixQaSyncStreams;
}) {
  const existingStream = params.syncStreams?.[params.actorId];
  if (existingStream) {
    return existingStream;
  }
  const stream = createMatrixQaRoomObserver({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    since: readMatrixQaSyncCursor(params.syncState, params.actorId),
  });
  if (params.syncStreams) {
    params.syncStreams[params.actorId] = stream;
  }
  return stream;
}

export function createMatrixQaScenarioClient(params: {
  accessToken: string;
  actorId?: MatrixQaActorId;
  baseUrl: string;
  observedEvents?: MatrixQaObservedEvent[];
  syncState?: MatrixQaSyncState;
  syncStreams?: MatrixQaSyncStreams;
}) {
  const syncObserver =
    params.actorId && params.observedEvents && params.syncState && params.syncStreams
      ? getOrCreateMatrixQaActorSyncStream({
          accessToken: params.accessToken,
          actorId: params.actorId,
          baseUrl: params.baseUrl,
          observedEvents: params.observedEvents,
          syncState: params.syncState,
          syncStreams: params.syncStreams,
        })
      : undefined;
  return createMatrixQaClient({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    ...(syncObserver ? { syncObserver } : {}),
  });
}

export function createMatrixQaDriverScenarioClient(context: MatrixQaScenarioContext) {
  return createMatrixQaScenarioClient({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
  });
}

export async function primeMatrixQaActorCursor(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  syncState: MatrixQaSyncState;
  syncStreams?: MatrixQaSyncStreams;
}) {
  const client = createMatrixQaScenarioClient({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    syncState: params.syncState,
    syncStreams: params.syncStreams,
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

export async function primeMatrixQaDriverScenarioClient(context: MatrixQaScenarioContext) {
  return await primeMatrixQaActorCursor({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    baseUrl: context.baseUrl,
    observedEvents: context.observedEvents,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
  });
}

export function advanceMatrixQaActorCursor(params: {
  actorId: MatrixQaActorId;
  syncState: MatrixQaSyncState;
  nextSince?: string;
  startSince: string;
}) {
  writeMatrixQaSyncCursor(params.syncState, params.actorId, params.nextSince ?? params.startSince);
}

type MatrixQaScenarioClient = ReturnType<typeof createMatrixQaScenarioClient>;

export async function assertNoSutReplyWindow(params: {
  actorId: MatrixQaActorId;
  client: MatrixQaScenarioClient;
  context: MatrixQaScenarioContext;
  roomId: string;
  since?: string;
  startSince: string;
  unexpectedLines?: string[];
  unexpectedMessage: string;
}) {
  const noReplyWindowMs = resolveMatrixQaNoReplyWindowMs(params.context.timeoutMs);
  const result = await params.client.waitForOptionalRoomEvent({
    observedEvents: params.context.observedEvents,
    predicate: (event) =>
      event.roomId === params.roomId &&
      event.sender === params.context.sutUserId &&
      event.type === "m.room.message",
    roomId: params.roomId,
    since: params.since,
    timeoutMs: noReplyWindowMs,
  });
  if (result.matched) {
    throw new Error(
      [
        params.unexpectedMessage,
        ...(params.unexpectedLines ?? []),
        ...buildMatrixReplyDetails("unexpected reply", buildMatrixReplyArtifact(result.event)),
      ].join("\n"),
    );
  }
  advanceMatrixQaActorCursor({
    actorId: params.actorId,
    syncState: params.context.syncState,
    nextSince: result.since,
    startSince: params.startSince,
  });
  return {
    noReplyWindowMs,
    since: result.since,
  };
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
  syncStreams?: MatrixQaSyncStreams;
  sutUserId: string;
  timeoutMs: number;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    syncState: params.syncState,
    syncStreams: params.syncStreams,
  });
  const token = buildMatrixQaToken(params.tokenPrefix);
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
      isMatrixQaExactMarkerReply(event, {
        roomId: params.roomId,
        sutUserId: params.sutUserId,
        token,
      }) &&
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

async function runTopLevelMentionScenario(params: {
  accessToken: string;
  actorId: MatrixQaActorId;
  baseUrl: string;
  observedEvents: MatrixQaObservedEvent[];
  roomId: string;
  syncState: MatrixQaSyncState;
  syncStreams?: MatrixQaSyncStreams;
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
  syncStreams?: MatrixQaSyncStreams;
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
    syncStreams: params.syncStreams,
    sutUserId: params.sutUserId,
    timeoutMs: params.timeoutMs,
    tokenPrefix: params.tokenPrefix,
  });
}

export async function runAssertedDriverTopLevelScenario(params: {
  context: MatrixQaScenarioContext;
  label: string;
  roomId?: string;
  tokenPrefix: string;
}) {
  const result = await runDriverTopLevelMentionScenario({
    baseUrl: params.context.baseUrl,
    driverAccessToken: params.context.driverAccessToken,
    observedEvents: params.context.observedEvents,
    roomId: params.roomId ?? params.context.roomId,
    syncState: params.context.syncState,
    syncStreams: params.context.syncStreams,
    sutUserId: params.context.sutUserId,
    timeoutMs: params.context.timeoutMs,
    tokenPrefix: params.tokenPrefix,
  });
  assertTopLevelReplyArtifact(params.label, result.reply);
  return result;
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
  syncStreams?: MatrixQaSyncStreams;
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
    syncStreams: params.context.syncStreams,
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
  sendClient?: MatrixQaScenarioClient;
  syncState: MatrixQaSyncState;
  syncStreams?: MatrixQaSyncStreams;
  sutUserId: string;
  replyPredicate?: (
    event: MatrixQaObservedEvent,
    match: { driverEventId: string; token: string },
  ) => boolean;
  timeoutMs: number;
  token: string;
}) {
  const { client, startSince } = await primeMatrixQaActorCursor({
    accessToken: params.accessToken,
    actorId: params.actorId,
    baseUrl: params.baseUrl,
    observedEvents: params.observedEvents,
    syncState: params.syncState,
    syncStreams: params.syncStreams,
  });
  const sendClient = params.sendClient ?? client;
  const triggerEventId = await sendClient.sendTextMessage({
    body: params.body,
    ...(params.mentionUserIds ? { mentionUserIds: params.mentionUserIds } : {}),
    roomId: params.roomId,
  });
  let observedTriggerEvent = false;
  const result = await client.waitForOptionalRoomEvent({
    observedEvents: params.observedEvents,
    predicate: (event) => {
      if (event.roomId !== params.roomId) {
        return false;
      }
      if (event.eventId === triggerEventId) {
        observedTriggerEvent = true;
        return false;
      }
      return (
        observedTriggerEvent &&
        event.sender === params.sutUserId &&
        event.type === "m.room.message" &&
        (params.replyPredicate?.(event, { driverEventId: triggerEventId, token: params.token }) ??
          true)
      );
    },
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
      driverEventId: triggerEventId,
      expectedNoReplyWindowMs: params.timeoutMs,
      token: params.token,
      triggerBody: params.body,
    },
    details: [
      `trigger event: ${triggerEventId}`,
      `trigger sender: ${params.actorUserId}`,
      `waited ${params.timeoutMs}ms with no SUT reply`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
