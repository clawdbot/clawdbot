import { supportsWorkerExecutionContextLaunch } from "./admission.js";
import {
  isCurrentActiveWorkerEnvironment,
  isUnavailableEnvironment,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchPlacement,
  type WorkerFailedDispatchPlacement,
} from "./placement-dispatch-failure.js";
import {
  recoverPendingWorkspaceResults,
  type PlacementRecoveryDeps,
} from "./placement-dispatch-pending-results.js";
import type { WorkerEnvironmentService } from "./service.js";

function isFailedPlacement(
  placement: WorkerDispatchPlacement,
): placement is WorkerFailedDispatchPlacement {
  return placement.state === "failed";
}

function workerDisappearanceError(
  environment: ReturnType<WorkerEnvironmentService["get"]>,
): Error | undefined {
  if (!environment) {
    return new Error("cloud worker disappeared: environment record missing");
  }
  if (
    environment.state !== "destroyed" &&
    environment.state !== "failed" &&
    environment.state !== "orphaned"
  ) {
    return undefined;
  }
  return new Error(
    `cloud worker disappeared: ${environment.error ?? `environment state ${environment.state}`}`,
  );
}

function blockingWorkspaceJournalSessions(
  placements: PlacementRecoveryDeps["placements"],
): Set<string> {
  const sessions = new Set<string>();
  const pendingBySession = new Map(
    placements
      .listPendingWorkspaceResults()
      .map((pending) => [pending.sessionId, pending] as const),
  );
  for (const owner of placements.listWorkspaceReconciliationOwners()) {
    const placement = placements.get(owner.sessionId);
    const pending = pendingBySession.get(owner.sessionId);
    const ownsCurrentGeneration = placement?.generation === owner.placementGeneration;
    const ownsDrainedPendingGeneration =
      placement?.state === "draining" &&
      placement.generation === owner.placementGeneration + 1 &&
      pending?.environmentId === owner.environmentId &&
      pending.ownerEpoch === owner.ownerEpoch &&
      pending.placementGeneration === owner.placementGeneration;
    if (
      (placement?.state === "active" || placement?.state === "draining") &&
      placement.environmentId === owner.environmentId &&
      placement.activeOwnerEpoch === owner.ownerEpoch &&
      (ownsCurrentGeneration || ownsDrainedPendingGeneration)
    ) {
      sessions.add(owner.sessionId);
    }
  }
  return sessions;
}

export function createPlacementRecoveryActions(deps: PlacementRecoveryDeps) {
  const { environments, failure, placements } = deps;

  const adoptActive = async (placement: WorkerActiveDispatchPlacement): Promise<void> => {
    // Worker turns are one-shot SSH children owned by the previous gateway process. A durable
    // claim cannot prove that child remains live after restart, so fence the whole placement.
    if (placement.turnClaim) {
      const error = new Error(
        "Active worker turn claim cannot be proven live after gateway restart",
      );
      await failure.failActive(placement, error, { forceClaimFence: true });
      return;
    }
    const environment = placement.environmentId
      ? environments.get(placement.environmentId)
      : undefined;
    const disappearance = workerDisappearanceError(environment);
    if (disappearance || (environment && isUnavailableEnvironment(environment))) {
      await failure.reclaimActive(
        placement,
        environment,
        disappearance ?? new Error(`Active worker environment is ${environment?.state}`),
      );
      return;
    }
    if (!environment || !isCurrentActiveWorkerEnvironment(placement, environment)) {
      await failure.reclaimActive(
        placement,
        environment,
        new Error("Active worker placement does not match its environment owner"),
      );
      return;
    }
    try {
      // Paired nodes are persistent runners, not one-shot SSH children. Their
      // dormant lease remains authoritative while offline; validate and create
      // the reconnect-scoped tunnel lazily when the next turn actually launches.
      if (!environment.nodeDeviceId) {
        await environments.startTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
        });
      }
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

  const reconcile = async (): Promise<void> => {
    await environments.reconcileOnce();
    const pendingResultOwners = await recoverPendingWorkspaceResults(deps, true);
    const journalOwners = blockingWorkspaceJournalSessions(placements);
    const moveOwners = (await deps.recoverPlacementMoves?.()) ?? new Set<string>();
    for (const placement of placements.listForReconcile()) {
      if (
        journalOwners.has(placement.sessionId) ||
        pendingResultOwners.has(placement.sessionId) ||
        moveOwners.has(placement.sessionId)
      ) {
        continue;
      }
      if (placement.state === "local" || placement.state === "reclaimed") {
        continue;
      }
      if (placement.state === "provisioning") {
        const environment = placement.environmentId
          ? environments.get(placement.environmentId)
          : undefined;
        const exactEnvironment =
          environment?.environmentId === placement.environmentId ? environment : undefined;
        if (
          exactEnvironment &&
          exactEnvironment.destroyRequestedAtMs === null &&
          (exactEnvironment.state === "requested" ||
            exactEnvironment.state === "provisioning" ||
            exactEnvironment.state === "bootstrapping" ||
            ((exactEnvironment.state === "ready" || exactEnvironment.state === "idle") &&
              supportsWorkerExecutionContextLaunch(exactEnvironment.bootstrapReceipt)))
        ) {
          // Transient provider or node-enrollment failure retains its exact durable operation.
          continue;
        }
        await failure.teardownEnvironment({
          placement,
          environmentId: exactEnvironment?.environmentId ?? null,
          ownerEpoch: exactEnvironment?.ownerEpoch ?? null,
          primaryError: new Error(
            exactEnvironment
              ? `Provisioning worker environment cannot be recovered from ${exactEnvironment.state}`
              : "Provisioning worker environment record is missing",
          ),
        });
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
      const error = new Error(`Worker dispatch interrupted in ${placement.state}`);
      if (placement.state === "draining") {
        await failure.failDraining(placement, error, { forceClaimFence: true });
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
  const reconcileActive = async (environmentId?: string): Promise<void> => {
    await environments.reconcileOnce();
    const pendingResultOwners = await recoverPendingWorkspaceResults(deps, false, environmentId);
    const journalOwners = blockingWorkspaceJournalSessions(placements);
    const moveOwners = (await deps.recoverPlacementMoves?.()) ?? new Set<string>();
    for (const placement of placements.listForReconcile()) {
      if (
        journalOwners.has(placement.sessionId) ||
        pendingResultOwners.has(placement.sessionId) ||
        moveOwners.has(placement.sessionId)
      ) {
        continue;
      }
      if (environmentId !== undefined && placement.environmentId !== environmentId) {
        continue;
      }
      if (isFailedPlacement(placement)) {
        await failure.retryFailedTeardown(placement);
        continue;
      }
      if (placement.state !== "active") {
        continue;
      }
      const environment = environments.get(placement.environmentId);
      const disappearance = workerDisappearanceError(environment);
      if (disappearance || (environment && isUnavailableEnvironment(environment))) {
        await failure.reclaimActive(
          placement,
          environment,
          disappearance ?? new Error(`Active worker environment is ${environment?.state}`),
        );
        continue;
      }
      if (!isCurrentActiveWorkerEnvironment(placement, environment)) {
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
