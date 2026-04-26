import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../../shared/live-transport-scenarios.js";
import { type MatrixQaConfigOverrides } from "../../substrate/config.js";
import {
  buildDefaultMatrixQaTopologySpec,
  findMatrixQaProvisionedRoom,
  mergeMatrixQaTopologySpecs,
  type MatrixQaProvisionedTopology,
  type MatrixQaTopologySpec,
} from "../../substrate/topology.js";

export type MatrixQaScenarioId =
  | "matrix-thread-follow-up"
  | "matrix-thread-root-preservation"
  | "matrix-thread-nested-reply-shape"
  | "matrix-thread-isolation"
  | "matrix-subagent-thread-spawn"
  | "matrix-top-level-reply-shape"
  | "matrix-room-thread-reply-override"
  | "matrix-room-quiet-streaming-preview"
  | "matrix-room-block-streaming"
  | "matrix-room-image-understanding-attachment"
  | "matrix-room-generated-image-delivery"
  | "matrix-media-type-coverage"
  | "matrix-attachment-only-ignored"
  | "matrix-unsupported-media-safe"
  | "matrix-dm-reply-shape"
  | "matrix-dm-shared-session-notice"
  | "matrix-dm-thread-reply-override"
  | "matrix-dm-per-room-session-override"
  | "matrix-room-autojoin-invite"
  | "matrix-secondary-room-reply"
  | "matrix-secondary-room-open-trigger"
  | "matrix-reaction-notification"
  | "matrix-reaction-threaded"
  | "matrix-reaction-not-a-reply"
  | "matrix-reaction-redaction-observed"
  | "matrix-restart-resume"
  | "matrix-post-restart-room-continue"
  | "matrix-initial-catchup-then-incremental"
  | "matrix-restart-replay-dedupe"
  | "matrix-stale-sync-replay-dedupe"
  | "matrix-room-membership-loss"
  | "matrix-homeserver-restart-resume"
  | "matrix-mention-gating"
  | "matrix-mxid-prefixed-command-block"
  | "matrix-mention-metadata-spoof-block"
  | "matrix-observer-allowlist-override"
  | "matrix-allowlist-block"
  | "matrix-allowlist-hot-reload"
  | "matrix-multi-actor-ordering"
  | "matrix-inbound-edit-ignored"
  | "matrix-inbound-edit-no-duplicate-trigger"
  | "matrix-e2ee-basic-reply"
  | "matrix-e2ee-thread-follow-up"
  | "matrix-e2ee-bootstrap-success"
  | "matrix-e2ee-recovery-key-lifecycle"
  | "matrix-e2ee-recovery-owner-verification-required"
  | "matrix-e2ee-cli-self-verification"
  | "matrix-e2ee-state-loss-external-recovery-key"
  | "matrix-e2ee-state-loss-stored-recovery-key"
  | "matrix-e2ee-state-loss-no-recovery-key"
  | "matrix-e2ee-stale-recovery-key-after-backup-reset"
  | "matrix-e2ee-server-backup-deleted-local-state-intact"
  | "matrix-e2ee-server-backup-deleted-local-reupload-restores"
  | "matrix-e2ee-corrupt-crypto-idb-snapshot"
  | "matrix-e2ee-server-device-deleted-local-state-intact"
  | "matrix-e2ee-sync-state-loss-crypto-intact"
  | "matrix-e2ee-wrong-account-recovery-key"
  | "matrix-e2ee-history-exists-backup-empty"
  | "matrix-e2ee-device-sas-verification"
  | "matrix-e2ee-qr-verification"
  | "matrix-e2ee-stale-device-hygiene"
  | "matrix-e2ee-dm-sas-verification"
  | "matrix-e2ee-restart-resume"
  | "matrix-e2ee-verification-notice-no-trigger"
  | "matrix-e2ee-artifact-redaction"
  | "matrix-e2ee-media-image"
  | "matrix-e2ee-key-bootstrap-failure";
export type MatrixQaE2eeScenarioId = Extract<MatrixQaScenarioId, `matrix-e2ee-${string}`>;

export type MatrixQaScenarioDefinition = LiveTransportScenarioDefinition<MatrixQaScenarioId> & {
  configOverrides?: MatrixQaConfigOverrides;
  topology?: MatrixQaTopologySpec;
};

