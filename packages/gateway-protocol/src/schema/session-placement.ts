import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SESSION_PLACEMENT_STATES } from "./session-placement-state.js";
import { WorkerIdentifierSchema } from "./worker-protocol-primitives.js";

export {
  isCloudWorkerPlacementState,
  type SessionPlacementState,
} from "./session-placement-state.js";

/** Durable gateway ownership states for one session execution placement.
 * The literal list stays explicit because Type.Union needs a tuple for
 * Static inference (a mapped array collapses Static to never); the guard
 * below keeps it in lockstep with SESSION_PLACEMENT_STATES. */
export const SessionPlacementStateSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("requested"),
  Type.Literal("provisioning"),
  Type.Literal("syncing"),
  Type.Literal("starting"),
  Type.Literal("active"),
  Type.Literal("draining"),
  Type.Literal("reconciling"),
  Type.Literal("reclaimed"),
  Type.Literal("failed"),
]);

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const placementStateVocabularyInSync: MutuallyAssignable<
  Static<typeof SessionPlacementStateSchema>,
  (typeof SESSION_PLACEMENT_STATES)[number]
> = true;
void placementStateVocabularyInSync;

const SessionPlacementTimingProperties = {
  generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  createdAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  updatedAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  stateChangedAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
};

const SessionPlacementOwnerEpochSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

const WorkerBundleHashSchema = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-f0-9]{64}$",
});

const SessionPlacementWorkspaceProperties = {
  workspaceBaseManifestRef: NonEmptyString,
  remoteWorkspaceDir: NonEmptyString,
};

const SessionPlacementAckProperties = {
  lastTranscriptAckCursor: Type.Optional(
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  lastLiveEventAckCursor: Type.Optional(
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
};

export const SessionPlacementDiskSpaceSchema = closedObject({
  status: Type.Union([Type.Literal("ok"), Type.Literal("warning"), Type.Literal("critical")]),
  availableBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  totalBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  observedAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

const SessionPlacementDiskSpaceProperties = {
  diskSpace: Type.Optional(SessionPlacementDiskSpaceSchema),
};

const WorkspaceResultConflictSchema = closedObject({
  paths: Type.Array(NonEmptyString, { minItems: 1, maxItems: 256 }),
  stagedResultRef: NonEmptyString,
  totalCount: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});

const SessionPlacementConflictProperties = {
  workspaceResultConflict: Type.Optional(WorkspaceResultConflictSchema),
};

const TerminalSessionPlacementProperties = {
  environmentId: Type.Optional(NonEmptyString),
  activeOwnerEpoch: Type.Optional(SessionPlacementOwnerEpochSchema),
  workspaceBaseManifestRef: Type.Optional(NonEmptyString),
  remoteWorkspaceDir: Type.Optional(NonEmptyString),
  workerBundleHash: Type.Optional(WorkerBundleHashSchema),
  ...SessionPlacementAckProperties,
  ...SessionPlacementConflictProperties,
  terminalReason: Type.Optional(NonEmptyString),
  terminalAtMs: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
};

function createUnownedSessionPlacementSchema<const State extends "local" | "requested">(
  state: State,
) {
  return closedObject({ state: Type.Literal(state), ...SessionPlacementTimingProperties });
}

function createWorkerOwnedSessionPlacementSchema<
  const State extends "active" | "draining" | "reconciling",
>(state: State) {
  return closedObject({
    state: Type.Literal(state),
    ...SessionPlacementTimingProperties,
    environmentId: NonEmptyString,
    activeOwnerEpoch: SessionPlacementOwnerEpochSchema,
    workerBundleHash: WorkerBundleHashSchema,
    ...SessionPlacementWorkspaceProperties,
    ...SessionPlacementAckProperties,
    ...SessionPlacementConflictProperties,
    ...SessionPlacementDiskSpaceProperties,
  });
}

const LocalSessionPlacementSchema = createUnownedSessionPlacementSchema("local");
const RequestedSessionPlacementSchema = createUnownedSessionPlacementSchema("requested");

const ProvisioningSessionPlacementSchema = closedObject({
  state: Type.Literal("provisioning"),
  ...SessionPlacementTimingProperties,
  environmentId: Type.Optional(NonEmptyString),
});

const SyncingSessionPlacementSchema = closedObject({
  state: Type.Literal("syncing"),
  ...SessionPlacementTimingProperties,
  environmentId: NonEmptyString,
  workerBundleHash: WorkerBundleHashSchema,
});

const StartingSessionPlacementSchema = closedObject({
  state: Type.Literal("starting"),
  ...SessionPlacementTimingProperties,
  environmentId: NonEmptyString,
  workerBundleHash: WorkerBundleHashSchema,
  ...SessionPlacementWorkspaceProperties,
});

const ActiveWorkerSessionPlacementSchema = createWorkerOwnedSessionPlacementSchema("active");
const DrainingSessionPlacementSchema = createWorkerOwnedSessionPlacementSchema("draining");
const ReconcilingSessionPlacementSchema = createWorkerOwnedSessionPlacementSchema("reconciling");

const ReclaimedSessionPlacementSchema = closedObject({
  state: Type.Literal("reclaimed"),
  ...SessionPlacementTimingProperties,
  ...TerminalSessionPlacementProperties,
});

const FailedSessionPlacementSchema = closedObject({
  state: Type.Literal("failed"),
  ...SessionPlacementTimingProperties,
  ...TerminalSessionPlacementProperties,
  recoveryError: NonEmptyString,
});

/** Gateway-visible placement projection; `state` remains the closed discriminator. */
export const SessionPlacementSchema = Type.Union([
  LocalSessionPlacementSchema,
  RequestedSessionPlacementSchema,
  ProvisioningSessionPlacementSchema,
  SyncingSessionPlacementSchema,
  StartingSessionPlacementSchema,
  ActiveWorkerSessionPlacementSchema,
  DrainingSessionPlacementSchema,
  ReconcilingSessionPlacementSchema,
  ReclaimedSessionPlacementSchema,
  FailedSessionPlacementSchema,
]);

const WORKER_MACHINE_CLASS_MAX_LENGTH = 128;
const WorkerMachineClassSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_MACHINE_CLASS_MAX_LENGTH,
});

/**
 * Requests one-way dispatch to an explicit device (`operator.write`), an explicit profile
 * (`operator.admin`), or an `operator.admin`-only `cloudWorkers.projectProfiles` lookup when no
 * target is supplied. Explicit targets take precedence. An absent, unmatched, or invalid mapping
 * is rejected with `INVALID_REQUEST` instead of provisioning or falling back to another target.
 */
export const SessionsDispatchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    profileId: Type.Optional(NonEmptyString),
    deviceId: Type.Optional(NonEmptyString),
    machineClass: Type.Optional(WorkerMachineClassSchema),
  },
  {
    additionalProperties: false,
    oneOf: [
      { required: ["profileId"], not: { required: ["deviceId"] } },
      {
        required: ["deviceId"],
        not: { anyOf: [{ required: ["profileId"] }, { required: ["machineClass"] }] },
      },
      {
        not: {
          anyOf: [
            { required: ["profileId"] },
            { required: ["deviceId"] },
            { required: ["machineClass"] },
          ],
        },
      },
    ],
  },
);

