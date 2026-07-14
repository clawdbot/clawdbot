import { randomBytes, randomUUID, createHash } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveWorktreeBase } from "./base-ref.js";
import { lockState, lockWorktreeForProcess, unlockWorktree } from "./git-lock.js";
import {
  commandError,
  listGitWorktrees,
  pathExists,
  removeEmptyParents,
  requireGit,
  requireGitRaw,
  runGit,
  type GitResult,
} from "./git.js";
import {
  deleteRegistryWorktree,
  findRegistryWorktreeByPath,
  findLiveRegistryWorktreeByOwner,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  insertRegistryWorktree,
  listRegistryWorktrees,
  updateRegistryWorktree,
} from "./registry.js";
import {
  abortWorktreeRemoval,
  claimWorktreeRemoval,
  finalizeWorktreeRemoval,
  hasLiveWorktreeRunLease,
} from "./run-lease.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeBranch,
  ManagedWorktreeBranchesResult,
  ManagedWorktreeGcResult,
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "./types.js";

export const IDLE_GC_MS = 7 * 24 * 60 * 60 * 1000; // Idle worktrees remain restorable after automatic cleanup.
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // Snapshot refs expire with their registry affordance.
export const WORKTREE_GC_INTERVAL_MS = 60 * 60 * 1000;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Non-forced removal aborted because the safety snapshot failed. */
export class WorktreeSnapshotError extends Error {
  readonly snapshotError: string;
  constructor(snapshotError: string, options?: ErrorOptions) {
    super(`worktree snapshot failed; removal aborted: ${snapshotError}`, options);
    this.snapshotError = snapshotError;
  }
}
const SNAPSHOT_REF_PREFIX = "refs/openclaw/snapshots";
const log = createSubsystemLogger("agents/worktrees");

type ServiceOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export type WorktreeCleanupLimits = {
  maxCount?: number;
  maxTotalSizeBytes?: number;
};

type ManagedWorktreeGcParams = {
  isOwnerActive?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  limits?: WorktreeCleanupLimits;
};

/**
 * Maps `worktrees.cleanup` config into enforceable byte/count limits.
 * 0 and unset both mean "no limit", so gc callers can pass the result verbatim.
 */
export function resolveWorktreeCleanupLimits(config?: {
  cleanup?: { maxCount?: number; maxTotalSizeGb?: number };
}): WorktreeCleanupLimits {
  const maxCount = config?.cleanup?.maxCount;
  const maxTotalSizeGb = config?.cleanup?.maxTotalSizeGb;
  return {
    ...(typeof maxCount === "number" && maxCount > 0 ? { maxCount: Math.floor(maxCount) } : {}),
    ...(typeof maxTotalSizeGb === "number" && maxTotalSizeGb > 0
      ? { maxTotalSizeBytes: Math.round(maxTotalSizeGb * 1024 ** 3) }
      : {}),
  };
}

function resultMessage(result: GitResult): string {
  return (result.stderr || result.stdout).trim().split("\n").slice(-12).join("\n");
}

