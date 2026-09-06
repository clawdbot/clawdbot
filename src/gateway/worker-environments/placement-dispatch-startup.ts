import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveNodeCommandAllowlist } from "../node-command-policy.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import {
  supportsWorkerExecutionContextLaunch,
  verifyWorkerAdmissionHandshake,
} from "./admission.js";
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
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementAuthorization,
  type WorkerPlacementDispatchRequest,
} from "./service-contract.js";
import type { WorkerEnvironmentReconcileCore, WorkerEnvironmentService } from "./service.js";

export type WorkerPlacementRecoveryBarrier = (params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  executionMode: WorkerPlacementDispatchRequest["executionMode"];
  environmentId: string;
  expectedGeneration: number;
  signal?: AbortSignal;
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

type WorkerNodePlacementAdmission = {
  node: NodeWorkerSupervisorNodeProof;
  requirement: DevicePlacementRequirement;
};

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
  environments: WorkerDispatchEnvironmentService &
    Partial<Pick<WorkerEnvironmentService, "requiresNodeEnrollment">>;
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

  const createDispatchEnvironment = (
    request: WorkerPlacementDispatchRequest,
    idempotencyKey: string,
    localPath: string,
    signal?: AbortSignal,
    preparedIntent?: WorkerProviderPreparedIntent,
  ) =>
    request.inheritedProfile
      ? environments.createFromProfileSnapshot(
          {
            profileId: request.profileId,
            providerId: request.inheritedProfile.providerId,
            profileSnapshot: request.inheritedProfile.profileSnapshot,
          },
          idempotencyKey,
          request.machineClass,
          request.executionMode,
          localPath,
          signal,
          preparedIntent,
        )
      : environments.create(
          request.profileId,
          idempotencyKey,
          request.machineClass,
          request.executionMode,
          localPath,
          signal,
          preparedIntent,
        );

  const validateCloudNodeCommands = (request: WorkerPlacementDispatchRequest) => {
    if (
      !request.deviceId &&
      request.devicePlacement?.requiredNodeCommands.length &&
      environments.requiresNodeEnrollment?.(request.profileId, request.inheritedProfile?.providerId)
    ) {
      const allowlist = resolveNodeCommandAllowlist(getRuntimeConfig());
      const deniedCommand = request.devicePlacement.requiredNodeCommands.find(
        (command) => !allowlist.has(command),
      );
      if (deniedCommand) {
        throw new Error(
          `cloud worker node command ${deniedCommand} is not enabled; add it to gateway.nodes.commands.allow and approve the command on the node`,
        );
      }
    }
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
  ): Promise<WorkerNodePlacementAdmission | undefined> => {
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

  const bindPreparedPlacement = async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    intent: WorkerProviderPreparedIntent;
    assertCurrent: () => void;
  }) => {
    const preparation = readWorkerProjectPreparation(params.intent.profileSnapshot.project);
    if (!preparation || params.intent.preparationKey !== preparation.key) {
      return undefined;
    }
    const assertCurrent = () => {
      params.assertCurrent();
      environments.assertPreparedIntentCurrent(params.request.profileId, params.intent);
    };
    assertCurrent();
    const expectedBuild = {
      bundleHash: preparation.artifacts.workerBundleHash,
      openclawVersion: preparation.artifacts.openclawVersion,
      protocolFeatures: preparation.artifacts.protocolFeatures,
    };
    for (const environment of environments.getPreparedCandidates(params.intent)) {
      if (
        !environment.nodeDeviceId ||
        !environment.leaseId ||
        !environment.bootstrapReceipt ||
        !supportsWorkerExecutionContextLaunch(environment.bootstrapReceipt) ||
        !verifyWorkerAdmissionHandshake(environment.bootstrapReceipt, expectedBuild)
      ) {
        continue;
      }
      let admittedNode: Awaited<ReturnType<typeof requireNodePlacementEligibility>>;
      try {
        admittedNode = await requireNodePlacementEligibility(params.request, environment);
      } catch {
        // An unavailable spare is a capacity miss; cancellation or revoked request authority is not.
        assertCurrent();
        continue;
      }
      assertCurrent();
      const remainsSelectable = () =>
        environments
          .getPreparedCandidates(params.intent)
          .some(
            (candidate) =>
              candidate.environmentId === environment.environmentId &&
              candidate.ownerEpoch === environment.ownerEpoch,
          );
      if (
        !admittedNode ||
        !options.isCurrentNodePlacement?.(admittedNode.node, admittedNode.requirement) ||
        !remainsSelectable()
      ) {
        continue;
      }
      const { node, requirement } = admittedNode;
      const placement = placements.bindPreparedEnvironment({
        sessionId: params.request.sessionId,
        sessionKey: params.request.sessionKey,
        agentId: params.request.agentId,
        executionMode: params.request.executionMode,
        expectedGeneration: params.placement.generation,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        providerId: params.intent.providerId,
        profileId: params.request.profileId,
        preparationKey: preparation.key,
        nodeDeviceId: environment.nodeDeviceId,
        leaseId: environment.leaseId,
        bundleHash: expectedBuild.bundleHash,
        assertCurrent: () => {
          assertCurrent();
          // Pool policy can change while node admission waits; recheck it at consumption.
          if (!remainsSelectable()) {
            throw new Error("Prepared worker is no longer available under the current pool policy");
          }
          if (!options.isCurrentNodePlacement?.(node, requirement)) {
            throw new Error("Prepared worker lost its current node authority before binding");
          }
        },
      });
      if (placement) {
        return { placement, environment, admittedNode };
      }
    }
    return undefined;
  };

  const continueProvisionedDispatch = async (params: {
    request: WorkerPlacementDispatchRequest;
    placement: WorkerDispatchPlacement;
    environment: Awaited<ReturnType<WorkerEnvironmentService["create"]>>;
    expectedEnvironmentId: string;
    localPath: string;
    onTransition?: (placement: WorkerDispatchPlacement) => void;
    authorize?: WorkerPlacementAuthorization;
    signal?: AbortSignal;
    recovery?: true;
    admittedNode?: WorkerNodePlacementAdmission;
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
    const admittedNode =
      params.admittedNode ?? (await requireNodePlacementEligibility(request, params.environment));
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
    const syncingPlacement = placement;
    const assertAttachmentCurrent = () => {
      params.signal?.throwIfAborted();
      params.authorize?.();
      const current = placements.get(request.sessionId);
      if (
        current?.state !== "syncing" ||
        current.generation !== syncingPlacement.generation ||
        current.sessionKey !== request.sessionKey ||
        current.agentId !== request.agentId ||
        current.executionMode !== request.executionMode ||
        current.environmentId !== provisioned.environmentId ||
        current.turnClaim !== null
      ) {
        throw new Error("Prepared workspace lost its exact placement authority before binding");
      }
      if (
        admittedNode &&
        !options.isCurrentNodePlacement?.(admittedNode.node, admittedNode.requirement)
      ) {
        throw new Error("Prepared worker lost its current node authority before attachment");
      }
    };
    const credential = await environments.attachSession({
      environmentId: provisioned.environmentId,
      ownerEpoch: provisioned.ownerEpoch,
      sessionId: request.sessionId,
      ...(params.environment.preparation
        ? {
            placementBinding: {
              sessionId: request.sessionId,
              sessionKey: request.sessionKey,
              agentId: request.agentId,
              executionMode: request.executionMode,
              generation: placement.generation,
              preparationKey: params.environment.preparation.key,
              assertCurrent: assertAttachmentCurrent,
            },
          }
        : {}),
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
      const preparation = readWorkerProjectPreparation(params.environment.profileSnapshot.project);
      if (preparation) {
        await environments.bindPreparedWorkspace({
          environmentId: provisioned.environmentId,
          ownerEpoch,
          sessionId: request.sessionId,
          sessionKey: request.sessionKey,
          preparationKey: preparation.key,
          cacheKey: preparation.cacheKey,
          signal: params.signal,
          assertCurrent: assertAttachmentCurrent,
        });
        assertAttachmentCurrent();
      }
      const synced = await tunnel.syncWorkspace({
        localPath: params.localPath,
        sessionId: request.sessionId,
        sessionKey: request.sessionKey,
        generation: placement.generation,
        ...(gitAuthor ? { gitAuthor } : {}),
        ...(project ? { projectKey: project.key } : {}),
      });
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
      const requireAttachedEnvironment = () => {
        params.signal?.throwIfAborted();
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
      try {
        environments.schedulePreparedRefill(provisioned.environmentId);
      } catch {
        // Capacity maintenance cannot turn a successfully activated session into a failed dispatch.
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
          run: async (localPath) => {
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
                localPath,
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
        result = await handleRecoveryFailure(error);
      }
      return result;
    };
    try {
      return await runAdmitted(recover);
    } catch (error) {
      // A refused session owner still owes cleanup. Shutdown and queued cancellation
      // remain with their existing owners and must not destroy an adoptable allocation.
      if (!(error instanceof WorkerPlacementAdmissionTargetError)) {
        throw error;
      }
      return await handleRecoveryFailure(error);
    }
  };

  return {
    bindPreparedPlacement,
    createDispatchEnvironment,
    validateCloudNodeCommands,
    validateDevicePlacement,
    continueProvisionedDispatch,
    resumeProvisioning,
  };
}
