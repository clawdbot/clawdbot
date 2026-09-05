import {
  getSessionRepositoryWorkspaceStore,
  type SessionRepositoryWorkspaceRecord,
} from "../../state/session-repository-workspaces.js";
import {
  recoverSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type {
  WorkerLocalWorkspaceReconcileRequest,
  WorkerWorkspaceReconcileRequest,
} from "./tunnel-contract.js";

/** Durable session workspace ownership is independent of its current worker placement. */
export type WorkerSessionWorkspace =
  | { kind: "local"; path: string }
  | { kind: "repository"; repository: SessionRepositoryWorkspaceRecord };

/** Repository roots contain result artifacts only; never use them as execution cwd. */
export function sessionWorkspaceRoot(workspace: WorkerSessionWorkspace): string {
  return workspace.kind === "local"
    ? workspace.path
    : getSessionRepositoryWorkspaceStore().artifactPath(workspace.repository.workspaceId);
}

export function createWorkerWorkspaceReconcileRequest(params: {
  workspace: WorkerSessionWorkspace;
  remoteWorkspaceDir: string;
  baseManifestRef: string;
  journal: WorkerLocalWorkspaceReconcileRequest["journal"];
  stagedResult: NonNullable<WorkerLocalWorkspaceReconcileRequest["stagedResult"]>;
  assertCurrent: () => void;
}): WorkerWorkspaceReconcileRequest {
  const { workspace, remoteWorkspaceDir, baseManifestRef, journal, stagedResult } = params;
  if (workspace.kind === "local") {
    return {
      source: { kind: "local", path: workspace.path, journal, stagedResult },
      remoteWorkspaceDir,
      baseManifestRef,
    };
  }
  if (!workspace.repository.baseManifestHash || !workspace.repository.manifestHash) {
    throw new Error("Repository workspace has no accepted source manifest");
  }
  return {
    remoteWorkspaceDir,
    // Repository results are cumulative from the pinned commit. The placement
    // journal advances independently as setup, turns, and editor saves settle.
    baseManifestRef: workspace.repository.baseManifestHash,
    source: {
      kind: "repository",
      referenceManifestRef: workspace.repository.manifestHash,
      prepareCheckpoint: async (payload) => {
        const prepared = await stageSessionRepositoryCheckpoint({
          ...payload,
          workspaceId: workspace.repository.workspaceId,
          expectedRevision: workspace.repository.revision,
          checkpointRef: stagedResult.ref,
          assertCurrent: params.assertCurrent,
        });
        return {
          verify: prepared.verify,
          discard: prepared.discard,
          publish: async () => {
            const accepted = await prepared.publish();
            params.assertCurrent();
            // The immutable ref is discoverable if the process stops between
            // checkpoint acceptance and recording its pending-result pointer.
            stagedResult.record(prepared.checkpointRef);
            journal.commit(payload.currentManifestRef);
            return accepted;
          },
        };
      },
    },
  };
}

export async function recoverSessionWorkspaceCheckpoint(params: {
  workspace: Extract<WorkerSessionWorkspace, { kind: "repository" }>;
  checkpointRef: string;
  assertCurrent: () => void;
  onAccepted: (manifestRef: string) => void;
}): Promise<void> {
  const accepted = await recoverSessionRepositoryCheckpoint({
    workspaceId: params.workspace.repository.workspaceId,
    checkpointRef: params.checkpointRef,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  if (!accepted.manifestHash) {
    throw new Error("Repository checkpoint has no accepted manifest");
  }
  params.onAccepted(accepted.manifestHash);
}
