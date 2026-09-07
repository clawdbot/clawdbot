import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { SpawnResult } from "../../process/exec.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import {
  AcceptedWorkspacePublicationIndeterminateError,
  isAcceptedWorkspacePublicationIndeterminateError,
  parseAcceptedWorkspaceSettlement,
  type AcceptedWorkspaceSettlementOutcome,
} from "./workspace-accepted-publication.js";
import type { WorkspaceHashMemo, WorkspaceReconcileMetrics } from "./workspace-hash-memo.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { changedPaths, manifestNodes } from "./workspace-reconcile.js";
import {
  captureRemoteWorkspaceManifest,
  WORKER_WORKSPACE_RSYNC_DESTINATION,
  workerAcceptedWorkspaceRsyncReceiverPath,
  workerWorkspaceCommandSucceeded,
  workspaceSyncError,
} from "./workspace-sync-helpers.js";
import {
  REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "./workspace-sync-scripts.js";

function isIndeterminateWorkspaceCommandResult(result: SpawnResult): boolean {
  return result.termination !== "exit" || result.code === 255;
}

function acceptedWorkspaceRollbackError(error: unknown, rollbackFailure: unknown): Error {
  const rollbackError = new Error("Accepted workspace publication rollback failed", {
    cause: error,
  });
  Object.defineProperty(rollbackError, "rollbackFailure", { value: rollbackFailure });
  return rollbackError;
}

export async function recoverAcceptedWorkspacePublication(params: {
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
  remoteWorkspaceDir: string;
}) {
  const recovered = await params.runWorkspaceCommand({
    transportRetry: "never",
    argv: [
      "node",
      "-e",
      REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
      "recover",
      params.remoteWorkspaceDir,
      randomBytes(16).toString("hex"),
    ],
  });
  if (!workerWorkspaceCommandSucceeded(recovered)) {
    throw workspaceSyncError(recovered);
  }
}

function createAcceptedWorkspacePublisher(params: {
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
  runRsync: (argv: (rsyncSsh: string) => string[]) => Promise<SpawnResult>;
  scpTarget: string;
  receiverEntryPath: string;
  localPath: string;
  remoteWorkspaceDir: string;
  remoteManifest: WorkerWorkspaceManifest;
  hashMemo: WorkspaceHashMemo;
  metrics: WorkspaceReconcileMetrics;
}) {
  return async (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => {
    const acceptedRaw = serializeWorkerWorkspaceManifest(accepted.manifest);
    const acceptedDigest = createHash("sha256").update(acceptedRaw).digest("hex");
    if (`sha256:${acceptedDigest}` !== accepted.manifestRef) {
      throw new Error("Accepted workspace manifest does not match its reference");
    }
    const published = await params.runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        params.remoteWorkspaceDir,
        "",
        "publish",
        acceptedDigest,
      ],
      input: acceptedRaw,
    });
    if (!workerWorkspaceCommandSucceeded(published)) {
      throw workspaceSyncError(published);
    }

    const verifyAcceptedWorkspace = async () => {
      const verifiedRef = await captureRemoteWorkspaceManifest({
        runWorkspaceCommand: params.runWorkspaceCommand,
        remoteWorkspaceDir: params.remoteWorkspaceDir,
        baseCommit: accepted.manifest.baseCommit,
        priorManifestDigests: accepted.manifest.baseCommit ? [acceptedDigest] : [],
        hashMemo: params.hashMemo,
        metrics: params.metrics,
      });
      if (verifiedRef !== accepted.manifestRef) {
        throw new Error(
          `Worker workspace does not match its accepted manifest: expected ${accepted.manifestRef}, got ${verifiedRef}`,
        );
      }
    };

    // Git-ignored and derived worker scratch paths are intentionally outside the
    // accepted manifest (for example dependency caches) and remain worker-local.
    // Only accepted manifest members may be mirrored from the gateway.
    const changed = changedPaths(params.remoteManifest, accepted.manifest);
    if (changed.size === 0) {
      await verifyAcceptedWorkspace();
      return;
    }

    const transactionNonce = randomBytes(16).toString("hex");
    const transactionCommand = async (action: "apply" | "rollback" | "commit" | "settle") =>
      await params.runWorkspaceCommand({
        transportRetry: "never",
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
          action,
          params.remoteWorkspaceDir,
          transactionNonce,
        ],
      });
    const settleIndeterminatePublication = async (
      operation: "apply" | "commit",
      publicationFailure: unknown,
    ): Promise<AcceptedWorkspaceSettlementOutcome> => {
      let settled: SpawnResult;
      try {
        settled = await transactionCommand("settle");
      } catch (observationFailure) {
        throw new AcceptedWorkspacePublicationIndeterminateError(
          operation,
          publicationFailure,
          observationFailure,
        );
      }
      if (!workerWorkspaceCommandSucceeded(settled)) {
        throw new AcceptedWorkspacePublicationIndeterminateError(
          operation,
          publicationFailure,
          workspaceSyncError(settled),
        );
      }
      try {
        return parseAcceptedWorkspaceSettlement(settled.stdout);
      } catch (observationFailure) {
        throw new AcceptedWorkspacePublicationIndeterminateError(
          operation,
          publicationFailure,
          observationFailure,
        );
      }
    };
    const finishIndeterminateCommit = async (commitFailure: unknown): Promise<void> => {
      const outcome = await settleIndeterminatePublication("commit", commitFailure);
      if (outcome === "committed") {
        return;
      }
      if (outcome !== "applied") {
        throw commitFailure;
      }
      let retried: SpawnResult;
      try {
        retried = await transactionCommand("commit");
      } catch (observationFailure) {
        throw new AcceptedWorkspacePublicationIndeterminateError(
          "commit",
          commitFailure,
          observationFailure,
        );
      }
      if (!workerWorkspaceCommandSucceeded(retried)) {
        const retryFailure = workspaceSyncError(retried);
        if (!isIndeterminateWorkspaceCommandResult(retried)) {
          throw retryFailure;
        }
        throw new AcceptedWorkspacePublicationIndeterminateError(
          "commit",
          commitFailure,
          retryFailure,
        );
      }
    };
    let transactionBegun = false;
    try {
      const begun = await params.runWorkspaceCommand({
        transportRetry: "never",
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
          "begin",
          params.remoteWorkspaceDir,
          transactionNonce,
        ],
        input: JSON.stringify([...changed]),
      });
      if (!workerWorkspaceCommandSucceeded(begun)) {
        throw workspaceSyncError(begun);
      }
      transactionBegun = true;
      const remoteStagingRoot = begun.stdout.trim();
      if (!path.posix.isAbsolute(remoteStagingRoot) || remoteStagingRoot.includes("\n")) {
        throw new Error("Worker returned an invalid accepted workspace staging path");
      }

      const acceptedNodes = manifestNodes(accepted.manifest);
      const transferPaths = [...changed].filter((entryPath) => acceptedNodes.has(entryPath));
      if (transferPaths.length > 0) {
        const temporaryDirectory = await fs.mkdtemp(
          path.join(resolvePreferredOpenClawTmpDir(), "openclaw-worker-workspace-accepted-"),
        );
        const transferListPath = path.join(temporaryDirectory, "transfer-list");
        try {
          await fs.writeFile(
            transferListPath,
            Buffer.from(`${transferPaths.toSorted().join("\0")}\0`),
            { mode: 0o600 },
          );
          const localSource = params.localPath.endsWith(path.sep)
            ? params.localPath
            : `${params.localPath}${path.sep}`;
          const transferred = await params.runRsync((rsyncSsh) => [
            "rsync",
            "--archive",
            "--checksum",
            "--no-recursive",
            "--from0",
            `--files-from=${transferListPath}`,
            `--rsync-path=${workerAcceptedWorkspaceRsyncReceiverPath({
              receiverEntryPath: params.receiverEntryPath,
              remoteWorkspaceDir: params.remoteWorkspaceDir,
              nonce: transactionNonce,
            })}`,
            "-e",
            rsyncSsh,
            "--",
            localSource,
            `${params.scpTarget}:${WORKER_WORKSPACE_RSYNC_DESTINATION}`,
          ]);
          if (!workerWorkspaceCommandSucceeded(transferred)) {
            throw workspaceSyncError(transferred);
          }
        } finally {
          await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
      }

      let applied: SpawnResult | undefined;
      try {
        applied = await transactionCommand("apply");
      } catch (applyFailure) {
        const outcome = await settleIndeterminatePublication("apply", applyFailure);
        if (outcome !== "applied" && outcome !== "committed") {
          throw applyFailure;
        }
      }
      if (applied && !workerWorkspaceCommandSucceeded(applied)) {
        const applyFailure = workspaceSyncError(applied);
        if (!isIndeterminateWorkspaceCommandResult(applied)) {
          throw applyFailure;
        }
        const outcome = await settleIndeterminatePublication("apply", applyFailure);
        if (outcome !== "applied" && outcome !== "committed") {
          throw applyFailure;
        }
      }
      await verifyAcceptedWorkspace();
      let committed: SpawnResult;
      try {
        committed = await transactionCommand("commit");
      } catch (commitFailure) {
        await finishIndeterminateCommit(commitFailure);
        return;
      }
      if (!workerWorkspaceCommandSucceeded(committed)) {
        const commitFailure = workspaceSyncError(committed);
        if (isIndeterminateWorkspaceCommandResult(committed)) {
          await finishIndeterminateCommit(commitFailure);
          return;
        }
        throw commitFailure;
      }
    } catch (error) {
      // Transport or settlement timeouts are observation evidence, never authority
      // for an inverse operation; recovery owns restoring both sides.
      if (isAcceptedWorkspacePublicationIndeterminateError(error)) {
        throw error;
      }
      if (transactionBegun) {
        try {
          const rolledBack = await transactionCommand("rollback");
          if (!workerWorkspaceCommandSucceeded(rolledBack)) {
            throw workspaceSyncError(rolledBack);
          }
        } catch (rollbackFailure) {
          throw acceptedWorkspaceRollbackError(error, rollbackFailure);
        }
      }
      throw error;
    }
  };
}

export function createAcceptedWorkspacePublisherFactory(
  params: Omit<Parameters<typeof createAcceptedWorkspacePublisher>[0], "remoteManifest">,
) {
  return (remoteManifest: WorkerWorkspaceManifest, initialRemoteRef: string) => {
    let expectedRemoteRef = initialRemoteRef;
    const publish = createAcceptedWorkspacePublisher({ ...params, remoteManifest });
    return {
      expectedRemoteRef: () => expectedRemoteRef,
      publishAcceptedManifest: async (accepted: {
        manifestRef: string;
        manifest: WorkerWorkspaceManifest;
        conflictPaths: string[];
      }) => {
        await publish(accepted);
        expectedRemoteRef = accepted.manifestRef;
      },
    };
  };
}
