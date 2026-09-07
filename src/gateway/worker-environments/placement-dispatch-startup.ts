import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { WorkerDispatchTargetChangedError } from "../server-worker-placement-session-target.js";
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
import { syncSessionRepositoryWorkspace } from "./repository-workspace-startup.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementAuthorization,
  type WorkerPlacementDispatchRequest,
} from "./service-contract.js";
import type { WorkerEnvironmentReconcileCore, WorkerEnvironmentService } from "./service.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";

export type WorkerPlacementRecoveryBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  environmentId: string;
  expectedGeneration: number;
  signal?: AbortSignal;
  run: (workspace: WorkerSessionWorkspace) => Promise<void>;
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
  environments: WorkerDispatchEnvironmentService & Pick<WorkerEnvironmentService, "recordError">;
  isShuttingDown?: () => boolean;
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

  const retainInterruptedProvisioning = (
    owned: WorkerDispatchPlacement,
    error: unknown,
  ): WorkerDispatchPlacement | undefined => {
    const current = placements.get(owned.sessionId);
    if (
      error instanceof WorkerPlacementAdmissionTargetError ||
      error instanceof WorkerDispatchTargetChangedError ||
      !options.isShuttingDown?.() ||
      current?.state !== "provisioning" ||
      current.state !== owned.state ||
      current.generation !== owned.generation ||
      current.environmentId !== owned.environmentId ||
      current.sessionKey !== owned.sessionKey ||
      current.agentId !== owned.agentId ||
      current.executionMode !== owned.executionMode
    ) {
      return undefined;
    }
    const environment = current.environmentId ? environments.get(current.environmentId) : undefined;
    if (!environment || !isPendingProvisioningEnvironment(environment, current.environmentId)) {
      return undefined;
    }
    // No await between owner validation and recording: shutdown retains this exact operation,
    // while explicit Stop's durable destroy intent must always win.
    environments.recordError(environment, error);
    return current;
  };

  const validateDevicePlacement = async (request: WorkerPlacementDispatchRequest) => {
    if (!request.deviceId) {
      return;
    }
    const eligibility = await resolveDevicePlacementEligibility({
      environmentService: environments,
      deviceId: request.deviceId,
      requirement: request.devicePlacement,
      config: getRuntimeConfig(),
    });
    if (!eligibility.ok) {
      throw new Error(eligibility.error);
    }
  };
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
    workspace: WorkerSessionWorkspace;
    onTransition?: (placement: WorkerDispatchPlacement) => void;
    authorize?: WorkerPlacementAuthorization;
    signal?: AbortSignal;
    recovery?: true;
  }): Promise<WorkerActiveDispatchPlacement> => {
    if (params.placement.state !== "provisioning") {
      throw new Error("Worker dispatch continuation requires a provisioning placement");
    }
    const { request } = params;
    params.signal?.throwIfAborted();
    const provisioned = requireProvisionedEnvironment(
      params.environment,
      params.expectedEnvironmentId,
      request.executionMode,
      environments,
    );
    const admittedNode = await requireNodePlacementEligibility(request, params.environment);
    // Provisioning and transport setup yield; revoked callers must not attach or upload.
    params.signal?.throwIfAborted();
    params.authorize?.();
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
    params.signal?.throwIfAborted();
    const credential = await environments.attachSession({
      environmentId: provisioned.environmentId,
      ownerEpoch: provisioned.ownerEpoch,
      sessionId: request.sessionId,
    });
    params.signal?.throwIfAborted();
    params.authorize?.();
    const ownerEpoch = credential.ownerEpoch;
    let activated = false;
    let stoppingTunnel: Promise<void> | undefined;
    const stopAttemptTunnel = () => {
      stoppingTunnel ??= environments.stopTunnel(provisioned.environmentId, ownerEpoch);
      void stoppingTunnel.catch(() => undefined);
    };
    params.signal?.addEventListener("abort", stopAttemptTunnel, { once: true });
    try {
      const tunnel = await environments.startTunnel({
        environmentId: provisioned.environmentId,
        ownerEpoch,
      });
      params.signal?.throwIfAborted();
      params.authorize?.();
      const gitAuthor = options.resolveGitAuthor?.(request.agentId);
      const project = readWorkerProjectSnapshot(params.environment.profileSnapshot.project);
      const requireAttachedEnvironment = () => {
        params.signal?.throwIfAborted();
        const attachedEnvironment = environments.get(provisioned.environmentId);
        if (
          !attachedEnvironment ||
          attachedEnvironment.state !== "attached" ||
          attachedEnvironment.destroyRequestedAtMs !== null ||
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
      const assertSyncOwner = () => {
        params.signal?.throwIfAborted();
        params.authorize?.();
        requireAttachedEnvironment();
        const current = placements.get(request.sessionId);
        if (
          current?.state !== "syncing" ||
          current.generation !== placement.generation ||
          current.environmentId !== provisioned.environmentId ||
          current.sessionKey !== request.sessionKey ||
          current.agentId !== request.agentId
        ) {
          throw new Error("Worker workspace preparation lost its exact placement owner");
        }
      };
      const synced =
        params.workspace.kind === "repository"
          ? await syncSessionRepositoryWorkspace({
              repository: params.workspace.repository,
              tunnel,
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              generation: placement.generation,
              gitAuthor,
              runSetupScript: request.runSetupScript,
              recovery: params.recovery,
              assertCurrent: assertSyncOwner,
            })
          : await tunnel.syncWorkspace({
              source: {
                kind: "local",
                path: params.workspace.path,
                ...(project ? { projectKey: project.key } : {}),
              },
              sessionId: request.sessionId,
              generation: placement.generation,
              ...(gitAuthor ? { gitAuthor } : {}),
            });
      assertSyncOwner();
      params.signal?.throwIfAborted();
      params.authorize?.();
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
        const active = placements.transition({
          sessionId: request.sessionId,
          from: "starting",
          to: "active",
          expectedGeneration: startingPlacement.generation,
          patch: { activeOwnerEpoch: ownerEpoch },
        });
        if (active.state !== "active") {
          throw new Error("Worker dispatch activation did not produce an active placement");
        }
        // Activation transfers the tunnel to session reconciliation before observers can Stop.
        activated = true;
        params.signal?.removeEventListener("abort", stopAttemptTunnel);
        options.reportTransition(params.onTransition, active);
        return active;
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
            signal: params.signal,
            activate,
          });
      try {
        options.onActivated?.(request);
      } catch {
        // Maintenance scheduling cannot overturn a durable placement activation.
      }
      return activePlacement;
    } finally {
      params.signal?.removeEventListener("abort", stopAttemptTunnel);
      if (!activated && params.signal?.aborted) {
        // Start may publish its owner after the first abort. Join that exact epoch as well
        // as the original stop, including initialization, SSH children and scratch cleanup.
        await environments.stopTunnel(provisioned.environmentId, ownerEpoch);
      }
      await stoppingTunnel;
    }
  };

  const resumeProvisioning = async (
    placement: WorkerProvisioningDispatchPlacement,
    reconcileEnvironmentCore: WorkerEnvironmentReconcileCore,
    onTransition?: (placement: WorkerDispatchPlacement) => void,
    runAdmitted: (
      run: (signal?: AbortSignal) => Promise<WorkerDispatchPlacement | undefined>,
    ) => Promise<WorkerDispatchPlacement | undefined> = (run) => run(),
  ): Promise<WorkerDispatchPlacement | undefined> => {
    const environmentId = placement.environmentId;
    let recoveryRunStarted = false;
    let interruptedByShutdown = false;
    let result: WorkerDispatchPlacement | undefined;
    let recoveryOwnedPlacement: WorkerDispatchPlacement = placement;
    const report = (next: WorkerDispatchPlacement) => {
      recoveryOwnedPlacement = next;
      options.reportTransition(onTransition, next);
    };
    report(placement);
    const handleRecoveryFailure = async (
      error: unknown,
    ): Promise<WorkerDispatchPlacement | undefined> => {
      const retained = retainInterruptedProvisioning(recoveryOwnedPlacement, error);
      if (retained) {
        report(retained);
        interruptedByShutdown = true;
        throw error;
      }
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
        return undefined;
      }
      const environment = environmentId ? environments.get(environmentId) : undefined;
      // Only a provider replay entered with exact authority may retain its durable operation.
      if (
        recoveryRunStarted &&
        current.state === "provisioning" &&
        isPendingProvisioningEnvironment(environment, environmentId)
      ) {
        return undefined;
      }
      const exactEnvironment = environment?.environmentId === environmentId ? environment : null;
      const failed = await failure.teardownEnvironment({
        placement: current,
        environmentId: exactEnvironment?.environmentId ?? null,
        ownerEpoch: exactEnvironment?.ownerEpoch ?? null,
        primaryError: error,
      });
      report(failed);
      return failed;
    };
    const recover = async (signal?: AbortSignal) => {
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
          signal,
          run: async (workspace) => {
            recoveryRunStarted = true;
            try {
              signal?.throwIfAborted();
              const initialEnvironment = environments.get(environmentId);
              if (initialEnvironment?.environmentId !== environmentId) {
                throw new Error("Provisioning worker environment record is missing");
              }
              if (initialEnvironment.destroyRequestedAtMs !== null) {
                throw new Error("Provisioning worker environment destruction was requested");
              }
              await reconcileEnvironmentCore(signal);
              signal?.throwIfAborted();
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
              result = await continueProvisionedDispatch({
                request: {
                  sessionId: placement.sessionId,
                  sessionKey: placement.sessionKey,
                  agentId: placement.agentId,
                  profileId: environment.profileId,
                  executionMode: placement.executionMode,
                  ...(devicePlacement ? { devicePlacement } : {}),
                  ...(environment.providerId === DEVICE_WORKER_PROVIDER_ID &&
                  environment.nodeDeviceId
                    ? { deviceId: environment.nodeDeviceId }
                    : {}),
                },
                placement: current,
                environment,
                expectedEnvironmentId: environmentId,
                workspace,
                onTransition: report,
                signal,
                recovery: true,
              });
            } catch (error) {
              // Keep teardown under the same session lifecycle fence that admitted recovery.
              result = await handleRecoveryFailure(error);
            }
          },
        });
      } catch (error) {
        if (interruptedByShutdown) {
          throw error;
        }
        result = await handleRecoveryFailure(error);
      }
      return result;
    };
    try {
      return await runAdmitted(recover);
    } catch (error) {
      // A refused session owner still owes cleanup. Shutdown and queued cancellation
      // remain with their existing owners and must not destroy an adoptable allocation.
      if (interruptedByShutdown || !(error instanceof WorkerPlacementAdmissionTargetError)) {
        throw error;
      }
      return await handleRecoveryFailure(error);
    }
  };

  return {
    validateDevicePlacement,
    continueProvisionedDispatch,
    retainInterruptedProvisioning,
    resumeProvisioning,
  };
}
