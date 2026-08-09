import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { killProcessTree } from "../../process/kill-tree.js";
import { workerSshCommandOptions } from "./ssh.js";
import {
  gitFileMode,
  MAX_WORKSPACE_GIT_CANDIDATES,
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";
import { isPortableRootContainedSymlink } from "./workspace-reconcile-fs.js";

const STDERR_LIMIT = 4_096;
const COMMAND_KILL_GRACE_MS = 300;
const COMMAND_CLOSE_GRACE_MS = 1_000;
const WORKSPACE_PREFLIGHT_TIMEOUT_MS = 10 * 60_000;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

type WorkerWorkspaceInventory = {
  manifestEntries: number;
  manifestPathBytes: number;
  transferPathBytes: number;
  manifestBytes: number;
  eligibleBytes: number;
};

class WorkerWorkspacePreflightError extends Error {
  readonly code = "invalid_state";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerWorkspacePreflightError";
  }
}

type WorkerWorkspaceInventoryEntry =
  | { path: string; type: "directory" }
  | { path: string; type: "file"; mode: number; size: number }
  | { path: string; type: "symlink"; target: string };

function workspaceInventoryError(message: string): WorkerWorkspacePreflightError {
  return new WorkerWorkspacePreflightError(message);
}

function assertWorkerWorkspaceInventoryValues(
  manifestEntries: number,
  manifestPathBytes: number,
  transferPathBytes: number,
  manifestBytes: number,
  eligibleBytes: number,
): void {
  if (manifestEntries > MAX_WORKSPACE_INVENTORY_ENTRIES) {
    throw workspaceInventoryError(
      `Cloud workspace inventory exceeds ${MAX_WORKSPACE_INVENTORY_ENTRIES} manifest entries; reduce eligible files or narrow .worktreeinclude`,
    );
  }
  if (manifestPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace manifest paths exceed the 64 MiB metadata limit; reduce eligible files or shorten their paths",
    );
  }
  if (transferPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace eligible paths exceed the 64 MiB metadata limit; reduce eligible files or narrow .worktreeinclude",
    );
  }
  if (manifestBytes > MAX_WORKSPACE_MANIFEST_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace manifest exceeds the 64 MiB limit; reduce eligible files or shorten their paths",
    );
  }
  if (eligibleBytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
    throw workspaceInventoryError(
      "Cloud workspace eligible content exceeds the 4 GiB limit; remove large eligible files or ignore them",
    );
  }
}

function inventoryEntryJson(entry: WorkerWorkspaceInventoryEntry): string {
  if (entry.type === "directory") {
    return JSON.stringify({ path: entry.path, type: entry.type, mode: 0o700 });
  }
  if (entry.type === "symlink") {
    return JSON.stringify({
      path: entry.path,
      type: entry.type,
      mode: 0o777,
      target: entry.target,
    });
  }
  return JSON.stringify({
    path: entry.path,
    type: entry.type,
    mode: gitFileMode(entry.mode),
    size: entry.size,
    sha256: "0".repeat(64),
  });
}

class WorkerWorkspaceInventoryBudget {
  readonly #paths = new Set<string>();
  readonly #emptyManifestBytes: number;
  #manifestPathBytes = 0;
  #transferPathBytes = 0;
  #manifestEntryBytes = 0;
  #eligibleBytes = 0;

  constructor(baseCommit: string | null) {
    this.#emptyManifestBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, baseCommit, entries: [] }),
    );
  }

  #assert(): void {
    const manifestEntries = this.#paths.size;
    assertWorkerWorkspaceInventoryValues(
      manifestEntries,
      this.#manifestPathBytes,
      this.#transferPathBytes,
      this.#emptyManifestBytes + this.#manifestEntryBytes + Math.max(0, manifestEntries - 1),
      this.#eligibleBytes,
    );
  }

  addTransferPath(entryPath: string): void {
    this.#transferPathBytes += Buffer.byteLength(entryPath) + 1;
    this.#assert();
  }

  addEntry(entry: WorkerWorkspaceInventoryEntry): void {
    if (this.#paths.has(entry.path)) {
      return;
    }
    this.#paths.add(entry.path);
    this.#manifestPathBytes += Buffer.byteLength(entry.path);
    this.#eligibleBytes +=
      entry.type === "file"
        ? entry.size
        : entry.type === "symlink"
          ? Buffer.byteLength(entry.target)
          : 0;
    this.#manifestEntryBytes += Buffer.byteLength(inventoryEntryJson(entry));
    this.#assert();
  }

  inventory(): WorkerWorkspaceInventory {
    const manifestEntries = this.#paths.size;
    return {
      manifestEntries,
      manifestPathBytes: this.#manifestPathBytes,
      transferPathBytes: this.#transferPathBytes,
      manifestBytes:
        this.#emptyManifestBytes + this.#manifestEntryBytes + Math.max(0, manifestEntries - 1),
      eligibleBytes: this.#eligibleBytes,
    };
  }
}

