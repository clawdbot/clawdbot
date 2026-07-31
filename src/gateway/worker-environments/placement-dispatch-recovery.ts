import { WORKER_LAUNCH_V2_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  isUnavailableEnvironment,
  type WorkerActiveDispatchPlacement,
  type WorkerDispatchPlacement,
  type WorkerDrainingDispatchPlacement,
  type WorkerFailedDispatchPlacement,
  type WorkerStartingDispatchPlacement,
} from "./placement-dispatch-failure.js";
import {
  recoverPendingWorkspaceResults,
  type PlacementRecoveryDeps,
} from "./placement-dispatch-pending-results.js";
import type { WorkerEnvironmentService } from "./service.js";

function supportsWorkerLaunchV2(environment: ReturnType<WorkerEnvironmentService["get"]>): boolean {
  // A persisted bundle hash can still match a pre-v2 worker when current bundle preparation fails.
  // Require the admitted receipt so restart recovery never revives an incompatible launch contract.
  return (
    environment?.bootstrapReceipt?.protocolFeatures.includes(WORKER_LAUNCH_V2_PROTOCOL_FEATURE) ===
    true
  );
}

function sameActiveEnvironment(
  placement: WorkerActiveDispatchPlacement | WorkerDrainingDispatchPlacement,
  environment: ReturnType<WorkerEnvironmentService["get"]>,
): boolean {
  return Boolean(
    environment &&
    environment.state === "attached" &&
    placement.environmentId &&
    environment.environmentId === placement.environmentId &&
    placement.activeOwnerEpoch !== null &&
    environment.ownerEpoch === placement.activeOwnerEpoch &&
    placement.workerBundleHash &&
    environment.bootstrapReceipt?.bundleHash === placement.workerBundleHash &&
    supportsWorkerLaunchV2(environment) &&
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

function blockingWorkspaceJournalSessions(
  placements: PlacementRecoveryDeps["placements"],
): Set<string> {
  const sessions = new Set<string>();
  for (const owner of placements.listWorkspaceReconciliationOwners()) {
    const placement = placements.get(owner.sessionId);
    if (
      (placement?.state === "active" || placement?.state === "draining") &&
      placement.environmentId === owner.environmentId &&
      placement.activeOwnerEpoch === owner.ownerEpoch &&
      placement.generation === owner.placementGeneration
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
      supportsWorkerLaunchV2(environment) &&
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
    const pendingResultOwners = await recoverPendingWorkspaceResults(deps, true);
    const journalOwners = blockingWorkspaceJournalSessions(placements);
    for (const placement of placements.listForReconcile()) {
      if (journalOwners.has(placement.sessionId) || pendingResultOwners.has(placement.sessionId)) {
        continue;
      }
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
    const pendingResultOwners = await recoverPendingWorkspaceResults(deps, false);
    const journalOwners = blockingWorkspaceJournalSessions(placements);
    for (const placement of placements.listForReconcile()) {
      if (journalOwners.has(placement.sessionId) || pendingResultOwners.has(placement.sessionId)) {
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
