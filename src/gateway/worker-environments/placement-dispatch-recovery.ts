import { supportsCurrentWorkerLaunch } from "./admission.js";
import {
  isCurrentActiveWorkerEnvironment,
  isUnavailableEnvironment,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchEnvironmentService,
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

function activePlacementExecutionError(
  placement: WorkerActiveDispatchPlacement,
  environment: NonNullable<ReturnType<WorkerDispatchEnvironmentService["get"]>>,
  environments: Pick<WorkerDispatchEnvironmentService, "supportsProviderExecutionMode">,
): Error | undefined {
  const provisionedMode = environment.profileSnapshot.executionMode;
  if (provisionedMode !== undefined && provisionedMode !== placement.executionMode) {
    return new Error("Active worker placement execution mode does not match its environment");
  }
  if (placement.executionMode === "worker-turn" && !environment.nodeDeviceId) {
    return new Error("Active worker-turn placement requires a node lease");
  }
  if (
    !environments.supportsProviderExecutionMode(environment.providerId, placement.executionMode)
  ) {
    return new Error(
      `Worker provider ${environment.providerId} does not support ${placement.executionMode} placement`,
    );
  }
  return undefined;
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
  // Orphan Git refs carry no live authority. Scan them once in the tracked full
  // post-start sweep, never on readiness or targeted turn recovery.
  let orphanCleanupPending = false;

  const adoptActive = async (placement: WorkerActiveDispatchPlacement): Promise<void> => {
    // Turn claims belong to the previous Gateway lifecycle and cannot prove live authority
    // after restart, so fence the whole placement before attempting to adopt it.
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
      const executionError = activePlacementExecutionError(placement, environment, environments);
      if (executionError) {
        throw executionError;
      }
      // Node leases stay authoritative while offline; their reconnect-scoped
      // tunnel is validated lazily when the next turn actually launches.
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

  const reconcile = async (mode?: "startup"): Promise<void> => {
    if (mode === "startup") {
      // Readiness fences live owners; unowned teardown remains in the service-owned sweep.
      for (const { environmentId, state } of placements.listForReconcile()) {
        if (environmentId && state !== "failed" && state !== "reclaimed") {
          await environments.reconcileEnvironment(environmentId);
        }
      }
    } else {
      await environments.reconcileOnce();
    }
    const pendingResultOwners = await recoverPendingWorkspaceResults(deps, mode !== "startup");
    orphanCleanupPending = mode === "startup";
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
              supportsCurrentWorkerLaunch(exactEnvironment.bootstrapReceipt)))
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
        // Terminal cleanup never gates readiness; tracked post-start owners resume it safely.
        if (mode !== "startup") {
          await failure.retryFailedTeardown(placement);
        }
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
    const cleanupOrphans = orphanCleanupPending && environmentId === undefined;
    const pendingResultOwners = await recoverPendingWorkspaceResults(
      deps,
      cleanupOrphans,
      environmentId,
    );
    if (cleanupOrphans) {
      orphanCleanupPending = false;
    }
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
      if (!environment || !isCurrentActiveWorkerEnvironment(placement, environment)) {
        await failure.reclaimActive(
          placement,
          environment,
          new Error("Active worker placement does not match its environment owner"),
        );
        continue;
      }
      const executionError = activePlacementExecutionError(placement, environment, environments);
      if (executionError) {
        await failure.failActive(placement, executionError, { forceClaimFence: true });
      }
    }
  };

  return { reconcile, reconcileActive };
}
