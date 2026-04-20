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
  runMatrixQaE2eeArtifactRedactionScenario,
  runMatrixQaE2eeBasicReplyScenario,
  runMatrixQaE2eeBootstrapSuccessScenario,
  runMatrixQaE2eeDeviceSasVerificationScenario,
  runMatrixQaE2eeDmSasVerificationScenario,
  runMatrixQaE2eeKeyBootstrapFailureScenario,
  runMatrixQaE2eeMediaImageScenario,
  runMatrixQaE2eeQrVerificationScenario,
  runMatrixQaE2eeRecoveryKeyLifecycleScenario,
  runMatrixQaE2eeRestartResumeScenario,
  runMatrixQaE2eeStaleDeviceHygieneScenario,
  runMatrixQaE2eeThreadFollowUpScenario,
  runMatrixQaE2eeVerificationNoticeNoTriggerScenario,
} from "./scenario-runtime-e2ee.js";
import {
  runInboundEditIgnoredScenario,
  runInboundEditNoDuplicateTriggerScenario,
} from "./scenario-runtime-edit.js";
import {
  runAttachmentOnlyIgnoredScenario,
  runGeneratedImageDeliveryScenario,
  runImageUnderstandingAttachmentScenario,
  runMediaTypeCoverageScenario,
  runUnsupportedMediaSafeScenario,
} from "./scenario-runtime-media.js";
import {
  runReactionNotAReplyScenario,
  runReactionNotificationScenario,
  runReactionRedactionObservedScenario,
} from "./scenario-runtime-reaction.js";
import {
  runHomeserverRestartResumeScenario,
  runInitialCatchupThenIncrementalScenario,
  runPostRestartRoomContinueScenario,
  runRestartResumeScenario,
} from "./scenario-runtime-restart.js";
import {
  runAllowlistHotReloadScenario,
  runBlockStreamingScenario,
  runMatrixQaCanary,
  runMembershipLossScenario,
  runObserverAllowlistOverrideScenario,
  runQuietStreamingPreviewScenario,
  runReactionThreadedScenario,
  runRoomAutoJoinInviteScenario,
  runRoomThreadReplyOverrideScenario,
  runSubagentThreadSpawnScenario,
  runThreadFollowUpScenario,
  runThreadIsolationScenario,
  runThreadNestedReplyShapeScenario,
  runThreadRootPreservationScenario,
  runTopLevelReplyShapeScenario,
} from "./scenario-runtime-room.js";
import {
  buildExactMarkerPrompt,
  buildMatrixQaToken,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  NO_REPLY_WINDOW_MS,
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

async function runNoReplyScenario(params: {
  accessToken: string;
  actorId: "driver" | "observer";
  actorUserId: string;
  body: string;
  context: MatrixQaScenarioContext;
  mentionUserIds?: string[];
  timeoutMs?: number;
  token: string;
}) {
  const timeoutMs = params.timeoutMs ?? params.context.timeoutMs;
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
    timeoutMs,
    token: params.token,
  });
}