/** Result returned once session dispatch reaches durable worker ownership. */
export const SessionsDispatchResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  sessionId: NonEmptyString,
  placement: ActiveWorkerSessionPlacementSchema,
});

/** Requests safe workspace reconciliation and teardown of an active cloud worker. */
export const SessionsReclaimParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Terminal placement returned after a worker reclaim operation. */
export const SessionsReclaimResultPlacementSchema = Type.Union([
  LocalSessionPlacementSchema,
  ReclaimedSessionPlacementSchema,
]);

/** Result returned once worker ownership is reclaimed or a failed placement is cleared. */
export const SessionsReclaimResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    sessionId: NonEmptyString,
    placement: SessionsReclaimResultPlacementSchema,
  },
  { additionalProperties: false },
);

/** Exact active source observed before a session placement move. */
export const SessionMoveExpectedSourceSchema = closedObject({
  generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  environmentId: WorkerIdentifierSchema,
  ownerEpoch: SessionPlacementOwnerEpochSchema,
});

/** Moves the session back to the Gateway without redispatching it. */
export const SessionMoveGatewayTargetSchema = closedObject({
  kind: Type.Literal("gateway"),
});

/** Moves the session to one configured cloud worker profile. */
export const SessionMoveProfileTargetSchema = closedObject({
  kind: Type.Literal("profile"),
  profileId: WorkerIdentifierSchema,
  machineClass: Type.Optional(WorkerMachineClassSchema),
});

/** Moves the session to one paired device worker. */
export const SessionMoveDeviceTargetSchema = closedObject({
  kind: Type.Literal("device"),
  deviceId: WorkerIdentifierSchema,
});

