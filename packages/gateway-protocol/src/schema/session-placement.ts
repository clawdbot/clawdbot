import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/** Durable gateway ownership states for one session execution placement. */
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

const TerminalSessionPlacementProperties = {
  environmentId: Type.Optional(NonEmptyString),
  activeOwnerEpoch: Type.Optional(SessionPlacementOwnerEpochSchema),
  workspaceBaseManifestRef: Type.Optional(NonEmptyString),
  remoteWorkspaceDir: Type.Optional(NonEmptyString),
  workerBundleHash: Type.Optional(WorkerBundleHashSchema),
  ...SessionPlacementAckProperties,
};

function createUnownedSessionPlacementSchema<const State extends "local" | "requested">(
  state: State,
) {
  return Type.Object(
    { state: Type.Literal(state), ...SessionPlacementTimingProperties },
    { additionalProperties: false },
  );
}

function createWorkerOwnedSessionPlacementSchema<
  const State extends "active" | "draining" | "reconciling",
>(state: State) {
  return Type.Object(
    {
      state: Type.Literal(state),
      ...SessionPlacementTimingProperties,
      environmentId: NonEmptyString,
      activeOwnerEpoch: SessionPlacementOwnerEpochSchema,
      workerBundleHash: WorkerBundleHashSchema,
      ...SessionPlacementWorkspaceProperties,
      ...SessionPlacementAckProperties,
    },
    { additionalProperties: false },
  );
}

export const LocalSessionPlacementSchema = createUnownedSessionPlacementSchema("local");
export const RequestedSessionPlacementSchema = createUnownedSessionPlacementSchema("requested");

export const ProvisioningSessionPlacementSchema = Type.Object(
  {
    state: Type.Literal("provisioning"),
    ...SessionPlacementTimingProperties,
    environmentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const SyncingSessionPlacementSchema = Type.Object(
  {
    state: Type.Literal("syncing"),
    ...SessionPlacementTimingProperties,
    environmentId: NonEmptyString,
    workerBundleHash: WorkerBundleHashSchema,
  },
  { additionalProperties: false },
);

export const StartingSessionPlacementSchema = Type.Object(
  {
    state: Type.Literal("starting"),
    ...SessionPlacementTimingProperties,
    environmentId: NonEmptyString,
    workerBundleHash: WorkerBundleHashSchema,
    ...SessionPlacementWorkspaceProperties,
  },
  { additionalProperties: false },
);

export const ActiveWorkerSessionPlacementSchema = createWorkerOwnedSessionPlacementSchema("active");
export const DrainingSessionPlacementSchema = createWorkerOwnedSessionPlacementSchema("draining");
export const ReconcilingSessionPlacementSchema =
  createWorkerOwnedSessionPlacementSchema("reconciling");

export const ReclaimedSessionPlacementSchema = Type.Object(
  {
    state: Type.Literal("reclaimed"),
    ...SessionPlacementTimingProperties,
    ...TerminalSessionPlacementProperties,
  },
  { additionalProperties: false },
);

export const FailedSessionPlacementSchema = Type.Object(
  {
    state: Type.Literal("failed"),
    ...SessionPlacementTimingProperties,
    ...TerminalSessionPlacementProperties,
    recoveryError: NonEmptyString,
  },
  { additionalProperties: false },
);

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

/** Requests one-way dispatch of an existing local session to a configured worker profile. */
export const SessionsDispatchParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    profileId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Result returned once session dispatch reaches durable worker ownership. */
export const SessionsDispatchResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    sessionId: NonEmptyString,
    placement: ActiveWorkerSessionPlacementSchema,
  },
  { additionalProperties: false },
);

/** Requests safe workspace reconciliation and teardown of an active cloud worker. */
export const SessionsReclaimParamsSchema = Type.Object(
  {
    key: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Result returned once worker ownership has been destroyed and reclaimed. */
export const SessionsReclaimResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    key: NonEmptyString,
    sessionId: NonEmptyString,
    placement: ReclaimedSessionPlacementSchema,
  },
  { additionalProperties: false },
);

export const SessionPlacementProtocolSchemas = {
  SessionPlacementState: SessionPlacementStateSchema,
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
  SessionsReclaimResult: SessionsReclaimResultSchema,
} as const;

export type SessionPlacementState = Static<typeof SessionPlacementStateSchema>;
export type SessionPlacement = Static<typeof SessionPlacementSchema>;
export type SessionsDispatchParams = Static<typeof SessionsDispatchParamsSchema>;
export type SessionsDispatchResult = Static<typeof SessionsDispatchResultSchema>;
export type SessionsReclaimParams = Static<typeof SessionsReclaimParamsSchema>;
export type SessionsReclaimResult = Static<typeof SessionsReclaimResultSchema>;
