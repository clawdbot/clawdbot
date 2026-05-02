import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  type MatrixQaScenarioDefinition,
} from "./scenario-catalog.js";
import {
  runAllowBotsDefaultBlockScenario,
  runAllowBotsMentionsDmUnmentionedScenario,
  runAllowBotsMentionsMentionedRoomScenario,
  runAllowBotsMentionsUnmentionedOpenRoomBlockScenario,
  runAllowBotsRoomOverrideBlocksAccountTrueScenario,
  runAllowBotsRoomOverrideEnablesAccountOffScenario,
  runAllowBotsSelfSenderIgnoredScenario,
  runAllowBotsTrueUnmentionedOpenRoomScenario,
} from "./scenario-runtime-allowbots.js";
import {
  runApprovalChannelTargetBothScenario,
  runApprovalDenyReactionScenario,
  runApprovalExecMetadataChunkedScenario,
  runApprovalExecMetadataSingleEventScenario,
  runApprovalPluginMetadataSingleEventScenario,
  runApprovalThreadTargetScenario,
} from "./scenario-runtime-approval.js";
import {
  runDmPerRoomSessionOverrideScenario,
  runDmSharedSessionNoticeScenario,
  runDmThreadReplyOverrideScenario,
} from "./scenario-runtime-dm.js";
import {
  runMatrixQaE2eeCorruptCryptoIdbSnapshotScenario,
  runMatrixQaE2eeHistoryExistsBackupEmptyScenario,
  runMatrixQaE2eeServerBackupDeletedLocalStateIntactScenario,
  runMatrixQaE2eeServerBackupDeletedLocalReuploadRestoresScenario,
  runMatrixQaE2eeServerDeviceDeletedLocalStateIntactScenario,
  runMatrixQaE2eeServerDeviceDeletedReloginRecoversScenario,
  runMatrixQaE2eeStaleRecoveryKeyAfterBackupResetScenario,
  runMatrixQaE2eeStateLossExternalRecoveryKeyScenario,
  runMatrixQaE2eeStateLossNoRecoveryKeyScenario,
  runMatrixQaE2eeStateLossStoredRecoveryKeyScenario,
  runMatrixQaE2eeSyncStateLossCryptoIntactScenario,
  runMatrixQaE2eeWrongAccountRecoveryKeyScenario,
} from "./scenario-runtime-e2ee-destructive.js";
import {
  runMatrixQaE2eeArtifactRedactionScenario,
  runMatrixQaE2eeBasicReplyScenario,
  runMatrixQaE2eeBootstrapSuccessScenario,
  runMatrixQaE2eeCliAccountAddEnableE2eeScenario,
  runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario,
  runMatrixQaE2eeCliEncryptionSetupIdempotentScenario,
  runMatrixQaE2eeCliEncryptionSetupMultiAccountScenario,
  runMatrixQaE2eeCliEncryptionSetupScenario,
  runMatrixQaE2eeCliRecoveryKeyInvalidScenario,
  runMatrixQaE2eeCliRecoveryKeySetupScenario,
  runMatrixQaE2eeCliSetupThenGatewayReplyScenario,
  runMatrixQaE2eeCliSelfVerificationScenario,
  runMatrixQaE2eeDeviceSasVerificationScenario,
  runMatrixQaE2eeDmSasVerificationScenario,
  runMatrixQaE2eeKeyBootstrapFailureScenario,
  runMatrixQaE2eeMediaImageScenario,
  runMatrixQaE2eeQrVerificationScenario,
  runMatrixQaE2eeRecoveryKeyLifecycleScenario,
  runMatrixQaE2eeRecoveryOwnerVerificationRequiredScenario,
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
  runRestartReplayDedupeScenario,
  runRestartResumeScenario,
  runStaleSyncReplayDedupeScenario,
} from "./scenario-runtime-restart.js";
import {
  runAllowlistHotReloadScenario,
  runBlockStreamingScenario,
  runMatrixQaCanary,
  runMembershipLossScenario,
  runObserverAllowlistOverrideScenario,
  runPartialStreamingPreviewScenario,
  runQuietStreamingPreviewScenario,
  runReactionThreadedScenario,
  runRoomAutoJoinInviteScenario,
  runRoomThreadReplyOverrideScenario,
  runSubagentThreadSpawnScenario,
  runThreadFollowUpScenario,
  runThreadIsolationScenario,
  runThreadNestedReplyShapeScenario,
  runThreadRootPreservationScenario,
  runToolProgressErrorScenario,
  runToolProgressMentionSafetyScenario,
  runToolProgressPreviewOptOutScenario,
  runToolProgressPreviewScenario,
  runTopLevelReplyShapeScenario,
} from "./scenario-runtime-room.js";
import {
  buildExactMarkerPrompt,
  buildMatrixQaToken,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  readMatrixQaSyncCursor,
  resolveMatrixQaNoReplyWindowMs,
  runNoReplyExpectedScenario,
  runTopologyScopedTopLevelScenario,
  writeMatrixQaSyncCursor,
  type MatrixQaScenarioContext,
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
export type { MatrixQaScenarioContext };

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
    syncStreams: params.context.syncStreams,
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
    timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
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
    case "matrix-room-partial-streaming-preview":
      return await runPartialStreamingPreviewScenario(context);
    case "matrix-room-quiet-streaming-preview":
      return await runQuietStreamingPreviewScenario(context);
    case "matrix-room-tool-progress-preview":
      return await runToolProgressPreviewScenario(context);
    case "matrix-room-tool-progress-preview-opt-out":
      return await runToolProgressPreviewOptOutScenario(context);
    case "matrix-room-tool-progress-error":
      return await runToolProgressErrorScenario(context);
    case "matrix-room-tool-progress-mention-safety":
      return await runToolProgressMentionSafetyScenario(context);
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
    case "matrix-approval-exec-metadata-single-event":
      return await runApprovalExecMetadataSingleEventScenario(context);
    case "matrix-approval-exec-metadata-chunked":
      return await runApprovalExecMetadataChunkedScenario(context);
    case "matrix-approval-plugin-metadata-single-event":
      return await runApprovalPluginMetadataSingleEventScenario(context);
    case "matrix-approval-deny-reaction":
      return await runApprovalDenyReactionScenario(context);
    case "matrix-approval-thread-target":
      return await runApprovalThreadTargetScenario(context);
    case "matrix-approval-channel-target-both":
      return await runApprovalChannelTargetBothScenario(context);
    case "matrix-restart-resume":
      return await runRestartResumeScenario(context);
    case "matrix-post-restart-room-continue":
      return await runPostRestartRoomContinueScenario(context);
    case "matrix-initial-catchup-then-incremental":
      return await runInitialCatchupThenIncrementalScenario(context);
    case "matrix-restart-replay-dedupe":
      return await runRestartReplayDedupeScenario(context);
    case "matrix-stale-sync-replay-dedupe":
      return await runStaleSyncReplayDedupeScenario(context);
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
    case "matrix-allowbots-default-block":
      return await runAllowBotsDefaultBlockScenario(context);
    case "matrix-allowbots-true-unmentioned-open-room":
      return await runAllowBotsTrueUnmentionedOpenRoomScenario(context);
    case "matrix-allowbots-mentions-mentioned-room":
      return await runAllowBotsMentionsMentionedRoomScenario(context);
    case "matrix-allowbots-mentions-unmentioned-open-room-block":
      return await runAllowBotsMentionsUnmentionedOpenRoomBlockScenario(context);
    case "matrix-allowbots-mentions-dm-unmentioned":
      return await runAllowBotsMentionsDmUnmentionedScenario(context);
    case "matrix-allowbots-room-override-blocks-account-true":
      return await runAllowBotsRoomOverrideBlocksAccountTrueScenario(context);
    case "matrix-allowbots-room-override-enables-account-off":
      return await runAllowBotsRoomOverrideEnablesAccountOffScenario(context);
    case "matrix-allowbots-self-sender-ignored":
      return await runAllowBotsSelfSenderIgnoredScenario(context);
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
    case "matrix-e2ee-recovery-owner-verification-required":
      return await runMatrixQaE2eeRecoveryOwnerVerificationRequiredScenario(context);
    case "matrix-e2ee-cli-account-add-enable-e2ee":
      return await runMatrixQaE2eeCliAccountAddEnableE2eeScenario(context);
    case "matrix-e2ee-cli-encryption-setup":
      return await runMatrixQaE2eeCliEncryptionSetupScenario(context);
    case "matrix-e2ee-cli-encryption-setup-idempotent":
      return await runMatrixQaE2eeCliEncryptionSetupIdempotentScenario(context);
    case "matrix-e2ee-cli-encryption-setup-bootstrap-failure":
      return await runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario(context);
    case "matrix-e2ee-cli-recovery-key-setup":
      return await runMatrixQaE2eeCliRecoveryKeySetupScenario(context);
    case "matrix-e2ee-cli-recovery-key-invalid":
      return await runMatrixQaE2eeCliRecoveryKeyInvalidScenario(context);
    case "matrix-e2ee-cli-encryption-setup-multi-account":
      return await runMatrixQaE2eeCliEncryptionSetupMultiAccountScenario(context);
    case "matrix-e2ee-cli-setup-then-gateway-reply":
      return await runMatrixQaE2eeCliSetupThenGatewayReplyScenario(context);
    case "matrix-e2ee-cli-self-verification":
      return await runMatrixQaE2eeCliSelfVerificationScenario(context);
    case "matrix-e2ee-state-loss-external-recovery-key":
      return await runMatrixQaE2eeStateLossExternalRecoveryKeyScenario(context);
    case "matrix-e2ee-state-loss-stored-recovery-key":
      return await runMatrixQaE2eeStateLossStoredRecoveryKeyScenario(context);
    case "matrix-e2ee-state-loss-no-recovery-key":
      return await runMatrixQaE2eeStateLossNoRecoveryKeyScenario(context);
    case "matrix-e2ee-stale-recovery-key-after-backup-reset":
      return await runMatrixQaE2eeStaleRecoveryKeyAfterBackupResetScenario(context);
    case "matrix-e2ee-server-backup-deleted-local-state-intact":
      return await runMatrixQaE2eeServerBackupDeletedLocalStateIntactScenario(context);
    case "matrix-e2ee-server-backup-deleted-local-reupload-restores":
      return await runMatrixQaE2eeServerBackupDeletedLocalReuploadRestoresScenario(context);
    case "matrix-e2ee-corrupt-crypto-idb-snapshot":
      return await runMatrixQaE2eeCorruptCryptoIdbSnapshotScenario(context);
    case "matrix-e2ee-server-device-deleted-local-state-intact":
      return await runMatrixQaE2eeServerDeviceDeletedLocalStateIntactScenario(context);
    case "matrix-e2ee-server-device-deleted-relogin-recovers":
      return await runMatrixQaE2eeServerDeviceDeletedReloginRecoversScenario(context);
    case "matrix-e2ee-sync-state-loss-crypto-intact":
      return await runMatrixQaE2eeSyncStateLossCryptoIntactScenario(context);
    case "matrix-e2ee-wrong-account-recovery-key":
      return await runMatrixQaE2eeWrongAccountRecoveryKeyScenario(context);
    case "matrix-e2ee-history-exists-backup-empty":
      return await runMatrixQaE2eeHistoryExistsBackupEmptyScenario(context);
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