function validateGitRelativePath(file: string): string {
  if (
    !file ||
    path.posix.isAbsolute(file) ||
    path.posix.normalize(file) !== file ||
    file === ".." ||
    file.startsWith("../")
  ) {
    throw new Error("Worker workspace git file list contains an unsafe path");
  }
  return file;
}

async function* readBoundedGitPathCandidates(filePath: string): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  let candidateCount = 0;
  let pathBytes = 0;
  for await (const value of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    pathBytes += chunk.byteLength;
    if (pathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      throw workspaceInventoryError("Cloud workspace Git path metadata exceeds the 64 MiB limit");
    }
    const buffer = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let offset = 0;
    for (;;) {
      const separator = buffer.indexOf(0, offset);
      if (separator < 0) {
        break;
      }
      candidateCount += 1;
      if (candidateCount > MAX_WORKSPACE_GIT_CANDIDATES) {
        throw workspaceInventoryError(
          `Cloud workspace Git path candidates exceed the ${MAX_WORKSPACE_GIT_CANDIDATES} limit`,
        );
      }
      yield validateGitRelativePath(buffer.subarray(offset, separator).toString("utf8"));
      offset = separator + 1;
    }
    pending = Buffer.from(buffer.subarray(offset));
  }
  if (pending.length > 0) {
    throw new Error("Worker workspace git file list is not NUL terminated");
  }
}

export async function runLocalCommandToFile(params: {
  argv: string[];
  inputPath?: string;
  outputPath: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  const [command, ...args] = params.argv;
  if (!command) {
    throw new Error("Worker workspace command requires an executable");
  }
  const output = await fs.open(params.outputPath, "wx", 0o600);
  const input = params.inputPath ? await fs.open(params.inputPath, "r") : undefined;
  let stderr = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    if (params.signal.aborted) {
      throw new Error("Worker workspace file enumeration was aborted");
    }
    const child = spawn(command, args, {
      env: workerSshCommandOptions({ timeoutMs: params.timeoutMs }).baseEnv,
      stdio: [input?.fd ?? "ignore", output.fd, "pipe"],
      ...(process.platform !== "win32" ? { detached: true } : {}),
      windowsHide: true,
    });
    const childStderr = child.stderr;
    if (!childStderr) {
      throw new Error("Worker workspace command has no stderr pipe");
    }
    childStderr.setEncoding("utf8");
    childStderr.on("data", (chunk: string) => {
      stderr = sliceUtf16Safe(`${stderr}${chunk}`, -STDERR_LIMIT);
    });
    const result = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; error?: Error }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      let terminationStarted = false;
      const terminate = () => {
        if (settled || terminationStarted) {
          return;
        }
        terminationStarted = true;
        const pid = child.pid;
        if (typeof pid === "number" && pid > 0) {
          killProcessTree(pid, {
            graceMs: COMMAND_KILL_GRACE_MS,
            detached: process.platform !== "win32",
          });
        } else {
          child.kill("SIGTERM");
        }
        // A descendant can retain stderr even after the direct child exits. Bound
        // shutdown so placement replacement cannot wait forever on that pipe.
        terminationTimer = setTimeout(() => {
          if (typeof pid === "number" && pid > 0) {
            killProcessTree(pid, { force: true, detached: process.platform !== "win32" });
          } else {
            child.kill("SIGKILL");
          }
          childStderr.destroy();
          finish({ code: null });
        }, COMMAND_KILL_GRACE_MS + COMMAND_CLOSE_GRACE_MS);
        terminationTimer.unref?.();
      };
      child.once("error", (error) => finish({ code: null, error }));
      child.once("close", (code) => finish({ code }));
      abort = terminate;
      params.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(terminate, params.timeoutMs);
      timer.unref?.();
      if (params.signal.aborted) {
        terminate();
      }
    });
    if (result.error) {
      throw result.error;
    }
    if (params.signal.aborted) {
      throw new Error("Worker workspace file enumeration was aborted");
    }
    if (result.code !== 0) {
      throw new Error(
        stderr.trim()
          ? `Worker workspace file enumeration failed: ${stderr.trim()}`
          : "Worker workspace file enumeration failed",
      );
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(terminationTimer);
    if (abort) {
      params.signal.removeEventListener("abort", abort);
    }
    await output.close();
    await input?.close();
  }
}