function validateName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("worktree name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

function generateName(): string {
  return `wt-${randomBytes(4).toString("hex")}`;
}

function recordOwnerMatches(
  record: ManagedWorktreeRecord,
  params: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): boolean {
  return (
    record.ownerKind === (params.ownerKind ?? "manual") &&
    (record.ownerId ?? undefined) === (params.ownerId ?? undefined)
  );
}

async function resolveRepository(repoRoot: string): Promise<{
  repoRoot: string;
  sourceRoot: string;
  commonDir: string;
  originUrl: string;
  fingerprint: string;
}> {
  const requested = await fs.realpath(repoRoot).catch(() => {
    throw new Error(`repository does not exist: ${repoRoot}`);
  });
  const rootResult = await runGit(requested, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) {
    throw new Error(`not a git checkout: ${repoRoot}`);
  }
  const sourceRoot = await fs.realpath(rootResult.stdout.trim());
  const commonRaw = await requireGit(sourceRoot, ["rev-parse", "--git-common-dir"]);
  const commonDir = await fs.realpath(
    path.isAbsolute(commonRaw) ? commonRaw : path.resolve(sourceRoot, commonRaw),
  );
  const primary = (await listGitWorktrees(sourceRoot))[0]?.path ?? sourceRoot;
  const canonicalRoot = await fs.realpath(primary);
  const origin = await runGit(canonicalRoot, ["config", "--get", "remote.origin.url"]);
  const originUrl = origin.code === 0 ? origin.stdout.trim() : "";
  const fingerprint = createHash("sha256")
    .update(`${commonDir}\n${originUrl}`)
    .digest("hex")
    .slice(0, 16);
  return { repoRoot: canonicalRoot, sourceRoot, commonDir, originUrl, fingerprint };
}

async function ensureNoSymlinkDirectory(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
  return true;
}

async function copyIncludedFiles(repoRoot: string, worktreePath: string): Promise<void> {
  const includePath = path.join(repoRoot, ".worktreeinclude");
  if (!(await pathExists(includePath))) {
    return;
  }
  const candidatesRaw = await requireGitRaw(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  const includedRaw = await requireGitRaw(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    `--exclude-from=${includePath}`,
    "-z",
  ]);
  const included = new Set(includedRaw.split("\0").filter(Boolean));
  for (const relativePath of candidatesRaw.split("\0").filter(Boolean)) {
    if (!included.has(relativePath) || path.isAbsolute(relativePath)) {
      continue;
    }
    const normalized = path.normalize(relativePath);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      continue;
    }
    if (
      !(await ensureNoSymlinkDirectory(repoRoot, normalized)) ||
      !(await ensureNoSymlinkDirectory(worktreePath, normalized))
    ) {
      continue;
    }
    const source = path.join(repoRoot, normalized);
    const destination = path.join(worktreePath, normalized);
    const sourceStat = await fs.lstat(source).catch(() => undefined);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    });
    await fs.chmod(destination, sourceStat.mode);
  }
}

async function cleanupFailedCreate(repoRoot: string, worktreePath: string, branch: string) {
  const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  const deletedBranch = await runGit(repoRoot, ["branch", "-D", branch]);
  await runGit(repoRoot, ["worktree", "prune"]);
  if (removed.code !== 0 || deletedBranch.code !== 0) {
    throw new Error(
      `failed to clean up worktree creation: ${resultMessage(removed) || resultMessage(deletedBranch)}`,
    );
  }
}

async function resetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed) {
    const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    if (removed.code !== 0) {
      throw commandError("git worktree remove", removed);
    }
  } else if (await pathExists(worktreePath)) {
    // A failed add can leave an unregistered directory; it is safe debris once git omits it.
    await fs.rm(worktreePath, { recursive: true, force: true });
  }
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code === 0) {
    await requireGit(repoRoot, ["branch", "-D", branch]);
  }
  await requireGit(repoRoot, ["worktree", "prune"]);
}

async function canResetFailedWorktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  failure: GitResult,
): Promise<boolean> {
  const message = resultMessage(failure);
  const createdBranch = message.includes(`Preparing worktree (new branch '${branch}')`);
  if (message.includes("unable to checkout working tree") || createdBranch) {
    return true;
  }
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed || (await pathExists(worktreePath))) {
    return false;
  }
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  return branchExists.code === 1;
}

async function runSetupScript(repoRoot: string, worktreePath: string): Promise<void> {
  const setupScript = path.join(repoRoot, ".openclaw", "worktree-setup.sh");
  const stat = await fs.stat(setupScript).catch(() => undefined);
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) {
    return;
  }
  const result = await runCommandWithTimeout([setupScript], {
    timeoutMs: 120_000,
    cwd: worktreePath,
    env: {
      OPENCLAW_SOURCE_TREE_PATH: repoRoot,
      OPENCLAW_WORKTREE_PATH: worktreePath,
    },
  });
  if (result.code !== 0) {
    throw new Error(
      `worktree setup failed${resultMessage(result) ? `:\n${resultMessage(result)}` : ""}`,
    );
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Sums file sizes without following symlinks, so a link cannot inflate or escape
 * the worktree. Only ENOENT is tolerated (cleanup races with removals); other
 * failures propagate so an unreadable tree is never measured as zero bytes.
 */
async function directorySizeBytes(root: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return 0;
    }
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      total += await directorySizeBytes(child);
    } else {
      try {
        total += (await fs.lstat(child)).size;
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }
  }
  return total;
}

