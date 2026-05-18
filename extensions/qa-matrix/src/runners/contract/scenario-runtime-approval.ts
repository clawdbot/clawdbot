import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { MatrixQaObservedEvent } from "../../substrate/events.js";
import { MATRIX_QA_DRIVER_DM_ROOM_KEY, resolveMatrixQaScenarioRoomId } from "./scenario-catalog.js";
import {
  advanceMatrixQaActorCursor,
  buildMatrixQaToken,
  createMatrixQaDriverScenarioClient,
  createMatrixQaScenarioClient,
  primeMatrixQaDriverScenarioClient,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

const MATRIX_QA_APPROVAL_ALLOW_ONCE_REACTION = "✅";
const MATRIX_QA_APPROVAL_DENY_REACTION = "❌";
const MATRIX_QA_APPROVAL_DECISION_TIMEOUT_MS = 30_000;
const MATRIX_QA_APPROVAL_SHORT_WINDOW_MS = 4_000;
const MATRIX_QA_APPROVAL_LONG_COMMAND_TEXT = "matrix approval chunk fallback ".repeat(40);

type MatrixQaApprovalDecision = "allow-once" | "deny";
type MatrixQaApprovalKind = "exec" | "plugin";
type MatrixQaApprovalOptionReactionParams = {
  context: MatrixQaScenarioContext;
  emoji: string;
  roomId: string;
  targetEventId: string;
};

function requireMatrixQaGatewayCall(context: MatrixQaScenarioContext) {
  if (!context.gatewayCall) {
    throw new Error("Matrix approval QA scenario requires a live gateway RPC client");
  }
  return context.gatewayCall;
}

function buildMatrixApprovalArtifact(event: MatrixQaObservedEvent) {
  if (!event.approval) {
    throw new Error(`Matrix event ${event.eventId} did not include approval metadata`);
  }
  return {
    ...event.approval,
    eventId: event.eventId,
    roomId: event.roomId,
  };
}

function isApprovalOptionReaction(
  event: MatrixQaObservedEvent,
  params: MatrixQaApprovalOptionReactionParams,
) {
  return (
    event.roomId === params.roomId &&
    event.sender === params.context.sutUserId &&
    event.type === "m.reaction" &&
    event.reaction?.eventId === params.targetEventId &&
    event.reaction.key === params.emoji
  );
}

function hasObservedApprovalOptionReaction(params: MatrixQaApprovalOptionReactionParams) {
  return params.context.observedEvents.some((event) => isApprovalOptionReaction(event, params));
}

function assertApprovalMetadata(params: {
  event: { approval?: unknown; eventId: string };
  expectedKind: MatrixQaApprovalKind;
}) {
  const approval =
    typeof params.event.approval === "object" && params.event.approval !== null
      ? (params.event.approval as {
          allowedDecisions?: string[];
          hasCommandText?: boolean;
          id?: string;
          kind?: string;
          state?: string;
          type?: string;
          version?: number;
        })
      : null;
  if (!approval) {
    throw new Error(`approval event ${params.event.eventId} did not expose metadata`);
  }
  if (approval.kind !== params.expectedKind) {
    throw new Error(
      `approval event ${params.event.eventId} kind was ${approval.kind ?? "<missing>"} instead of ${params.expectedKind}`,
    );
  }
  if (!approval.id) {
    throw new Error(`approval event ${params.event.eventId} did not expose an approval id`);
  }
  if (approval.version !== 1) {
    throw new Error(`approval event ${params.event.eventId} did not expose version=1`);
  }
  if (approval.type !== "approval.request") {
    throw new Error(`approval event ${params.event.eventId} did not expose type=approval.request`);
  }
  if (approval.state !== "pending") {
    throw new Error(`approval event ${params.event.eventId} did not expose state=pending`);
  }
  if (!approval.allowedDecisions?.includes("deny")) {
    throw new Error(`approval event ${params.event.eventId} did not include deny`);
  }
  if (
    params.expectedKind === "exec" &&
    (!approval.allowedDecisions.includes("allow-once") || approval.hasCommandText !== true)
  ) {
    throw new Error(`approval event ${params.event.eventId} did not expose exec approval fields`);
  }
}

function isExpectedApprovalEvent(
  event: MatrixQaObservedEvent,
  params: {
    context: MatrixQaScenarioContext;
    expectedApprovalId: string;
    expectedKind: MatrixQaApprovalKind;
    roomId: string;
    threadRootEventId?: string;
  },
) {
  return (
    event.roomId === params.roomId &&
    event.sender === params.context.sutUserId &&
    event.type === "m.room.message" &&
    event.approval?.kind === params.expectedKind &&
    event.approval.id === params.expectedApprovalId &&
    (!params.threadRootEventId || event.relatesTo?.eventId === params.threadRootEventId)
  );
}

async function waitForApprovalEvent(params: {
  context: MatrixQaScenarioContext;
  expectedApprovalId: string;
  expectedKind: MatrixQaApprovalKind;
  roomId: string;
  since?: string;
  threadRootEventId?: string;
}) {
  const observedMatch = params.context.observedEvents.find((event) =>
    isExpectedApprovalEvent(event, params),
  );
  if (observedMatch) {
    assertApprovalMetadata({
      event: observedMatch,
      expectedKind: params.expectedKind,
    });
    return {
      event: observedMatch,
      since: params.since,
    };
  }
  const client = createMatrixQaScenarioClient({
    accessToken: params.context.driverAccessToken,
    baseUrl: params.context.baseUrl,
  });
  const matched = await client.waitForRoomEvent({
    observedEvents: params.context.observedEvents,
    predicate: (event) => isExpectedApprovalEvent(event, params),
    roomId: params.roomId,
    since: params.since,
    timeoutMs: params.context.timeoutMs,
  });
  assertApprovalMetadata({
    event: matched.event,
    expectedKind: params.expectedKind,
  });
  return matched;
}

async function waitForObservedApprovalEvent(params: {
  context: MatrixQaScenarioContext;
  expectedApprovalId: string;
  expectedKind: MatrixQaApprovalKind;
  excludedRoomIds?: string[];
  roomIds: string[];
  timeoutMs: number;
}) {
  const client = createMatrixQaDriverScenarioClient(params.context);
  const roomIds = Array.from(
    new Set(params.roomIds.map((roomId) => roomId.trim()).filter(Boolean)),
  );
  const primaryRoomId = roomIds[0];
  if (!primaryRoomId) {
    throw new Error("Matrix approval wait requires at least one candidate room");
  }
  const excludedRoomIds = new Set(params.excludedRoomIds ?? []);
  const isExpectedObservedApproval = (event: MatrixQaObservedEvent) => {
    if (excludedRoomIds.has(event.roomId)) {
      return false;
    }
    if (
      roomIds.some((roomId) =>
        isExpectedApprovalEvent(event, {
          ...params,
          roomId,
        }),
      )
    ) {
      return true;
    }
    return (
      event.sender === params.context.sutUserId &&
      event.type === "m.room.message" &&
      event.approval?.kind === params.expectedKind &&
      event.approval.id === params.expectedApprovalId
    );
  };
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    const observedMatch = params.context.observedEvents.find(isExpectedObservedApproval);
    if (observedMatch) {
      assertApprovalMetadata({
        event: observedMatch,
        expectedKind: params.expectedKind,
      });
      return {
        event: observedMatch,
        since: undefined,
      };
    }
    const remainingMs = params.timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await client.waitForOptionalRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: isExpectedObservedApproval,
      roomId: primaryRoomId,
      timeoutMs: Math.min(1_000, remainingMs),
    });
    await sleep(Math.min(100, Math.max(25, params.timeoutMs - (Date.now() - startedAt))));
  }
  throw new Error(
    `timed out waiting for observed Matrix approval ${params.expectedApprovalId} in ${roomIds.join(", ")}`,
  );
}

