import {
  getSessionRepositoryWorkspaceStore,
  type SessionRepositoryWorkspaceRecord,
} from "../../state/session-repository-workspaces.js";
import {
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import type { WorkerTunnelHandle, WorkerWorkspaceSyncRequest } from "./tunnel-contract.js";
import { prepareWorkerGitHubBinding } from "./worker-github-binding.js";

/** Prepare source on the worker and durably accept its initial state before activation. */
export async function syncSessionRepositoryWorkspace(params: {
  repository: SessionRepositoryWorkspaceRecord;
  tunnel: WorkerTunnelHandle;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  generation: number;
  gitAuthor?: { name?: string; email?: string };
  runSetupScript?: boolean;
  recovery?: true;
  assertCurrent: () => void;
}) {
  const store = getSessionRepositoryWorkspaceStore();
  let repository = params.repository;
  if (params.recovery && !repository.checkpointRef && repository.runSetupScript) {
    throw new Error(
      "Repository setup was interrupted before its first checkpoint. Retry dispatch with an administrator to authorize setup again.",
    );
  }
  if (!repository.checkpointRef && repository.runSetupScript && params.runSetupScript !== true) {
    throw new Error(
      "Repository setup requires administrator authorization; retry dispatch as an administrator.",
    );
  }
  params.assertCurrent();
  const github = await prepareWorkerGitHubBinding({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    assertCurrent: () => {
      params.assertCurrent();
      return true;
    },
  });
  params.assertCurrent();
  const source: Extract<WorkerWorkspaceSyncRequest["source"], { kind: "repository" }> = {
    kind: "repository",
    url: repository.url,
    ref: repository.requestedRef ?? undefined,
    branch: repository.branch,
    baseCommit: repository.baseCommit ?? undefined,
    runSetupScript:
      !repository.checkpointRef && repository.runSetupScript && params.runSetupScript === true,
    ...(github ? { gitToken: github.token } : {}),
  };
  const sync = async (checkpoint?: typeof source.checkpoint) => {
    params.assertCurrent();
    return await params.tunnel.syncWorkspace({
      sessionId: params.sessionId,
      generation: params.generation,
      gitAuthor: params.gitAuthor,
      source: { ...source, ...(checkpoint ? { checkpoint } : {}) },
    });
  };
  const synced = repository.checkpointRef
    ? await withSessionRepositoryCheckpoint(
        { workspaceId: repository.workspaceId, includePublication: true },
        sync,
      )
    : await sync();
  params.assertCurrent();
  if (synced.mode !== "repository") {
    throw new Error("Repository preparation did not return a repository workspace");
  }
  if (!repository.baseCommit || !repository.baseManifestHash) {
    repository = store.bindBase({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      baseCommit: synced.baseCommit,
      baseManifestHash: synced.baseManifestRef,
      assertCurrent: params.assertCurrent,
    });
  } else if (
    repository.baseCommit !== synced.baseCommit ||
    repository.baseManifestHash !== synced.baseManifestRef
  ) {
    throw new Error("Repository preparation changed the pinned source baseline");
  }
  if (repository.checkpointRef) {
    if (synced.manifestRef !== repository.manifestHash) {
      throw new Error("Repository preparation did not restore the accepted checkpoint");
    }
    return synced;
  }
  const quiescence = await params.tunnel.quiesceWorkspace(synced.remoteWorkspaceDir);
  let reconciliation: Awaited<ReturnType<WorkerTunnelHandle["reconcileWorkspace"]>> | undefined;
  try {
    params.assertCurrent();
    reconciliation = await params.tunnel.reconcileWorkspace({
      remoteWorkspaceDir: synced.remoteWorkspaceDir,
      baseManifestRef: synced.baseManifestRef,
      source: {
        kind: "repository",
        referenceManifestRef: synced.manifestRef,
        prepareCheckpoint: (payload) =>
          stageSessionRepositoryCheckpoint({
            ...payload,
            workspaceId: repository.workspaceId,
            expectedRevision: repository.revision,
            assertCurrent: params.assertCurrent,
          }),
      },
    });
    await quiescence.assertActive();
    await reconciliation.verifyStable();
    await reconciliation.verifyLocalStable();
    params.assertCurrent();
    if (!reconciliation.publishStagedResult) {
      throw new Error("Repository preparation did not stage a durable checkpoint");
    }
    await reconciliation.publishStagedResult();
    params.assertCurrent();
    return { ...synced, manifestRef: reconciliation.manifestRef };
  } finally {
    try {
      await reconciliation?.discardPreparedStagedResult?.();
    } finally {
      await quiescence.resume();
    }
  }
}
