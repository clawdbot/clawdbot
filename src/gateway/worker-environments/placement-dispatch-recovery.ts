import {
  isUnavailableEnvironment,
  type PlacementFailureActions,
  type WorkerActivationBarrier,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
  type WorkerDispatchPlacement,
  type WorkerDispatchPlacementStore,
  type WorkerFailedDispatchPlacement,
  type WorkerStartingDispatchPlacement,
} from "./placement-dispatch-failure.js";
import type { WorkerEnvironmentService } from "./service.js";

function sameActiveEnvironment(
  placement: WorkerActiveDispatchPlacement,
  environment: ReturnType<WorkerEnvironmentService["get"]>,
): environment is NonNullable<typeof environment> {
  return Boolean(
    environment &&
    environment.state === "attached" &&
    placement.environmentId &&
    environment.environmentId === placement.environmentId &&
    placement.activeOwnerEpoch !== null &&
    environment.ownerEpoch === placement.activeOwnerEpoch &&
    placement.workerBundleHash &&
    environment.bootstrapReceipt?.bundleHash === placement.workerBundleHash &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === placement.sessionId,
  );
}

function isStartingPlacement(
  placement: WorkerDispatchPlacement,
): placement is WorkerStartingDispatchPlacement {
  return placement.state === "starting";
}

function isFailedPlacement(
  placement: WorkerDispatchPlacement,
): placement is WorkerFailedDispatchPlacement {
  return placement.state === "failed";
}

export function createPlacementRecoveryActions(deps: {
  placements: WorkerDispatchPlacementStore;
  environments: WorkerDispatchEnvironmentService;
  runActivationBarrier: WorkerActivationBarrier;
  failure: PlacementFailureActions;
}) {
  const { environments, failure, placements } = deps;

  const adoptActive = async (placement: WorkerActiveDispatchPlacement): Promise<void> => {
    // Worker turns are one-shot SSH children owned by the previous gateway process. A durable
    // claim cannot prove that child remains live after restart, so fence the whole placement.
    if (placement.turnClaim) {
      const error = new Error(
        "Active worker turn claim cannot be proven live after gateway restart",
      );
      await failure.failActive(placement, error);
      return;
    }
    const environment = placement.environmentId
      ? environments.get(placement.environmentId)
      : undefined;
    if (!environment || isUnavailableEnvironment(environment)) {
      await failure.reclaimActive(
        placement,
        environment,
        new Error("Active worker disappeared during restart reconciliation"),
      );
      return;
    }
    if (!sameActiveEnvironment(placement, environment)) {
      await failure.reclaimActive(
        placement,
        environment,
        new Error("Active worker placement does not match its environment owner"),
      );
      return;
    }
    try {
      await environments.startTunnel({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      });
      placements.adoptActive({
        sessionId: placement.sessionId,
        expectedGeneration: placement.generation,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
      });
    } catch (error) {
      await failure.failActive(placement, error);
    }
  };

  const resumeStarting = async (placement: WorkerStartingDispatchPlacement): Promise<void> => {
    const environment = placement.environmentId
      ? environments.get(placement.environmentId)
      : undefined;
    const expectedBundle = placement.workerBundleHash;
    const hasSyncedWorkspace = Boolean(
      placement.workspaceBaseManifestRef && placement.remoteWorkspaceDir,
    );
    const canResume =
      environment &&
      expectedBundle &&
      environment.bootstrapReceipt?.bundleHash === expectedBundle &&
      hasSyncedWorkspace;
    if (!canResume) {
      const error = new Error("Interrupted worker dispatch cannot safely resume");
      await failure.teardownEnvironment({
        placement,
        environmentId: placement.environmentId,
        ownerEpoch: environment?.ownerEpoch ?? null,
        primaryError: error,
      });
      return;
    }
    try {
      const ownerEpoch =
        environment.state === "attached" &&
        environment.attachedSessionIds.length === 1 &&
        environment.attachedSessionIds[0] === placement.sessionId
          ? environment.ownerEpoch
          : environment.state === "ready" || environment.state === "idle"
            ? (
                await environments.attachSession({
                  environmentId: environment.environmentId,
                  ownerEpoch: environment.ownerEpoch,
                  sessionId: placement.sessionId,
                })
              ).ownerEpoch
            : undefined;
      if (ownerEpoch === undefined) {
        throw new Error(`Worker environment cannot resume dispatch from ${environment.state}`);
      }
      await environments.startTunnel({ environmentId: environment.environmentId, ownerEpoch });
      await deps.runActivationBarrier({
        sessionId: placement.sessionId,
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        activate: () => {
          const activated = placements.transition({
            sessionId: placement.sessionId,
            from: "starting",
            to: "active",
            expectedGeneration: placement.generation,
            patch: { activeOwnerEpoch: ownerEpoch },
          });
          if (activated.state !== "active") {
            throw new Error("Worker dispatch activation did not produce an active placement");
          }
          return activated;
        },
      });
    } catch (error) {
      await failure.teardownEnvironment({
        placement,
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        primaryError: error,
      });
    }
  };

  const reconcile = async (): Promise<void> => {
    await environments.reconcileOnce();
    for (const placement of placements.listForReconcile()) {
      if (placement.state === "local" || placement.state === "reclaimed") {
        continue;
      }
      if (placement.state === "active") {
        await adoptActive(placement);
        continue;
      }
      if (isFailedPlacement(placement)) {
        await failure.retryFailedTeardown(placement);
        continue;
      }
      if (isStartingPlacement(placement)) {
        await resumeStarting(placement);
        continue;
      }
      const error = new Error(`Worker dispatch interrupted in ${placement.state}`);
      if (placement.state === "draining") {
        await failure.failDraining(placement, error);
        continue;
      }
      await failure.teardownEnvironment({
        placement,
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
        primaryError: error,
      });
    }
  };

  // Runtime sweeps must not classify a live dispatch preparation as a crash. They only repair
  // durable active ownership and retry teardown already fenced by a previous failure.
  const reconcileActive = async (): Promise<void> => {
    await environments.reconcileOnce();
    for (const placement of placements.listForReconcile()) {
      if (isFailedPlacement(placement)) {
        await failure.retryFailedTeardown(placement);
        continue;
      }
      if (placement.state !== "active") {
        continue;
      }
      const environment = environments.get(placement.environmentId);
      if (!environment || isUnavailableEnvironment(environment)) {
        await failure.reclaimActive(
          placement,
          environment,
          new Error("Active worker disappeared during an admitted turn"),
        );
        continue;
      }
      if (!sameActiveEnvironment(placement, environment)) {
        await failure.reclaimActive(
          placement,
          environment,
          new Error("Active worker placement does not match its environment owner"),
        );
      }
    }
  };

  return { reconcile, reconcileActive };
}
