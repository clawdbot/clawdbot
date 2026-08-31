import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { supportsWorkerExecutionContextLaunch } from "./admission.js";
import { resolveDevicePlacementEligibility } from "./device-placement-eligibility.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type {
  PlacementFailureActions,
  WorkerActivationBarrier,
  WorkerActiveDispatchPlacement,
  WorkerDispatchEnvironmentService,
  WorkerDispatchPlacement,
  WorkerDispatchPlacementStore,
  WorkerProvisioningDispatchPlacement,
} from "./placement-dispatch-failure.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import type {
  WorkerPlacementAuthorization,
  WorkerPlacementDispatchRequest,
} from "./service-contract.js";
import type { WorkerEnvironmentReconcileCore, WorkerEnvironmentService } from "./service.js";

export type WorkerPlacementRecoveryBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  environmentId: string;
  expectedGeneration: number;
  run: (localPath: string) => Promise<void>;
}) => Promise<void>;

export type WorkerDevicePlacementRequirementResolver = (
  identity: Pick<
    WorkerPlacementDispatchRequest,
    "sessionId" | "sessionKey" | "agentId" | "executionMode"
  >,
) => Promise<DevicePlacementRequirement>;

export type WorkerNodePlacementAuthority = (
  node: NodeWorkerSupervisorNodeProof,
  requirement: DevicePlacementRequirement,
) => boolean;

function isPendingProvisioningEnvironment(
  environment: ReturnType<WorkerEnvironmentService["get"]>,
  environmentId: string | null,
): boolean {
  return (
    environment?.environmentId === environmentId &&
    environment.destroyRequestedAtMs === null &&
    (environment.state === "requested" ||
      environment.state === "provisioning" ||
      environment.state === "bootstrapping")
  );
}

function requireProvisionedEnvironment(
  environment: Awaited<ReturnType<WorkerEnvironmentService["create"]>>,
  expectedEnvironmentId: string,
  executionMode: WorkerPlacementDispatchRequest["executionMode"],
  environments: Pick<WorkerDispatchEnvironmentService, "supportsProviderExecutionMode">,
): { environmentId: string; ownerEpoch: number; bundleHash: string } {
  if (
    (environment.state !== "ready" && environment.state !== "idle") ||
    environment.environmentId !== expectedEnvironmentId ||
    environment.destroyRequestedAtMs !== null ||
    !environment.bootstrapReceipt ||
    !supportsWorkerExecutionContextLaunch(environment.bootstrapReceipt)
  ) {
    throw new Error(
      `Worker environment is not dispatchable with the current execution-context contract: ${environment.state}`,
    );
  }
  if (
    (environment.profileSnapshot.executionMode !== undefined &&
      environment.profileSnapshot.executionMode !== executionMode) ||
    (executionMode === "worker-turn" &&
      environment.profileSnapshot.executionMode !== undefined &&
      !environment.nodeDeviceId) ||
    !environments.supportsProviderExecutionMode(environment.providerId, executionMode)
  ) {
    throw new Error("Worker environment does not support the placement's exact execution mode");
  }
  return {
    environmentId: environment.environmentId,
    ownerEpoch: environment.ownerEpoch,
    bundleHash: environment.bootstrapReceipt.bundleHash,
  };
}

