import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { workerSshCommandOptions } from "./ssh.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { changedPaths, manifestNodes } from "./workspace-reconcile.js";
import {
  parseManifestRef,
  workerWorkspaceCommandSucceeded,
  workspaceSyncError,
} from "./workspace-sync-helpers.js";
import {
  REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "./workspace-sync-scripts.js";

const WORKSPACE_TIMEOUT_MS = 10 * 60_000;

export async function recoverAcceptedWorkspacePublication(params: {
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
  remoteWorkspaceDir: string;
}) {
  const recovered = await params.runWorkspaceCommand({
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
  runTask: (argv: string[], options: CommandOptions) => Promise<SpawnResult>;
  ownerSignal: AbortSignal;
  rsyncSsh: string;
  scpTarget: string;
  localPath: string;
  remoteWorkspaceDir: string;
  remoteManifest: WorkerWorkspaceManifest;
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
      const verified = await params.runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_MANIFEST_JS,
          params.remoteWorkspaceDir,
          accepted.manifest.baseCommit ?? "",
          ...(accepted.manifest.baseCommit ? ["eligible", acceptedDigest] : []),
        ],
      });
      if (!workerWorkspaceCommandSucceeded(verified)) {
        throw workspaceSyncError(verified);
      }
      const verifiedRef = parseManifestRef(verified.stdout.trim());
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
    const transactionCommand = async (action: "apply" | "rollback" | "commit") =>
      await params.runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS,
          action,
          params.remoteWorkspaceDir,
          transactionNonce,
        ],
      });
    let transactionBegun = false;
    try {
      const begun = await params.runWorkspaceCommand({
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
          path.join(os.tmpdir(), "openclaw-worker-workspace-accepted-"),
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
          const transferred = await params.runTask(
            [
              "rsync",
              "--archive",
              "--checksum",
              "--no-recursive",
              "--from0",
              `--files-from=${transferListPath}`,
              "-e",
              params.rsyncSsh,
              "--",
              localSource,
              `${params.scpTarget}:${remoteStagingRoot}/`,
            ],
            workerSshCommandOptions({
              timeoutMs: WORKSPACE_TIMEOUT_MS,
              signal: params.ownerSignal,
            }),
          );
          if (!workerWorkspaceCommandSucceeded(transferred)) {
            throw workspaceSyncError(transferred);
          }
        } finally {
          await fs.rm(temporaryDirectory, { recursive: true, force: true });
        }
      }

      const applied = await transactionCommand("apply");
      if (!workerWorkspaceCommandSucceeded(applied)) {
        throw workspaceSyncError(applied);
      }
      await verifyAcceptedWorkspace();
      const committed = await transactionCommand("commit");
      if (!workerWorkspaceCommandSucceeded(committed)) {
        throw workspaceSyncError(committed);
      }
    } catch (error) {
      if (transactionBegun) {
        const rolledBack = await transactionCommand("rollback");
        if (!workerWorkspaceCommandSucceeded(rolledBack)) {
          const rollbackError = new Error("Accepted workspace publication rollback failed", {
            cause: error,
          });
          Object.defineProperty(rollbackError, "rollbackFailure", {
            value: workspaceSyncError(rolledBack),
          });
          throw rollbackError;
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
