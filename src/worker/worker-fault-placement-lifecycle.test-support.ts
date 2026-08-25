import { hashWorkerCredential } from "../gateway/worker-environments/credential.js";
import type { WorkerLiveEventReceiver } from "../gateway/worker-environments/live-events.js";
import {
  projectWorkerSessionTurnClaim,
  type WorkerSessionTurnClaim,
} from "../gateway/worker-environments/placement-record.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
} from "../gateway/worker-environments/placement-store.js";
import type { WorkerEnvironmentStore } from "../gateway/worker-environments/store.js";

type WorkerFaultPlacementLifecycleOptions = {
  agentId: string;
  bundleHash: string;
  environmentId: string;
  environmentStore: WorkerEnvironmentStore;
  getLiveEvents: () => Pick<WorkerLiveEventReceiver, "rotateCredential">;
  getOwnerEpoch: () => number;
  placementStore: WorkerSessionPlacementStore;
  rpcSetVersion: number;
  sessionId: string;
  sessionKey: string;
};

export class WorkerFaultPlacementLifecycle {
  private claimSequence = 0;

  constructor(private readonly options: WorkerFaultPlacementLifecycleOptions) {}

  prepareRun(runId: string, credential: string): WorkerSessionTurnClaim {
    const current = this.options.placementStore.get(this.options.sessionId);
    const placement = current?.state === "active" ? current : this.activatePlacement();
    const activeClaim = projectWorkerSessionTurnClaim(placement);
    if (activeClaim) {
      if (activeClaim.runId !== runId) {
        throw new Error(`fault placement is already claimed by ${activeClaim.runId}`);
      }
      this.bindCredentialToClaim(credential, activeClaim);
      return activeClaim;
    }
    const claim = this.options.placementStore.claimTurn({
      sessionId: this.options.sessionId,
      agentId: this.options.agentId,
      sessionKey: this.options.sessionKey,
      claimId: `claim:${runId}:${++this.claimSequence}`,
      runId,
      owner: {
        kind: "worker",
        environmentId: this.options.environmentId,
        ownerEpoch: this.options.getOwnerEpoch(),
      },
    });
    this.bindCredentialToClaim(credential, claim);
    return claim;
  }

  settleRun(runId: string): void {
    const placement = this.options.placementStore.get(this.options.sessionId);
    const claim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
    if (!claim || claim.runId !== runId) {
      throw new Error(`fault run ${runId} does not own the active placement`);
    }
    const pending = this.options.placementStore
      .listPendingWorkspaceResults()
      .some(
        (result) =>
          result.sessionId === claim.sessionId &&
          result.claimId === claim.claimId &&
          result.runId === claim.runId,
      );
    if (pending) {
      this.options.placementStore.acceptWorkspaceResult(claim);
      this.options.placementStore.completeWorkspaceResultAndReleaseTurn(claim);
      return;
    }
    this.options.placementStore.releaseTurn(claim);
  }

  reclaimPlacement(
    placement: Extract<WorkerSessionPlacementRecord, { state: "active" }>,
    ownerEpoch: number,
  ): void {
    const draining = this.options.placementStore.startDrain({
      sessionId: placement.sessionId,
      environmentId: this.options.environmentId,
      ownerEpoch,
      expectedGeneration: placement.generation,
    });
    if (draining.state !== "draining") {
      throw new Error("fault placement did not enter draining");
    }
    const reconciling = this.options.placementStore.startReconcile({
      sessionId: placement.sessionId,
      environmentId: this.options.environmentId,
      ownerEpoch,
      expectedGeneration: draining.generation,
    });
    if (reconciling.state !== "reconciling") {
      throw new Error("fault placement did not enter reconciliation");
    }
    const reclaimed = this.options.placementStore.transition({
      sessionId: placement.sessionId,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    if (reclaimed.state !== "reclaimed") {
      throw new Error("fault placement did not finish reclaimed");
    }
  }

  private activatePlacement(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
    let placement = this.options.placementStore.startDispatch({
      sessionId: this.options.sessionId,
      agentId: this.options.agentId,
      sessionKey: this.options.sessionKey,
    });
    const transitions = [
      { to: "provisioning", patch: { environmentId: this.options.environmentId } },
      { to: "syncing", patch: { workerBundleHash: this.options.bundleHash } },
      {
        to: "starting",
        patch: {
          workspaceBaseManifestRef: `sha256:${"c".repeat(64)}`,
          remoteWorkspaceDir: `/workspace/${this.options.sessionId}`,
        },
      },
      { to: "active", patch: { activeOwnerEpoch: this.options.getOwnerEpoch() } },
    ] as const;
    for (const transition of transitions) {
      placement = this.options.placementStore.transition({
        sessionId: this.options.sessionId,
        from: placement.state,
        expectedGeneration: placement.generation,
        ...transition,
      });
    }
    if (placement.state !== "active") {
      throw new Error("fault placement activation failed");
    }
    return placement;
  }

  private bindCredentialToClaim(credential: string, claim: WorkerSessionTurnClaim): void {
    if (claim.owner.kind !== "worker") {
      throw new Error("fault worker credential requires a worker-owned claim");
    }
    const previous = this.options.environmentStore.getCredential(this.options.environmentId);
    const credentialHash = hashWorkerCredential(credential, claim);
    this.options.environmentStore.renewCredential({
      environmentId: this.options.environmentId,
      expectedOwnerEpoch: claim.owner.ownerEpoch,
      credentialHash,
      sessionId: this.options.sessionId,
      rpcSetVersion: this.options.rpcSetVersion,
      expiresAtMs: Date.now() + 60_000,
    });
    if (previous && previous.credentialHash !== credentialHash) {
      this.options.getLiveEvents().rotateCredential({
        credentialHash,
        environmentId: this.options.environmentId,
        newProcessTurn: true,
        previousCredentialHash: previous.credentialHash,
        runEpoch: claim.owner.ownerEpoch,
        sessionId: this.options.sessionId,
      });
    }
  }
}