async function snapshotWorktree(record: ManagedWorktreeRecord, reason: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worktree-index-"));
  const indexPath = path.join(tempDir, "index");
  const snapshotRef = `${SNAPSHOT_REF_PREFIX}/${record.id}`;
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "OpenClaw",
    GIT_AUTHOR_EMAIL: "openclaw@localhost",
    GIT_COMMITTER_NAME: "OpenClaw",
    GIT_COMMITTER_EMAIL: "openclaw@localhost",
  };
  try {
    await requireGit(record.path, ["read-tree", "HEAD"], { env });
    // Ignored files stay outside the repository object database; provisioning recreates them.
    await requireGit(record.path, ["add", "-A"], { env });
    const tree = await requireGit(record.path, ["write-tree"], { env });
    const treeEntries = await requireGit(record.path, ["ls-tree", "-r", tree]);
    // Gitlinks omit nested worktree files, so accepting one would violate the full-tree snapshot.
    if (treeEntries.split("\n").some((entry) => entry.startsWith("160000 "))) {
      throw new Error("nested git repositories cannot be snapshotted losslessly");
    }
    const parent = await requireGit(record.path, ["rev-parse", "HEAD"]);
    const commit = await requireGit(
      record.path,
      ["commit-tree", tree, "-p", parent, "-m", `OpenClaw worktree snapshot: ${reason}`],
      { env },
    );
    await requireGit(record.repoRoot, ["update-ref", snapshotRef, commit]);
    return snapshotRef;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export class ManagedWorktreeService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: ServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async create(params: CreateManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    const repository = await resolveRepository(params.repoRoot);
    const name = validateName(params.name ?? generateName());
    const root = path.join(resolveStateDir(this.env), "worktrees", repository.fingerprint);
    const worktreePath = path.join(root, name);
    const existing = findRegistryWorktreeByPath(this.env, worktreePath);
    // Name reuse only ever adopts the caller's own record. Without this guard a
    // caller-chosen name could bind a new owner to another session's or a
    // manual checkout and run inside it.
    if (existing?.name === name && !existing.removedAt && !recordOwnerMatches(existing, params)) {
      throw new Error(
        `worktree name is already in use by ${existing.ownerKind}${existing.ownerId ? ` ${existing.ownerId}` : ""}: ${name}`,
      );
    }
    if (existing?.name === name && existing.removedAt === undefined) {
      if (await pathExists(existing.path)) {
        return existing;
      }
      updateRegistryWorktree(this.env, existing.id, { removedAt: this.now() });
    }
    if (existing?.name === name && existing.removedAt !== undefined && existing.snapshotRef) {
      if (!recordOwnerMatches(existing, params)) {
        throw new Error(
          `worktree name is already in use by ${existing.ownerKind}${existing.ownerId ? ` ${existing.ownerId}` : ""}: ${name}`,
        );
      }
      return await this.restore({ id: existing.id });
    }
    const branch = `openclaw/${name}`;
    const branchExists = await runGit(repository.repoRoot, [
      "show-ref",
      "--quiet",
      "--verify",
      `refs/heads/${branch}`,
    ]);
    if (branchExists.code === 0) {
      throw new Error(`branch already exists: ${branch}`);
    }
    if (branchExists.code !== 1) {
      throw commandError("git show-ref --verify", branchExists);
    }
    const base = await resolveWorktreeBase(repository.repoRoot, params.baseRef);
    await fs.mkdir(root, { recursive: true });
    let gitBase = base.gitOperand;
    let recordBase = base.recordRef;
    let added = await runGit(repository.repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      "--",
      worktreePath,
      gitBase,
    ]);
    if (added.code !== 0 && base.remote) {
      if (!(await canResetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, added))) {
        throw commandError("git worktree add", added);
      }
      await resetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch);
      gitBase = "HEAD";
      recordBase = "HEAD";
      added = await runGit(repository.repoRoot, [
        "worktree",
        "add",
        "-b",
        branch,
        "--",
        worktreePath,
        gitBase,
      ]);
    }
    if (added.code !== 0) {
      throw commandError("git worktree add", added);
    }
    try {
      await copyIncludedFiles(repository.sourceRoot, worktreePath);
      if (params.runSetupScript !== false) {
        await runSetupScript(repository.sourceRoot, worktreePath);
      }
    } catch (error) {
      try {
        await cleanupFailedCreate(repository.repoRoot, worktreePath, branch);
      } catch (cleanupError) {
        throw new Error(`${String(error)}\n${String(cleanupError)}`, { cause: cleanupError });
      }
      throw error;
    }
    const createdAt = this.now();
    const record: ManagedWorktreeRecord = {
      id: randomUUID(),
      name,
      repoFingerprint: repository.fingerprint,
      repoRoot: repository.repoRoot,
      path: worktreePath,
      branch,
      baseRef: recordBase,
      ownerKind: params.ownerKind ?? "manual",
      ...(params.ownerId ? { ownerId: params.ownerId } : {}),
      createdAt,
      lastActiveAt: createdAt,
    };
    insertRegistryWorktree(this.env, record);
    return record;
  }

  async list(): Promise<ManagedWorktreeRecord[]> {
    const records = listRegistryWorktrees(this.env);
    for (const record of records) {
      if (record.removedAt === undefined && !(await pathExists(record.path))) {
        const removedAt = this.now();
        updateRegistryWorktree(this.env, record.id, { removedAt });
        record.removedAt = removedAt;
      }
    }
    return records.filter((record) => record.removedAt === undefined || record.snapshotRef);
  }

  findLiveByOwner(
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
  ): ManagedWorktreeRecord | undefined {
    return findLiveRegistryWorktreeByOwner(this.env, ownerKind, ownerId);
  }

  /** Resolves the canonical registry root and the caller's own checkout root. */
  async resolveRepositoryPaths(
    repoRoot: string,
  ): Promise<{ canonicalRoot: string; sourceRoot: string }> {
    const resolved = await resolveRepository(repoRoot);
    return { canonicalRoot: resolved.repoRoot, sourceRoot: resolved.sourceRoot };
  }

  /**
   * Lists selectable base refs for a repository without touching the network.
   * Base-ref pickers must stay snappy; resolveWorktreeBase() still fetches on create
   * when no explicit ref is chosen.
   */
  async listRepositoryBranches(repoRoot: string): Promise<ManagedWorktreeBranchesResult> {
    const repository = await resolveRepository(repoRoot);
    // Keyed by short branch name; the stored name is always a resolvable base
    // ref, so remote-only branches keep their remote-qualified form
    // (origin/feature-a) instead of a bare name git cannot resolve.
    const branches = new Map<string, ManagedWorktreeBranch>();
    const remoteRaw = await runGit(repository.repoRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes",
    ]);
    if (remoteRaw.code === 0) {
      for (const refname of remoteRaw.stdout.split("\n")) {
        const trimmed = refname.trim();
        if (!trimmed.startsWith("refs/remotes/")) {
          continue;
        }
        const withoutPrefix = trimmed.slice("refs/remotes/".length);
        const slash = withoutPrefix.indexOf("/");
        if (slash <= 0) {
          continue;
        }
        const shortName = withoutPrefix.slice(slash + 1);
        // remote HEAD symrefs are pointers, not selectable branches.
        if (!shortName || shortName === "HEAD") {
          continue;
        }
        branches.set(shortName, { name: withoutPrefix, kind: "remote" });
      }
    }
    const localRaw = await runGit(repository.repoRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    if (localRaw.code === 0) {
      for (const line of localRaw.stdout.split("\n")) {
        const name = line.trim();
        if (name) {
          branches.set(name, { name, kind: "local" });
        }
      }
    }
    const remoteHead = await runGit(repository.repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const defaultShort =
      remoteHead.code === 0
        ? remoteHead.stdout.trim().replace(/^origin\//, "") || undefined
        : undefined;
    const head = await runGit(repository.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const headBranch = head.code === 0 ? head.stdout.trim() || undefined : undefined;
    const defaultBranch = defaultShort
      ? (branches.get(defaultShort)?.name ?? defaultShort)
      : undefined;
    // Deterministic picker ordering: default base first, current checkout next, rest alphabetical.
    const rank = (shortName: string) =>
      shortName === defaultShort ? 0 : shortName === headBranch ? 1 : 2;
    const sorted = [...branches.entries()]
      .toSorted(
        ([aShort, a], [bShort, b]) => rank(aShort) - rank(bShort) || a.name.localeCompare(b.name),
      )
      .map(([, branch]) => branch);
    return {
      branches: sorted,
      ...(defaultBranch ? { defaultBranch } : {}),
      ...(headBranch ? { headBranch } : {}),
    };
  }

  async acquire(id: string): Promise<ManagedWorktreeRecord> {
    const record = this.requireLiveRecord(id);
    await lockWorktreeForProcess(record);
    const lastActiveAt = this.now();
    updateRegistryWorktree(this.env, id, { lastActiveAt });
    return { ...record, lastActiveAt };
  }

  async release(id: string): Promise<void> {
    const record = getRegistryWorktree(this.env, id);
    if (!record || record.removedAt !== undefined || !(await pathExists(record.path))) {
      return;
    }
    const state = await lockState(record);
    if (state.kind === "live" && state.pid !== process.pid) {
      return;
    }
    if (state.kind === "foreign") {
      return;
    }
    if (state.kind !== "none") {
      await unlockWorktree(record);
    }
  }

  async remove(params: {
    id: string;
    reason: string;
    force?: boolean;
    claimToken?: string;
  }): Promise<RemoveManagedWorktreeResult> {
    const record = this.requireLiveRecord(params.id);
    const force = params.force ?? false;
    // Claim removal before any cleanliness or snapshot work so a live run lease
    // rejects it and an admitted run cannot start once the claim is held. The
    // opaque token makes the claim exclusive against competing removers; a caller
    // that already claimed (removeIfLossless) passes its token to keep one claim.
    const claimToken = params.claimToken ?? randomUUID();
    claimWorktreeRemoval(this.env, { worktreeId: record.id, token: claimToken, force });
    try {
      const state = await lockState(record);
      if ((state.kind === "live" || state.kind === "foreign") && !force) {
        throw new Error(
          state.kind === "live"
            ? `worktree is locked by live OpenClaw pid ${state.pid}`
            : `worktree has a foreign lock${state.reason ? `: ${state.reason}` : ""}`,
        );
      }
      if (state.kind !== "none") {
        await requireGit(record.repoRoot, ["worktree", "unlock", record.path]);
      }
      let snapshotRef = record.snapshotRef;
      let snapshotError: string | undefined;
      try {
        snapshotRef = await snapshotWorktree(record, params.reason);
        updateRegistryWorktree(this.env, record.id, { snapshotRef });
      } catch (error) {
        snapshotError = error instanceof Error ? error.message : String(error);
        if (!force) {
          throw new WorktreeSnapshotError(snapshotError, { cause: error });
        }
      }
      const removed = await runGit(record.repoRoot, ["worktree", "remove", "--force", record.path]);
      if (removed.code !== 0) {
        throw commandError("git worktree remove", removed);
      }
      const branchDelete = await runGit(record.repoRoot, ["branch", "-D", record.branch]);
      if (branchDelete.code !== 0) {
        throw commandError("git branch -D", branchDelete);
      }
      await requireGit(record.repoRoot, ["worktree", "prune"]);
      await removeEmptyParents(
        path.dirname(record.path),
        path.join(resolveStateDir(this.env), "worktrees"),
      );
      const removedAt = this.now();
      updateRegistryWorktree(this.env, record.id, { removedAt, snapshotRef });
      finalizeWorktreeRemoval(this.env, record.id);
      return {
        removed: true,
        ...(snapshotRef ? { snapshotRef } : {}),
        ...(snapshotError ? { snapshotError } : {}),
      };
    } catch (error) {
      abortWorktreeRemoval(this.env, record.id, claimToken);
      throw error;
    }
  }

  async restore(params: { id: string }): Promise<ManagedWorktreeRecord> {
    const record = getRegistryWorktree(this.env, params.id);
    if (!record?.snapshotRef || record.removedAt === undefined) {
      throw new Error(`worktree ${params.id} is not restorable`);
    }
    if (!(await pathExists(record.repoRoot))) {
      throw new Error(`source repository no longer exists: ${record.repoRoot}`);
    }
    const parent = await requireGit(record.repoRoot, ["rev-parse", `${record.snapshotRef}^`]);
    await fs.mkdir(path.dirname(record.path), { recursive: true });
    await requireGit(record.repoRoot, [
      "worktree",
      "add",
      "--detach",
      record.path,
      record.snapshotRef,
    ]);
    let branchCreated = false;
    try {
      // Branch history stays at the original commit; the snapshot is restored as working state.
      await requireGit(record.repoRoot, ["branch", record.branch, parent]);
      branchCreated = true;
      await requireGit(record.path, ["symbolic-ref", "HEAD", `refs/heads/${record.branch}`]);
      await requireGit(record.path, ["reset"]);
      await copyIncludedFiles(record.repoRoot, record.path);
    } catch (error) {
      const removed = await runGit(record.repoRoot, ["worktree", "remove", "--force", record.path]);
      const branchDeleted = branchCreated
        ? await runGit(record.repoRoot, ["branch", "-D", record.branch])
        : undefined;
      if (removed.code !== 0 || (branchDeleted && branchDeleted.code !== 0)) {
        throw new Error(
          `${String(error)}\nrestore cleanup failed: ${resultMessage(removed) || (branchDeleted ? resultMessage(branchDeleted) : "")}`,
          { cause: error },
        );
      }
      throw error;
    }
    const lastActiveAt = this.now();
    updateRegistryWorktree(this.env, params.id, { removedAt: undefined, lastActiveAt });
    // Clear any lease rows or removal marker stranded by a crash between git removal
    // and finalize so the restored worktree admits runs again.
    finalizeWorktreeRemoval(this.env, params.id);
    const restored = { ...record, lastActiveAt };
    delete restored.removedAt;
    return restored;
  }

  async removeIfLossless(id: string): Promise<boolean> {
    const record = this.requireLiveRecord(id);
    const claimToken = randomUUID();
    try {
      claimWorktreeRemoval(this.env, { worktreeId: id, token: claimToken, force: false });
    } catch {
      // A live run lease or a competing remover holds the worktree; a lossless
      // auto-cleanup must not race it.
      return false;
    }
    try {
      const status = await requireGit(record.path, ["status", "--porcelain"]);
      const unpushed = await requireGit(record.path, [
        "log",
        "HEAD",
        "--not",
        "--remotes",
        "--oneline",
      ]);
      if (status || unpushed) {
        abortWorktreeRemoval(this.env, id, claimToken);
        return false;
      }
    } catch (error) {
      abortWorktreeRemoval(this.env, id, claimToken);
      throw error;
    }
    await this.release(id);
    await this.remove({ id, reason: "run-end", claimToken });
    return true;
  }

  async removeIfLosslessByPath(worktreePath: string): Promise<boolean> {
    const record = findLiveRegistryWorktreeByPath(this.env, worktreePath);
    if (!record) {
      return false;
    }
    return await this.removeIfLossless(record.id);
  }

  async releaseByPath(worktreePath: string): Promise<void> {
    const record = findLiveRegistryWorktreeByPath(this.env, worktreePath);
    if (record) {
      await this.release(record.id);
    }
  }

  async gc(params: ManagedWorktreeGcParams = {}): Promise<ManagedWorktreeGcResult> {
    const now = this.now();
    const removed: string[] = [];
    const records = listRegistryWorktrees(this.env);
    for (const record of records) {
      try {
        if (record.removedAt === undefined && !(await pathExists(record.path))) {
          updateRegistryWorktree(this.env, record.id, { removedAt: now });
          record.removedAt = now;
        }
        // Manual worktrees remain until explicit removal; only run-owned worktrees expire.
        const expiresWhenIdle = record.ownerKind === "workboard" || record.ownerKind === "session";
        if (
          record.removedAt === undefined &&
          expiresWhenIdle &&
          now - record.lastActiveAt > IDLE_GC_MS
        ) {
          if (await this.isProtectedFromAutoRemoval(record, params.isOwnerActive)) {
            continue;
          }
          await this.remove({ id: record.id, reason: "idle-gc" });
          removed.push(record.id);
        }
      } catch (error) {
        log.warn(`idle cleanup failed for ${record.id}: ${String(error)}`);
      }
    }
    removed.push(...(await this.enforceCleanupLimits(params)));
    const orphansDeleted = await this.reconcileOrphans(records);
    let snapshotsPruned = 0;
    for (const record of listRegistryWorktrees(this.env)) {
      if (record.removedAt === undefined || now - record.removedAt <= SNAPSHOT_RETENTION_MS) {
        continue;
      }
      try {
        if (record.snapshotRef && (await pathExists(record.repoRoot))) {
          await requireGit(record.repoRoot, ["update-ref", "-d", record.snapshotRef]);
        }
        deleteRegistryWorktree(this.env, record.id);
        snapshotsPruned += 1;
      } catch (error) {
        log.warn(`snapshot retention failed for ${record.id}: ${String(error)}`);
      }
    }
    return { removed, orphansDeleted, snapshotsPruned };
  }

  /**
   * Shared auto-removal guard for idle and limit cleanup: active owners, live run
   * leases, and live/foreign git locks all veto removal; a dead lock is cleared.
   */
  private async isProtectedFromAutoRemoval(
    record: ManagedWorktreeRecord,
    isOwnerActive?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean,
  ): Promise<boolean> {
    if (
      record.ownerId !== undefined &&
      isOwnerActive?.(record.ownerKind, record.ownerId) === true
    ) {
      return true;
    }
    if (hasLiveWorktreeRunLease(this.env, record.id)) {
      return true;
    }
    const state = await lockState(record);
    if (state.kind === "live" || state.kind === "foreign") {
      return true;
    }
    if (state.kind === "dead") {
      await requireGit(record.repoRoot, ["worktree", "unlock", record.path]);
    }
    return false;
  }

  /**
   * Enforces configured count/size retention across all live managed worktrees.
   * Manual worktrees count toward the totals but are never limit-evicted, so a
   * limit can stay exceeded when only protected worktrees remain.
   */
  private async enforceCleanupLimits(params: ManagedWorktreeGcParams): Promise<string[]> {
    const limits = params.limits ?? {};
    if (limits.maxCount === undefined && limits.maxTotalSizeBytes === undefined) {
      return [];
    }
    const live = listRegistryWorktrees(this.env).filter((record) => record.removedAt === undefined);
    const sizes = new Map<string, number>();
    let totalBytes = 0;
    if (limits.maxTotalSizeBytes !== undefined) {
      for (const record of live) {
        try {
          const bytes = await directorySizeBytes(record.path);
          sizes.set(record.id, bytes);
          totalBytes += bytes;
        } catch (error) {
          // Unmeasurable trees stay out of the size total, making it a lower
          // bound: measured worktrees stay capped while no worktree is ever
          // evicted off a bogus zero-byte reading. Aborting enforcement here
          // instead would let one unreadable directory disable the whole cap;
          // the count limit still bounds unmeasurable worktrees.
          log.warn(`worktree size measurement failed for ${record.id}: ${String(error)}`);
        }
      }
    }
    let liveCount = live.length;
    const overLimit = () =>
      (limits.maxCount !== undefined && liveCount > limits.maxCount) ||
      (limits.maxTotalSizeBytes !== undefined && totalBytes > limits.maxTotalSizeBytes);
    if (!overLimit()) {
      return [];
    }
    // Any concurrent removal (manual delete, run-end cleanup, competing gc)
    // must shrink the accounted pressure before the next destructive step, so
    // totals are recomputed from the registry per iteration. Sizes reuse the
    // up-front measurements; worktrees created after them are too fresh to be
    // eviction candidates in this pass.
    const refreshTotals = () => {
      const liveIds = new Set(
        listRegistryWorktrees(this.env)
          .filter((record) => record.removedAt === undefined)
          .map((record) => record.id),
      );
      liveCount = liveIds.size;
      if (limits.maxTotalSizeBytes !== undefined) {
        totalBytes = 0;
        for (const [id, bytes] of sizes) {
          if (liveIds.has(id)) {
            totalBytes += bytes;
          }
        }
      }
      return liveIds;
    };
    const removed: string[] = [];
    const candidates = live
      .filter((record) => record.ownerKind === "workboard" || record.ownerKind === "session")
      .toSorted((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const record of candidates) {
      const liveIds = refreshTotals();
      if (!overLimit()) {
        break;
      }
      if (!liveIds.has(record.id)) {
        continue;
      }
      try {
        if (await this.isProtectedFromAutoRemoval(record, params.isOwnerActive)) {
          continue;
        }
        await this.remove({ id: record.id, reason: "limit-gc" });
      } catch (error) {
        log.warn(`cleanup limit removal failed for ${record.id}: ${String(error)}`);
        continue;
      }
      removed.push(record.id);
    }
    refreshTotals();
    if (overLimit()) {
      log.warn(
        `worktree cleanup limits still exceeded after evicting ${removed.length}; remaining worktrees are protected or manual`,
      );
    }
    return removed;
  }

  private requireLiveRecord(id: string): ManagedWorktreeRecord {
    const record = getRegistryWorktree(this.env, id);
    if (!record || record.removedAt !== undefined) {
      throw new Error(`unknown active worktree: ${id}`);
    }
    return record;
  }

  private async reconcileOrphans(records: ManagedWorktreeRecord[]): Promise<number> {
    const managedPaths = new Set(records.map((record) => path.resolve(record.path)));
    const worktreesRoot = path.join(resolveStateDir(this.env), "worktrees");
    const fingerprints = await fs.readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
    let deleted = 0;
    for (const fingerprint of fingerprints) {
      if (!fingerprint.isDirectory()) {
        continue;
      }
      const fingerprintPath = path.join(worktreesRoot, fingerprint.name);
      const names = await fs.readdir(fingerprintPath, { withFileTypes: true }).catch(() => []);
      for (const name of names) {
        if (!name.isDirectory()) {
          continue;
        }
        const candidate = path.join(fingerprintPath, name.name);
        if (managedPaths.has(path.resolve(candidate))) {
          continue;
        }
        const repository = await resolveRepository(candidate).catch(() => undefined);
        if (repository) {
          const listed = await listGitWorktrees(repository.repoRoot).catch(() => []);
          if (listed.some((entry) => path.resolve(entry.path) === path.resolve(candidate))) {
            continue;
          }
        }
        await fs.rm(candidate, { recursive: true, force: true });
        deleted += 1;
      }
      await fs.rmdir(fingerprintPath).catch(() => undefined);
    }
    return deleted;
  }
}

export const managedWorktrees = new ManagedWorktreeService();

export type {
  CreateManagedWorktreeParams,
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "./types.js";
