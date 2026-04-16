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
  runGeneratedImageDeliveryScenario,
  runHomeserverRestartResumeScenario,
  runImageUnderstandingAttachmentScenario,
  runMatrixQaCanary,
  runMembershipLossScenario,
  runObserverAllowlistOverrideScenario,
  runQuietStreamingPreviewScenario,
  runReactionNotAReplyScenario,
  runReactionNotificationScenario,
  runReactionThreadedScenario,
  runRestartResumeScenario,
  runRoomAutoJoinInviteScenario,
  runRoomThreadReplyOverrideScenario,
  runThreadFollowUpScenario,
  runThreadIsolationScenario,
  runThreadNestedReplyShapeScenario,
  runThreadRootPreservationScenario,
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

async function runDriverTopologyScopedScenario(params: {
  context: MatrixQaScenarioContext;
  roomKey: string;
  tokenPrefix: string;
  withMention?: boolean;
}) {
  return await runTopologyScopedTopLevelScenario({
    accessToken: params.context.driverAccessToken,
    actorId: "driver",
    actorUserId: params.context.driverUserId,
    context: params.context,
    roomKey: params.roomKey,
    tokenPrefix: params.tokenPrefix,
    ...(params.withMention === undefined ? {} : { withMention: params.withMention }),
  });
}

function buildMatrixQaToken(prefix: string) {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

async function runNoReplyScenario(params: {
  accessToken: string;
  actorId: "driver" | "observer";
  actorUserId: string;
  body: string;
  context: MatrixQaScenarioContext;
  mentionUserIds?: string[];
  token: string;
}) {
  return await runNoReplyExpectedScenario({
    accessToken: params.accessToken,
    actorId: params.actorId,
    actorUserId: params.actorUserId,
    baseUrl: params.context.baseUrl,
    body: params.body,
    ...(params.mentionUserIds ? { mentionUserIds: params.mentionUserIds } : {}),
    observedEvents: params.context.observedEvents,
    roomId: params.context.roomId,
    syncState: params.context.syncState,
    sutUserId: params.context.sutUserId,
    timeoutMs: params.context.timeoutMs,
    token: params.token,
  });
}

export async function runMatrixQaScenario(
  scenario: MatrixQaScenarioDefinition,
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  switch (scenario.id) {
    case "matrix-thread-follow-up":
      return await runThreadFollowUpScenario(context);
    case "matrix-thread-root-preservation":
      return await runThreadRootPreservationScenario(context);
    case "matrix-thread-nested-reply-shape":
      return await runThreadNestedReplyShapeScenario(context);
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
    case "matrix-room-image-understanding-attachment":
      return await runImageUnderstandingAttachmentScenario(context);
    case "matrix-room-generated-image-delivery":
      return await runGeneratedImageDeliveryScenario(context);
    case "matrix-dm-reply-shape":
      return await runDriverTopologyScopedScenario({
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
      return await runDriverTopologyScopedScenario({
        context,
        roomKey: MATRIX_QA_SECONDARY_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_SECONDARY",
      });
    case "matrix-secondary-room-open-trigger":
      return await runDriverTopologyScopedScenario({
        context,
        roomKey: MATRIX_QA_SECONDARY_ROOM_KEY,
        tokenPrefix: "MATRIX_QA_SECONDARY_OPEN",
        withMention: false,
      });
    case "matrix-reaction-notification":
      return await runReactionNotificationScenario(context);
    case "matrix-reaction-threaded":
      return await runReactionThreadedScenario(context);
    case "matrix-reaction-not-a-reply":
      return await runReactionNotAReplyScenario(context);
    case "matrix-restart-resume":
      return await runRestartResumeScenario(context);
    case "matrix-room-membership-loss":
      return await runMembershipLossScenario(context);
    case "matrix-homeserver-restart-resume":
      return await runHomeserverRestartResumeScenario(context);
    case "matrix-mention-gating": {
      const token = buildMatrixQaToken("MATRIX_QA_NOMENTION");
      return await runNoReplyScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        body: buildExactMarkerPrompt(token),
        context,
        token,
      });
    }
    case "matrix-observer-allowlist-override":
      return await runObserverAllowlistOverrideScenario(context);
    case "matrix-allowlist-block": {
      const token = buildMatrixQaToken("MATRIX_QA_ALLOWLIST");
      return await runNoReplyScenario({
        accessToken: context.observerAccessToken,
        actorId: "observer",
        actorUserId: context.observerUserId,
        body: buildMentionPrompt(context.sutUserId, token),
        mentionUserIds: [context.sutUserId],
        context,
        token,
      });
    }
    default: {
      const exhaustiveScenarioId: never = scenario.id;
      return exhaustiveScenarioId;
    }
  }
}