async function writeEligibleGitFiles(params: {
  gitRoot: string;
  baseCommit: string | null;
  eligiblePath: string;
  ignoredPath: string;
  selectedPath: string;
  outputPath: string;
}): Promise<WorkerWorkspaceInventory> {
  const output = await fs.open(params.outputPath, "wx", 0o600);
  const canonicalRoot = await fs.realpath(params.gitRoot);
  const budget = new WorkerWorkspaceInventoryBudget(params.baseCommit);
  const transferredPaths = new Set<string>();
  let buffered: string[] = [];
  let bufferedBytes = 0;
  const flush = async () => {
    if (buffered.length === 0) {
      return;
    }
    await output.write(buffered.join(""));
    buffered = [];
    bufferedBytes = 0;
  };
  const appendIfTransferable = async (file: string) => {
    if (isDerivedWorkspacePath(file)) {
      return;
    }
    if (transferredPaths.has(file)) {
      return;
    }
    const absolute = path.join(canonicalRoot, file);
    const stats = await fs.lstat(absolute).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
        return undefined;
      }
      throw error;
    });
    // Gitlinks are directories. Keep their commit in the base repository without
    // recursively copying nested repositories or their credential-bearing metadata.
    if (!stats || (!stats.isFile() && !stats.isSymbolicLink())) {
      return;
    }
    transferredPaths.add(file);
    let symlinkTarget: string | undefined;
    if (stats.isSymbolicLink()) {
      // Mirrors the remote manifest guard, but before transfer: macOS openrsync
      // stat-fails escaping links with an opaque error instead of copying them.
      symlinkTarget = await fs.readlink(absolute);
      if (!isPortableRootContainedSymlink(canonicalRoot, file, symlinkTarget)) {
        throw workspaceInventoryError(
          `Cloud workspace symlink is not portable or escapes the sync root: ${sliceUtf16Safe(file, 0, 160)}`,
        );
      }
    }
    const segments = file.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      budget.addEntry({ path: segments.slice(0, index).join("/"), type: "directory" });
    }
    if (stats.isSymbolicLink()) {
      budget.addEntry({ path: file, type: "symlink", target: symlinkTarget! });
    } else {
      budget.addEntry({ path: file, type: "file", mode: stats.mode & 0o777, size: stats.size });
    }
    budget.addTransferPath(file);
    const record = `${file}\0`;
    buffered.push(record);
    bufferedBytes += Buffer.byteLength(record);
    if (bufferedBytes >= 64 * 1024) {
      await flush();
    }
  };
  try {
    for await (const file of readBoundedGitPathCandidates(params.eligiblePath)) {
      await appendIfTransferable(file);
    }
    const ignored = readBoundedGitPathCandidates(params.ignoredPath)[Symbol.asyncIterator]();
    const selected = readBoundedGitPathCandidates(params.selectedPath)[Symbol.asyncIterator]();
    let ignoredItem = await ignored.next();
    let selectedItem = await selected.next();
    while (!ignoredItem.done && !selectedItem.done) {
      const order = Buffer.compare(Buffer.from(ignoredItem.value), Buffer.from(selectedItem.value));
      if (order === 0) {
        await appendIfTransferable(ignoredItem.value);
        ignoredItem = await ignored.next();
        selectedItem = await selected.next();
      } else if (order < 0) {
        ignoredItem = await ignored.next();
      } else {
        selectedItem = await selected.next();
      }
    }
    while (!ignoredItem.done) {
      ignoredItem = await ignored.next();
    }
    while (!selectedItem.done) {
      selectedItem = await selected.next();
    }
    await flush();
    return budget.inventory();
  } finally {
    await output.close();
  }
}

