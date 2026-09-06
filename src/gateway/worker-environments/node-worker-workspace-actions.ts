import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { NodeWorkerWorkspaceExecResult } from "../../worker/node-workspace-protocol.js";
import { NODE_WORKSPACE_EMPTY_MANIFEST_REF } from "../../worker/node-workspace-transfer-protocol.js";
import { prepareRepositoryPublicationRestore } from "../github-repository-publication-restore.js";
import { createNodeWorkerRepositoryPreparation } from "./node-worker-repository-preparation.js";
import {
  createNodeWorkerWorkspaceFallback,
  recordNodeSyncPath,
} from "./node-worker-workspace-fallback.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type {
  WorkerLocalWorkspaceReconcileRequest,
  WorkerLocalWorkspaceSyncRequest,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceCommand,
  WorkerWorkspaceTunnelHandle,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";
import { runInstrumentedWorkspaceReconcile } from "./workspace-finalize.js";
import { workerProjectSeedKey } from "./workspace-git-base.js";
import {
  measureLocalWorkspaceReconciliation,
  pruneWorkspaceHashMemo,
  withWorkspaceHashMemo,
  type WorkspaceHashMemo,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceResultStable,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";
import {
  workerWorkspaceResultStaging,
  workerWorkspaceTransferPaths,
} from "./workspace-result-staging.js";

const workspaceLog = createSubsystemLogger("gateway/worker-workspace");

export type NodeWorkerWorkspaceBinding = {
  source:
    | { kind: "local"; path: string }
    | { kind: "repository"; baseCommit: string; baseManifestRef: string };
  manifestRef: string;
  remoteWorkspaceDir: string;
};

type NodeWorkerWorkspaceActions = Pick<
  WorkerWorkspaceTunnelHandle,
  | "runWorkspaceCommand"
  | "syncWorkspace"
  | "quiesceWorkspace"
  | "reconcileWorkspace"
  | "stageAttachments"
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
    if (restoredWorkspace.source.kind === "repository") {
      await params.workspaceTransfer.prepareRepository({
        environmentId: params.environmentId,
        ownerEpoch: params.ownerEpoch,
        sessionId: params.sessionId,
        generation: params.ownerEpoch,
        baseCommit: restoredWorkspace.source.baseCommit,
        baseManifestRef: restoredWorkspace.source.baseManifestRef,
        isAuthorized: params.isOwnerCurrent,
        signal: params.ownerSignal,
      });
      return;
    }
    // Restore transport custody only. The uploaded base is hash-bound to placement;
    // three-way reconciliation owns legitimate changes on either workspace.
    const prepared = await params.workspaceTransfer.prepareSync({
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      localPath: restoredWorkspace.source.path,
      // The transfer service re-reads the durable environment and credential together.
      // This closure fences the exact in-memory tunnel instance without duplicating that read.
      isAuthorized: params.isOwnerCurrent,
      signal: params.ownerSignal,
    });
    params.workspaceTransfer.revoke(params.environmentId, prepared.token);
  };
  // Same placement-lifetime memo contract as the SSH tunnel owner: stat-identity
  // keys self-invalidate on change, and without this owner every turn re-hashes
  // the full managed worktree during prepare/apply/verify.
  const placementHashMemo: WorkspaceHashMemo = new Map();
  const reconcileWorkspace = (request: WorkerWorkspaceReconcileRequest) =>
    runInstrumentedWorkspaceReconcile((metrics) =>
      request.source.kind === "repository"
        ? reconcileRepository(request)
        : reconcileWorkspaceRun(
            {
              remoteWorkspaceDir: request.remoteWorkspaceDir,
              baseManifestRef: request.baseManifestRef,
              localPath: request.source.path,
              journal: request.source.journal,
              stagedResult: request.source.stagedResult,
            },
            metrics,
          ),
    );
  const reconcileRepository = async (request: WorkerWorkspaceReconcileRequest) => {
    if (request.source.kind !== "repository") {
      throw new Error("Repository checkpoint source is required");
    }
    const token = params.workspaceTransfer.prepareUpload(
      params.environmentId,
      request.baseManifestRef,
    );
    try {
      const result = await exec({
        argv: ["openclaw-internal-workspace-transfer"],
        transfer: {
          direction: "upload",
          token,
          baseManifestRef: request.baseManifestRef,
          referenceManifestRef: request.source.referenceManifestRef,
        },
        timeoutMs: 10 * 60_000,
        transportRetry: "never",
      });
      if (result.code !== 0 || result.termination !== "exit") {
        throw new Error("Node repository checkpoint upload failed");
      }
      const uploaded = params.workspaceTransfer.takeUpload(
        params.environmentId,
        request.baseManifestRef,
      );
      try {
        const verifyStable = async () => {
          const observed = await workspace.captureManifest(
            request.remoteWorkspaceDir,
            uploaded.base.baseCommit,
            uploaded.currentManifestRef,
          );
          if (observed !== uploaded.currentManifestRef) {
            throw new Error("Repository workspace changed during checkpoint capture");
          }
        };
        await verifyStable();
        if (!uploaded.base.baseCommit) {
          throw new Error("Repository checkpoint has no pinned Git base");
        }
        let publicationToken: string | undefined;
        let publication: ReturnType<typeof params.workspaceTransfer.takeUpload> | undefined;
        let publicationDigest: string | undefined;
        try {
          try {
            publicationToken = params.workspaceTransfer.prepareUpload(
              params.environmentId,
              NODE_WORKSPACE_EMPTY_MANIFEST_REF,
            );
            const captured = await exec({
              argv: ["openclaw-internal-workspace-transfer"],
              transfer: {
                direction: "upload",
                token: publicationToken,
                baseManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
                referenceManifestRef: NODE_WORKSPACE_EMPTY_MANIFEST_REF,
                publicationBaseCommit: uploaded.base.baseCommit,
              },
              timeoutMs: 10 * 60_000,
              transportRetry: "never",
            });
            if (captured.code !== 0 || captured.termination !== "exit") {
              throw new Error("Repository publication capture failed");
            }
            publication = params.workspaceTransfer.takeUpload(
              params.environmentId,
              NODE_WORKSPACE_EMPTY_MANIFEST_REF,
            );
            const snapshot = publication.current.entries.find(
              (entry) => entry.path === "snapshot.json",
            );
            if (snapshot?.type !== "file") {
              throw new Error("Repository publication snapshot is missing");
            }
            publicationDigest = `sha256:${snapshot.sha256}`;
          } catch (error) {
            params.ownerSignal.throwIfAborted();
            if (!params.isOwnerCurrent()) {
              throw error;
            }
            workspaceLog.warn(
              `Repository publication capture unavailable: ${boundedWorkerError(error)}`,
            );
          }
          // Publication restrictions never own recovery acceptance. Its remote
          // stability, live owner and final quiescence fences still run below.
          await verifyStable();
          const prepared = await request.source.prepareCheckpoint({
            stagingRoot: uploaded.stagingRoot,
            ...(publication && publicationDigest
              ? { publicationStagingRoot: publication.stagingRoot, publicationDigest }
              : {}),
            baseManifestRaw: uploaded.baseRaw,
            currentManifestRaw: uploaded.currentRaw,
            baseManifestRef: uploaded.baseManifestRef,
            currentManifestRef: uploaded.currentManifestRef,
          });
          return {
            manifestRef: uploaded.currentManifestRef,
            changed: uploaded.currentManifestRef !== uploaded.baseManifestRef,
            verifyStable,
            verifyLocalStable: () => prepared.verify(),
            publishStagedResult: async () => {
              await prepared.publish();
            },
            discardPreparedStagedResult: () => prepared.discard(),
          };
        } finally {
          if (publicationToken) {
            params.workspaceTransfer.revoke(params.environmentId, publicationToken);
          }
          if (publication) {
            await fsp.rm(publication.stagingRoot, { recursive: true, force: true });
          }
        }
      } finally {
        await fsp.rm(uploaded.stagingRoot, { recursive: true, force: true });
      }
    } finally {
      params.workspaceTransfer.revoke(params.environmentId, token);
    }
  };
  const reconcileWorkspaceRun = async (
    request: WorkerLocalWorkspaceReconcileRequest,
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
          referenceManifestRef: request.baseManifestRef,
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
        const token = params.workspaceTransfer.publishSnapshot(params.environmentId, {
          manifest: accepted.manifest,
          manifestRef: accepted.manifestRef,
          rawManifest: serializeWorkerWorkspaceManifest(accepted.manifest),
          root: await fsp.realpath(request.localPath),
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
  const syncRepository = async (
    request: Parameters<WorkerWorkspaceTunnelHandle["syncWorkspace"]>[0],
  ) => {
    if (request.source.kind !== "repository") {
      throw new Error("Repository source is required");
    }
    const source = request.source;
    const repository = createNodeWorkerRepositoryPreparation(exec);
    const prepared = await repository.prepareRepository({
      origin: source.url,
      ref: source.ref,
      commit: source.baseCommit,
      branch: source.branch,
      gitToken: source.gitToken,
    });
    if (prepared.kind === "failed") {
      throw new Error(`Cloud repository preparation failed: ${prepared.reason}`);
    }
    const baseManifestRef = prepared.result.manifestRef;
    const baseCommit = prepared.result.baseCommit;
    const remoteWorkspaceDir = prepared.result.remoteWorkspaceDir;
    if (request.gitAuthor) {
      await repository.configureAuthor(remoteWorkspaceDir, request.gitAuthor);
    }
    await params.workspaceTransfer.prepareRepository({
      environmentId: params.environmentId,
      ownerEpoch: params.ownerEpoch,
      sessionId: params.sessionId,
      generation: params.ownerEpoch,
      baseCommit,
      baseManifestRef,
      isAuthorized: params.isOwnerCurrent,
      signal: params.ownerSignal,
    });
    let manifestRef = baseManifestRef;
    if (source.checkpoint) {
      const checkpoint = source.checkpoint;
      const digest = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      if (digest(checkpoint.baseManifestRaw) !== baseManifestRef) {
        throw new Error("Repository checkpoint baseline differs from its cloned commit");
      }
      manifestRef = digest(checkpoint.currentManifestRaw);
      const manifest = parseWorkerWorkspaceManifest(checkpoint.currentManifestRaw, manifestRef);
      const base = parseWorkerWorkspaceManifest(checkpoint.baseManifestRaw, baseManifestRef);
      const token = params.workspaceTransfer.publishSnapshot(params.environmentId, {
        manifest,
        manifestRef,
        rawManifest: checkpoint.currentManifestRaw,
        root: checkpoint.stagingRoot,
        blobPaths: new Set(workerWorkspaceTransferPaths(manifest, base)),
      });
      try {
        const applied = await exec({
          argv: ["openclaw-internal-workspace-transfer"],
          transfer: {
            direction: "download",
            token,
            manifestRef,
            checkpointBaseManifestRef: baseManifestRef,
          },
          timeoutMs: 10 * 60_000,
          transportRetry: "never",
        });
        if (
          applied.code !== 0 ||
          applied.termination !== "exit" ||
          applied.stdout.trim() !== manifestRef
        ) {
          throw new Error("Repository checkpoint restore failed");
        }
        for (const command of await prepareRepositoryPublicationRestore({
          ...checkpoint,
          current: manifest,
        })) {
          const restored = await exec({ ...command, timeoutMs: 60_000, transportRetry: "never" });
          if (restored.code !== 0 || restored.termination !== "exit") {
            throw new Error(
              "Repository publication paths could not be restored; retry workspace preparation",
            );
          }
        }
      } finally {
        params.workspaceTransfer.revoke(params.environmentId, token);
      }
    } else if (source.runSetupScript) {
      const setup = await exec({
        argv: [
          "node",
          "-e",
          String.raw`const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.cwd();
const script = path.join(root, ".openclaw", "worktree-setup.sh");
const stat = fs.statSync(script, { throwIfNoEntry: false });
if (stat?.isFile() && (stat.mode & 0o111)) {
  const run = spawnSync(script, [], {
    cwd: root,
    env: { ...process.env, OPENCLAW_SOURCE_TREE_PATH: root, OPENCLAW_WORKTREE_PATH: root },
    stdio: "inherit",
  });
  process.exitCode = run.status ?? 1;
}`,
        ],
        timeoutMs: 120_000,
        transportRetry: "never",
      });
      if (setup.code !== 0 || setup.termination !== "exit") {
        throw new Error("Repository setup script failed");
      }
      manifestRef = await repository.captureManifest(
        remoteWorkspaceDir,
        baseCommit,
        baseManifestRef,
      );
    }
    return {
      mode: "repository" as const,
      remoteWorkspaceDir,
      manifestRef,
      baseCommit,
      baseManifestRef,
    };
  };
  return {
    validateRestoredWorkspace,
    runWorkspaceCommand: exec,
    stageAttachments: async (request) => {
      const prepared = await params.workspaceTransfer.prepareAttachments({
        ...request,
        environmentId: params.environmentId,
      });
      try {
        const result = await exec({
          argv: ["openclaw-internal-workspace-transfer"],
          transfer: {
            direction: "download",
            token: prepared.token,
            manifestRef: prepared.snapshot.manifestRef,
            attachments: true,
          },
          transportRetry: "never",
          assertCurrent: () => {
            if (!request.isAuthorized()) {
              throw new Error("Worker attachment transfer authority closed");
            }
          },
          signal: request.signal,
        });
        if (
          result.termination !== "exit" ||
          result.code !== 0 ||
          result.stdout.trim() !== prepared.snapshot.manifestRef
        ) {
          throw new Error("Worker attachment transfer failed");
        }
      } finally {
        params.workspaceTransfer.revoke(params.environmentId, prepared.token);
      }
    },
    syncWorkspace: async (request) => {
      workspaceReady = true;
      try {
        if (request.source.kind === "repository") {
          return await syncRepository(request);
        }
        const localRequest: WorkerLocalWorkspaceSyncRequest = {
          sessionId: request.sessionId,
          generation: request.generation,
          gitAuthor: request.gitAuthor,
          localPath: request.source.path,
          projectKey: request.source.projectKey,
        };
        const prepared = await params.workspaceTransfer.prepareSync({
          environmentId: params.environmentId,
          ownerEpoch: params.ownerEpoch,
          sessionId: params.sessionId,
          generation: params.ownerEpoch,
          localPath: localRequest.localPath,
          // Durable owner state is revalidated by the transfer service after every awaited I/O.
          isAuthorized: params.isOwnerCurrent,
          signal: params.ownerSignal,
        });
        try {
          if (!localRequest.projectKey) {
            const originStartedAt = performance.now();
            const origin = await workspace.trySyncWorkspace(
              localRequest,
              prepared.snapshot.manifestRef,
            );
            recordNodeSyncPath(params.environmentId, params.sessionId, origin, originStartedAt);
            if (origin.kind === "synced") {
              return await workspace.finalizeSync(localRequest, origin.result);
            }
          }
          const transferred = await exec({
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: {
              direction: "download",
              token: prepared.token,
              manifestRef: prepared.snapshot.manifestRef,
              ...(localRequest.projectKey && prepared.snapshot.manifest.baseCommit
                ? {
                    seedKey: workerProjectSeedKey({
                      key: localRequest.projectKey,
                      baseCommit: prepared.snapshot.manifest.baseCommit,
                    }),
                  }
                : {}),
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
          return await workspace.finalizeSync(localRequest, {
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
