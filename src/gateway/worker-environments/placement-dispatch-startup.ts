import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
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
  reportTransition: (
    observer: ((placement: WorkerDispatchPlacement) => void) | undefined,
    placement: WorkerDispatchPlacement,
  ) => void;
}) {
  const { environments, failure, placements } = options;

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
    );
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
    const synced = await tunnel.syncWorkspace({
      localPath: params.localPath,
      sessionId: request.sessionId,
      generation: placement.generation,
      ...(gitAuthor ? { gitAuthor } : {}),
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
    const attachedEnvironment = environments.get(provisioned.environmentId);
    if (
      !attachedEnvironment ||
      attachedEnvironment.state !== "attached" ||
      attachedEnvironment.ownerEpoch !== ownerEpoch ||
      attachedEnvironment.attachedSessionIds.length !== 1 ||
      attachedEnvironment.attachedSessionIds[0] !== request.sessionId ||
      attachedEnvironment.bootstrapReceipt?.bundleHash !== provisioned.bundleHash
    ) {
      throw new Error("Worker dispatch lost its exact environment owner before activation");
    }
    const activate = (): WorkerActiveDispatchPlacement => {
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
            if (environment.providerId === DEVICE_WORKER_PROVIDER_ID && environment.nodeDeviceId) {
              if (!options.resolveDevicePlacementRequirement) {
                throw new Error("Paired-device recovery has no authoritative runtime requirement");
              }
              devicePlacement = await options.resolveDevicePlacementRequirement({
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                executionMode: placement.executionMode,
              });
              const eligibility = await resolveDevicePlacementEligibility({
                environmentService: environments,
                deviceId: environment.nodeDeviceId,
                requirement: devicePlacement,
                config: getRuntimeConfig(),
              });
              if (!eligibility.ok) {
                throw new Error(eligibility.error);
              }
            }
            await continueProvisionedDispatch({
              request: {
                sessionId: placement.sessionId,
                sessionKey: placement.sessionKey,
                agentId: placement.agentId,
                profileId: environment.profileId,
                executionMode: placement.executionMode,
                ...(environment.providerId === DEVICE_WORKER_PROVIDER_ID && environment.nodeDeviceId
                  ? { deviceId: environment.nodeDeviceId, devicePlacement }
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