export function createWorkerPlacementDispatchStartup(options: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  failure: PlacementFailureActions;
  runRecoveryBarrier: WorkerPlacementRecoveryBarrier;
  runActivationBarrier: WorkerActivationBarrier;
  onActivated?: (request: WorkerPlacementDispatchRequest) => void;
  resolveGitAuthor?: (agentId: string) => { name?: string; email?: string } | undefined;
  resolveDevicePlacementRequirement?: WorkerDevicePlacementRequirementResolver;
  isCurrentNodePlacement?: WorkerNodePlacementAuthority;
  reportTransition: (
    observer: ((placement: WorkerDispatchPlacement) => void) | undefined,
    placement: WorkerDispatchPlacement,
  ) => void;
}) {
  const { environments, failure, placements } = options;

  const requireNodePlacementEligibility = async (
    request: WorkerPlacementDispatchRequest,
    environment: Awaited<ReturnType<WorkerEnvironmentService["create"]>>,
    admittedNode?: NodeWorkerSupervisorNodeProof,
  ): Promise<
    { node: NodeWorkerSupervisorNodeProof; requirement: DevicePlacementRequirement } | undefined
  > => {
    const deviceId = environment.nodeDeviceId;
    if (!deviceId) {
      return undefined;
    }
    const requirement =
      request.devicePlacement ??
      (options.resolveDevicePlacementRequirement
        ? await options.resolveDevicePlacementRequirement({
            sessionId: request.sessionId,
            sessionKey: request.sessionKey,
            agentId: request.agentId,
            executionMode: request.executionMode,
          })
        : undefined);
    if (!requirement) {
      throw new Error("Node-backed cloud placement has no authoritative runtime requirement");
    }
    const eligibility = await resolveDevicePlacementEligibility({
      environmentService: environments,
      deviceId,
      requirement,
      config: getRuntimeConfig(),
      ...(admittedNode ? { currentNode: admittedNode } : {}),
    });
    if (!eligibility.ok) {
      throw new Error(eligibility.error);
    }
    return { node: eligibility.node, requirement };
  };

  const continueProvisionedDispatch = async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    environment: Awaited<ReturnType<WorkerEnvironmentService["create"]>>;
    expectedEnvironmentId: string;
    localPath: string;
    onTransition?: (placement: WorkerDispatchPlacement) => void;
    authorize?: WorkerPlacementAuthorization;
    recovery?: true;
  }): Promise<WorkerActiveDispatchPlacement> => {
    if (params.placement.state !== "provisioning") {
      throw new Error("Worker dispatch continuation requires a provisioning placement");
    }
    const { request } = params;
    const provisioned = requireProvisionedEnvironment(
      params.environment,
      params.expectedEnvironmentId,
      request.executionMode,
      environments,
    );
    const admittedNode = await requireNodePlacementEligibility(request, params.environment);
    let placement = placements.transition({
      sessionId: request.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: params.placement.generation,
      patch: {
        environmentId: provisioned.environmentId,
        workerBundleHash: provisioned.bundleHash,
      },
    });
    options.reportTransition(params.onTransition, placement);
    const credential = await environments.attachSession({
      environmentId: provisioned.environmentId,
      ownerEpoch: provisioned.ownerEpoch,
      sessionId: request.sessionId,
    });
    const ownerEpoch = credential.ownerEpoch;
    const tunnel = await environments.startTunnel({
      environmentId: provisioned.environmentId,
      ownerEpoch,
    });
    const gitAuthor = options.resolveGitAuthor?.(request.agentId);
    const project = readWorkerProjectSnapshot(params.environment.profileSnapshot.project);
    const synced = await tunnel.syncWorkspace({
      localPath: params.localPath,
      sessionId: request.sessionId,
      generation: placement.generation,
      ...(gitAuthor ? { gitAuthor } : {}),
      ...(project ? { projectKey: project.key } : {}),
    });
    placement = placements.transition({
      sessionId: request.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: synced.manifestRef,
        remoteWorkspaceDir: synced.remoteWorkspaceDir,
      },
    });
    options.reportTransition(params.onTransition, placement);
    const startingPlacement = placement;
    const requireAttachedEnvironment = () => {
      const attachedEnvironment = environments.get(provisioned.environmentId);
      if (
        !attachedEnvironment ||
        attachedEnvironment.state !== "attached" ||
        attachedEnvironment.ownerEpoch !== ownerEpoch ||
        attachedEnvironment.attachedSessionIds.length !== 1 ||
        attachedEnvironment.attachedSessionIds[0] !== request.sessionId ||
        attachedEnvironment.nodeDeviceId !== params.environment.nodeDeviceId ||
        attachedEnvironment.leaseId !== params.environment.leaseId ||
        attachedEnvironment.bootstrapReceipt?.bundleHash !== provisioned.bundleHash
      ) {
        throw new Error("Worker dispatch lost its exact environment owner before activation");
      }
      return attachedEnvironment;
    };
    await requireNodePlacementEligibility(
      request,
      requireAttachedEnvironment(),
      admittedNode?.node,
    );
    requireAttachedEnvironment();
    const activate = (): WorkerActiveDispatchPlacement => {
      requireAttachedEnvironment();
      if (
        admittedNode &&
        !options.isCurrentNodePlacement?.(admittedNode.node, admittedNode.requirement)
      ) {
        throw new Error(
          "Worker dispatch lost its current node connection, pairing generation, command authorization, or capacity before activation",
        );
      }
      const activated = placements.transition({
        sessionId: request.sessionId,
        from: "starting",
        to: "active",
        expectedGeneration: startingPlacement.generation,
        patch: { activeOwnerEpoch: ownerEpoch },
      });
      if (activated.state !== "active") {
        throw new Error("Worker dispatch activation did not produce an active placement");
      }
      options.reportTransition(params.onTransition, activated);
      return activated;
    };
    // Recovery retains the exact session/placement lifecycle fence through activation.
    const activePlacement = params.recovery
      ? activate()
      : await options.runActivationBarrier({
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          agentId: request.agentId,
          executionMode: request.executionMode,
          authorize: params.authorize,
          activate,
        });
    try {
      options.onActivated?.(request);
    } catch {
      // Maintenance scheduling cannot overturn a durable placement activation.
    }
    return activePlacement;
  };

  const resumeProvisioning = async (
    placement: WorkerProvisioningDispatchPlacement,
    reconcileEnvironmentCore: WorkerEnvironmentReconcileCore,
  ): Promise<void> => {
    const environmentId = placement.environmentId;
    let recoveryRunStarted = false;
    let recoveryOwnedPlacement: WorkerDispatchPlacement = placement;
    const handleRecoveryFailure = async (error: unknown): Promise<void> => {
      const current = placements.get(placement.sessionId);
      if (
        !current ||
        (current.state !== "provisioning" &&
          current.state !== "syncing" &&
          current.state !== "starting") ||
        current.state !== recoveryOwnedPlacement.state ||
        current.generation !== recoveryOwnedPlacement.generation ||
        current.environmentId !== environmentId ||
        current.sessionKey !== placement.sessionKey ||
        current.agentId !== placement.agentId ||
        current.executionMode !== placement.executionMode
      ) {
        return;
      }
      const environment = environmentId ? environments.get(environmentId) : undefined;
      // Only a provider replay entered with exact authority may retain its durable operation.
      if (
        recoveryRunStarted &&
        current.state === "provisioning" &&
        isPendingProvisioningEnvironment(environment, environmentId)
      ) {
        return;
      }
      const exactEnvironment = environment?.environmentId === environmentId ? environment : null;
      await failure.teardownEnvironment({
        placement: current,
        environmentId: exactEnvironment?.environmentId ?? null,
        ownerEpoch: exactEnvironment?.ownerEpoch ?? null,
        primaryError: error,
      });
    };
    try {
      if (!environmentId) {
        throw new Error("Provisioning worker placement has no environment owner");
      }
      await options.runRecoveryBarrier({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        executionMode: placement.executionMode,
        environmentId,
        expectedGeneration: placement.generation,
        run: async (localPath) => {
          recoveryRunStarted = true;
          try {
            const initialEnvironment = environments.get(environmentId);
            if (initialEnvironment?.environmentId !== environmentId) {
              throw new Error("Provisioning worker environment record is missing");
            }
            if (initialEnvironment.destroyRequestedAtMs !== null) {
              throw new Error("Provisioning worker environment destruction was requested");
            }
            await reconcileEnvironmentCore();
            const current = placements.get(placement.sessionId);
            if (
              current?.state !== "provisioning" ||
              current.generation !== placement.generation ||
              current.environmentId !== environmentId
            ) {
              throw new Error("Provisioning worker placement changed during restart recovery");
            }
            const environment = environments.get(environmentId);
            if (environment?.environmentId !== environmentId) {
              throw new Error("Provisioning worker environment record is missing");
            }
            if (isPendingProvisioningEnvironment(environment, environmentId)) {
              return;
            }
            let devicePlacement: DevicePlacementRequirement | undefined;
            if (environment.nodeDeviceId) {
              if (!options.resolveDevicePlacementRequirement) {
                throw new Error("Node-backed recovery has no authoritative runtime requirement");
              }
              devicePlacement = await options.resolveDevicePlacementRequirement({
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                executionMode: placement.executionMode,
              });
            }
            await continueProvisionedDispatch({
              request: {
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                profileId: environment.profileId,
                executionMode: placement.executionMode,
                ...(devicePlacement ? { devicePlacement } : {}),
                ...(environment.providerId === DEVICE_WORKER_PROVIDER_ID && environment.nodeDeviceId
                  ? { deviceId: environment.nodeDeviceId }
                  : {}),
              },
              placement: current,
              environment,
              expectedEnvironmentId: environmentId,
              localPath,
              onTransition: (next) => {
                recoveryOwnedPlacement = next;
              },
              recovery: true,
            });
          } catch (error) {
            // Keep teardown under the same session lifecycle fence that admitted recovery.
            await handleRecoveryFailure(error);
          }
        },
      });
    } catch (error) {
      await handleRecoveryFailure(error);
    }
  };

  return { continueProvisionedDispatch, resumeProvisioning };
}
