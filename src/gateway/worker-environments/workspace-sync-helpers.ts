import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { redactSensitiveText } from "../../logging/redact.js";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { WORKER_BUNDLE_RSYNC_RECEIVER_PATH } from "../../shared/worker-bundle-hash.js";
import {
  type PreparedWorkerSsh,
  workerSshCommandOptions,
  workerSshOptions,
  workerSshRemoteCommand,
} from "./ssh.js";
import { WorkerWorkspaceOperatorRecoveryError } from "./tunnel-contract.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceSyncRequest } from "./tunnel-contract.js";
import {
  recordRemoteWorkspaceHashMetrics,
  serializeRemoteWorkspaceHashMemo,
  type WorkspaceHashMemo,
  type WorkspaceReconcileMetrics,
} from "./workspace-hash-memo.js";
import { MAX_RECONCILIATION_ENTRIES } from "./workspace-manifest.js";
import { WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE } from "./workspace-quiescence-scripts.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const WORKER_HASH_IDENTITY_PATTERN = /^worker:\d+:\d+:\d+:\d+:\d+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const remoteWorkspaceManifestEnvelopeSchema = z
  .object({
    version: z.literal(1),
    manifestRef: z.string().regex(MANIFEST_REF_PATTERN),
    memo: z
      .array(
        z.tuple([z.string().regex(WORKER_HASH_IDENTITY_PATTERN), z.string().regex(SHA256_PATTERN)]),
      )
      .max(MAX_RECONCILIATION_ENTRIES),
    metrics: z
      .object({
        contentHashCount: z.number().finite().nonnegative(),
        contentHashDurationMs: z.number().finite().nonnegative(),
        memoHitCount: z.number().finite().nonnegative(),
        memoTruncatedCount: z.number().finite().nonnegative(),
        totalDurationMs: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();
const INBOUND_QUOTA_INITIAL_POLL_MS = 25;
const INBOUND_QUOTA_MAX_POLL_MS = 250;
export const WORKER_WORKSPACE_RSYNC_DESTINATION = "openclaw-rsync-destination";

export type WorkerWorkspaceActionsOptions = {
  environmentId: string;
  sharedHost?: boolean;
  ownerSignal: AbortSignal;
  waitForPrepared: () => Promise<PreparedWorkerSsh>;
  runner: { run(argv: string[], options: CommandOptions): Promise<SpawnResult> };
  tasks: Set<Promise<unknown>>;
  bundleHash: string;
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

export function workspaceQuiescenceError(result: SpawnResult): Error {
  const error = workspaceSyncError(result);
  return result.termination === "exit" &&
    result.code === WORKER_WORKSPACE_OPERATOR_RECOVERY_EXIT_CODE
    ? new WorkerWorkspaceOperatorRecoveryError(error)
    : error;
}

export function workerWorkspaceRsyncRemoteCommand(
  prepared: PreparedWorkerSsh,
  port = prepared.port,
): string {
  return workerSshRemoteCommand([
    "ssh",
    ...workerSshOptions(prepared, { forwarding: "disabled" }),
    "-a",
    "-x",
    "-T",
    "-p",
    String(port),
  ]);
}

type WorkerWorkspaceRsyncReceiverMode = "accepted-next" | "git-pack" | "workspace-root";

function workerWorkspaceRsyncReceiverPath(params: {
  receiverEntryPath: string;
  remoteWorkspaceDir: string;
  canonicalHome: string;
  remoteRelative: string;
  mode: WorkerWorkspaceRsyncReceiverMode;
  nonce: string;
}): string {
  const context = Buffer.from(
    JSON.stringify([params.remoteWorkspaceDir, params.canonicalHome, params.remoteRelative]),
  ).toString("base64url");
  const command = ["node", params.receiverEntryPath, params.mode, context, params.nonce];
  if (command.some((word) => !/^[A-Za-z0-9_./-]+$/u.test(word))) {
    throw new Error("Worker workspace rsync receiver command is not shell-safe");
  }
  return command.join(" ");
}

export function createWorkerWorkspaceRsyncReceiverPathFactory(params: {
  receiverEntryPath: string;
  remoteWorkspaceDir: string;
  canonicalHome: string;
  remoteRelative: string;
}): (mode: "git-pack" | "workspace-root") => string {
  return (mode) =>
    workerWorkspaceRsyncReceiverPath({
      ...params,
      mode,
      nonce: randomBytes(16).toString("hex"),
    });
}

export function workerAcceptedWorkspaceRsyncReceiverPath(params: {
  receiverEntryPath: string;
  remoteWorkspaceDir: string;
  nonce: string;
}): string {
  const workspaceRootMarker = "/.openclaw-worker/workspaces/";
  const markerIndex = params.remoteWorkspaceDir.lastIndexOf(workspaceRootMarker);
  if (markerIndex < 1) {
    throw new Error("Accepted workspace path is outside the managed workspace root");
  }
  const canonicalHome = params.remoteWorkspaceDir.slice(0, markerIndex);
  const remoteRelative = params.remoteWorkspaceDir.slice(markerIndex + 1);
  return workerWorkspaceRsyncReceiverPath({
    receiverEntryPath: params.receiverEntryPath,
    remoteWorkspaceDir: params.remoteWorkspaceDir,
    canonicalHome,
    remoteRelative,
    mode: "accepted-next",
    nonce: params.nonce,
  });
}

export function workerWorkspaceRsyncReceiverEntryPath(bundleHash: string): string {
  if (!/^[a-f0-9]{64}$/u.test(bundleHash)) {
    throw new Error("Worker workspace rsync receiver bundle hash is invalid");
  }
  return `.openclaw-worker/${bundleHash}/${WORKER_BUNDLE_RSYNC_RECEIVER_PATH}`;
}

export function workerWorkspaceSshArgv(
  prepared: PreparedWorkerSsh,
  remoteArgv: readonly string[],
  port = prepared.port,
): string[] {
  return [
    "ssh",
    ...workerSshOptions(prepared, { forwarding: "disabled" }),
    "-a",
    "-x",
    "-T",
    "-p",
    String(port),
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
    transportRetry: "idempotent",
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

export async function captureRemoteWorkspaceManifest(params: {
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
  remoteWorkspaceDir: string;
  baseCommit: string | null;
  priorManifestDigests: readonly string[];
  hashMemo: WorkspaceHashMemo;
  metrics: WorkspaceReconcileMetrics;
}): Promise<string> {
  params.metrics.remoteManifestCalls += 1;
  const startedAt = performance.now();
  const captured = await params
    .runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        params.remoteWorkspaceDir,
        params.baseCommit ?? "",
        ...(params.baseCommit ? ["eligible"] : []),
        ...params.priorManifestDigests,
        "memo-v1",
      ],
      input: serializeRemoteWorkspaceHashMemo(params.hashMemo),
    })
    .finally(() => {
      params.metrics.remoteManifestWallDurationMs += performance.now() - startedAt;
    });
  if (!workerWorkspaceCommandSucceeded(captured)) {
    throw workspaceSyncError(captured);
  }
  let response;
  try {
    response = remoteWorkspaceManifestEnvelopeSchema.parse(JSON.parse(captured.stdout));
  } catch (error) {
    throw new Error("Worker workspace manifest returned an invalid memo response", {
      cause: error,
    });
  }
  for (const identity of params.hashMemo.keys()) {
    if (identity.startsWith("worker:")) {
      params.hashMemo.delete(identity);
    }
  }
  for (const [identity, sha256] of response.memo) {
    params.hashMemo.set(identity, sha256);
  }
  recordRemoteWorkspaceHashMetrics(params.metrics, response.metrics);
  return response.manifestRef;
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

export function parseRemoteWorkspaceSetup(
  stdout: string,
  remoteRelative: string,
): { canonicalHome: string; remoteWorkspaceDir: string } {
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error("Worker workspace setup returned an invalid response");
  }
  const record = isRecord(response) ? response : undefined;
  const canonicalHome = record?.canonicalHome;
  const remoteWorkspaceDir = record?.canonicalWorkspace;
  if (
    record?.tag !== "openclaw-workspace-setup-v1" ||
    typeof canonicalHome !== "string" ||
    !path.posix.isAbsolute(canonicalHome) ||
    path.posix.normalize(canonicalHome) !== canonicalHome ||
    typeof remoteWorkspaceDir !== "string" ||
    !path.posix.isAbsolute(remoteWorkspaceDir) ||
    path.posix.normalize(remoteWorkspaceDir) !== remoteWorkspaceDir ||
    remoteWorkspaceDir === "/" ||
    remoteWorkspaceDir !== path.posix.join(canonicalHome, remoteRelative)
  ) {
    throw new Error("Worker workspace setup returned an invalid response");
  }
  return { canonicalHome, remoteWorkspaceDir };
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
  let pollIntervalMs = INBOUND_QUOTA_INITIAL_POLL_MS;
  // Rsync reports logical updates, not partial files or retry residue. Back off
  // the canonical tree scan, then always recheck once more before acceptance.
  while (!(await Promise.race([transferSettled, delay(pollIntervalMs).then(() => false)]))) {
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
    pollIntervalMs = Math.min(pollIntervalMs * 2, INBOUND_QUOTA_MAX_POLL_MS);
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
