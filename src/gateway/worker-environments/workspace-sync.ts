import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import {
  type PreparedWorkerSsh,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "./ssh.js";
import type {
  WorkerTunnelHandle,
  WorkerWorkspaceCommand,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceReconcileResult,
  WorkerWorkspaceSyncRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import { DERIVED_WORKSPACE_RSYNC_EXCLUDES } from "./workspace-path-exclusions.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceMatchesManifest,
  assertWorkspaceResultStable,
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  recoverWorkerWorkspaceReconciliation,
} from "./workspace-reconcile.js";
import {
  workerWorkspaceResultStaging,
  workerWorkspaceTransferPaths,
} from "./workspace-result-staging.js";
import {
  MANIFEST_REF_PATTERN,
  parseManifestRef,
  parseRemoteWorkspaceDirectory,
  probeWorkspaceGitMode,
  readTransferredManifest,
  runBoundedInboundRsync as runBoundedInboundRsyncTransfer,
  stableWorkerPathComponent,
  validateWorkspaceSyncRequest,
  waitForQuiescenceRenewal,
  workerWorkspaceCommandSucceeded as success,
  workspaceSyncError,
  type WorkerWorkspaceActionsOptions,
} from "./workspace-sync-helpers.js";
import { runLocalCommandToFile, writeEligibleGitFiles } from "./workspace-sync-local.js";
export { stableWorkerPathComponent } from "./workspace-sync-helpers.js";
import {
  REMOTE_GIT_WORKSPACE_SETUP_SCRIPT,
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
  REMOTE_WORKSPACE_MANIFEST_JS,
  REMOTE_WORKSPACE_SETUP_SCRIPT,
} from "./workspace-sync-scripts.js";

const REMOTE_SETUP_TIMEOUT_MS = 20_000;
const WORKSPACE_TIMEOUT_MS = 10 * 60_000;
const WORKSPACE_QUIESCENCE_TIMEOUT_MS = 12 * 60_000;
const WORKSPACE_QUIESCENCE_RENEW_INTERVAL_MS = 4 * 60_000;
// Relative to the $HOME/.openclaw-worker root owned by REMOTE_WORKSPACE_SETUP_SCRIPT;
// rsync targets must use the returned absolute directory, never this relative path.
const REMOTE_WORKSPACE_ROOT = "workspaces";
const REMOTE_GIT_PACK_NAME = ".openclaw-base.pack";
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const INBOUND_RSYNC_BW_LIMIT_KIB = 65_536;

/** Binds workspace commands and synchronization to one connected tunnel owner. */
export function createWorkerWorkspaceActions(
  options: WorkerWorkspaceActionsOptions,
): Pick<
  WorkerTunnelHandle,
  "quiesceWorkspace" | "reconcileWorkspace" | "runWorkspaceCommand" | "syncWorkspace"
> {
  const track = <T>(task: Promise<T>): Promise<T> => {
    options.tasks.add(task);
    void task.then(
      () => options.tasks.delete(task),
      () => options.tasks.delete(task),
    );
    return task;
  };

  const requirePrepared = (): PreparedWorkerSsh => {
    const prepared = options.getPrepared();
    if (!options.isConnected() || !prepared) {
      throw new Error("Worker tunnel owner is no longer connected");
    }
    return prepared;
  };

  const runTask = (argv: string[], commandOptions: CommandOptions): Promise<SpawnResult> =>
    track(options.runner.run(argv, commandOptions));

  const runBoundedInboundRsync = async (params: {
    argv: string[];
    destinationRoot: string;
    entryLimit: number;
    totalByteLimit: number;
  }): Promise<SpawnResult> => {
    return await runBoundedInboundRsyncTransfer({
      ...params,
      ownerSignal: options.ownerSignal,
      runTask,
      timeoutMs: WORKSPACE_TIMEOUT_MS,
    });
  };

  const runWorkspaceCommand = async (command: WorkerWorkspaceCommand): Promise<SpawnResult> => {
    const prepared = requirePrepared();
    return await runTask(
      [
        "ssh",
        ...workerSshOptions(prepared, { forwarding: "disabled" }),
        "-a",
        "-x",
        "-T",
        "-p",
        String(prepared.port),
        "--",
        prepared.sshTarget,
        workerSshRemoteCommand(command.argv),
      ],
      workerSshCommandOptions({
        input: command.input,
        timeoutMs: command.timeoutMs ?? WORKSPACE_TIMEOUT_MS,
        signal: command.signal
          ? AbortSignal.any([options.ownerSignal, command.signal])
          : options.ownerSignal,
      }),
    );
  };

  const quiesceWorkspace = async (remoteWorkspaceDir: string) => {
    if (!path.posix.isAbsolute(remoteWorkspaceDir)) {
      throw new Error("Worker workspace quiescence path must be absolute");
    }
    const result = await runWorkspaceCommand({
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_QUIESCE_JS,
        remoteWorkspaceDir,
        String(WORKSPACE_QUIESCENCE_TIMEOUT_MS),
      ],
    });
    if (!success(result)) {
      throw workspaceSyncError(result);
    }
    const acknowledgement = /^quiesced ([a-f0-9]{32})$/u.exec(result.stdout.trim());
    if (!acknowledgement) {
      throw new Error("Worker workspace quiescence returned an invalid acknowledgement");
    }
    const nonce = acknowledgement[1]!;
    let resumed = false;
    let renewalFailure: unknown;
    const renewalAbort = new AbortController();
    const abortRenewal = () => renewalAbort.abort(options.ownerSignal.reason);
    options.ownerSignal.addEventListener("abort", abortRenewal, { once: true });
    let renewalQueue = Promise.resolve();
    const renew = (validationMode: "heartbeat" | "final") => {
      const operation = renewalQueue.then(async () => {
        const renewedResult = await runWorkspaceCommand({
          argv: [
            "node",
            "-e",
            REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
            remoteWorkspaceDir,
            nonce,
            String(WORKSPACE_QUIESCENCE_TIMEOUT_MS),
            validationMode,
          ],
        });
        if (!success(renewedResult)) {
          throw workspaceSyncError(renewedResult);
        }
        if (renewedResult.stdout.trim() !== `renewed ${nonce}`) {
          throw new Error(
            "Worker workspace quiescence renewal returned an invalid acknowledgement",
          );
        }
      });
      renewalQueue = operation.catch(() => undefined);
      return operation;
    };
    const renewalLoop = (async () => {
      while (!renewalAbort.signal.aborted) {
        if (
          !(await waitForQuiescenceRenewal(
            renewalAbort.signal,
            WORKSPACE_QUIESCENCE_RENEW_INTERVAL_MS,
          ))
        ) {
          return;
        }
        try {
          await renew("heartbeat");
        } catch (error) {
          renewalFailure = error;
          return;
        }
      }
    })();
    return {
      assertActive: async () => {
        if (resumed) {
          throw new Error("Worker workspace quiescence was already released");
        }
        if (renewalFailure) {
          throw new Error("Worker workspace quiescence renewal failed", {
            cause: renewalFailure,
          });
        }
        await renew("final");
      },
      resume: async () => {
        if (resumed) {
          return;
        }
        options.ownerSignal.removeEventListener("abort", abortRenewal);
        renewalAbort.abort();
        await renewalLoop;
        const resumedResult = await runWorkspaceCommand({
          argv: ["node", "-e", REMOTE_WORKSPACE_RESUME_JS, remoteWorkspaceDir, nonce],
        });
        if (!success(resumedResult)) {
          throw workspaceSyncError(resumedResult);
        }
        resumed = true;
      },
    };
  };

  const syncWorkspaceImpl = async (
    request: WorkerWorkspaceSyncRequest,
  ): Promise<WorkerWorkspaceSyncResult> => {
    validateWorkspaceSyncRequest(request);
    const prepared = requirePrepared();
    const environmentKey = stableWorkerPathComponent(options.environmentId, 16);
    const sessionKey = stableWorkerPathComponent(request.sessionId, 32);
    const remoteRelative = [
      REMOTE_WORKSPACE_ROOT,
      environmentKey,
      sessionKey,
      String(request.generation),
    ].join("/");
    const setup = await runWorkspaceCommand({
      argv: ["sh", "-s", "--", remoteRelative],
      input: REMOTE_WORKSPACE_SETUP_SCRIPT,
    });
    if (!success(setup)) {
      throw workspaceSyncError(setup);
    }
    const remoteWorkspaceDir = parseRemoteWorkspaceDirectory(setup.stdout.trim());
    // Result refs can make plain workspaces unborn repos; only committed repos use Git sync.
    const { mode, gitRoot, baseCommit } = await probeWorkspaceGitMode({
      localPath: request.localPath,
      commandOptions: workerSshCommandOptions({
        timeoutMs: REMOTE_SETUP_TIMEOUT_MS,
        signal: options.ownerSignal,
      }),
      runTask,
    });
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-worker-workspace-sync-"),
    );
    const rsyncSsh = workerSshRemoteCommand([
      "ssh",
      ...workerSshOptions(prepared, { forwarding: "disabled" }),
      "-a",
      "-x",
      "-T",
      "-p",
      String(prepared.port),
    ]);
    try {
      let fileListPath: string | undefined;
      if (mode === "git") {
        const [canonicalRequestPath, canonicalGitRoot] = await Promise.all([
          fs.realpath(request.localPath),
          fs.realpath(gitRoot),
        ]);
        if (canonicalRequestPath !== canonicalGitRoot) {
          throw new Error("Worker git workspace sync requires the managed worktree root");
        }
        if (!GIT_COMMIT_PATTERN.test(baseCommit)) {
          throw new Error("Worker workspace git base is not a commit id");
        }

        const eligiblePath = path.join(temporaryDirectory, "eligible");
        const ignoredPath = path.join(temporaryDirectory, "ignored");
        const selectedPath = path.join(temporaryDirectory, "selected");
        fileListPath = path.join(temporaryDirectory, "transfer-list");
        await runLocalCommandToFile({
          argv: [
            "git",
            "-C",
            gitRoot,
            "ls-files",
            "--full-name",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ],
          outputPath: eligiblePath,
          signal: options.ownerSignal,
          timeoutMs: WORKSPACE_TIMEOUT_MS,
        });
        const worktreeIncludePath = path.join(gitRoot, ".worktreeinclude");
        const worktreeInclude = await fs.lstat(worktreeIncludePath).catch(() => undefined);
        if (worktreeInclude?.isFile()) {
          await runLocalCommandToFile({
            argv: [
              "git",
              "-C",
              gitRoot,
              "ls-files",
              "--full-name",
              "--others",
              "--ignored",
              "--exclude-standard",
              "-z",
            ],
            outputPath: ignoredPath,
            signal: options.ownerSignal,
            timeoutMs: WORKSPACE_TIMEOUT_MS,
          });
          await runLocalCommandToFile({
            argv: [
              "git",
              "-C",
              gitRoot,
              "ls-files",
              "--full-name",
              "--others",
              "--ignored",
              `--exclude-from=${worktreeIncludePath}`,
              "-z",
            ],
            outputPath: selectedPath,
            signal: options.ownerSignal,
            timeoutMs: WORKSPACE_TIMEOUT_MS,
          });
        } else {
          await Promise.all([
            fs.writeFile(ignoredPath, "", { mode: 0o600 }),
            fs.writeFile(selectedPath, "", { mode: 0o600 }),
          ]);
        }
        await writeEligibleGitFiles({
          gitRoot,
          eligiblePath,
          ignoredPath,
          selectedPath,
          outputPath: fileListPath,
        });

        const objectListPath = path.join(temporaryDirectory, "base-objects");
        const packPath = path.join(temporaryDirectory, "base.pack");
        await runLocalCommandToFile({
          argv: [
            "git",
            "-C",
            gitRoot,
            "rev-list",
            "--objects",
            "--no-object-names",
            `${baseCommit}^{tree}`,
          ],
          outputPath: objectListPath,
          signal: options.ownerSignal,
          timeoutMs: WORKSPACE_TIMEOUT_MS,
        });
        await fs.appendFile(objectListPath, `${baseCommit}\n`);
        await runLocalCommandToFile({
          argv: ["git", "-C", gitRoot, "pack-objects", "--stdout"],
          inputPath: objectListPath,
          outputPath: packPath,
          signal: options.ownerSignal,
          timeoutMs: WORKSPACE_TIMEOUT_MS,
        });
        const packTransfer = await runTask(
          [
            "rsync",
            "--archive",
            "--checksum",
            "-e",
            rsyncSsh,
            "--",
            packPath,
            `${prepared.scpTarget}:${remoteWorkspaceDir}/${REMOTE_GIT_PACK_NAME}`,
          ],
          workerSshCommandOptions({
            timeoutMs: WORKSPACE_TIMEOUT_MS,
            signal: options.ownerSignal,
          }),
        );
        if (!success(packTransfer)) {
          throw workspaceSyncError(packTransfer);
        }
        const [authorName, authorEmail] = await Promise.all(
          ["user.name", "user.email"].map(async (key) => {
            const result = await runTask(
              ["git", "-C", gitRoot, "config", "--get", key],
              workerSshCommandOptions({
                timeoutMs: REMOTE_SETUP_TIMEOUT_MS,
                signal: options.ownerSignal,
              }),
            );
            return success(result) ? result.stdout.trim() : "";
          }),
        );
        const seeded = await runWorkspaceCommand({
          argv: [
            "sh",
            "-s",
            "--",
            remoteWorkspaceDir,
            path.posix.join(remoteWorkspaceDir, REMOTE_GIT_PACK_NAME),
            baseCommit,
            authorName ?? "",
            authorEmail ?? "",
          ],
          input: REMOTE_GIT_WORKSPACE_SETUP_SCRIPT,
        });
        if (!success(seeded)) {
          throw workspaceSyncError(seeded);
        }
      }

      const localSource = gitRoot.endsWith(path.sep) ? gitRoot : `${gitRoot}${path.sep}`;
      const transfer = await runTask(
        [
          "rsync",
          "--archive",
          "--checksum",
          "--exclude=.git",
          ...DERIVED_WORKSPACE_RSYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
          ...(fileListPath ? ["--recursive", "--from0", `--files-from=${fileListPath}`] : []),
          "-e",
          rsyncSsh,
          "--",
          localSource,
          `${prepared.scpTarget}:${remoteWorkspaceDir}/`,
        ],
        workerSshCommandOptions({
          timeoutMs: WORKSPACE_TIMEOUT_MS,
          signal: options.ownerSignal,
        }),
      );
      if (!success(transfer)) {
        throw workspaceSyncError(transfer);
      }

      const manifest = await runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_MANIFEST_JS,
          remoteWorkspaceDir,
          baseCommit,
          ...(mode === "git" ? ["eligible"] : []),
        ],
      });
      if (!success(manifest)) {
        throw workspaceSyncError(manifest);
      }
      return {
        mode,
        remoteWorkspaceDir,
        manifestRef: parseManifestRef(manifest.stdout.trim()),
      };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  };

  const reconcileWorkspaceImpl = async (
    request: WorkerWorkspaceReconcileRequest,
  ): Promise<WorkerWorkspaceReconcileResult> => {
    if (!path.isAbsolute(request.localPath) || !path.posix.isAbsolute(request.remoteWorkspaceDir)) {
      throw new Error("Worker workspace reconcile paths must be absolute");
    }
    const pending = request.journal.load();
    if (pending) {
      await recoverWorkerWorkspaceReconciliation({ root: request.localPath, journal: pending });
      request.journal.abort();
    }
    const baseDigest = MANIFEST_REF_PATTERN.exec(request.baseManifestRef)?.[0]?.slice(7);
    if (!baseDigest) {
      throw new Error("Worker workspace base manifest reference is invalid");
    }
    const prepared = requirePrepared();
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-worker-workspace-reconcile-"),
    );
    const stagingRoot = path.join(temporaryDirectory, "staging");
    const manifestRoot = path.join(temporaryDirectory, "manifests");
    const baseManifestPath = path.join(manifestRoot, `${baseDigest}.json`);
    const transferListPath = path.join(temporaryDirectory, "transfer-list");
    const rsyncSsh = workerSshRemoteCommand([
      "ssh",
      ...workerSshOptions(prepared, { forwarding: "disabled" }),
      "-a",
      "-x",
      "-T",
      "-p",
      String(prepared.port),
    ]);
    try {
      await fs.mkdir(stagingRoot, { mode: 0o700 });
      await fs.mkdir(manifestRoot, { mode: 0o700 });
      const baseManifestTransfer = await runBoundedInboundRsync({
        argv: [
          "rsync",
          "--archive",
          "--no-recursive",
          "--checksum",
          `--max-size=${MAX_RECONCILIATION_FILE_BYTES}`,
          `--bwlimit=${INBOUND_RSYNC_BW_LIMIT_KIB}`,
          "-e",
          rsyncSsh,
          "--",
          `${prepared.scpTarget}:.openclaw-worker/manifests/${baseDigest}.json`,
          baseManifestPath,
        ],
        destinationRoot: manifestRoot,
        entryLimit: 1,
        totalByteLimit: MAX_RECONCILIATION_FILE_BYTES,
      });
      if (!success(baseManifestTransfer)) {
        throw workspaceSyncError(baseManifestTransfer);
      }
      const baseRaw = await readTransferredManifest(baseManifestPath);
      const base = parseWorkerWorkspaceManifest(baseRaw, request.baseManifestRef);
      await fs.rm(baseManifestPath);
      await assertWorkspaceMatchesManifest({ root: request.localPath, manifest: base });
      const verifyStable = async (expectedRef: string): Promise<void> => {
        const expectedDigest = expectedRef.slice("sha256:".length);
        const verified = await runWorkspaceCommand({
          argv: [
            "node",
            "-e",
            REMOTE_WORKSPACE_MANIFEST_JS,
            request.remoteWorkspaceDir,
            base.baseCommit ?? "",
            // The accepted result omits deleted paths. Seed both manifests so a
            // deleted path recreated under a new ignore rule still invalidates the fence.
            ...(base.baseCommit ? ["eligible", expectedDigest, baseDigest] : []),
          ],
        });
        if (!success(verified)) {
          throw workspaceSyncError(verified);
        }
        if (parseManifestRef(verified.stdout.trim()) !== expectedRef) {
          throw new Error("Cloud workspace changed during final reconciliation");
        }
      };
      const currentResult = await runWorkspaceCommand({
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_MANIFEST_JS,
          request.remoteWorkspaceDir,
          base.baseCommit ?? "",
          ...(base.baseCommit ? ["eligible"] : []),
          ...(base.baseCommit ? [baseDigest] : []),
        ],
      });
      if (!success(currentResult)) {
        throw workspaceSyncError(currentResult);
      }
      const currentRef = parseManifestRef(currentResult.stdout.trim());
      if (currentRef === request.baseManifestRef) {
        await verifyStable(currentRef);
        const stagedResult = request.stagedResult
          ? await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
              request,
              stagingRoot,
              currentManifestRef: currentRef,
              baseManifestRaw: baseRaw,
              currentManifestRaw: baseRaw,
            })
          : undefined;
        if (!stagedResult) {
          request.journal.commit(currentRef);
        }
        return {
          manifestRef: currentRef,
          changed: false,
          verifyStable: async () => await verifyStable(currentRef),
          verifyLocalStable: async () =>
            await assertWorkspaceResultStable({
              root: request.localPath,
              base,
              current: base,
            }),
          ...stagedResult,
        };
      }
      const currentDigest = currentRef.slice("sha256:".length);
      const currentManifestPath = path.join(manifestRoot, `${currentDigest}.json`);
      const currentManifestTransfer = await runBoundedInboundRsync({
        argv: [
          "rsync",
          "--archive",
          "--no-recursive",
          "--checksum",
          `--max-size=${MAX_RECONCILIATION_FILE_BYTES}`,
          `--bwlimit=${INBOUND_RSYNC_BW_LIMIT_KIB}`,
          "-e",
          rsyncSsh,
          "--",
          `${prepared.scpTarget}:.openclaw-worker/manifests/${currentDigest}.json`,
          currentManifestPath,
        ],
        destinationRoot: manifestRoot,
        entryLimit: 1,
        totalByteLimit: MAX_RECONCILIATION_FILE_BYTES,
      });
      if (!success(currentManifestTransfer)) {
        throw workspaceSyncError(currentManifestTransfer);
      }
      const currentRaw = await readTransferredManifest(currentManifestPath);
      const current = parseWorkerWorkspaceManifest(currentRaw, currentRef);
      const transferPaths = workerWorkspaceTransferPaths(current, base);
      const transferPathSet = new Set(transferPaths);
      if (transferPaths.length > 0) {
        await fs.writeFile(transferListPath, Buffer.from(`${transferPaths.join("\0")}\0`), {
          mode: 0o600,
        });
        const resultTransfer = await runBoundedInboundRsync({
          argv: [
            "rsync",
            "--archive",
            "--checksum",
            `--max-size=${MAX_RECONCILIATION_FILE_BYTES}`,
            `--bwlimit=${INBOUND_RSYNC_BW_LIMIT_KIB}`,
            "--from0",
            `--files-from=${transferListPath}`,
            "-e",
            rsyncSsh,
            "--",
            `${prepared.scpTarget}:${request.remoteWorkspaceDir}/`,
            `${stagingRoot}/`,
          ],
          destinationRoot: stagingRoot,
          entryLimit: MAX_RECONCILIATION_ENTRIES * 2,
          totalByteLimit: MAX_RECONCILIATION_TOTAL_BYTES,
        });
        if (!success(resultTransfer)) {
          throw workspaceSyncError(resultTransfer);
        }
      }
      await assertWorkspaceMatchesManifest({
        root: stagingRoot,
        manifest: current,
        entries: current.entries.filter((entry) => transferPathSet.has(entry.path)),
      });
      // Catch additions, deletions, and writes that raced the inbound transfer.
      // Stop performs this check once more after local acceptance, directly
      // before destroying the remote owner.
      await verifyStable(currentRef);
      const stagedResult = request.stagedResult
        ? await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
            request,
            stagingRoot,
            currentManifestRef: currentRef,
            baseManifestRaw: baseRaw,
            currentManifestRaw: currentRaw,
          })
        : undefined;
      if (!stagedResult) {
        await applyStagedWorkerWorkspace({
          root: request.localPath,
          stagingRoot,
          baseManifestRef: request.baseManifestRef,
          currentManifestRef: currentRef,
          base,
          current,
          journal: request.journal,
        });
      }
      return {
        manifestRef: currentRef,
        changed: true,
        verifyStable: async () => await verifyStable(currentRef),
        verifyLocalStable: async () =>
          await assertWorkspaceResultStable({ root: request.localPath, base, current }),
        ...stagedResult,
      };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return {
    quiesceWorkspace,
    reconcileWorkspace(request) {
      return track(reconcileWorkspaceImpl(request));
    },
    runWorkspaceCommand,
    syncWorkspace(request) {
      // Keep the outer task registered across local-file phases so tunnel stop drains all owner work.
      return track(syncWorkspaceImpl(request));
    },
  };
}
