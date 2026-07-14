import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveText } from "../../logging/redact.js";
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
  WorkerWorkspaceSyncRequest,
  WorkerWorkspaceSyncResult,
} from "./tunnel-contract.js";
import { runLocalCommandToFile, writeEligibleGitFiles } from "./workspace-sync-local.js";
import {
  REMOTE_GIT_WORKSPACE_SETUP_SCRIPT,
  REMOTE_WORKSPACE_MANIFEST_JS,
  REMOTE_WORKSPACE_SETUP_SCRIPT,
} from "./workspace-sync-scripts.js";

const REMOTE_SETUP_TIMEOUT_MS = 20_000;
const WORKSPACE_TIMEOUT_MS = 10 * 60_000;
// Relative to the $HOME/.openclaw-worker root owned by REMOTE_WORKSPACE_SETUP_SCRIPT;
// rsync targets must use the returned absolute directory, never this relative path.
const REMOTE_WORKSPACE_ROOT = "workspaces";
const REMOTE_GIT_PACK_NAME = ".openclaw-base.pack";
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;

type WorkerWorkspaceRunner = {
  run(argv: string[], options: CommandOptions): Promise<SpawnResult>;
};

type WorkerWorkspaceActionsOptions = {
  environmentId: string;
  ownerSignal: AbortSignal;
  isConnected: () => boolean;
  getPrepared: () => PreparedWorkerSsh | undefined;
  runner: WorkerWorkspaceRunner;
  tasks: Set<Promise<unknown>>;
};

function success(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

function workspaceSyncError(result: SpawnResult): Error {
  const detail = redactSensitiveText(result.stderr || result.stdout, { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return new Error(
    detail ? `Worker workspace sync failed: ${detail}` : "Worker workspace sync failed",
  );
}

export function stableWorkerPathComponent(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function validateWorkspaceSyncRequest(request: WorkerWorkspaceSyncRequest): void {
  if (!request.sessionId.trim()) {
    throw new Error("Worker workspace session id must be non-empty");
  }
  if (!path.isAbsolute(request.localPath)) {
    throw new Error("Worker workspace local path must be absolute");
  }
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
    throw new Error("Worker workspace generation must be a non-negative safe integer");
  }
}

function parseRemoteWorkspaceDirectory(stdout: string): string {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const directory = lines.length === 1 ? lines[0] : undefined;
  if (
    !directory ||
    !path.posix.isAbsolute(directory) ||
    path.posix.normalize(directory) !== directory ||
    directory === "/"
  ) {
    throw new Error("Worker workspace setup returned an invalid remote directory");
  }
  return directory;
}

function parseManifestRef(stdout: string): string {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const manifestRef = lines.length === 1 ? lines[0] : undefined;
  if (!manifestRef || !MANIFEST_REF_PATTERN.test(manifestRef)) {
    throw new Error("Worker workspace sync returned an invalid manifest reference");
  }
  return manifestRef;
}

/** Binds workspace commands and synchronization to one connected tunnel owner. */
export function createWorkerWorkspaceActions(
  options: WorkerWorkspaceActionsOptions,
): Pick<WorkerTunnelHandle, "runWorkspaceCommand" | "syncWorkspace"> {
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

    const gitRootResult = await runTask(
      ["git", "-C", request.localPath, "rev-parse", "--show-toplevel"],
      workerSshCommandOptions({
        timeoutMs: REMOTE_SETUP_TIMEOUT_MS,
        signal: options.ownerSignal,
      }),
    );
    const mode = success(gitRootResult) ? "git" : "plain";
    let baseCommit = "";
    let gitRoot = request.localPath;
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
        gitRoot = gitRootResult.stdout.trim();
        const [canonicalRequestPath, canonicalGitRoot] = await Promise.all([
          fs.realpath(request.localPath),
          fs.realpath(gitRoot),
        ]);
        if (canonicalRequestPath !== canonicalGitRoot) {
          throw new Error("Worker git workspace sync requires the managed worktree root");
        }
        const gitBase = await runTask(
          ["git", "-C", gitRoot, "rev-parse", "--verify", "HEAD"],
          workerSshCommandOptions({
            timeoutMs: REMOTE_SETUP_TIMEOUT_MS,
            signal: options.ownerSignal,
          }),
        );
        if (!success(gitBase)) {
          throw new Error("Worker git workspace has no base commit");
        }
        baseCommit = gitBase.stdout.trim();
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
        argv: ["node", "-e", REMOTE_WORKSPACE_MANIFEST_JS, remoteWorkspaceDir, baseCommit],
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

  return {
    runWorkspaceCommand,
    syncWorkspace(request) {
      // Keep the outer task registered across local-file phases so tunnel stop drains all owner work.
      return track(syncWorkspaceImpl(request));
    },
  };
}
