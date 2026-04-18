import {
  MATRIX_QA_HOMESERVER_ROOM_KEY,
  MATRIX_QA_RESTART_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-catalog.js";
import {
  buildMatrixReplyDetails,
  buildMatrixQaToken,
  buildMentionPrompt,
  buildMatrixReplyArtifact,
  isMatrixQaExactMarkerReply,
  assertTopLevelReplyArtifact,
  advanceMatrixQaActorCursor,
  primeMatrixQaDriverScenarioClient,
  runAssertedDriverTopLevelScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runHomeserverRestartResumeScenario(context: MatrixQaScenarioContext) {
  if (!context.interruptTransport) {
    throw new Error("Matrix homeserver restart scenario requires a transport interruption hook");
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_HOMESERVER_ROOM_KEY);
  await context.interruptTransport();
  const resumed = await runAssertedDriverTopLevelScenario({
    context,
    label: "post-homeserver-restart reply",
    roomId,
    tokenPrefix: "MATRIX_QA_HOMESERVER",
  });
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
  const result = await runAssertedDriverTopLevelScenario({
    context,
    label: "post-restart reply",
    roomId,
    tokenPrefix: "MATRIX_QA_RESTART",
  });
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

export async function runPostRestartRoomContinueScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGateway) {
    throw new Error("Matrix post-restart continuity scenario requires a gateway restart callback");
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_RESTART_ROOM_KEY);
  await context.restartGateway();
  const first = await runAssertedDriverTopLevelScenario({
    context,
    label: "first post-restart reply",
    roomId,
    tokenPrefix: "MATRIX_QA_RESTART_FIRST",
  });
  const second = await runAssertedDriverTopLevelScenario({
    context,
    label: "second post-restart reply",
    roomId,
    tokenPrefix: "MATRIX_QA_RESTART_SECOND",
  });
  return {
    artifacts: {
      firstDriverEventId: first.driverEventId,
      firstReply: first.reply,
      firstToken: first.token,
      restartSignal: "SIGUSR1",
      roomId,
      secondDriverEventId: second.driverEventId,
      secondReply: second.reply,
      secondToken: second.token,
    },
    details: [
      `room id: ${roomId}`,
      "restart signal: SIGUSR1",
      `first post-restart driver event: ${first.driverEventId}`,
      ...buildMatrixReplyDetails("first reply", first.reply),
      `second post-restart driver event: ${second.driverEventId}`,
      ...buildMatrixReplyDetails("second reply", second.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}

export async function runInitialCatchupThenIncrementalScenario(context: MatrixQaScenarioContext) {
  if (!context.restartGatewayWithQueuedMessage) {
    throw new Error(
      "Matrix initial catchup scenario requires a queued-message gateway restart callback",
    );
  }
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_RESTART_ROOM_KEY);
  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  const catchupToken = buildMatrixQaToken("MATRIX_QA_CATCHUP");
  const catchupBody = buildMentionPrompt(context.sutUserId, catchupToken);
  let catchupDriverEventId = "";

  await context.restartGatewayWithQueuedMessage(async () => {
    catchupDriverEventId = await client.sendTextMessage({
      body: catchupBody,
      mentionUserIds: [context.sutUserId],
      roomId,
    });
  });

  const catchupMatched = await client.waitForRoomEvent({
    observedEvents: context.observedEvents,
    predicate: (event) =>
      isMatrixQaExactMarkerReply(event, {
        roomId,
        sutUserId: context.sutUserId,
        token: catchupToken,
      }) && event.relatesTo === undefined,
    roomId,
    since: startSince,
    timeoutMs: context.timeoutMs,
  });
  advanceMatrixQaActorCursor({
    actorId: "driver",
    syncState: context.syncState,
    nextSince: catchupMatched.since,
    startSince,
  });
  const catchupReply = buildMatrixReplyArtifact(catchupMatched.event, catchupToken);
  assertTopLevelReplyArtifact("catchup reply", catchupReply);

  const incremental = await runAssertedDriverTopLevelScenario({
    context,
    label: "incremental reply after catchup",
    roomId,
    tokenPrefix: "MATRIX_QA_INCREMENTAL",
  });

  return {
    artifacts: {
      catchupDriverEventId,
      catchupReply,
      catchupToken,
      incrementalDriverEventId: incremental.driverEventId,
      incrementalReply: incremental.reply,
      incrementalToken: incremental.token,
      restartSignal: "SIGUSR1",
      roomId,
    },
    details: [
      `room id: ${roomId}`,
      "restart signal: SIGUSR1",
      `catchup driver event: ${catchupDriverEventId}`,
      ...buildMatrixReplyDetails("catchup reply", catchupReply),
      `incremental driver event: ${incremental.driverEventId}`,
      ...buildMatrixReplyDetails("incremental reply", incremental.reply),
    ].join("\n"),
  } satisfies MatrixQaScenarioExecution;
}
