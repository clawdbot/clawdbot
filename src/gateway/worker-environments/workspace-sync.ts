import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withTimeout } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { type PreparedWorkerSsh, runWorkerSshCandidates, workerSshCommandOptions } from "./ssh.js";
import type {
  WorkerTunnelHandle,
  WorkerWorkspaceCommand,
  WorkerWorkspaceReconcileRequest,
  WorkerWorkspaceReconcileResult,
  WorkerWorkspaceSyncRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import {
  createAcceptedWorkspacePublisherFactory,
  recoverAcceptedWorkspacePublication,
} from "./workspace-accepted-sync.js";
import { registerWorkspaceReconcileReporter } from "./workspace-finalize.js";
import {
  createWorkspaceReconcileMetrics,
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  measureLocalWorkspaceReconciliation,
  withWorkspaceHashMemo,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "./workspace-inventory-limits.js";
import { DERIVED_WORKSPACE_RSYNC_EXCLUDES } from "./workspace-path-exclusions.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceMatchesManifest,
  assertWorkspaceResultStable,
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";
import {
  workerWorkspaceResultStaging,
  workerWorkspaceTransferPaths,
} from "./workspace-result-staging.js";
import {
  captureRemoteWorkspaceManifest,
  createWorkerWorkspaceRsyncReceiverPathFactory,
  parseManifestRef,
  parseRemoteWorkspaceSetup,
  probeWorkspaceGitMode,
  readTransferredManifest,
  resolveRemoteWorkspaceManifest,
  stableWorkerPathComponent,
  validateWorkspaceSyncRequest,
  WORKER_WORKSPACE_RSYNC_DESTINATION,
  workerWorkspaceCommandSucceeded as success,
  workerWorkspaceRsyncRemoteCommand,
  workerWorkspaceRsyncReceiverEntryPath,
  workerWorkspaceSshArgv,
  workspaceSyncError,
  type WorkerWorkspaceActionsOptions,
} from "./workspace-sync-helpers.js";
import {
  createGitTransferList,
  filterExistingGitTransferList,
  runLocalCommandToFile,
} from "./workspace-sync-local.js";
import {
  REMOTE_GIT_WORKSPACE_RETRY_RESET_JS,
  REMOTE_GIT_WORKSPACE_SETUP_SCRIPT,
  REMOTE_WORKSPACE_MANIFEST_JS,
  REMOTE_WORKSPACE_SETUP_SCRIPT,
} from "./workspace-sync-scripts.js";
import { createWorkerWorkspaceRsyncTransport } from "./workspace-sync-transport.js";

const REMOTE_SETUP_TIMEOUT_MS = 20_000;
const WORKSPACE_TIMEOUT_MS = 10 * 60_000;
// Relative to the canonical worker $HOME owned by REMOTE_WORKSPACE_SETUP_SCRIPT;
// rsync targets must use the returned absolute directory, never this relative path.
const REMOTE_WORKSPACE_ROOT = ".openclaw-worker/workspaces";
const REMOTE_GIT_PACK_NAME = ".openclaw-base.pack";
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const INBOUND_RSYNC_BW_LIMIT_KIB = 65_536;
const workspaceSyncLog = createSubsystemLogger("gateway/worker-workspace");

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

  const waitForPrepared = async (
    timeoutMs: number,
    message: string,
    signal?: AbortSignal,
  ): Promise<PreparedWorkerSsh> => {
    signal?.throwIfAborted();
    const operation = withTimeout(options.waitForPrepared(), timeoutMs, { message });
    if (!signal) {
      return await operation;
    }
    return await new Promise<PreparedWorkerSsh>((resolve, reject) => {
      const onAbort = () => {
        try {
          signal.throwIfAborted();
        } catch (error) {
          reject(
            error instanceof Error
              ? error
              : new Error("Worker workspace command aborted", { cause: error }),
          );
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
      void operation.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  };

  const runTask = (argv: string[], opts: CommandOptions) => track(options.runner.run(argv, opts));

  const { runBoundedInboundRsync, runRsync } = createWorkerWorkspaceRsyncTransport({
    ownerSignal: options.ownerSignal,
    runTask,
    timeoutMs: WORKSPACE_TIMEOUT_MS,
  });
  const receiverEntryPath = workerWorkspaceRsyncReceiverEntryPath(options.bundleHash);

  const runWorkspaceCommand = async (command: WorkerWorkspaceCommand): Promise<SpawnResult> => {
    const timeoutMs = command.timeoutMs ?? WORKSPACE_TIMEOUT_MS;
    const deadlineMs = Date.now() + timeoutMs;
    const signal = command.signal
      ? AbortSignal.any([options.ownerSignal, command.signal])
      : options.ownerSignal;
    // Waiting before first dispatch is safe for every command. `transportRetry` only controls
    // whether an ambiguous SSH result may be replayed after dispatch.
    const prepared = await waitForPrepared(
      timeoutMs,
      "Worker tunnel did not reconnect within the workspace command timeout",
      command.signal,
    );
    signal.throwIfAborted();
    const remainingCommandTimeoutMs = () => Math.max(0, deadlineMs - Date.now());
    const commandOptions = (remainingTimeoutMs: number): CommandOptions => {
      const base = workerSshCommandOptions({
        input: command.input,
        timeoutMs: remainingTimeoutMs,
        signal,
      });
      return command.argv.at(-1) === "memo-v1"
        ? { ...base, maxOutputBytes: MAX_WORKSPACE_HASH_MEMO_BYTES }
        : base;
    };
    // Exit 255 does not prove whether the remote command was accepted, so stateful
    // commands must stay pinned to one transport attempt.
    if (command.transportRetry === "never") {
      const operation = runTask(
        workerWorkspaceSshArgv(prepared, command.argv),
        commandOptions(remainingCommandTimeoutMs()),
      );
      command.onDispatchReady?.();
      return await operation;
    }
    return await runWorkerSshCandidates(
      prepared,
      remainingCommandTimeoutMs(),
      async (port, remainingTimeoutMs) =>
        await runTask(
          workerWorkspaceSshArgv(prepared, command.argv, port),
          commandOptions(remainingTimeoutMs),
        ),
    );
  };

  const quiesceWorkspace = createWorkerWorkspaceQuiescence({
    ownerSignal: options.ownerSignal,
    sharedHost: options.sharedHost === true,
    runWorkspaceCommand,
  });

  const syncWorkspaceImpl = async (
    request: WorkerWorkspaceSyncRequest,
  ): Promise<WorkerWorkspaceSyncResult> => {
    validateWorkspaceSyncRequest(request);
    const prepared = await waitForPrepared(
      WORKSPACE_TIMEOUT_MS,
      "Worker tunnel did not reconnect within the workspace synchronization timeout",
    );
    const remoteRelative = [
      REMOTE_WORKSPACE_ROOT,
      stableWorkerPathComponent(options.environmentId, 16),
      stableWorkerPathComponent(request.sessionId, 32),
      String(request.generation),
    ].join("/");
    const setup = await runWorkspaceCommand({
      transportRetry: "never",
      argv: ["sh", "-s", "--", remoteRelative],
      input: REMOTE_WORKSPACE_SETUP_SCRIPT,
    });
    if (!success(setup)) {
      throw workspaceSyncError(setup);
    }
    const { canonicalHome, remoteWorkspaceDir } = parseRemoteWorkspaceSetup(
      setup.stdout.trim(),
      remoteRelative,
    );
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
    try {
      const receiverContext = {
        receiverEntryPath,
        remoteWorkspaceDir,
        canonicalHome,
        remoteRelative,
      };
      const mutationReceiverPath = createWorkerWorkspaceRsyncReceiverPathFactory(receiverContext);
      let gitTransferListPath: string | undefined;
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

        gitTransferListPath = await createGitTransferList({
          gitRoot,
          temporaryDirectory: path.join(temporaryDirectory, "transfer"),
          signal: options.ownerSignal,
          timeoutMs: WORKSPACE_TIMEOUT_MS,
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
        const packTransfer = await runRsync(prepared, (rsyncSsh) => [
          "rsync",
          "--archive",
          "--checksum",
          `--rsync-path=${mutationReceiverPath("git-pack")}`,
          "-e",
          rsyncSsh,
          "--",
          packPath,
          `${prepared.scpTarget}:${WORKER_WORKSPACE_RSYNC_DESTINATION}`,
        ]);
        if (!success(packTransfer)) {
          throw workspaceSyncError(packTransfer);
        }
        const [detectedAuthorName, detectedAuthorEmail] = await Promise.all(
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
        const authorName = request.gitAuthor?.name ?? detectedAuthorName;
        const authorEmail = request.gitAuthor?.email ?? detectedAuthorEmail;
        const seeded = await runWorkspaceCommand({
          transportRetry: "never",
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
      const transferArgv = (rsyncSsh: string, fileListPath?: string) => [
        "rsync",
        "--archive",
        "--checksum",
        "--delete-delay",
        "--exclude=.git",
        ...DERIVED_WORKSPACE_RSYNC_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
        ...(fileListPath ? ["--recursive", "--from0", `--files-from=${fileListPath}`] : []),
        `--rsync-path=${mutationReceiverPath("workspace-root")}`,
        "-e",
        rsyncSsh,
        "--",
        localSource,
        `${prepared.scpTarget}:${WORKER_WORKSPACE_RSYNC_DESTINATION}`,
      ];
      let retryingGitTransfer = false;
      let transferAttempt = 0;
      const preparedGitTransferListPath = gitTransferListPath;
      const transfer = preparedGitTransferListPath
        ? await runWorkerSshCandidates(
            prepared,
            WORKSPACE_TIMEOUT_MS,
            async (port, remainingTimeoutMs) => {
              const deadlineMs = Date.now() + remainingTimeoutMs;
              const commandOptions = () =>
                workerSshCommandOptions({
                  timeoutMs: Math.max(0, deadlineMs - Date.now()),
                  signal: options.ownerSignal,
                });
              if (retryingGitTransfer) {
                const resetNonce = randomBytes(16).toString("hex");
                const reset = await runTask(
                  workerWorkspaceSshArgv(
                    prepared,
                    [
                      "node",
                      "-e",
                      REMOTE_GIT_WORKSPACE_RETRY_RESET_JS,
                      remoteWorkspaceDir,
                      canonicalHome,
                      remoteRelative,
                      resetNonce,
                    ],
                    port,
                  ),
                  commandOptions(),
                );
                if (!success(reset)) {
                  // Reset changes remote state, so an ambiguous result must fail closed.
                  throw workspaceSyncError(reset);
                }
                if (reset.stdout !== `reset ${resetNonce}\n`) {
                  throw new Error(
                    "Worker workspace retry reset returned an invalid acknowledgement",
                  );
                }
              }
              const fileListPath = await filterExistingGitTransferList({
                gitRoot,
                preparedListPath: preparedGitTransferListPath,
                outputPath: path.join(
                  path.dirname(preparedGitTransferListPath),
                  `attempt-${transferAttempt++}`,
                ),
              });
              const result = await runTask(
                transferArgv(workerWorkspaceRsyncRemoteCommand(prepared, port), fileListPath),
                commandOptions(),
              );
              retryingGitTransfer = result.termination === "exit" && result.code === 255;
              return result;
            },
          )
        : await runRsync(prepared, (rsyncSsh) => transferArgv(rsyncSsh));
      if (!success(transfer)) {
        throw workspaceSyncError(transfer);
      }

      const manifest = await runWorkspaceCommand({
        transportRetry: "idempotent",
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

  const reconcileWorkspaceRun = async (
    request: WorkerWorkspaceReconcileRequest,
    metrics: WorkspaceReconcileMetrics,
  ): Promise<WorkerWorkspaceReconcileResult> => {
    if (!path.isAbsolute(request.localPath) || !path.posix.isAbsolute(request.remoteWorkspaceDir)) {
      throw new Error("Worker workspace reconcile paths must be absolute");
    }
    const pending = request.journal.load();
    if (pending) {
      await recoverWorkerWorkspaceReconciliation({ root: request.localPath, journal: pending });
      request.journal.abort();
    }
    const hashMemo = new Map<string, string>();
    const runLocalReconciliation = <T>(operation: () => Promise<T>): Promise<T> =>
      measureLocalWorkspaceReconciliation(metrics, () =>
        withWorkspaceHashMemo(hashMemo, operation, metrics.gateway),
      );
    const baseDigest = await resolveRemoteWorkspaceManifest(
      runWorkspaceCommand,
      request.remoteWorkspaceDir,
      request.baseManifestRef,
    );
    const prepared = await waitForPrepared(
      WORKSPACE_TIMEOUT_MS,
      "Worker tunnel did not reconnect within the workspace reconciliation timeout",
    );
    const temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-worker-workspace-reconcile-"),
    );
    const stagingRoot = path.join(temporaryDirectory, "staging");
    const manifestRoot = path.join(temporaryDirectory, "manifests");
    const baseManifestPath = path.join(manifestRoot, `${baseDigest}.json`);
    const transferListPath = path.join(temporaryDirectory, "transfer-list");
    const acceptedWorkspacePublisher = createAcceptedWorkspacePublisherFactory({
      runWorkspaceCommand,
      runRsync: async (argv) => await runRsync(prepared, argv),
      scpTarget: prepared.scpTarget,
      receiverEntryPath,
      localPath: request.localPath,
      remoteWorkspaceDir: request.remoteWorkspaceDir,
      hashMemo,
      metrics,
    });
    try {
      await fs.mkdir(stagingRoot, { mode: 0o700 });
      await fs.mkdir(manifestRoot, { mode: 0o700 });
      const baseManifestTransfer = await runBoundedInboundRsync({
        prepared,
        argv: (rsyncSsh) => [
          "rsync",
          "--archive",
          "--no-recursive",
          "--checksum",
          `--max-size=${MAX_WORKSPACE_MANIFEST_BYTES}`,
          `--bwlimit=${INBOUND_RSYNC_BW_LIMIT_KIB}`,
          "-e",
          rsyncSsh,
          "--",
          `${prepared.scpTarget}:.openclaw-worker/manifests/${baseDigest}.json`,
          baseManifestPath,
        ],
        destinationRoot: manifestRoot,
        entryLimit: 1,
        totalByteLimit: MAX_WORKSPACE_MANIFEST_BYTES,
      });
      if (!success(baseManifestTransfer)) {
        throw workspaceSyncError(baseManifestTransfer);
      }
      const baseRaw = await readTransferredManifest(baseManifestPath);
      const base = parseWorkerWorkspaceManifest(baseRaw, request.baseManifestRef);
      await fs.rm(baseManifestPath);
      // Recover interrupted publication before measuring; a partial swap is not a planning base.
      await recoverAcceptedWorkspacePublication({
        runWorkspaceCommand,
        remoteWorkspaceDir: request.remoteWorkspaceDir,
      });
      const verifyStable = async (expectedRef: string): Promise<void> => {
        const expectedDigest = expectedRef.slice("sha256:".length);
        const observedRef = await captureRemoteWorkspaceManifest({
          runWorkspaceCommand,
          remoteWorkspaceDir: request.remoteWorkspaceDir,
          baseCommit: base.baseCommit,
          // Seed both manifests so a recreated path under a new ignore rule
          // still invalidates the late-writer fence.
          priorManifestDigests: base.baseCommit ? [expectedDigest, baseDigest] : [],
          hashMemo,
          metrics,
        });
        if (observedRef !== expectedRef) {
          throw new Error("Cloud workspace changed during final reconciliation");
        }
      };
      const currentRef = await captureRemoteWorkspaceManifest({
        runWorkspaceCommand,
        remoteWorkspaceDir: request.remoteWorkspaceDir,
        baseCommit: base.baseCommit,
        priorManifestDigests: base.baseCommit ? [baseDigest] : [],
        hashMemo,
        metrics,
      });
      const changed = currentRef !== request.baseManifestRef;
      let current = base;
      let currentRaw = baseRaw;
      if (changed) {
        const currentDigest = currentRef.slice("sha256:".length);
        const currentManifestPath = path.join(manifestRoot, `${currentDigest}.json`);
        const currentManifestTransfer = await runBoundedInboundRsync({
          prepared,
          argv: (rsyncSsh) => [
            "rsync",
            "--archive",
            "--no-recursive",
            "--checksum",
            `--max-size=${MAX_WORKSPACE_MANIFEST_BYTES}`,
            `--bwlimit=${INBOUND_RSYNC_BW_LIMIT_KIB}`,
            "-e",
            rsyncSsh,
            "--",
            `${prepared.scpTarget}:.openclaw-worker/manifests/${currentDigest}.json`,
            currentManifestPath,
          ],
          destinationRoot: manifestRoot,
          entryLimit: 1,
          totalByteLimit: MAX_WORKSPACE_MANIFEST_BYTES,
        });
        if (!success(currentManifestTransfer)) {
          throw workspaceSyncError(currentManifestTransfer);
        }
        currentRaw = await readTransferredManifest(currentManifestPath);
        current = parseWorkerWorkspaceManifest(currentRaw, currentRef);
      }
      const { expectedRemoteRef, publishAcceptedManifest } = acceptedWorkspacePublisher(
        current,
        currentRef,
      );
      if (changed) {
        const transferPaths = workerWorkspaceTransferPaths(current, base);
        const transferPathSet = new Set(transferPaths);
        if (transferPaths.length > 0) {
          await fs.writeFile(transferListPath, Buffer.from(`${transferPaths.join("\0")}\0`), {
            mode: 0o600,
          });
          const resultTransfer = await runBoundedInboundRsync({
            prepared,
            argv: (rsyncSsh) => [
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
      }
      // Catch additions, deletions, and writes that raced the inbound transfer.
      // Stop performs this check once more after local acceptance, directly
      // before destroying the remote owner.
      await verifyStable(currentRef);
      const preparedStagedResult = request.stagedResult
        ? await runLocalReconciliation(
            async () =>
              await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
                request,
                stagingRoot,
                currentManifestRef: currentRef,
                baseManifestRaw: baseRaw,
                currentManifestRaw: currentRaw,
                publishAcceptedManifest,
              }),
          )
        : undefined;
      const stagedResult = preparedStagedResult
        ? {
            ...preparedStagedResult,
            applyPreparedStagedResult: async () =>
              await runLocalReconciliation(
                async () => await preparedStagedResult.applyPreparedStagedResult(),
              ),
            verifyLocalStable: async () =>
              await runLocalReconciliation(
                async () => await preparedStagedResult.verifyLocalStable(),
              ),
          }
        : undefined;
      let appliedWorkspaceResult: WorkerWorkspaceApplyResult | undefined;
      if (!stagedResult) {
        appliedWorkspaceResult = await runLocalReconciliation(
          async () =>
            await applyStagedWorkerWorkspace({
              root: request.localPath,
              stagingRoot,
              baseManifestRef: request.baseManifestRef,
              currentManifestRef: currentRef,
              base,
              current,
              journal: request.journal,
              publishAcceptedManifest,
            }),
        );
      }
      return {
        get manifestRef() {
          return expectedRemoteRef();
        },
        changed,
        verifyStable: async () => await verifyStable(expectedRemoteRef()),
        verifyLocalStable: async () =>
          await runLocalReconciliation(
            async () =>
              await (appliedWorkspaceResult?.verifyLocalStable() ??
                assertWorkspaceResultStable({ root: request.localPath, base, current })),
          ),
        getAppliedWorkspaceResult: () => appliedWorkspaceResult,
        ...stagedResult,
      };
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const reconcileWorkspaceImpl = async (
    request: WorkerWorkspaceReconcileRequest,
  ): Promise<WorkerWorkspaceReconcileResult> => {
    const metrics = createWorkspaceReconcileMetrics();
    const startedAt = performance.now();
    const report = (outcome: "failed" | "succeeded") => {
      workspaceSyncLog.debug("worker workspace reconcile completed", {
        outcome,
        durationMs: performance.now() - startedAt,
        ...metrics,
      });
    };
    try {
      const reconciliation = await reconcileWorkspaceRun(request, metrics);
      registerWorkspaceReconcileReporter(reconciliation, report);
      return reconciliation;
    } catch (error) {
      report("failed");
      throw error;
    }
  };

  return {
    quiesceWorkspace,
    reconcileWorkspace: (request) => track(reconcileWorkspaceImpl(request)),
    runWorkspaceCommand,
    // Keep the outer task registered across local-file phases so tunnel stop drains all owner work.
    syncWorkspace: (request) => track(syncWorkspaceImpl(request)),
  };
}