export const MATRIX_QA_BLOCK_ROOM_KEY = "block";
export const MATRIX_QA_DRIVER_DM_ROOM_KEY = "driver-dm";
export const MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY = "driver-dm-shared";
export const MATRIX_QA_E2EE_ROOM_KEY = "e2ee";
export const MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY = "e2ee-verification-dm";
export const MATRIX_QA_HOMESERVER_ROOM_KEY = "homeserver";
export const MATRIX_QA_MAIN_ROOM_KEY = "main";
export const MATRIX_QA_MEDIA_ROOM_KEY = "media";
export const MATRIX_QA_MEMBERSHIP_ROOM_KEY = "membership";
export const MATRIX_QA_RESTART_ROOM_KEY = "restart";
export const MATRIX_QA_SECONDARY_ROOM_KEY = "secondary";
export const MATRIX_QA_STALE_SYNC_ROOM_KEY = "stale-sync";

const MATRIX_QA_LIVE_MODEL_TIMEOUT_MS = 120_000;
const MATRIX_QA_IMAGE_GENERATION_TIMEOUT_MS = 180_000;
const MATRIX_QA_E2EE_REPLY_TIMEOUT_MS = 150_000;
const MATRIX_QA_E2EE_MEDIA_TIMEOUT_MS = 180_000;

function buildMatrixQaDmTopology(
  rooms: Array<{
    key: string;
    name: string;
  }>,
): MatrixQaTopologySpec {
  return {
    defaultRoomKey: MATRIX_QA_MAIN_ROOM_KEY,
    rooms: rooms.map((room) => ({
      key: room.key,
      kind: "dm" as const,
      members: ["driver", "sut"],
      name: room.name,
    })),
  };
}

function buildMatrixQaSingleGroupTopology(params: {
  encrypted?: boolean;
  key: string;
  name: string;
  requireMention: boolean;
}): MatrixQaTopologySpec {
  return {
    defaultRoomKey: MATRIX_QA_MAIN_ROOM_KEY,
    rooms: [
      {
        encrypted: params.encrypted === true,
        key: params.key,
        kind: "group",
        members: ["driver", "observer", "sut"],
        name: params.name,
        requireMention: params.requireMention,
      },
    ],
  };
}

export function buildMatrixQaE2eeScenarioRoomKey(scenarioId: MatrixQaE2eeScenarioId) {
  const suffix = scenarioId.replace(/^matrix-e2ee-/, "").replace(/[^A-Za-z0-9_-]/g, "-");
  return `${MATRIX_QA_E2EE_ROOM_KEY}-${suffix}`;
}

function buildMatrixQaE2eeScenarioTopology(params: {
  scenarioId: MatrixQaE2eeScenarioId;
  name: string;
}): MatrixQaTopologySpec {
  return buildMatrixQaSingleGroupTopology({
    encrypted: true,
    key: buildMatrixQaE2eeScenarioRoomKey(params.scenarioId),
    name: params.name,
    requireMention: true,
  });
}

const MATRIX_QA_DRIVER_DM_TOPOLOGY = buildMatrixQaDmTopology([
  {
    key: MATRIX_QA_DRIVER_DM_ROOM_KEY,
    name: "Matrix QA Driver/SUT DM",
  },
]);

const MATRIX_QA_SHARED_DM_TOPOLOGY = buildMatrixQaDmTopology([
  {
    key: MATRIX_QA_DRIVER_DM_ROOM_KEY,
    name: "Matrix QA Driver/SUT DM",
  },
  {
    key: MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
    name: "Matrix QA Driver/SUT Shared DM",
  },
]);

const MATRIX_QA_SECONDARY_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_SECONDARY_ROOM_KEY,
  name: "Matrix QA Secondary Room",
  requireMention: true,
});

const MATRIX_QA_BLOCK_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_BLOCK_ROOM_KEY,
  name: "Matrix QA Block Streaming Room",
  requireMention: true,
});

const MATRIX_QA_MEMBERSHIP_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  name: "Matrix QA Membership Room",
  requireMention: true,
});

const MATRIX_QA_MEDIA_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_MEDIA_ROOM_KEY,
  name: "Matrix QA Media Room",
  requireMention: true,
});

const MATRIX_QA_RESTART_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_RESTART_ROOM_KEY,
  name: "Matrix QA Restart Room",
  requireMention: true,
});

const MATRIX_QA_STALE_SYNC_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_STALE_SYNC_ROOM_KEY,
  name: "Matrix QA Stale Sync Room",
  requireMention: true,
});

const MATRIX_QA_HOMESERVER_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_HOMESERVER_ROOM_KEY,
  name: "Matrix QA Homeserver Restart Room",
  requireMention: true,
});

