import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { SESSION_PLACEMENT_STATES } from "./session-placement-state.js";

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

/** Requests one-way dispatch of an existing local session to a configured worker profile. */
export const SessionsDispatchParamsSchema = closedObject({
  key: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  profileId: NonEmptyString,
});

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

export type SessionPlacement = Static<typeof SessionPlacementSchema>;
export type SessionsDispatchParams = Static<typeof SessionsDispatchParamsSchema>;
export type SessionsDispatchResult = Static<typeof SessionsDispatchResultSchema>;
export type SessionsReclaimParams = Static<typeof SessionsReclaimParamsSchema>;
export type SessionsReclaimResult = Static<typeof SessionsReclaimResultSchema>;