async function createGitTransferListWithInventory(params: {
  gitRoot: string;
  baseCommit: string | null;
  temporaryDirectory: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<{ path: string; inventory: WorkerWorkspaceInventory }> {
  const eligiblePath = path.join(params.temporaryDirectory, "eligible");
  const ignoredPath = path.join(params.temporaryDirectory, "ignored");
  const selectedPath = path.join(params.temporaryDirectory, "selected");
  const outputPath = path.join(params.temporaryDirectory, "transfer-list");
  await fs.mkdir(params.temporaryDirectory, { mode: 0o700 });
  await runLocalCommandToFile({
    argv: [
      "git",
      "-C",
      params.gitRoot,
      "ls-files",
      "--full-name",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    outputPath: eligiblePath,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
  const worktreeIncludePath = path.join(params.gitRoot, ".worktreeinclude");
  const worktreeInclude = await fs.lstat(worktreeIncludePath).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  });
  if (worktreeInclude?.isFile()) {
    const [ignoredResult, selectedResult] = await Promise.allSettled([
      runLocalCommandToFile({
        argv: [
          "git",
          "-C",
          params.gitRoot,
          "ls-files",
          "--full-name",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
        ],
        outputPath: ignoredPath,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      }),
      runLocalCommandToFile({
        argv: [
          "git",
          "-C",
          params.gitRoot,
          "ls-files",
          "--full-name",
          "--others",
          "--ignored",
          `--exclude-from=${worktreeIncludePath}`,
          "-z",
        ],
        outputPath: selectedPath,
        signal: params.signal,
        timeoutMs: params.timeoutMs,
      }),
    ]);
    if (ignoredResult.status === "rejected") {
      throw ignoredResult.reason;
    }
    if (selectedResult.status === "rejected") {
      throw selectedResult.reason;
    }
  } else {
    await Promise.all([
      fs.writeFile(ignoredPath, "", { mode: 0o600 }),
      fs.writeFile(selectedPath, "", { mode: 0o600 }),
    ]);
  }
  const inventory = await writeEligibleGitFiles({
    gitRoot: params.gitRoot,
    baseCommit: params.baseCommit,
    eligiblePath,
    ignoredPath,
    selectedPath,
    outputPath,
  });
  return { path: outputPath, inventory };
}

export async function createGitTransferList(
  params: Parameters<typeof createGitTransferListWithInventory>[0],
): Promise<string> {
  return (await createGitTransferListWithInventory(params)).path;
}

async function readBoundedGitValue(filePath: string): Promise<string> {
  const value = await fs.readFile(filePath, "utf8");
  if (Buffer.byteLength(value) > 4_096) {
    throw new Error("Cloud workspace Git metadata is unexpectedly large");
  }
  return value.trim();
}

export async function preflightWorkerWorkspace(params: {
  localPath: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<WorkerWorkspaceInventory> {
  const timeoutMs = params.timeoutMs ?? WORKSPACE_PREFLIGHT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-worker-workspace-preflight-"),
  );
  try {
    const canonicalRoot = await fs.realpath(params.localPath);
    const gitRootPath = path.join(temporaryDirectory, "git-root");
    const baseCommitPath = path.join(temporaryDirectory, "base-commit");
    const metadataResults = await Promise.allSettled([
      runLocalCommandToFile({
        argv: ["git", "-C", canonicalRoot, "rev-parse", "--show-toplevel"],
        outputPath: gitRootPath,
        signal,
        timeoutMs,
      }),
      runLocalCommandToFile({
        argv: ["git", "-C", canonicalRoot, "rev-parse", "--verify", "HEAD"],
        outputPath: baseCommitPath,
        signal,
        timeoutMs,
      }),
    ]);
    for (const result of metadataResults) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    const [reportedRoot, baseCommit] = await Promise.all([
      readBoundedGitValue(gitRootPath),
      readBoundedGitValue(baseCommitPath),
    ]);
    if ((await fs.realpath(reportedRoot)) !== canonicalRoot) {
      throw workspaceInventoryError(
        "Cloud worker dispatch requires the canonical managed Git worktree root",
      );
    }
    if (!GIT_COMMIT_PATTERN.test(baseCommit)) {
      throw new Error("Cloud workspace Git baseline is not a commit id");
    }
    const transfer = await createGitTransferListWithInventory({
      gitRoot: canonicalRoot,
      baseCommit,
      temporaryDirectory: path.join(temporaryDirectory, "transfer"),
      signal,
      timeoutMs,
    });
    return transfer.inventory;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function filterExistingGitTransferList(params: {
  gitRoot: string;
  preparedListPath: string;
  outputPath: string;
}): Promise<string> {
  const output = await fs.open(params.outputPath, "wx", 0o600);
  try {
    for await (const file of readNulFile(params.preparedListPath)) {
      const stats = await fs.lstat(path.join(params.gitRoot, file)).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (stats?.isFile() || stats?.isSymbolicLink()) {
        await output.write(`${file}\0`);
      }
    }
  } finally {
    await output.close();
  }
  return params.outputPath;
}