async function runMultiActorOrderingScenario(context: MatrixQaScenarioContext) {
  const blockedToken = buildMatrixQaToken("MATRIX_QA_MULTI_BLOCKED");
  const blocked = await runNoReplyScenario({
    accessToken: context.observerAccessToken,
    actorId: "observer",
    actorUserId: context.observerUserId,
    body: buildMentionPrompt(context.sutUserId, blockedToken),
    mentionUserIds: [context.sutUserId],
    context,
    timeoutMs: Math.min(NO_REPLY_WINDOW_MS, context.timeoutMs),
    token: blockedToken,
  });
  const accepted = await runDriverTopologyScopedScenario({
    context,
    roomKey: context.topology.defaultRoomKey,
    tokenPrefix: "MATRIX_QA_MULTI_DRIVER",
  });
  return {
    artifacts: {
      accepted: accepted.artifacts ?? {},
      blocked: blocked.artifacts ?? {},
    },
    details: [blocked.details, accepted.details].join("\n"),
  } satisfies MatrixQaScenarioExecution;
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
    case "matrix-subagent-thread-spawn":
      return await runSubagentThreadSpawnScenario(context);
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
    case "matrix-media-type-coverage":
      return await runMediaTypeCoverageScenario(context);
    case "matrix-attachment-only-ignored":
      return await runAttachmentOnlyIgnoredScenario(context);
    case "matrix-unsupported-media-safe":
      return await runUnsupportedMediaSafeScenario(context);
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
    case "matrix-reaction-redaction-observed":
      return await runReactionRedactionObservedScenario(context);
    case "matrix-restart-resume":
      return await runRestartResumeScenario(context);
    case "matrix-post-restart-room-continue":
      return await runPostRestartRoomContinueScenario(context);
    case "matrix-initial-catchup-then-incremental":
      return await runInitialCatchupThenIncrementalScenario(context);
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
    case "matrix-mxid-prefixed-command-block": {
      const token = buildMatrixQaToken("MATRIX_QA_MXID_COMMAND");
      return await runNoReplyScenario({
        accessToken: context.observerAccessToken,
        actorId: "observer",
        actorUserId: context.observerUserId,
        body: `${context.sutUserId} /new`,
        mentionUserIds: [context.sutUserId],
        context,
        token,
      });
    }
    case "matrix-mention-metadata-spoof-block": {
      const token = buildMatrixQaToken("MATRIX_QA_METADATA_SPOOF");
      return await runNoReplyScenario({
        accessToken: context.driverAccessToken,
        actorId: "driver",
        actorUserId: context.driverUserId,
        body: buildExactMarkerPrompt(token),
        mentionUserIds: [context.sutUserId],
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
    case "matrix-allowlist-hot-reload":
      return await runAllowlistHotReloadScenario(context);
    case "matrix-multi-actor-ordering":
      return await runMultiActorOrderingScenario(context);
    case "matrix-inbound-edit-ignored":
      return await runInboundEditIgnoredScenario(context);
    case "matrix-inbound-edit-no-duplicate-trigger":
      return await runInboundEditNoDuplicateTriggerScenario(context);
    case "matrix-e2ee-basic-reply":
      return await runMatrixQaE2eeBasicReplyScenario(context);
    case "matrix-e2ee-thread-follow-up":
      return await runMatrixQaE2eeThreadFollowUpScenario(context);
    case "matrix-e2ee-bootstrap-success":
      return await runMatrixQaE2eeBootstrapSuccessScenario(context);
    case "matrix-e2ee-recovery-key-lifecycle":
      return await runMatrixQaE2eeRecoveryKeyLifecycleScenario(context);
    case "matrix-e2ee-device-sas-verification":
      return await runMatrixQaE2eeDeviceSasVerificationScenario(context);
    case "matrix-e2ee-qr-verification":
      return await runMatrixQaE2eeQrVerificationScenario(context);
    case "matrix-e2ee-stale-device-hygiene":
      return await runMatrixQaE2eeStaleDeviceHygieneScenario(context);
    case "matrix-e2ee-dm-sas-verification":
      return await runMatrixQaE2eeDmSasVerificationScenario(context);
    case "matrix-e2ee-restart-resume":
      return await runMatrixQaE2eeRestartResumeScenario(context);
    case "matrix-e2ee-verification-notice-no-trigger":
      return await runMatrixQaE2eeVerificationNoticeNoTriggerScenario(context);
    case "matrix-e2ee-artifact-redaction":
      return await runMatrixQaE2eeArtifactRedactionScenario(context);
    case "matrix-e2ee-media-image":
      return await runMatrixQaE2eeMediaImageScenario(context);
    case "matrix-e2ee-key-bootstrap-failure":
      return await runMatrixQaE2eeKeyBootstrapFailureScenario(context);
    default: {
      const exhaustiveScenarioId: never = scenario.id;
      return exhaustiveScenarioId;
    }
  }
}
