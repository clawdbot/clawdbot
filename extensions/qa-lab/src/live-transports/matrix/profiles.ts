const MATRIX_QA_RELEASE_SCENARIO_IDS = [
  "channel-chat-baseline",
  "matrix-allowlist-hot-reload",
] as const;

const MATRIX_QA_FAST_SCENARIO_IDS = [
  "channel-chat-baseline",
  "thread-follow-up",
  "thread-isolation",
  "channel-top-level-reply-shape",
  "matrix-reaction-notification",
  "matrix-approval-exec-metadata-single-event",
  "matrix-approval-exec-metadata-chunked",
  "channel-mention-gating",
  "matrix-allowbots-default-block",
  "matrix-allowbots-mentions-mentioned-room",
  "channel-sender-allowlist",
  "matrix-e2ee-basic-reply",
] as const;

const MATRIX_QA_TRANSPORT_SCENARIO_IDS = [
  "thread-follow-up",
  "matrix-thread-root-preservation",
  "matrix-thread-nested-reply-shape",
  "thread-isolation",
  "channel-top-level-reply-shape",
  "thread-reply-override",
  "matrix-room-partial-streaming-preview",
  "matrix-room-quiet-streaming-preview",
  "matrix-room-tool-progress-preview",
  "matrix-room-tool-progress-command-preview",
  "matrix-room-tool-progress-preview-opt-out",
  "matrix-room-tool-progress-error",
  "matrix-room-tool-progress-mention-safety",
  "dm-chat-baseline",
  "dm-shared-session",
  "matrix-dm-thread-reply-override",
  "dm-per-room-session",
  "matrix-room-autojoin-invite",
  "channel-secondary-conversation-isolation",
  "matrix-secondary-room-open-trigger",
  "matrix-reaction-notification",
  "matrix-reaction-threaded",
  "matrix-reaction-not-a-reply",
  "matrix-reaction-redaction-observed",
  "matrix-approval-exec-metadata-single-event",
  "matrix-approval-exec-metadata-chunked",
  "matrix-approval-plugin-metadata-single-event",
  "matrix-approval-deny-reaction",
  "matrix-approval-thread-target",
  "matrix-approval-channel-target-both",
  "matrix-initial-catchup-then-incremental",
  "matrix-stale-sync-replay-dedupe",
  "matrix-room-membership-loss",
  "matrix-homeserver-restart-resume",
  "channel-mention-gating",
  "matrix-allowbots-default-block",
  "matrix-allowbots-true-unmentioned-open-room",
  "matrix-allowbots-mentions-mentioned-room",
  "matrix-allowbots-mentions-unmentioned-open-room-block",
  "matrix-allowbots-mentions-dm-unmentioned",
  "matrix-allowbots-room-override-blocks-account-true",
  "matrix-allowbots-room-override-enables-account-off",
  "matrix-allowbots-self-sender-ignored",
  "matrix-mxid-prefixed-command-block",
  "matrix-mention-metadata-spoof-block",
  "matrix-allowlist-hot-reload",
  "channel-sender-allowlist",
  "channel-multi-actor-ordering",
  "matrix-inbound-edit-ignored",
  "matrix-inbound-edit-no-duplicate-trigger",
] as const;

const MATRIX_QA_MEDIA_SCENARIO_IDS = [
  "matrix-room-image-understanding-attachment",
  "matrix-room-generated-image-delivery",
  "matrix-media-type-coverage",
  "matrix-voice-preflight-mention",
  "matrix-attachment-only-ignored",
  "matrix-unsupported-media-safe",
  "matrix-e2ee-media-image",
] as const;

const MATRIX_QA_E2EE_SMOKE_SCENARIO_IDS = [
  "matrix-e2ee-basic-reply",
  "matrix-e2ee-thread-follow-up",
  "matrix-e2ee-bootstrap-success",
  "matrix-e2ee-recovery-key-lifecycle",
  "matrix-e2ee-recovery-owner-verification-required",
  "matrix-e2ee-restart-resume",
  "matrix-e2ee-artifact-redaction",
  "matrix-e2ee-key-bootstrap-failure",
] as const;

