import fsp from "node:fs/promises";
import type { NodeWorkerWorkspaceExecResult } from "../../worker/node-workspace-protocol.js";
import {
  createNodeWorkerWorkspaceFallback,
  recordNodeSyncPath,
} from "./node-worker-workspace-fallback.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import { runInstrumentedWorkspaceReconcile } from "./workspace-finalize.js";
import {
  measureLocalWorkspaceReconciliation,
  pruneWorkspaceHashMemo,
  withWorkspaceHashMemo,
  type WorkspaceHashMemo,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceResultStable,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

export type NodeWorkerWorkspaceBinding = {
  localPath: string;
  manifestRef: string;
  remoteWorkspaceDir: string;
};

type NodeWorkerWorkspaceActions = Pick<
  WorkerWorkspaceTunnelHandle,
  "runWorkspaceCommand" | "syncWorkspace" | "quiesceWorkspace" | "reconcileWorkspace"
> & { validateRestoredWorkspace: () => Promise<void> };

export function createNodeWorkerWorkspaceActions(params: {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  ownerSignal: AbortSignal;
  isOwnerCurrent: () => boolean;
  restoredWorkspace?: NodeWorkerWorkspaceBinding;
  workspaceTransfer: NodeWorkspaceTransferService;
  runWorkspaceCommand: (
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean },
  ) => Promise<NodeWorkerWorkspaceExecResult>;
}): NodeWorkerWorkspaceActions {
  const { restoredWorkspace } = params;
  let workspaceReady = restoredWorkspace !== undefined;
  const exec = async (command: WorkerWorkspaceCommand & { resetWorkspace?: boolean }) => {
    if (!workspaceReady) {
      throw new Error("node worker workspace is unavailable before sync");
    }
    return await params.runWorkspaceCommand(command);
  };
  const workspace = createNodeWorkerWorkspaceFallback(exec);
  const quiesceWorkspace = createWorkerWorkspaceQuiescence({
    ownerSignal: params.ownerSignal,
    sharedHost: true,
    runWorkspaceCommand: exec,
  });
  const validateRestoredWorkspace = async (): Promise<void> => {
    if (!restoredWorkspace) {
      return;
    }
    const prepared = await params.workspaceTransfer.prepareSync({
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      localPath: restoredWorkspace.localPath,
      // The transfer service re-reads the durable environment and credential together.
      // This closure fences the exact in-memory tunnel instance without duplicating that read.
      isAuthorized: params.isOwnerCurrent,
      signal: params.ownerSignal,
    });
    params.workspaceTransfer.revoke(params.environmentId, prepared.token);
    if (prepared.snapshot.manifestRef !== restoredWorkspace.manifestRef) {
      throw new Error("Gateway workspace changed before node tunnel recovery");
    }
    const quiescence = await quiesceWorkspace(restoredWorkspace.remoteWorkspaceDir);
    try {
      const remoteManifestRef = await workspace.captureManifest(
        restoredWorkspace.remoteWorkspaceDir,
        prepared.snapshot.manifest.baseCommit,
        restoredWorkspace.manifestRef,
      );
      if (remoteManifestRef !== restoredWorkspace.manifestRef) {
        throw new Error("Node workspace changed before tunnel recovery");
      }
    } finally {
      await quiescence.resume();
    }
  };
  // Same placement-lifetime memo contract as the SSH tunnel owner: stat-identity
  // keys self-invalidate on change, and without this owner every turn re-hashes
  // the full managed worktree during prepare/apply/verify.
  const placementHashMemo: WorkspaceHashMemo = new Map();
  const reconcileWorkspace = (
    request: Parameters<WorkerWorkspaceTunnelHandle["reconcileWorkspace"]>[0],
  ) => runInstrumentedWorkspaceReconcile((metrics) => reconcileWorkspaceRun(request, metrics));
  const reconcileWorkspaceRun = async (
    request: Parameters<WorkerWorkspaceTunnelHandle["reconcileWorkspace"]>[0],
    metrics: WorkspaceReconcileMetrics,
  ) => {
    pruneWorkspaceHashMemo(placementHashMemo);
    const runLocalReconciliation = <T>(operation: () => Promise<T>): Promise<T> =>
      measureLocalWorkspaceReconciliation(metrics, () =>
        withWorkspaceHashMemo(placementHashMemo, operation, metrics.gateway),
      );
    const pending = request.journal.load();
    if (pending) {
      await recoverWorkerWorkspaceReconciliation({ root: request.localPath, journal: pending });
      request.journal.abort();
    }
    const uploadToken = params.workspaceTransfer.prepareUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    let uploadedResult: Awaited<ReturnType<typeof exec>>;
    try {
      uploadedResult = await exec({
        argv: ["openclaw-internal-workspace-transfer"],
        transfer: {
          direction: "upload",
          token: uploadToken,
          baseManifestRef: request.baseManifestRef,
        },
        timeoutMs: 10 * 60_000,
        transportRetry: "never",
      });
    } finally {
      params.workspaceTransfer.revoke(params.environmentId, uploadToken);
    }
    if (uploadedResult.termination !== "exit" || uploadedResult.code !== 0) {
      throw new Error("Node workspace reconcile upload failed");
    }
    const uploaded = params.workspaceTransfer.takeUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    try {
      const changed = uploaded.currentManifestRef !== request.baseManifestRef;
      let expectedRemoteRef = uploaded.currentManifestRef;
      const verifyStable = async () => {
        const observed = await workspace.captureManifest(
          request.remoteWorkspaceDir,
          uploaded.base.baseCommit,
          expectedRemoteRef,
        );
        if (observed !== expectedRemoteRef) {
          throw new Error("Cloud workspace changed during final reconciliation");
        }
      };
      await verifyStable();
      const publishAcceptedManifest = async (accepted: {
        manifestRef: string;
        manifest: typeof uploaded.current;
        conflictPaths: string[];
      }) => {
        if (accepted.manifestRef === expectedRemoteRef) {
          return;
        }
        const baseSnapshot = params.workspaceTransfer.getSnapshot(
          params.environmentId,
          request.baseManifestRef,
        );
        const token = params.workspaceTransfer.publishSnapshot(params.environmentId, {
          manifest: accepted.manifest,
          manifestRef: accepted.manifestRef,
          rawManifest: serializeWorkerWorkspaceManifest(accepted.manifest),
          root: await fsp.realpath(request.localPath),
          ...(baseSnapshot?.packPath ? { packPath: baseSnapshot.packPath } : {}),
        });
        try {
          const published = await exec({
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: { direction: "download", token, manifestRef: accepted.manifestRef },
            timeoutMs: 10 * 60_000,
            transportRetry: "never",
          });
          if (
            published.termination !== "exit" ||
            published.code !== 0 ||
            published.stdout.trim() !== accepted.manifestRef
          ) {
            throw new Error("Node workspace accepted manifest publication failed");
          }
          expectedRemoteRef = accepted.manifestRef;
        } finally {
          params.workspaceTransfer.revoke(params.environmentId, token);
        }
      };
      const preparedStagedResult = request.stagedResult
        ? await runLocalReconciliation(
            async () =>
              await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
                request,
                stagingRoot: uploaded.stagingRoot,
                currentManifestRef: uploaded.currentManifestRef,
                baseManifestRaw: uploaded.baseRaw,
                currentManifestRaw: uploaded.currentRaw,
                publishAcceptedManifest,
              }),
          )
        : undefined;
      let appliedWorkspaceResult: WorkerWorkspaceApplyResult | undefined;
      if (!preparedStagedResult) {
        appliedWorkspaceResult = await runLocalReconciliation(
          async () =>
            await applyStagedWorkerWorkspace({
              root: request.localPath,
              stagingRoot: uploaded.stagingRoot,
              baseManifestRef: request.baseManifestRef,
              currentManifestRef: uploaded.currentManifestRef,
              base: uploaded.base,
              current: uploaded.current,
              journal: request.journal,
              publishAcceptedManifest,
            }),
        );
      }
      return {
        get manifestRef() {
          return expectedRemoteRef;
        },
        changed,
        verifyStable,
        verifyLocalStable: async () =>
          await runLocalReconciliation(
            async () =>
              await (appliedWorkspaceResult?.verifyLocalStable() ??
                assertWorkspaceResultStable({
                  root: request.localPath,
                  base: uploaded.base,
                  current: uploaded.current,
                })),
          ),
        getAppliedWorkspaceResult: () => appliedWorkspaceResult,
        ...(preparedStagedResult
          ? {
              ...preparedStagedResult,
              applyPreparedStagedResult: async () => {
                await runLocalReconciliation(
                  async () => await preparedStagedResult.applyPreparedStagedResult(),
                );
                appliedWorkspaceResult = preparedStagedResult.getAppliedWorkspaceResult();
              },
            }
          : {}),
      };
    } finally {
      await fsp.rm(uploaded.stagingRoot, { recursive: true, force: true });
    }
  };
  return {
    validateRestoredWorkspace,
    runWorkspaceCommand: exec,
    syncWorkspace: async (request) => {
      workspaceReady = true;
      try {
        const prepared = await params.workspaceTransfer.prepareSync({
          environmentId: params.environmentId,
          ownerEpoch: params.ownerEpoch,
          sessionId: params.sessionId,
          generation: params.ownerEpoch,
          localPath: request.localPath,
          // Durable owner state is revalidated by the transfer service after every awaited I/O.
          isAuthorized: params.isOwnerCurrent,
          signal: params.ownerSignal,
        });
        try {
          const originStartedAt = performance.now();
          const origin = await workspace.trySyncWorkspace(request, prepared.snapshot.manifestRef);
          recordNodeSyncPath(params.environmentId, params.sessionId, origin, originStartedAt);
          if (origin.kind === "synced") {
            return await workspace.finalizeSync(request, origin.result);
          }
          const transferred = await exec({
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: {
              direction: "download",
              token: prepared.token,
              manifestRef: prepared.snapshot.manifestRef,
            },
            timeoutMs: 10 * 60_000,
            transportRetry: "never",
          });
          if (
            transferred.termination !== "exit" ||
            transferred.code !== 0 ||
            transferred.stdout.trim() !== prepared.snapshot.manifestRef
          ) {
            throw new Error("Node workspace transfer failed");
          }
          return await workspace.finalizeSync(request, {
            mode: prepared.snapshot.manifest.baseCommit ? ("git" as const) : ("plain" as const),
            remoteWorkspaceDir: transferred.workspaceDir,
            manifestRef: prepared.snapshot.manifestRef,
          });
        } finally {
          params.workspaceTransfer.revoke(params.environmentId, prepared.token);
        }
      } catch (error) {
        workspaceReady = restoredWorkspace !== undefined;
        throw error;
      }
    },
    quiesceWorkspace,
    reconcileWorkspace,
  };
}