function listDriverDmApprovalCandidateRoomIds(context: MatrixQaScenarioContext) {
  const preferredRoomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_DRIVER_DM_ROOM_KEY);
  return [
    preferredRoomId,
    ...context.topology.rooms
      .filter(
        (room) =>
          room.kind === "dm" &&
          room.memberRoles.includes("driver") &&
          room.memberRoles.includes("sut"),
      )
      .map((room) => room.roomId),
  ];
}

async function reactToApproval(params: {
  context: MatrixQaScenarioContext;
  decision: MatrixQaApprovalDecision;
  roomId: string;
  targetEventId: string;
}) {
  const client = createMatrixQaDriverScenarioClient(params.context);
  const emoji =
    params.decision === "allow-once"
      ? MATRIX_QA_APPROVAL_ALLOW_ONCE_REACTION
      : MATRIX_QA_APPROVAL_DENY_REACTION;
  if (
    !hasObservedApprovalOptionReaction({
      context: params.context,
      emoji,
      roomId: params.roomId,
      targetEventId: params.targetEventId,
    })
  ) {
    await client.waitForRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: (event) =>
        isApprovalOptionReaction(event, {
          context: params.context,
          emoji,
          roomId: params.roomId,
          targetEventId: params.targetEventId,
        }),
      roomId: params.roomId,
      timeoutMs: params.context.timeoutMs,
    });
  }
  const eventId = await client.sendReaction({
    emoji,
    messageId: params.targetEventId,
    roomId: params.roomId,
  });
  await client
    .waitForRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: (event) =>
        event.roomId === params.roomId &&
        event.sender === params.context.driverUserId &&
        event.type === "m.reaction" &&
        event.reaction?.eventId === params.targetEventId &&
        event.reaction.key === emoji,
      roomId: params.roomId,
      timeoutMs: params.context.timeoutMs,
    })
    .catch((err: unknown) => {
      throw new Error(
        `Matrix approval reaction ${eventId} was not observed before waiting for the gateway decision: ${String(err)}`,
      );
    });
  return {
    eventId,
    reaction: {
      eventId: params.targetEventId,
      key: emoji,
    },
  };
}