const MATRIX_QA_E2EE_DEEP_SCENARIO_IDS = [
  "matrix-e2ee-state-after-missing-encryption",
  "matrix-e2ee-state-loss-external-recovery-key",
  "matrix-e2ee-state-loss-stored-recovery-key",
  "matrix-e2ee-state-loss-no-recovery-key",
  "matrix-e2ee-stale-recovery-key-after-backup-reset",
  "matrix-e2ee-server-backup-deleted-local-state-intact",
  "matrix-e2ee-server-backup-deleted-local-reupload-restores",
  "matrix-e2ee-corrupt-crypto-idb-snapshot",
  "matrix-e2ee-server-device-deleted-local-state-intact",
  "matrix-e2ee-server-device-deleted-relogin-recovers",
  "matrix-e2ee-sync-state-loss-crypto-intact",
  "matrix-e2ee-history-exists-backup-empty",
  "matrix-e2ee-device-sas-verification",
  "matrix-e2ee-qr-verification",
  "matrix-e2ee-stale-device-hygiene",
  "matrix-e2ee-dm-sas-verification",
  "matrix-e2ee-verification-notice-no-trigger",
  "matrix-e2ee-wrong-account-recovery-key",
] as const;

const MATRIX_QA_E2EE_CLI_SCENARIO_IDS = [
  "matrix-e2ee-cli-account-add-enable-e2ee",
  "matrix-e2ee-cli-encryption-setup",
  "matrix-e2ee-cli-encryption-setup-idempotent",
  "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
  "matrix-e2ee-cli-recovery-key-setup",
  "matrix-e2ee-cli-recovery-key-invalid",
  "matrix-e2ee-cli-encryption-setup-multi-account",
  "matrix-e2ee-cli-setup-then-gateway-reply",
  "matrix-e2ee-cli-self-verification",
] as const;

const MATRIX_QA_ALL_SCENARIO_IDS = Array.from(
  new Set([
    "channel-chat-baseline",
    ...MATRIX_QA_TRANSPORT_SCENARIO_IDS,
    ...MATRIX_QA_MEDIA_SCENARIO_IDS,
    ...MATRIX_QA_E2EE_SMOKE_SCENARIO_IDS,
    ...MATRIX_QA_E2EE_DEEP_SCENARIO_IDS,
    ...MATRIX_QA_E2EE_CLI_SCENARIO_IDS,
  ]),
);

const MATRIX_QA_PROFILE_SCENARIO_IDS = {
  all: MATRIX_QA_ALL_SCENARIO_IDS,
  fast: MATRIX_QA_FAST_SCENARIO_IDS,
  release: MATRIX_QA_RELEASE_SCENARIO_IDS,
  transport: MATRIX_QA_TRANSPORT_SCENARIO_IDS,
  media: MATRIX_QA_MEDIA_SCENARIO_IDS,
  "e2ee-smoke": MATRIX_QA_E2EE_SMOKE_SCENARIO_IDS,
  "e2ee-deep": MATRIX_QA_E2EE_DEEP_SCENARIO_IDS,
  "e2ee-cli": MATRIX_QA_E2EE_CLI_SCENARIO_IDS,
} as const;

export function resolveMatrixQaScenarioIds(params: {
  profile?: string;
  scenarioIds?: readonly string[];
}): string[] {
  if (params.scenarioIds && params.scenarioIds.length > 0) {
    return [...params.scenarioIds];
  }
  const profile = params.profile?.trim() || "all";
  if (!(profile in MATRIX_QA_PROFILE_SCENARIO_IDS)) {
    throw new Error(
      `Unknown QA Lab Matrix profile "${profile}". Expected one of: all, fast, release, transport, media, e2ee-smoke, e2ee-deep, e2ee-cli.`,
    );
  }
  return [
    ...MATRIX_QA_PROFILE_SCENARIO_IDS[profile as keyof typeof MATRIX_QA_PROFILE_SCENARIO_IDS],
  ];
}
