import { randomUUID } from "node:crypto";
import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  type MatrixQaScenarioDefinition,
} from "./scenario-catalog.js";
import {
  runDmPerRoomSessionOverrideScenario,
  runDmSharedSessionNoticeScenario,
  runDmThreadReplyOverrideScenario,
} from "./scenario-runtime-dm.js";
import {
  runBlockStreamingScenario,
  runHomeserverRestartResumeScenario,
  runMatrixQaCanary,
  runMembershipLossScenario,
  runObserverAllowlistOverrideScenario,
  runQuietStreamingPreviewScenario,
  runReactionNotificationScenario,
  runRestartResumeScenario,
  runRoomAutoJoinInviteScenario,
  runRoomThreadReplyOverrideScenario,
  runThreadFollowUpScenario,
  runThreadIsolationScenario,
  runTopLevelReplyShapeScenario,
} from "./scenario-runtime-room.js";
import {
  buildExactMarkerPrompt,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  readMatrixQaSyncCursor,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  writeMatrixQaSyncCursor,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export {
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  readMatrixQaSyncCursor,
  runMatrixQaCanary,
  writeMatrixQaSyncCursor,
};
export type { MatrixQaScenarioContext, MatrixQaSyncState };

export async function runMatrixQaScenario(
  scenario: MatrixQaScenarioDefinition,
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  switch (scenario.id) {
    case "matrix-thread-follow-up":
      return await runThreadFollowUpScenario(context);
    case "matrix-thread-isolation":
      return await runThreadIsolationScenario(context);
    case "matrix-top-level-reply-shape":
      return await runTopLevelReplyShapeScenario(context);
    case "matrix-room-thread-reply-override":
      return await runRoomThreadReplyOverrideScenario(context);
    case "matrix-room-quiet-streaming-preview":
      return await runQuietStreamingPreviewScenario(context);
    case "matrix-room-block-streaming":
      return await runBlockStreamingScenario(context);
    case "matrix-dm-reply-shape":
      return await runTopologyScopedTopLevelScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        context,
        roomKey: MATRIX_QA_DRIVER_DM_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_DM",
        withMention: false,
      });
    case "matrix-dm-shared-session-notice":
      return await runDmSharedSessionNoticeScenario(context);
    case "matrix-dm-thread-reply-override":
      return await runDmThreadReplyOverrideScenario(context);
    case "matrix-dm-per-room-session-override":
      return await runDmPerRoomSessionOverrideScenario(context);
    case "matrix-room-autojoin-invite":
      return await runRoomAutoJoinInviteScenario(context);
    case "matrix-secondary-room-reply":
      return await runTopologyScopedTopLevelScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        context,
        roomKey: MATRIX_QA_SECONDARY_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_SECONDARY",
      });
    case "matrix-secondary-room-open-trigger":
      return await runTopologyScopedTopLevelScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        context,
        roomKey: MATRIX_QA_SECONDARY_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_SECONDARY_OPEN",
        withMention: false,
      });
    case "matrix-reaction-notification":
      return await runReactionNotificationScenario(context);
    case "matrix-restart-resume":
      return await runRestartResumeScenario(context);
    case "matrix-room-membership-loss":
      return await runMembershipLossScenario(context);
    case "matrix-homeserver-restart-resume":
      return await runHomeserverRestartResumeScenario(context);
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
    case "matrix-observer-allowlist-override":
      return await runObserverAllowlistOverrideScenario(context);
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
