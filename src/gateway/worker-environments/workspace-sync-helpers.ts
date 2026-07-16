import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { redactSensitiveText } from "../../logging/redact.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { type PreparedWorkerSsh, workerSshCommandOptions } from "./ssh.js";
import type { WorkerWorkspaceSyncRequest } from "./tunnel-contract.js";

export const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;

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