function assertApprovalDecisionResult(params: {
  approvalId: string;
  decision: MatrixQaApprovalDecision;
  result: unknown;
}) {
  const result =
    typeof params.result === "object" && params.result !== null
      ? (params.result as { decision?: unknown; id?: unknown })
      : null;
  if (result?.id !== params.approvalId) {
    throw new Error(
      `approval decision result id was ${formatApprovalResultValue(result?.id)} instead of ${params.approvalId}`,
    );
  }
  if (result?.decision !== params.decision) {
    throw new Error(
      `approval decision was ${formatApprovalResultValue(result?.decision)} instead of ${params.decision}`,
    );
  }
}

function formatApprovalResultValue(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "<missing>";
  }
  return JSON.stringify(value) ?? "<unserializable>";
}

async function requestExecApproval(params: {
  context: MatrixQaScenarioContext;
  command: string;
  id?: string;
  threadRootEventId?: string;
}) {
  const gatewayCall = requireMatrixQaGatewayCall(params.context);
  return await gatewayCall(
    "exec.approval.request",
    {
      ...(params.id ? { id: params.id } : {}),
      ask: "always",
      command: params.command,
      host: "gateway",
      security: "full",
      timeoutMs: MATRIX_QA_APPROVAL_DECISION_TIMEOUT_MS,
      twoPhase: true,
      turnSourceAccountId: params.context.sutAccountId,
      turnSourceChannel: "matrix",
      turnSourceTo: `room:${params.context.roomId}`,
      ...(params.threadRootEventId ? { turnSourceThreadId: params.threadRootEventId } : {}),
    },
    {
      expectFinal: false,
      timeoutMs: MATRIX_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

async function requestPluginApproval(params: { context: MatrixQaScenarioContext; token: string }) {
  const gatewayCall = requireMatrixQaGatewayCall(params.context);
  return await gatewayCall(
    "plugin.approval.request",
    {
      agentId: "qa",
      description: `Matrix plugin approval QA request ${params.token}`,
      pluginId: "qa-matrix-plugin",
      severity: "warning",
      timeoutMs: MATRIX_QA_APPROVAL_DECISION_TIMEOUT_MS,
      title: "Matrix plugin approval QA",
      toolName: "matrix_qa_tool",
      twoPhase: true,
      turnSourceAccountId: params.context.sutAccountId,
      turnSourceChannel: "matrix",
      turnSourceTo: `room:${params.context.roomId}`,
    },
    {
      expectFinal: false,
      timeoutMs: MATRIX_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

async function waitForApprovalDecision(params: {
  approvalId: string;
  context: MatrixQaScenarioContext;
  kind: MatrixQaApprovalKind;
}) {
  const gatewayCall = requireMatrixQaGatewayCall(params.context);
  const method =
    params.kind === "exec" ? "exec.approval.waitDecision" : "plugin.approval.waitDecision";
  return await gatewayCall(
    method,
    { id: params.approvalId },
    {
      expectFinal: true,
      timeoutMs: MATRIX_QA_APPROVAL_DECISION_TIMEOUT_MS + 5_000,
    },
  );
}

async function resolveApprovalDecision(params: {
  approvalId: string;
  context: MatrixQaScenarioContext;
  decision: MatrixQaApprovalDecision;
  kind: MatrixQaApprovalKind;
}) {
  const gatewayCall = requireMatrixQaGatewayCall(params.context);
  const method = params.kind === "exec" ? "exec.approval.resolve" : "plugin.approval.resolve";
  return await gatewayCall(
    method,
    { decision: params.decision, id: params.approvalId },
    {
      expectFinal: false,
      timeoutMs: 5_000,
    },
  );
}

function readAcceptedApprovalRequest(result: unknown) {
  const accepted =
    typeof result === "object" && result !== null
      ? (result as { id?: unknown; status?: unknown })
      : null;
  if (accepted?.status !== "accepted") {
    throw new Error(
      `approval request status was ${formatApprovalResultValue(accepted?.status)} instead of accepted`,
    );
  }
  return accepted;
}

function assertAcceptedApprovalRequest(params: { approvalId: string; result: unknown }) {
  const id = readAcceptedApprovalRequest(params.result).id;
  if (id !== params.approvalId) {
    throw new Error(
      `accepted approval id was ${formatApprovalResultValue(id)} instead of ${params.approvalId}`,
    );
  }
}

function readAcceptedApprovalRequestId(result: unknown) {
  const id = readAcceptedApprovalRequest(result).id;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("approval request did not return an accepted approval id");
  }
  return id;
}

function buildExecApprovalCommand(params: { expectChunk?: boolean; token: string }) {
  if (!params.expectChunk) {
    return `printf ${params.token}`;
  }
  return `printf '${params.token} ${MATRIX_QA_APPROVAL_LONG_COMMAND_TEXT}'`;
}

async function runExecApprovalScenario(params: {
  context: MatrixQaScenarioContext;
  decision: MatrixQaApprovalDecision;
  expectChunk?: boolean;
  tokenPrefix: string;
  threadRootEventId?: string;
}) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(params.context);
  const token = buildMatrixQaToken(params.tokenPrefix);
  const command = buildExecApprovalCommand({ expectChunk: params.expectChunk, token });
  const approvalId = `qa-${token.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const accepted = await requestExecApproval({
    context: params.context,
    command,
    id: approvalId,
    threadRootEventId: params.threadRootEventId,
  });
  assertAcceptedApprovalRequest({ approvalId, result: accepted });
  const approval = await waitForApprovalEvent({
    context: params.context,
    expectedApprovalId: approvalId,
    expectedKind: "exec",
    roomId: params.context.roomId,
    since: startSince,
    threadRootEventId: params.threadRootEventId,
  });
  if (params.expectChunk) {
    const chunk = await client.waitForRoomEvent({
      observedEvents: params.context.observedEvents,
      predicate: (event) =>
        event.roomId === params.context.roomId &&
        event.sender === params.context.sutUserId &&
        event.type === "m.room.message" &&
        event.body?.includes(token) === true &&
        event.eventId !== approval.event.eventId &&
        event.approval === undefined,
      roomId: params.context.roomId,
      timeoutMs: params.context.timeoutMs,
    });
    if (chunk.event.approval) {
      throw new Error(`chunk event ${chunk.event.eventId} unexpectedly duplicated metadata`);
    }
  }
  const reaction = await reactToApproval({
    context: params.context,
    decision: params.decision,
    roomId: params.context.roomId,
    targetEventId: approval.event.eventId,
  });
  const result = await waitForApprovalDecision({
    approvalId,
    context: params.context,
    kind: "exec",
  });
  assertApprovalDecisionResult({
    approvalId,
    decision: params.decision,
    result,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: params.context.syncState,
    nextSince: approval.since,
    startSince,
  });
  return {
    artifacts: {
      approval: buildMatrixApprovalArtifact(approval.event),
      reactionEmoji: reaction.reaction?.key,
      reactionEventId: reaction.eventId,
      reactionTargetEventId: reaction.reaction?.eventId,
      token,
    },
    details: [
      `approval event: ${approval.event.eventId}`,
      `approval id: ${approvalId}`,
      `approval kind: ${approval.event.approval?.kind ?? "<missing>"}`,
      `decision: ${params.decision}`,
      `reaction event: ${reaction.eventId}`,
      `reaction target: ${reaction.reaction?.eventId ?? "<missing>"}`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runApprovalExecMetadataSingleEventScenario(context: MatrixQaScenarioContext) {
  return await runExecApprovalScenario({
    context,
    decision: "allow-once",
    tokenPrefix: "MATRIX_QA_APPROVAL_EXEC",
  });
}

export async function runApprovalExecMetadataChunkedScenario(context: MatrixQaScenarioContext) {
  return await runExecApprovalScenario({
    context,
    decision: "allow-once",
    expectChunk: true,
    tokenPrefix: "MATRIX_QA_APPROVAL_CHUNKED",
  });
}

export async function runApprovalDenyReactionScenario(context: MatrixQaScenarioContext) {
  return await runExecApprovalScenario({
    context,
    decision: "deny",
    tokenPrefix: "MATRIX_QA_APPROVAL_DENY",
  });
}

export async function runApprovalThreadTargetScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const token = buildMatrixQaToken("MATRIX_QA_APPROVAL_THREAD_ROOT");
  const rootEventId = await client.sendTextMessage({
    body: `Matrix approval thread root ${token}`,
    roomId: context.roomId,
  });
  const result = await runExecApprovalScenario({
    context,
    decision: "allow-once",
    threadRootEventId: rootEventId,
    tokenPrefix: "MATRIX_QA_APPROVAL_THREAD",
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    startSince,
  });
  return {
    artifacts: {
      ...result.artifacts,
      rootEventId,
    },
    details: [result.details, `thread root event: ${rootEventId}`].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runApprovalPluginMetadataSingleEventScenario(
  context: MatrixQaScenarioContext,
) {
  const { startSince } = await primeMatrixQaDriverScenarioClient(context);
  const token = buildMatrixQaToken("MATRIX_QA_PLUGIN_APPROVAL");
  const accepted = await requestPluginApproval({ context, token });
  const approvalId = readAcceptedApprovalRequestId(accepted);
  const approval = await waitForApprovalEvent({
    context,
    expectedApprovalId: approvalId,
    expectedKind: "plugin",
    roomId: context.roomId,
    since: startSince,
  });
  const approvalMetadata = approval.event.approval;
  if (
    approvalMetadata?.pluginId !== "qa-matrix-plugin" ||
    approvalMetadata.toolName !== "matrix_qa_tool" ||
    approvalMetadata.severity !== "warning" ||
    approvalMetadata.agentId !== "qa"
  ) {
    throw new Error(`plugin approval event ${approval.event.eventId} did not expose plugin fields`);
  }
  const reaction = await reactToApproval({
    context,
    decision: "allow-once",
    roomId: context.roomId,
    targetEventId: approval.event.eventId,
  });
  const result = await waitForApprovalDecision({
    approvalId,
    context,
    kind: "plugin",
  });
  assertApprovalDecisionResult({
    approvalId,
    decision: "allow-once",
    result,
  });
  return {
    artifacts: {
      approval: buildMatrixApprovalArtifact(approval.event),
      reactionEmoji: reaction.reaction?.key,
      reactionEventId: reaction.eventId,
      reactionTargetEventId: reaction.reaction?.eventId,
      token,
    },
    details: [
      `approval event: ${approval.event.eventId}`,
      `approval id: ${approvalMetadata.id}`,
      `plugin id: ${approvalMetadata.pluginId ?? "<missing>"}`,
      `tool name: ${approvalMetadata.toolName ?? "<missing>"}`,
      `decision: allow-once`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runApprovalChannelTargetBothScenario(context: MatrixQaScenarioContext) {
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const dmRoomIds = listDriverDmApprovalCandidateRoomIds(context);
  const token = buildMatrixQaToken("MATRIX_QA_APPROVAL_BOTH");
  const approvalId = `qa-${token.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const accepted = await requestExecApproval({
    context,
    command: `printf ${token}`,
    id: approvalId,
  });
  assertAcceptedApprovalRequest({ approvalId, result: accepted });
  const channelApproval = await waitForApprovalEvent({
    context,
    expectedApprovalId: approvalId,
    expectedKind: "exec",
    roomId: context.roomId,
    since: startSince,
  });
  const dmApproval = await waitForObservedApprovalEvent({
    context,
    excludedRoomIds: [context.roomId],
    expectedApprovalId: approvalId,
    expectedKind: "exec",
    roomIds: dmRoomIds,
    timeoutMs: context.timeoutMs,
  });
  if (channelApproval.event.approval?.id !== dmApproval.event.approval?.id) {
    throw new Error("target=both delivered different approval ids to channel and DM");
  }
  await resolveApprovalDecision({
    approvalId,
    context,
    decision: "allow-once",
    kind: "exec",
  });
  const lateDuplicate = await client.waitForOptionalRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      event.sender === context.sutUserId &&
      event.type === "m.room.message" &&
      event.approval?.id === approvalId &&
      event.eventId !== channelApproval.event.eventId &&
      event.eventId !== dmApproval.event.eventId,
    roomId: context.roomId,
    timeoutMs: MATRIX_QA_APPROVAL_SHORT_WINDOW_MS,
  });
  if (lateDuplicate.matched) {
    throw new Error(`approval ${approvalId} was re-delivered after resolution`);
  }
  return {
    artifacts: {
      approvals: [
        buildMatrixApprovalArtifact(channelApproval.event),
        buildMatrixApprovalArtifact(dmApproval.event),
      ],
      token,
    },
    details: [
      `channel approval event: ${channelApproval.event.eventId}`,
      `dm approval event: ${dmApproval.event.eventId}`,
      `approval id: ${approvalId}`,
      `cleanup decision: allow-once`,
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
