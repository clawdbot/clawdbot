import { MATRIX_QA_SECONDARY_ROOM_KEY } from "./scenario-contract.js";
import {
  buildExactMarkerPrompt,
  buildMatrixQaToken,
  resolveMatrixQaNoReplyWindowMs,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMxidPrefixedCommandBlockScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const token = buildMatrixQaToken("MATRIX_QA_MXID_COMMAND");
  return await runNoReplyExpectedScenario({
    accessToken: context.observerAccessToken,
    actorId: "observer",
    actorUserId: context.observerUserId,
    baseUrl: context.baseUrl,
    body: `${context.sutUserId} /new`,
    mentionUserIds: [context.sutUserId],
    observedEvents: context.observedEvents,
    roomId: context.roomId,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
    sutUserId: context.sutUserId,
    timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
    token,
  });
}

export async function runMentionMetadataSpoofBlockScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const token = buildMatrixQaToken("MATRIX_QA_METADATA_SPOOF");
  return await runNoReplyExpectedScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    actorUserId: context.driverUserId,
    baseUrl: context.baseUrl,
    body: buildExactMarkerPrompt(token),
    mentionUserIds: [context.sutUserId],
    observedEvents: context.observedEvents,
    roomId: context.roomId,
    syncState: context.syncState,
    syncStreams: context.syncStreams,
    sutUserId: context.sutUserId,
    timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
    token,
  });
}

export async function runSecondaryRoomOpenTriggerScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  return await runTopologyScopedTopLevelScenario({
    accessToken: context.driverAccessToken,
    actorId: "driver",
    actorUserId: context.driverUserId,
    context,
    roomKey: MATRIX_QA_SECONDARY_ROOM_KEY,
    tokenPrefix: "MATRIX_QA_SECONDARY_OPEN",
    withMention: false,
  });
}