const MATRIX_QA_E2EE_VERIFICATION_DM_TOPOLOGY: MatrixQaTopologySpec = {
  defaultRoomKey: "main",
  rooms: [
    {
      encrypted: true,
      key: MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY,
      kind: "dm",
      members: ["driver", "observer"],
      name: "Matrix QA E2EE Verification DM",
    },
  ],
};

const MATRIX_QA_E2EE_CONFIG = {
  encryption: true,
  startupVerification: "off",
} satisfies MatrixQaConfigOverrides;

export const MATRIX_QA_SCENARIOS: MatrixQaScenarioDefinition[] = [
  {
    id: "matrix-thread-follow-up",
    standardId: "thread-follow-up",
    timeoutMs: 60_000,
    title: "Matrix thread follow-up reply",
  },
  {
    id: "matrix-thread-root-preservation",
    timeoutMs: 60_000,
    title: "Matrix threaded replies keep the original root event",
  },
  {
    id: "matrix-thread-nested-reply-shape",
    timeoutMs: 60_000,
    title: "Matrix nested threaded replies keep fallback replies on the root event",
  },
  {
    id: "matrix-thread-isolation",
    standardId: "thread-isolation",
    timeoutMs: 75_000,
    title: "Matrix top-level reply stays out of prior thread",
  },
  {
    id: "matrix-subagent-thread-spawn",
    timeoutMs: MATRIX_QA_LIVE_MODEL_TIMEOUT_MS,
    title: "Matrix sessions_spawn thread=true creates a bound child thread",
    configOverrides: {
      groupsByKey: {
        [MATRIX_QA_MAIN_ROOM_KEY]: {
          tools: {
            allow: ["sessions_spawn", "sessions_yield"],
          },
        },
      },
      threadBindings: {
        enabled: true,
        spawnSubagentSessions: true,
      },
      toolProfile: "coding",
    },
  },
  {
    id: "matrix-top-level-reply-shape",
    standardId: "top-level-reply-shape",
    timeoutMs: 45_000,
    title: "Matrix top-level reply keeps replyToMode off",
  },
  {
    id: "matrix-room-thread-reply-override",
    timeoutMs: 45_000,
    title: "Matrix threadReplies always keeps room replies threaded",
    configOverrides: {
      threadReplies: "always",
    },
  },
  {
    id: "matrix-room-quiet-streaming-preview",
    timeoutMs: 45_000,
    title: "Matrix quiet streaming emits notice previews before finalizing",
    configOverrides: {
      streaming: "quiet",
    },
  },
  {
    id: "matrix-room-block-streaming",
    timeoutMs: 45_000,
    title: "Matrix block streaming preserves completed quiet preview blocks",
    topology: MATRIX_QA_BLOCK_ROOM_TOPOLOGY,
    configOverrides: {
      agentDefaults: {
        blockStreamingChunk: {
          breakPreference: "newline",
          maxChars: 48,
          minChars: 1,
        },
        blockStreamingCoalesce: {
          idleMs: 0,
          maxChars: 48,
          minChars: 1,
        },
      },
      blockStreaming: true,
      streaming: "quiet",
    },
  },
  {
    id: "matrix-room-image-understanding-attachment",
    timeoutMs: 60_000,
    title: "Matrix captioned image attachments reach the model vision path",
    topology: MATRIX_QA_MEDIA_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-room-generated-image-delivery",
    timeoutMs: MATRIX_QA_IMAGE_GENERATION_TIMEOUT_MS,
    title: "Matrix generated images deliver as real image attachments while streaming",
    topology: MATRIX_QA_MEDIA_ROOM_TOPOLOGY,
    configOverrides: {
      streaming: "quiet",
    },
  },
  {
    id: "matrix-media-type-coverage",
    timeoutMs: 90_000,
    title: "Matrix media attachments cover image, audio, video, PDF, and EPUB transport",
    topology: MATRIX_QA_MEDIA_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-attachment-only-ignored",
    timeoutMs: 8_000,
    title: "Matrix attachment-only group media does not bypass mention gating",
    topology: MATRIX_QA_MEDIA_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-unsupported-media-safe",
    timeoutMs: 45_000,
    title: "Matrix unsupported media attachments do not block caption replies",
    topology: MATRIX_QA_MEDIA_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-dm-reply-shape",
    timeoutMs: 45_000,
    title: "Matrix DM reply stays top-level without a mention",
    topology: MATRIX_QA_DRIVER_DM_TOPOLOGY,
  },
  {
    id: "matrix-dm-shared-session-notice",
    timeoutMs: 45_000,
    title: "Matrix shared DM sessions emit a cross-room notice",
    topology: MATRIX_QA_SHARED_DM_TOPOLOGY,
  },
  {
    id: "matrix-dm-thread-reply-override",
    timeoutMs: 45_000,
    title: "Matrix DM thread override keeps DM replies threaded",
    topology: MATRIX_QA_DRIVER_DM_TOPOLOGY,
    configOverrides: {
      dm: {
        threadReplies: "always",
      },
      threadReplies: "off",
    },
  },
  {
    id: "matrix-dm-per-room-session-override",
    timeoutMs: 45_000,
    title: "Matrix DM per-room session override suppresses cross-room notices",
    topology: MATRIX_QA_SHARED_DM_TOPOLOGY,
    configOverrides: {
      dm: {
        sessionScope: "per-room",
      },
    },
  },
  {
    id: "matrix-room-autojoin-invite",
    timeoutMs: 60_000,
    title: "Matrix invite auto-join accepts fresh group rooms",
    configOverrides: {
      autoJoin: "always",
      groupPolicy: "open",
    },
  },
  {
    id: "matrix-secondary-room-reply",
    timeoutMs: 45_000,
    title: "Matrix secondary room reply stays scoped to that room",
    topology: MATRIX_QA_SECONDARY_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-secondary-room-open-trigger",
    timeoutMs: 45_000,
    title: "Matrix secondary room can opt out of mention gating",
    topology: MATRIX_QA_SECONDARY_ROOM_TOPOLOGY,
    configOverrides: {
      groupsByKey: {
        [MATRIX_QA_SECONDARY_ROOM_KEY]: {
          requireMention: false,
        },
      },
    },
  },
  {
    id: "matrix-reaction-notification",
    standardId: "reaction-observation",
    timeoutMs: 45_000,
    title: "Matrix reactions on bot replies are observed",
  },
  {
    id: "matrix-reaction-threaded",
    timeoutMs: 45_000,
    title: "Matrix reactions preserve threaded reply targets",
  },
  {
    id: "matrix-reaction-not-a-reply",
    timeoutMs: 8_000,
    title: "Matrix reactions do not trigger a fresh bot reply",
  },
  {
    id: "matrix-reaction-redaction-observed",
    timeoutMs: 45_000,
    title: "Matrix reaction removals are observed as redactions",
  },
  {
    id: "matrix-restart-resume",
    standardId: "restart-resume",
    timeoutMs: 60_000,
    title: "Matrix lane resumes cleanly after gateway restart",
    topology: MATRIX_QA_RESTART_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-post-restart-room-continue",
    timeoutMs: 75_000,
    title: "Matrix restarted room continues after the first recovered reply",
    topology: MATRIX_QA_RESTART_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-initial-catchup-then-incremental",
    timeoutMs: 90_000,
    title: "Matrix initial catchup is followed by incremental replies",
    topology: MATRIX_QA_RESTART_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-restart-replay-dedupe",
    timeoutMs: 90_000,
    title: "Matrix restart does not redeliver a handled event",
    topology: MATRIX_QA_RESTART_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-stale-sync-replay-dedupe",
    timeoutMs: 90_000,
    title: "Matrix stale sync replay is absorbed by inbound dedupe",
    topology: MATRIX_QA_STALE_SYNC_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-room-membership-loss",
    timeoutMs: 75_000,
    title: "Matrix room membership loss recovers after re-invite",
    topology: MATRIX_QA_MEMBERSHIP_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-homeserver-restart-resume",
    timeoutMs: 75_000,
    title: "Matrix lane resumes after homeserver restart",
    topology: MATRIX_QA_HOMESERVER_ROOM_TOPOLOGY,
  },
  {
    id: "matrix-mention-gating",
    standardId: "mention-gating",
    timeoutMs: 8_000,
    title: "Matrix room message without mention does not trigger",
  },
  {
    id: "matrix-mxid-prefixed-command-block",
    timeoutMs: 8_000,
    title: "Matrix MXID-prefixed control commands stay gated",
    configOverrides: {
      groupPolicy: "open",
    },
  },
  {
    id: "matrix-mention-metadata-spoof-block",
    timeoutMs: 8_000,
    title: "Matrix metadata-only mention spoof does not trigger",
  },
  {
    id: "matrix-observer-allowlist-override",
    timeoutMs: 45_000,
    title: "Matrix sender allowlist override lets observer messages trigger replies",
    configOverrides: {
      groupAllowRoles: ["driver", "observer"],
    },
  },
  {
    id: "matrix-allowlist-block",
    standardId: "allowlist-block",
    timeoutMs: 8_000,
    title: "Matrix sender allowlist blocks observer replies",
  },
  {
    id: "matrix-allowlist-hot-reload",
    timeoutMs: 60_000,
    title: "Matrix group sender allowlist removals hot-reload without gateway restart",
    configOverrides: {
      groupAllowRoles: ["driver", "observer"],
    },
  },
  {
    id: "matrix-multi-actor-ordering",
    timeoutMs: 60_000,
    title: "Matrix blocked observer traffic does not poison later driver replies",
  },
  {
    id: "matrix-inbound-edit-ignored",
    timeoutMs: 8_000,
    title: "Matrix inbound edits cannot turn ignored messages into triggers",
  },
  {
    id: "matrix-inbound-edit-no-duplicate-trigger",
    timeoutMs: 45_000,
    title: "Matrix inbound edits do not duplicate already handled triggers",
  },
  {
    id: "matrix-e2ee-basic-reply",
    timeoutMs: 75_000,
    title: "Matrix E2EE encrypted room replies decrypt end-to-end",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-basic-reply",
      name: "Matrix QA E2EE Basic Reply Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-thread-follow-up",
    timeoutMs: 75_000,
    title: "Matrix E2EE encrypted threads preserve reply shape",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-thread-follow-up",
      name: "Matrix QA E2EE Thread Follow-up Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-bootstrap-success",
    timeoutMs: 90_000,
    title: "Matrix E2EE bootstrap verifies the owner device and backup",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-bootstrap-success",
      name: "Matrix QA E2EE Bootstrap Success Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-recovery-key-lifecycle",
    timeoutMs: 90_000,
    title: "Matrix E2EE recovery key restores and resets room-key backup",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-recovery-key-lifecycle",
      name: "Matrix QA E2EE Recovery Key Lifecycle Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-recovery-owner-verification-required",
    timeoutMs: 90_000,
    title: "Matrix E2EE recovery key backup access still requires Matrix identity trust",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-recovery-owner-verification-required",
      name: "Matrix QA E2EE Recovery Owner Verification Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-cli-self-verification",
    timeoutMs: 180_000,
    title: "Matrix E2EE CLI interactive self-verification establishes identity trust",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-cli-self-verification",
      name: "Matrix QA E2EE CLI Self Verification Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-state-loss-external-recovery-key",
    timeoutMs: 180_000,
    title: "Matrix E2EE total state loss restores backup with an external recovery key",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-state-loss-external-recovery-key",
      name: "Matrix QA E2EE State Loss External Key Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-state-loss-stored-recovery-key",
    timeoutMs: 180_000,
    title: "Matrix E2EE crypto state loss restores backup from a surviving recovery key",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-state-loss-stored-recovery-key",
      name: "Matrix QA E2EE State Loss Stored Key Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-state-loss-no-recovery-key",
    timeoutMs: 120_000,
    title: "Matrix E2EE total state loss without a recovery key fails closed",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-state-loss-no-recovery-key",
      name: "Matrix QA E2EE State Loss No Key Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-stale-recovery-key-after-backup-reset",
    timeoutMs: 180_000,
    title: "Matrix E2EE stale recovery key is rejected after server backup reset",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-stale-recovery-key-after-backup-reset",
      name: "Matrix QA E2EE Stale Recovery Key Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-server-backup-deleted-local-state-intact",
    timeoutMs: 120_000,
    title: "Matrix E2EE local crypto survives server backup deletion",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-server-backup-deleted-local-state-intact",
      name: "Matrix QA E2EE Server Backup Deleted Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-server-backup-deleted-local-reupload-restores",
    timeoutMs: 180_000,
    title: "Matrix E2EE local keys re-upload after server backup deletion",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-server-backup-deleted-local-reupload-restores",
      name: "Matrix QA E2EE Server Backup Reupload Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-corrupt-crypto-idb-snapshot",
    timeoutMs: 180_000,
    title: "Matrix E2EE corrupt crypto snapshot repairs through backup restore",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-corrupt-crypto-idb-snapshot",
      name: "Matrix QA E2EE Corrupt IDB Snapshot Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-server-device-deleted-local-state-intact",
    timeoutMs: 120_000,
    title: "Matrix E2EE server-side device deletion invalidates surviving local state",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-server-device-deleted-local-state-intact",
      name: "Matrix QA E2EE Server Device Deleted Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-sync-state-loss-crypto-intact",
    timeoutMs: MATRIX_QA_E2EE_REPLY_TIMEOUT_MS,
    title: "Matrix E2EE sync cursor loss keeps crypto decryptability intact",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-sync-state-loss-crypto-intact",
      name: "Matrix QA E2EE Sync State Loss Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-history-exists-backup-empty",
    timeoutMs: 180_000,
    title: "Matrix E2EE backup reset preserves encrypted history via local key re-upload",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-history-exists-backup-empty",
      name: "Matrix QA E2EE Empty Backup Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-device-sas-verification",
    timeoutMs: 90_000,
    title: "Matrix E2EE device verification completes SAS emoji compare",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-device-sas-verification",
      name: "Matrix QA E2EE Device SAS Verification Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-qr-verification",
    timeoutMs: 90_000,
    title: "Matrix E2EE QR verification completes identity scan",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-qr-verification",
      name: "Matrix QA E2EE QR Verification Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-stale-device-hygiene",
    timeoutMs: 90_000,
    title: "Matrix E2EE stale own devices can be removed without deleting the current device",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-stale-device-hygiene",
      name: "Matrix QA E2EE Stale Device Hygiene Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-dm-sas-verification",
    timeoutMs: 90_000,
    title: "Matrix E2EE DM verification notices stay scoped and complete SAS",
    topology: MATRIX_QA_E2EE_VERIFICATION_DM_TOPOLOGY,
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-restart-resume",
    timeoutMs: MATRIX_QA_E2EE_REPLY_TIMEOUT_MS,
    title: "Matrix E2EE encrypted rooms resume after gateway restart",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-restart-resume",
      name: "Matrix QA E2EE Restart Resume Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-verification-notice-no-trigger",
    timeoutMs: 30_000,
    title: "Matrix E2EE verification notices do not trigger replies",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-verification-notice-no-trigger",
      name: "Matrix QA E2EE Verification Notice Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-artifact-redaction",
    timeoutMs: MATRIX_QA_E2EE_REPLY_TIMEOUT_MS,
    title: "Matrix E2EE decrypted payloads stay out of default event artifacts",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-artifact-redaction",
      name: "Matrix QA E2EE Artifact Redaction Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-media-image",
    timeoutMs: MATRIX_QA_E2EE_MEDIA_TIMEOUT_MS,
    title: "Matrix E2EE encrypted image attachments reach the model vision path",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-media-image",
      name: "Matrix QA E2EE Media Image Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-key-bootstrap-failure",
    timeoutMs: 90_000,
    title: "Matrix E2EE bootstrap reports room-key backup failures",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-key-bootstrap-failure",
      name: "Matrix QA E2EE Key Bootstrap Failure Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
  {
    id: "matrix-e2ee-wrong-account-recovery-key",
    timeoutMs: 180_000,
    title: "Matrix E2EE rejects a recovery key from a different account",
    topology: buildMatrixQaE2eeScenarioTopology({
      scenarioId: "matrix-e2ee-wrong-account-recovery-key",
      name: "Matrix QA E2EE Wrong Account Key Room",
    }),
    configOverrides: MATRIX_QA_E2EE_CONFIG,
  },
];

export const MATRIX_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  alwaysOnStandardScenarioIds: ["canary"],
  scenarios: MATRIX_QA_SCENARIOS,
});

export function findMatrixQaScenarios(ids?: string[]) {
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Matrix",
    scenarios: MATRIX_QA_SCENARIOS,
  });
}

export function buildMatrixQaTopologyForScenarios(params: {
  defaultRoomName: string;
  scenarios: MatrixQaScenarioDefinition[];
}): MatrixQaTopologySpec {
  return mergeMatrixQaTopologySpecs([
    buildDefaultMatrixQaTopologySpec({
      defaultRoomName: params.defaultRoomName,
    }),
    ...params.scenarios.flatMap((scenario) => (scenario.topology ? [scenario.topology] : [])),
  ]);
}

export function resolveMatrixQaScenarioRoomId(
  context: Pick<{ roomId: string; topology: MatrixQaProvisionedTopology }, "roomId" | "topology">,
  roomKey?: string,
) {
  if (!roomKey) {
    return context.roomId;
  }
  return findMatrixQaProvisionedRoom(context.topology, roomKey).roomId;
}
