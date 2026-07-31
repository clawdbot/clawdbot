import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandBuffered, runCommandWithTimeout } from "../../process/exec.js";
import type { WorkerWorkspaceReconcileRequest } from "./tunnel-contract.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_FILE_BYTES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
  type WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";
import { reconciliationEntries } from "./workspace-reconcile-derived-paths.js";
import { absoluteEntryMatches, localPath } from "./workspace-reconcile-fs.js";
import {
  applyStagedWorkerWorkspace,
  changedEntryPaths,
  inspectAcceptedWorkerWorkspace,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";

const PATCH_TIMEOUT_MS = 10 * 60_000;
// Match managed-worktree refs/openclaw/snapshots: deleting the owning ref is
// sufficient; unreachable objects may remain until normal Git GC.
const WORKER_RESULT_REF_PREFIX = "refs/openclaw/worker-results";
const WORKER_RESULT_CANDIDATE_REF_PREFIX = "refs/openclaw/worker-result-candidates";
const WORKER_RESULT_CLEANUP_REF_PREFIX = "refs/openclaw/worker-result-cleanup";
const WORKER_RESULT_CLAIM_ID_PATTERN = /^[A-Za-z0-9-]+$/u;
const STAGED_RESULT_MESSAGE = "OpenClaw worker workspace result";
const STAGED_RESULT_METADATA_LIMIT = 128 * 1024 * 1024 + 4_096;
// Git documents the platform null device as the per-command way to disable
// hooks. An unowned path under a shared temp dir could be populated by another user.
const DISABLED_GIT_HOOKS_PATH = os.devNull;

function gitCommand(cwd: string, args: string[]): string[] {
  return ["git", "-c", `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, "-C", cwd, ...args];
}

export function workerWorkspaceTransferPaths(
  current: WorkerWorkspaceManifest,
  base: WorkerWorkspaceManifest,
): string[] {
  // Staging is directory-agnostic because it transfers file and symlink bytes only.
  const changed = changedEntryPaths(base, current);
  const paths = reconciliationEntries(current.entries)
    .filter((entry) => changed.has(entry.path))
    .map((entry) => {
      if (entry.type === "file" && entry.size > MAX_RECONCILIATION_FILE_BYTES) {
        throw new Error(`Cloud workspace result is too large: ${entry.path}`);
      }
      return entry.path;
    });
  if (paths.length > MAX_RECONCILIATION_ENTRIES) {
    throw new Error(
      `Cloud workspace reconciliation exceeds the ${MAX_RECONCILIATION_ENTRIES} entry limit`,
    );
  }
  return paths;
}

async function requireGit(cwd: string, args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(gitCommand(cwd, args), {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout.trim();
}

function requireWorkerResultStorageRef(ref: string): string {
  if (
    !new RegExp(
      `^(?:${WORKER_RESULT_REF_PREFIX}|${WORKER_RESULT_CANDIDATE_REF_PREFIX}|${WORKER_RESULT_CLEANUP_REF_PREFIX})/[A-Za-z0-9-]+$`,
      "u",
    ).test(ref)
  ) {
    throw new Error("Cloud workspace staged result reference is invalid");
  }
  return ref;
}

function requireWorkerResultRef(ref: string): string {
  if (!ref.startsWith(`${WORKER_RESULT_REF_PREFIX}/`)) {
    throw new Error("Cloud workspace staged result reference is invalid");
  }
  return requireWorkerResultStorageRef(ref);
}

export function workerWorkspaceResultRef(claimId: string): string {
  if (!WORKER_RESULT_CLAIM_ID_PATTERN.test(claimId)) {
    throw new Error("Cloud workspace result claim id is invalid");
  }
  return `${WORKER_RESULT_REF_PREFIX}/${claimId}`;
}

export function preparedWorkerWorkspaceResultRef(stagedResultRef: string): string {
  const ref = requireWorkerResultRef(stagedResultRef);
  return `${WORKER_RESULT_CANDIDATE_REF_PREFIX}/${ref.slice(WORKER_RESULT_REF_PREFIX.length + 1)}`;
}

export function cleanupWorkerWorkspaceResultRef(stagedResultRef: string): string {
  const ref = requireWorkerResultRef(stagedResultRef);
  return `${WORKER_RESULT_CLEANUP_REF_PREFIX}/${ref.slice(WORKER_RESULT_REF_PREFIX.length + 1)}`;
}

export function isWorkerWorkspaceResultCleanupRef(ref: string): boolean {
  return ref.startsWith(`${WORKER_RESULT_CLEANUP_REF_PREFIX}/`);
}

async function hasGitAdminPath(root: string): Promise<boolean> {
  let current = root;
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

async function ensureWorkerWorkspaceResultRepository(root: string): Promise<string> {
  const resolved = await fs.realpath(root);
  const probe = await runCommandWithTimeout(gitCommand(resolved, ["rev-parse", "--git-dir"]), {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: 1024 * 1024,
  });
  if (probe.termination === "exit" && probe.code === 0) {
    return resolved;
  }
  await requireGit(resolved, ["init", "--quiet", "--object-format=sha1"]);
  return resolved;
}

export async function hasWorkerWorkspaceResultRef(params: {
  root: string;
  stagedResultRef: string;
}): Promise<boolean> {
  let root: string;
  try {
    root = await fs.realpath(params.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (!(await hasGitAdminPath(root))) {
    return false;
  }
  const result = await runCommandWithTimeout(
    gitCommand(root, [
      "show-ref",
      "--verify",
      "--quiet",
      requireWorkerResultStorageRef(params.stagedResultRef),
    ]),
    { timeoutMs: PATCH_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
  );
  if (result.termination === "exit" && result.code === 0) {
    return true;
  }
  if (result.termination === "exit" && result.code === 1) {
    return false;
  }
  throw new Error((result.stderr || result.stdout || "git show-ref failed").trim());
}

function stagedResultMessage(params: {
  baseManifestRef: string;
  currentManifestRef: string;
  baseManifestRaw: string;
  currentManifestRaw: string;
}): Buffer {
  const base = Buffer.from(params.baseManifestRaw);
  const current = Buffer.from(params.currentManifestRaw);
  const header = Buffer.from(
    `${STAGED_RESULT_MESSAGE}\nversion 1\nbase-ref ${params.baseManifestRef}\ncurrent-ref ${params.currentManifestRef}\nbase-bytes ${base.byteLength}\ncurrent-bytes ${current.byteLength}\n\n`,
  );
  return Buffer.concat([header, base, current]);
}

function quoteFastImportPath(entryPath: string): string {
  const bytes = Buffer.from(entryPath);
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0) {
      throw new Error("Cloud workspace staged result path contains a null byte");
    }
    if (byte === 0x22 || byte === 0x5c) {
      quoted += `\\${String.fromCharCode(byte)}`;
    } else if (byte >= 0x20 && byte < 0x7f) {
      quoted += String.fromCharCode(byte);
    } else {
      quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    }
  }
  return `${quoted}"`;
}

async function readGitBlob(params: {
  root: string;
  objectId: string;
  maxBytes: number;
}): Promise<Buffer> {
  const result = await runCommandBuffered(
    gitCommand(params.root, ["cat-file", "blob", params.objectId]),
    { timeoutMs: PATCH_TIMEOUT_MS, maxOutputBytes: params.maxBytes + 1 },
  );
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  if (result.stdout.byteLength > params.maxBytes) {
    throw new Error("Cloud workspace staged result exceeds its byte limit");
  }
  return result.stdout;
}

async function stageWorkerWorkspaceResult(params: {
  root: string;
  stagingRoot: string;
  stagedResultRef: string;
  baseManifestRef: string;
  currentManifestRef: string;
  baseManifestRaw: string;
  currentManifestRaw: string;
}): Promise<void> {
  const root = await ensureWorkerWorkspaceResultRepository(params.root);
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  const base = parseWorkerWorkspaceManifest(params.baseManifestRaw, params.baseManifestRef);
  const current = parseWorkerWorkspaceManifest(
    params.currentManifestRaw,
    params.currentManifestRef,
  );
  // This ref is the complete worker-result artifact, not a patch cache. Keep
  // unchanged blobs too so recovery is self-contained after the worker dies.
  const entries = reconciliationEntries(current.entries).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (entries.length > MAX_RECONCILIATION_ENTRIES) {
    throw new Error(
      `Cloud workspace reconciliation exceeds the ${MAX_RECONCILIATION_ENTRIES} entry limit`,
    );
  }
  const changed = changedEntryPaths(base, current);
  const blobs: Array<{ entry: WorkerWorkspaceManifestEntry; mark: number; content: Buffer }> = [];
  let totalBytes = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "file" && entry.size > MAX_RECONCILIATION_FILE_BYTES) {
      throw new Error(`Cloud workspace result is too large: ${entry.path}`);
    }
    const sourceRoot = changed.has(entry.path) ? params.stagingRoot : root;
    const source = localPath(sourceRoot, entry.path);
    if (!(await absoluteEntryMatches(source, entry))) {
      throw new Error(`Cloud workspace staged payload is invalid: ${entry.path}`);
    }
    const content =
      entry.type === "symlink" ? Buffer.from(entry.target) : await fs.readFile(source);
    if (
      entry.type === "file" &&
      (content.byteLength !== entry.size ||
        createHash("sha256").update(content).digest("hex") !== entry.sha256)
    ) {
      throw new Error(`Cloud workspace staged payload changed while reading: ${entry.path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Cloud workspace staged result exceeds its byte limit");
    }
    blobs.push({ entry, mark: index + 1, content });
  }
  const message = stagedResultMessage(params);
  const chunks: Uint8Array[] = [];
  for (const blob of blobs) {
    chunks.push(Buffer.from(`blob\nmark :${blob.mark}\ndata ${blob.content.byteLength}\n`));
    chunks.push(blob.content, Buffer.from("\n"));
  }
  chunks.push(
    Buffer.from(
      `commit ${stagedResultRef}\nauthor OpenClaw <openclaw@localhost> 0 +0000\ncommitter OpenClaw <openclaw@localhost> 0 +0000\ndata ${message.byteLength}\n`,
    ),
    message,
    Buffer.from("\ndeleteall\n"),
  );
  for (const blob of blobs) {
    const mode =
      blob.entry.type === "symlink"
        ? "120000"
        : (blob.entry.mode & 0o111) !== 0
          ? "100755"
          : "100644";
    chunks.push(Buffer.from(`M ${mode} :${blob.mark} ${quoteFastImportPath(blob.entry.path)}\n`));
  }
  chunks.push(Buffer.from("done\n"));
  const imported = await runCommandBuffered(gitCommand(root, ["fast-import", "--quiet"]), {
    input: Buffer.concat(chunks),
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: { stdout: 1024 * 1024, stderr: 1024 * 1024 },
  });
  if (imported.termination !== "exit" || imported.code !== 0) {
    throw new Error(imported.stderr.toString("utf8").trim() || "git fast-import failed");
  }
  await requireGit(root, ["rev-parse", `${stagedResultRef}^{commit}`]);
}

type LoadedStagedWorkerWorkspace = {
  baseManifestRef: string;
  currentManifestRef: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  objectsByPath: Map<string, { mode: string; objectId: string }>;
};

async function loadStagedWorkerWorkspace(
  root: string,
  stagedResultRef: string,
): Promise<LoadedStagedWorkerWorkspace> {
  const ref = requireWorkerResultStorageRef(stagedResultRef);
  const rawCommit = await runCommandBuffered(gitCommand(root, ["cat-file", "commit", ref]), {
    timeoutMs: PATCH_TIMEOUT_MS,
    maxOutputBytes: STAGED_RESULT_METADATA_LIMIT,
  });
  if (rawCommit.termination !== "exit" || rawCommit.code !== 0) {
    throw new Error(rawCommit.stderr.toString("utf8").trim() || "git cat-file failed");
  }
  const commitHeaderEnd = rawCommit.stdout.indexOf("\n\n");
  if (commitHeaderEnd < 0) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const message = rawCommit.stdout.subarray(commitHeaderEnd + 2);
  const metadataEnd = message.indexOf("\n\n");
  if (metadataEnd < 0) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const lines = message.subarray(0, metadataEnd).toString("utf8").split("\n");
  const match = /^sha256:[a-f0-9]{64}$/u;
  const baseManifestRef = lines[2]?.slice("base-ref ".length) ?? "";
  const currentManifestRef = lines[3]?.slice("current-ref ".length) ?? "";
  const baseBytes = Number(lines[4]?.slice("base-bytes ".length));
  const currentBytes = Number(lines[5]?.slice("current-bytes ".length));
  if (
    lines[0] !== STAGED_RESULT_MESSAGE ||
    lines[1] !== "version 1" ||
    !lines[2]?.startsWith("base-ref ") ||
    !lines[3]?.startsWith("current-ref ") ||
    !lines[4]?.startsWith("base-bytes ") ||
    !lines[5]?.startsWith("current-bytes ") ||
    lines.length !== 6 ||
    !match.test(baseManifestRef) ||
    !match.test(currentManifestRef) ||
    !Number.isSafeInteger(baseBytes) ||
    baseBytes < 0 ||
    !Number.isSafeInteger(currentBytes) ||
    currentBytes < 0
  ) {
    throw new Error("Cloud workspace staged result metadata is invalid");
  }
  const manifests = message.subarray(metadataEnd + 2);
  if (manifests.byteLength !== baseBytes + currentBytes) {
    throw new Error("Cloud workspace staged result metadata is truncated");
  }
  const baseRaw = manifests.subarray(0, baseBytes).toString("utf8");
  const currentRaw = manifests.subarray(baseBytes).toString("utf8");
  const base = parseWorkerWorkspaceManifest(baseRaw, baseManifestRef);
  const current = parseWorkerWorkspaceManifest(currentRaw, currentManifestRef);
  const tree = await runCommandBuffered(
    gitCommand(root, ["ls-tree", "-r", "-z", "--full-tree", ref]),
    { timeoutMs: PATCH_TIMEOUT_MS, maxOutputBytes: 2 * MAX_RECONCILIATION_FILE_BYTES },
  );
  if (tree.termination !== "exit" || tree.code !== 0) {
    throw new Error(tree.stderr.toString("utf8").trim() || "git ls-tree failed");
  }
  const objectsByPath = new Map<string, { mode: string; objectId: string }>();
  for (const record of tree.stdout.toString("utf8").split("\0").filter(Boolean)) {
    const parsed = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(
      record,
    );
    if (!parsed) {
      throw new Error("Cloud workspace staged result tree is invalid");
    }
    objectsByPath.set(parsed[3]!, { mode: parsed[1]!, objectId: parsed[2]! });
  }
  const entries = reconciliationEntries(current.entries);
  if (objectsByPath.size !== entries.length) {
    throw new Error("Cloud workspace staged result tree does not match its manifest");
  }
  for (const entry of entries) {
    const object = objectsByPath.get(entry.path);
    const expectedMode =
      entry.type === "symlink" ? "120000" : (entry.mode & 0o111) !== 0 ? "100755" : "100644";
    if (!object || object.mode !== expectedMode) {
      throw new Error(`Cloud workspace staged result tree is invalid: ${entry.path}`);
    }
  }
  return { baseManifestRef, currentManifestRef, base, current, objectsByPath };
}

async function materializeStagedEntry(params: {
  root: string;
  entry: WorkerWorkspaceManifestEntry;
  content?: Uint8Array;
}): Promise<void> {
  const target = localPath(params.root, params.entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (params.entry.type === "symlink") {
    await fs.symlink(params.entry.target, target);
    return;
  }
  if (!params.content) {
    throw new Error(`Cloud workspace staged content is missing: ${params.entry.path}`);
  }
  await fs.writeFile(target, params.content, { mode: params.entry.mode, flag: "wx" });
  await fs.chmod(target, params.entry.mode);
  if (!(await absoluteEntryMatches(target, params.entry))) {
    throw new Error(`Cloud workspace staged payload is invalid: ${params.entry.path}`);
  }
}

export async function applyStagedWorkerWorkspaceResult(params: {
  root: string;
  stagedResultRef: string;
  expectedBaseManifestRef: string;
  alreadyAccepted?: boolean;
  journal: WorkerWorkspaceReconciliationJournalAdapter;
  publishAcceptedManifest?: (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => Promise<void>;
}): Promise<WorkerWorkspaceApplyResult & { changed: boolean }> {
  const root = await fs.realpath(params.root);
  const staged = await loadStagedWorkerWorkspace(root, params.stagedResultRef);
  if (params.alreadyAccepted || staged.baseManifestRef !== params.expectedBaseManifestRef) {
    // An acceptance marker proves the mutations already ran even when omitted
    // local nodes left the manifest ref unchanged. Re-snapshot; never replay.
    // A base advance proves the same commit-before-acceptance crash window.
    const accepted = await inspectAcceptedWorkerWorkspace({
      root,
      expectedManifestRef: params.expectedBaseManifestRef,
      allowAdvancedLocalState: true,
      base: staged.base,
      current: staged.current,
    });
    if (!accepted) {
      throw new Error("Cloud workspace staged result does not match the placement base");
    }
    params.journal.commit(accepted.manifestRef);
    return {
      ...accepted,
      changed: changedEntryPaths(staged.base, staged.current).size > 0,
    };
  }
  const changed = changedEntryPaths(staged.base, staged.current);
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-staged-result-"));
  try {
    for (const entry of reconciliationEntries(staged.current.entries)) {
      if (!changed.has(entry.path)) {
        continue;
      }
      const object = staged.objectsByPath.get(entry.path)!;
      const content = await readGitBlob({
        root,
        objectId: object.objectId,
        maxBytes: MAX_RECONCILIATION_FILE_BYTES,
      });
      if (entry.type === "symlink") {
        if (content.toString("utf8") !== entry.target) {
          throw new Error(`Cloud workspace staged result tree is invalid: ${entry.path}`);
        }
        await materializeStagedEntry({ root: stagingRoot, entry });
      } else {
        await materializeStagedEntry({ root: stagingRoot, entry, content });
      }
    }
    const applied = await applyStagedWorkerWorkspace({
      root,
      stagingRoot,
      baseManifestRef: staged.baseManifestRef,
      currentManifestRef: staged.currentManifestRef,
      base: staged.base,
      current: staged.current,
      journal: params.journal,
      publishAcceptedManifest: params.publishAcceptedManifest,
    });
    return { ...applied, changed: changed.size > 0 };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function prepareRequestedWorkerWorkspaceResult(params: {
  request: WorkerWorkspaceReconcileRequest;
  stagingRoot: string;
  currentManifestRef: string;
  baseManifestRaw: string;
  currentManifestRaw: string;
  publishAcceptedManifest?: (accepted: {
    manifestRef: string;
    manifest: WorkerWorkspaceManifest;
    conflictPaths: string[];
  }) => Promise<void>;
}): Promise<{
  applyPreparedStagedResult(): Promise<void>;
  getAppliedWorkspaceResult(): WorkerWorkspaceApplyResult | undefined;
  verifyLocalStable(): Promise<void>;
  publishStagedResult(): Promise<void>;
  discardPreparedStagedResult(): Promise<void>;
}> {
  const stagedResult = params.request.stagedResult;
  if (!stagedResult) {
    throw new Error("Cloud workspace durable result staging was not requested");
  }
  const candidateRef = preparedWorkerWorkspaceResultRef(stagedResult.ref);
  let appliedWorkspaceResult: WorkerWorkspaceApplyResult | undefined;
  await stageWorkerWorkspaceResult({
    root: params.request.localPath,
    stagingRoot: params.stagingRoot,
    stagedResultRef: candidateRef,
    baseManifestRef: params.request.baseManifestRef,
    currentManifestRef: params.currentManifestRef,
    baseManifestRaw: params.baseManifestRaw,
    currentManifestRaw: params.currentManifestRaw,
  });
  return {
    applyPreparedStagedResult: async () => {
      const root = await ensureWorkerWorkspaceResultRepository(params.request.localPath);
      appliedWorkspaceResult = await applyStagedWorkerWorkspaceResult({
        root,
        stagedResultRef: candidateRef,
        expectedBaseManifestRef: params.request.baseManifestRef,
        journal: params.request.journal,
        publishAcceptedManifest: params.publishAcceptedManifest,
      });
    },
    getAppliedWorkspaceResult: () => appliedWorkspaceResult,
    verifyLocalStable: async () => {
      if (!appliedWorkspaceResult) {
        throw new Error("Cloud workspace staged result has not been applied");
      }
      await appliedWorkspaceResult.verifyLocalStable();
    },
    publishStagedResult: async () => {
      const root = await ensureWorkerWorkspaceResultRepository(params.request.localPath);
      const commit = await requireGit(root, ["rev-parse", `${candidateRef}^{commit}`]);
      await requireGit(root, ["update-ref", stagedResult.ref, commit]);
      await requireGit(root, ["update-ref", "-d", candidateRef]);
      // Final fences precede publishing. Preserve the canonical ref on any
      // SQLite failure so restart recovery can discover the verified result.
      stagedResult.record(stagedResult.ref);
    },
    discardPreparedStagedResult: async () => {
      await deleteStagedWorkerWorkspaceResult({
        root: params.request.localPath,
        stagedResultRef: candidateRef,
      });
    },
  };
}

export async function deleteStagedWorkerWorkspaceResult(params: {
  root: string;
  stagedResultRef: string;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  await requireGit(root, ["update-ref", "-d", stagedResultRef]);
  if (stagedResultRef.startsWith(`${WORKER_RESULT_REF_PREFIX}/`)) {
    await requireGit(root, ["update-ref", "-d", preparedWorkerWorkspaceResultRef(stagedResultRef)]);
  }
}

export async function moveStagedWorkerWorkspaceResultToCleanup(params: {
  root: string;
  stagedResultRef: string;
}): Promise<string> {
  const root = await fs.realpath(params.root);
  const stagedResultRef = requireWorkerResultRef(params.stagedResultRef);
  const cleanupRef = cleanupWorkerWorkspaceResultRef(stagedResultRef);
  const commit = await requireGit(root, ["rev-parse", `${stagedResultRef}^{commit}`]);
  // The temporary cleanup namespace survives the SQLite fence removal. Either
  // side of this two-step move is therefore discoverable after a crash.
  await requireGit(root, ["update-ref", cleanupRef, commit]);
  await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef });
  return cleanupRef;
}

export async function restoreStagedWorkerWorkspaceResultFromCleanup(params: {
  root: string;
  cleanupRef: string;
  stagedResultRef: string;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const cleanupRef = requireWorkerResultStorageRef(params.cleanupRef);
  if (!isWorkerWorkspaceResultCleanupRef(cleanupRef)) {
    throw new Error("Cloud workspace cleanup result reference is invalid");
  }
  const stagedResultRef = requireWorkerResultRef(params.stagedResultRef);
  const commit = await requireGit(root, ["rev-parse", `${cleanupRef}^{commit}`]);
  await requireGit(root, ["update-ref", stagedResultRef, commit]);
  await requireGit(root, ["update-ref", "-d", cleanupRef]);
}

export async function deleteWorkerWorkspaceResultCleanupRefs(params: {
  root: string;
  retainedRefs?: ReadonlySet<string>;
}): Promise<void> {
  const root = await fs.realpath(params.root);
  const output = await requireGit(root, [
    "for-each-ref",
    "--format=%(refname)",
    `${WORKER_RESULT_CLEANUP_REF_PREFIX}/`,
  ]);
  for (const cleanupRef of output.split("\n").filter(Boolean)) {
    requireWorkerResultStorageRef(cleanupRef);
    if (!params.retainedRefs?.has(cleanupRef)) {
      await requireGit(root, ["update-ref", "-d", cleanupRef]);
    }
  }
}

export const workerWorkspaceResultStaging = {
  prepareRequestedWorkerWorkspaceResult,
  stageWorkerWorkspaceResult,
};
