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
  | "matrix-thread-isolation"
  | "matrix-top-level-reply-shape"
  | "matrix-room-thread-reply-override"
  | "matrix-room-quiet-streaming-preview"
  | "matrix-room-block-streaming"
  | "matrix-dm-reply-shape"
  | "matrix-dm-shared-session-notice"
  | "matrix-dm-thread-reply-override"
  | "matrix-dm-per-room-session-override"
  | "matrix-room-autojoin-invite"
  | "matrix-secondary-room-reply"
  | "matrix-secondary-room-open-trigger"
  | "matrix-reaction-notification"
  | "matrix-restart-resume"
  | "matrix-room-membership-loss"
  | "matrix-homeserver-restart-resume"
  | "matrix-mention-gating"
  | "matrix-observer-allowlist-override"
  | "matrix-allowlist-block";

export type MatrixQaScenarioDefinition = LiveTransportScenarioDefinition<MatrixQaScenarioId> & {
  configOverrides?: MatrixQaConfigOverrides;
  topology?: MatrixQaTopologySpec;
};

export const MATRIX_QA_BLOCK_ROOM_KEY = "block";
export const MATRIX_QA_DRIVER_DM_ROOM_KEY = "driver-dm";
export const MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY = "driver-dm-shared";
export const MATRIX_QA_HOMESERVER_ROOM_KEY = "homeserver";
export const MATRIX_QA_MEMBERSHIP_ROOM_KEY = "membership";
export const MATRIX_QA_RESTART_ROOM_KEY = "restart";
export const MATRIX_QA_SECONDARY_ROOM_KEY = "secondary";

function buildMatrixQaDmTopology(
  rooms: Array<{
    key: string;
    name: string;
  }>,
): MatrixQaTopologySpec {
  return {
    defaultRoomKey: "main",
    rooms: rooms.map((room) => ({
      key: room.key,
      kind: "dm" as const,
      members: ["driver", "sut"],
      name: room.name,
    })),
  };
}

function buildMatrixQaSingleGroupTopology(params: {
  key: string;
  name: string;
  requireMention: boolean;
}): MatrixQaTopologySpec {
  return {
    defaultRoomKey: "main",
    rooms: [
      {
        key: params.key,
        kind: "group",
        members: ["driver", "observer", "sut"],
        name: params.name,
        requireMention: params.requireMention,
      },
    ],
  };
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

const MATRIX_QA_RESTART_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_RESTART_ROOM_KEY,
  name: "Matrix QA Restart Room",
  requireMention: true,
});

const MATRIX_QA_HOMESERVER_ROOM_TOPOLOGY = buildMatrixQaSingleGroupTopology({
  key: MATRIX_QA_HOMESERVER_ROOM_KEY,
  name: "Matrix QA Homeserver Restart Room",
  requireMention: true,
});

export const MATRIX_QA_SCENARIOS: MatrixQaScenarioDefinition[] = [
  {
    id: "matrix-thread-follow-up",
    standardId: "thread-follow-up",
    timeoutMs: 60_000,
    title: "Matrix thread follow-up reply",
  },
  {
    id: "matrix-thread-isolation",
    standardId: "thread-isolation",
    timeoutMs: 75_000,
    title: "Matrix top-level reply stays out of prior thread",
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
    id: "matrix-restart-resume",
    standardId: "restart-resume",
    timeoutMs: 60_000,
    title: "Matrix lane resumes cleanly after gateway restart",
    topology: MATRIX_QA_RESTART_ROOM_TOPOLOGY,
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
    title: "Matrix allowlist blocks non-driver replies",
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
