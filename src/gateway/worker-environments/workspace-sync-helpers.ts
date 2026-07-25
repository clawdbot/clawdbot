import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redactSensitiveText } from "../../logging/redact.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import {
  type PreparedWorkerSsh,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "./ssh.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceSyncRequest } from "./tunnel-contract.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type WorkerWorkspaceActionsOptions = {
  environmentId: string;
  ownerSignal: AbortSignal;
  isConnected: () => boolean;
  getPrepared: () => PreparedWorkerSsh | undefined;
  runner: { run(argv: string[], options: CommandOptions): Promise<SpawnResult> };
  tasks: Set<Promise<unknown>>;
};

export function waitForQuiescenceRenewal(
  signal: AbortSignal,
  intervalMs: number,
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, intervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function workerWorkspaceCommandSucceeded(result: SpawnResult): boolean {
  return result.termination === "exit" && result.code === 0;
}

export function workspaceSyncError(result: SpawnResult): Error {
  const detail = redactSensitiveText(result.stderr || result.stdout, { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return new Error(
    detail ? `Worker workspace sync failed: ${detail}` : "Worker workspace sync failed",
  );
}

export function workerWorkspaceRsyncRemoteCommand(prepared: PreparedWorkerSsh): string {
  return workerSshRemoteCommand([
    "ssh",
    ...workerSshOptions(prepared, { forwarding: "disabled" }),
    "-a",
    "-x",
    "-T",
    "-p",
    String(prepared.port),
  ]);
}

export function workerWorkspaceSshArgv(
  prepared: PreparedWorkerSsh,
  remoteArgv: readonly string[],
): string[] {
  return [
    "ssh",
    ...workerSshOptions(prepared, { forwarding: "disabled" }),
    "-a",
    "-x",
    "-T",
    "-p",
    String(prepared.port),
    "--",
    prepared.sshTarget,
    workerSshRemoteCommand(remoteArgv),
  ];
}

async function resolveRemoteWorkspaceBaseManifest(
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>,
  remoteWorkspaceDir: string,
  expectedRef: string,
): Promise<string> {
  const baseDigest = MANIFEST_REF_PATTERN.test(expectedRef) ? expectedRef.slice(7) : "";
  if (!baseDigest) {
    throw new Error("Worker workspace base manifest reference is invalid");
  }
  const resolved = await runWorkspaceCommand({
    argv: [
      "node",
      "-e",
      REMOTE_WORKSPACE_MANIFEST_JS,
      remoteWorkspaceDir,
      "",
      "resolve",
      baseDigest,
    ],
  });
  if (!workerWorkspaceCommandSucceeded(resolved)) {
    throw workspaceSyncError(resolved);
  }
  if (parseManifestRef(resolved.stdout.trim()) !== expectedRef) {
    throw new Error("Worker workspace base manifest resolution returned the wrong reference");
  }
  return baseDigest;
}

export async function resolveRemoteWorkspaceManifest(
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>,
  remoteWorkspaceDir: string,
  expectedRef: string,
) {
  return await resolveRemoteWorkspaceBaseManifest(
    runWorkspaceCommand,
    remoteWorkspaceDir,
    expectedRef,
  );
}

export async function verifyRemoteWorkspaceManifest(params: {
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
  remoteWorkspaceDir: string;
  baseCommit: string | null;
  baseDigest: string;
  expectedRef: string;
}): Promise<void> {
  const expectedDigest = params.expectedRef.slice("sha256:".length);
  const verified = await params.runWorkspaceCommand({
    argv: [
      "node",
      "-e",
      REMOTE_WORKSPACE_MANIFEST_JS,
      params.remoteWorkspaceDir,
      params.baseCommit ?? "",
      // Seed both manifests so a deleted path recreated under a new ignore rule
      // still invalidates the fence.
      ...(params.baseCommit ? ["eligible", expectedDigest, params.baseDigest] : []),
    ],
  });
  if (!workerWorkspaceCommandSucceeded(verified)) {
    throw workspaceSyncError(verified);
  }
  if (parseManifestRef(verified.stdout.trim()) !== params.expectedRef) {
    throw new Error("Cloud workspace changed during final reconciliation");
  }
}

export async function probeWorkspaceGitMode(params: {
  localPath: string;
  commandOptions: CommandOptions;
  runTask: (argv: string[], options: CommandOptions) => Promise<SpawnResult>;
}): Promise<{ mode: "git" | "plain"; gitRoot: string; baseCommit: string }> {
  const gitAdmin = await fs.lstat(path.join(params.localPath, ".git")).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!gitAdmin) {
    return { mode: "plain", gitRoot: params.localPath, baseCommit: "" };
  }
  const [gitRootResult, gitBaseResult] = await Promise.all([
    params.runTask(
      ["git", "-C", params.localPath, "rev-parse", "--show-toplevel"],
      params.commandOptions,
    ),
    params.runTask(
      ["git", "-C", params.localPath, "rev-parse", "--verify", "--quiet", "HEAD"],
      params.commandOptions,
    ),
  ]);
  if (!workerWorkspaceCommandSucceeded(gitRootResult)) {
    throw workspaceSyncError(gitRootResult);
  }
  if (workerWorkspaceCommandSucceeded(gitBaseResult)) {
    return {
      mode: "git",
      gitRoot: gitRootResult.stdout.trim(),
      baseCommit: gitBaseResult.stdout.trim(),
    };
  }
  if (gitBaseResult.termination === "exit" && gitBaseResult.code === 1) {
    return { mode: "plain", gitRoot: params.localPath, baseCommit: "" };
  }
  throw workspaceSyncError(gitBaseResult);
}

export function stableWorkerPathComponent(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function validateWorkspaceSyncRequest(request: WorkerWorkspaceSyncRequest): void {
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

export function parseRemoteWorkspaceDirectory(stdout: string): string {
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

export function parseManifestRef(stdout: string): string {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  const manifestRef = lines.length === 1 ? lines[0] : undefined;
  if (!manifestRef || !MANIFEST_REF_PATTERN.test(manifestRef)) {
    throw new Error("Worker workspace sync returned an invalid manifest reference");
  }
  return manifestRef;
}

export async function readTransferredManifest(filePath: string): Promise<string> {
  const stats = await fs.lstat(filePath).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024 * 1024) {
    throw new Error("Worker workspace manifest transfer is not a bounded regular file");
  }
  return await fs.readFile(filePath, "utf8");
}

async function inboundDirectoryUsage(
  root: string,
  limits: { bytes: number; entries: number },
): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const walk = async (directory: string): Promise<void> => {
    for await (const directoryEntry of await fs.opendir(directory)) {
      const candidate = path.join(directory, directoryEntry.name);
      const stats = await fs.lstat(candidate).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      });
      if (!stats) {
        continue;
      }
      entries += 1;
      if (entries > limits.entries) {
        return;
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await walk(candidate);
      } else if (stats.isFile()) {
        bytes += stats.size;
        if (bytes > limits.bytes) {
          return;
        }
      }
      if (bytes > limits.bytes || entries > limits.entries) {
        return;
      }
    }
  };
  await walk(root);
  return { bytes, entries };
}

export async function runBoundedInboundRsync(params: {
  argv: string[];
  destinationRoot: string;
  entryLimit: number;
  totalByteLimit: number;
  ownerSignal: AbortSignal;
  runTask: (argv: string[], options: CommandOptions) => Promise<SpawnResult>;
  timeoutMs: number;
}): Promise<SpawnResult> {
  const quotaAbort = new AbortController();
  const signal = AbortSignal.any([params.ownerSignal, quotaAbort.signal]);
  const transfer = params.runTask(
    params.argv,
    workerSshCommandOptions({ timeoutMs: params.timeoutMs, signal }),
  );
  const transferSettled = transfer.then(
    () => true,
    () => true,
  );
  let quotaError: Error | undefined;
  while (!(await Promise.race([transferSettled, delay(25).then(() => false)]))) {
    const usage = await inboundDirectoryUsage(params.destinationRoot, {
      bytes: params.totalByteLimit,
      entries: params.entryLimit,
    });
    if (usage.bytes > params.totalByteLimit || usage.entries > params.entryLimit) {
      quotaError = new Error(
        `Cloud workspace inbound transfer exceeds its ${params.totalByteLimit} byte or ${params.entryLimit} entry limit`,
      );
      quotaAbort.abort(quotaError);
      break;
    }
  }
  let result: SpawnResult;
  try {
    result = await transfer;
  } catch (error) {
    throw quotaError ?? error;
  }
  const finalUsage = await inboundDirectoryUsage(params.destinationRoot, {
    bytes: params.totalByteLimit,
    entries: params.entryLimit,
  });
  if (
    quotaError ||
    finalUsage.bytes > params.totalByteLimit ||
    finalUsage.entries > params.entryLimit
  ) {
    throw (
      quotaError ??
      new Error(
        `Cloud workspace inbound transfer exceeds its ${params.totalByteLimit} byte or ${params.entryLimit} entry limit`,
      )
    );
  }
  return result;
}