/** Closed destination union for session placement moves. */
export const SessionMoveTargetSchema = Type.Union([
  SessionMoveGatewayTargetSchema,
  SessionMoveProfileTargetSchema,
  SessionMoveDeviceTargetSchema,
]);

/** Durable operator-visible progress for one placement move intent. */
export const SessionPlacementMoveSchema = closedObject({
  target: SessionMoveTargetSchema,
  updatedAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
});

/** Requests one exact-source placement move without replaying active work. */
export const SessionsMoveParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  expected: SessionMoveExpectedSourceSchema,
  target: SessionMoveTargetSchema,
});

/** Successful terminal states returned by sessions.move. */
export const SessionMovePlacementStateSchema = Type.Union([
  Type.Literal("local"),
  Type.Literal("active"),
]);

/** Bounded placement state returned by sessions.move. */
export const SessionMovePlacementSchema = closedObject({
  state: SessionMovePlacementStateSchema,
  generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});

/** Result returned after the requested placement move reaches its destination. */
export const SessionsMoveResultSchema = closedObject({
  ok: Type.Literal(true),
  key: NonEmptyString,
  sessionId: NonEmptyString,
  placement: SessionMovePlacementSchema,
});

export const SessionPlacementProtocolSchemas = {
  SessionPlacementState: SessionPlacementStateSchema,
  SessionPlacementDiskSpace: SessionPlacementDiskSpaceSchema,
  LocalSessionPlacement: LocalSessionPlacementSchema,
  RequestedSessionPlacement: RequestedSessionPlacementSchema,
  ProvisioningSessionPlacement: ProvisioningSessionPlacementSchema,
  SyncingSessionPlacement: SyncingSessionPlacementSchema,
  StartingSessionPlacement: StartingSessionPlacementSchema,
  ActiveWorkerSessionPlacement: ActiveWorkerSessionPlacementSchema,
  DrainingSessionPlacement: DrainingSessionPlacementSchema,
  ReconcilingSessionPlacement: ReconcilingSessionPlacementSchema,
  ReclaimedSessionPlacement: ReclaimedSessionPlacementSchema,
  FailedSessionPlacement: FailedSessionPlacementSchema,
  SessionPlacement: SessionPlacementSchema,
  SessionsDispatchParams: SessionsDispatchParamsSchema,
  SessionsDispatchResult: SessionsDispatchResultSchema,
  SessionsReclaimParams: SessionsReclaimParamsSchema,
  SessionsReclaimResultPlacement: SessionsReclaimResultPlacementSchema,
  SessionsReclaimResult: SessionsReclaimResultSchema,
  SessionMoveExpectedSource: SessionMoveExpectedSourceSchema,
  SessionMoveGatewayTarget: SessionMoveGatewayTargetSchema,
  SessionMoveProfileTarget: SessionMoveProfileTargetSchema,
  SessionMoveDeviceTarget: SessionMoveDeviceTargetSchema,
  SessionMoveTarget: SessionMoveTargetSchema,
  SessionPlacementMove: SessionPlacementMoveSchema,
  SessionsMoveParams: SessionsMoveParamsSchema,
  SessionMovePlacementState: SessionMovePlacementStateSchema,
  SessionMovePlacement: SessionMovePlacementSchema,
  SessionsMoveResult: SessionsMoveResultSchema,
} as const;

export type SessionPlacement = Static<typeof SessionPlacementSchema>;
export type SessionPlacementDiskSpace = Static<typeof SessionPlacementDiskSpaceSchema>;
export type SessionsDispatchParams = Static<typeof SessionsDispatchParamsSchema>;
export type SessionsDispatchResult = Static<typeof SessionsDispatchResultSchema>;
export type SessionsReclaimParams = Static<typeof SessionsReclaimParamsSchema>;
export type SessionsReclaimResultPlacement = Static<typeof SessionsReclaimResultPlacementSchema>;
export type SessionsReclaimResult = Static<typeof SessionsReclaimResultSchema>;
export type SessionMoveExpectedSource = Static<typeof SessionMoveExpectedSourceSchema>;
export type SessionMoveTarget = Static<typeof SessionMoveTargetSchema>;
export type SessionPlacementMove = Static<typeof SessionPlacementMoveSchema>;
export type SessionsMoveParams = Static<typeof SessionsMoveParamsSchema>;
export type SessionMovePlacementState = Static<typeof SessionMovePlacementStateSchema>;
export type SessionMovePlacement = Static<typeof SessionMovePlacementSchema>;
export type SessionsMoveResult = Static<typeof SessionsMoveResultSchema>;
