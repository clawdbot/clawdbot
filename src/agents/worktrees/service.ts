import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveStateDir } from "../../config/paths.js";
import { isMissingPathError, formatErrorMessage } from "../../infra/errors.js";
import { root as fsRoot } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createStagedInputPathMatcher,
  STAGED_INPUT_GIT_PATHSPEC,
} from "../../media/staged-inputs.js";
import { createCommandError } from "../../process/command-error.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { createCrustaceanSlug } from "../session-slug.js";
import { resolveWorktreeBase } from "./base-ref.js";
import {
  directorySizeBytes,
  estimateWorktreeGitBytes,
  requireWorktreeDiskSpace,
  WORKTREE_SETUP_HEADROOM_BYTES,
} from "./capacity.js";
import { lockState, lockWorktreeForProcess, unlockWorktree } from "./git-lock.js";
import {
  commandError,
  insideGitCheckout,
  listGitWorktrees,
  worktreePathExists,
  removeEmptyParents,
  requireGit,
  requireGitBuffer,
  runGit,
  type GitResult,
} from "./git.js";
import { worktreeOwnerMatches } from "./owner.js";
import {
  hasUnsnapshotableProvisionedFiles,
  estimateProvisionedFileBytes,
  provisionIncludedFiles,
  restoreProvisionedFiles,
  snapshotProvisionedFiles,
  SNAPSHOT_CHUNK_BYTES,
} from "./provisioned-files.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  deleteRegistryWorktree,
  findRegistryWorktreeByPath,
  findLiveRegistryWorktreeByOwner,
  findLiveRegistryWorktreeByPath,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  insertRegistryWorktree,
  listRegistryWorktrees,
  updateRegistryWorktree,
  WorktreeRemovalContentionError,
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
  ManagedWorktreeRunEndCleanup,
  ManagedWorktreeRunEndCleanupOutcome,
  RemoveManagedWorktreeResult,
} from "./types.js";

export const IDLE_GC_MS = 7 * 24 * 60 * 60 * 1000; // Idle worktrees remain restorable after automatic cleanup.
export const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // Snapshot refs expire with their registry affordance.
export const WORKTREE_GC_INTERVAL_MS = 60 * 60 * 1000;

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKTREE_CREATE_LEASE_SCOPE = "core:managed-worktrees:create";
const WORKTREE_CREATE_LEASE_MS = 60_000;
const WORKTREE_CREATE_LEASE_WAIT_MS = 5 * 60_000;
// Materializing a checkout gets extra time without extending other Git commands or setup.
const WORKTREE_CHECKOUT_TIMEOUT_MS = 300_000;

/** Removal aborted because snapshot loss was not permitted. */
export class WorktreeSnapshotError extends Error {
  readonly snapshotError: string;
  constructor(snapshotError: string, options?: ErrorOptions) {
    super(`worktree snapshot failed; removal aborted: ${snapshotError}`, options);
    this.snapshotError = snapshotError;
  }
}

export type WorktreeRemovalFailureReason =
  | "busy"
  | "foreign-lock"
  | "snapshot-failed"
  | "cleanup-failed";

export class WorktreeRemovalLockError extends Error {
  constructor(
    readonly kind: "busy" | "foreign-lock",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeRemovalLockError";
  }
}

export function classifyWorktreeRemovalError(error: unknown): WorktreeRemovalFailureReason {
  if (error instanceof WorktreeRemovalContentionError) {
    return "busy";
  }
  if (error instanceof WorktreeRemovalLockError) {
    return error.kind;
  }
  if (error instanceof WorktreeSnapshotError) {
    return "snapshot-failed";
  }
  return "cleanup-failed";
}

export class WorktreeRepositoryError extends Error {}
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
  shouldProtectOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  shouldRemoveOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean;
  limits?: WorktreeCleanupLimits;
};

type WorktreeMutationGuard = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard">;
type RemoveWorktreeParams = WorktreeMutationGuard & {
  id: string;
  reason: string;
  allowSnapshotLoss?: boolean;
  claimToken?: string;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
};
const MAX_WORKTREES = 30;

/** A bounded default; manual and actively used worktrees remain protected. */
export function resolveWorktreeCleanupLimits(): WorktreeCleanupLimits {
  return { maxCount: MAX_WORKTREES };
}

function validateName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("worktree name must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return name;
}

async function nameIsUnavailable(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  root: string,
  name: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): Promise<boolean> {
  const worktreePath = path.join(root, name);
  const registered = findRegistryWorktreeByPath(env, worktreePath);
  if (
    owner.ownerId &&
    registered &&
    registered.removedAt === undefined &&
    worktreeOwnerMatches(registered, owner)
  ) {
    // Let createForRepository reuse the caller's live checkout; a collision here
    // could mint a second checkout for one owner. Removed records stay collisions:
    // restore is explicit-name/id only, so a generated name (title slug or random
    // crustacean) must never silently resurrect a retired checkout.
    return false;
  }
  if (registered || (await worktreePathExists(worktreePath))) {
    return true;
  }
  const branch = `openclaw/${name}`;
  const branchExists = await runGit(repoRoot, [
    "show-ref",
    "--quiet",
    "--verify",
    `refs/heads/${branch}`,
  ]);
  if (branchExists.code === 0) {
    return true;
  }
  if (branchExists.code !== 1) {
    throw commandError("git show-ref --verify", branchExists);
  }
  return (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
}

function appendNameOrdinal(name: string, ordinal: number): string {
  const suffix = `-${ordinal}`;
  return `${name.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}

async function generateName(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  root: string,
  owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  suggestedName: string,
): Promise<string> {
  validateName(suggestedName);
  for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
    const candidate = ordinal === 1 ? suggestedName : appendNameOrdinal(suggestedName, ordinal);
    if (!(await nameIsUnavailable(env, repoRoot, root, candidate, owner))) {
      return candidate;
    }
  }
  throw new Error(`no available worktree name for ${suggestedName}`);
}

type ResolvedRepository = {
  repoRoot: string;
  sourceRoot: string;
  commonDir: string;
  originUrl: string;
  fingerprint: string;
};

async function resolveRepositoryFromRealPath(
  requested: string,
  requestedLabel: string,
): Promise<ResolvedRepository> {
  const rootResult = await runGit(requested, ["rev-parse", "--show-toplevel"]);
  if (rootResult.code !== 0) {
    if (insideGitCheckout(requested)) {
      throw new Error(
        `Git metadata is unavailable for ${requested}; checkout preserved. Restore the original repository metadata, then use git worktree repair from that repository. Do not recreate its index or delete the checkout to bypass recovery.`,
      );
    }
    throw new WorktreeRepositoryError(`not a git checkout: ${requestedLabel}`);
  }
  const sourceRoot = await fs.realpath(rootResult.stdout.trim());
  const headResult = await runGit(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headResult.code !== 0) {
    throw new WorktreeRepositoryError(`git checkout has no commits: ${requestedLabel}`);
  }
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

async function resolveRepository(repoRoot: string): Promise<ResolvedRepository> {
  const requested = await fs.realpath(repoRoot).catch(() => {
    throw new Error(`repository does not exist: ${repoRoot}`);
  });
  return await resolveRepositoryFromRealPath(requested, repoRoot);
}

async function canonicalPathKey(target: string): Promise<string> {
  const canonical = await fs.realpath(target);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

async function shouldPreserveOrphanCandidate(
  target: string,
  managedPaths: ReadonlySet<string>,
): Promise<boolean> {
  const targetKey = await canonicalPathKey(target);
  if (managedPaths.has(targetKey)) {
    return true;
  }
  // Any top-level .git entry marks uncertain user work; broken indirection only
  // strengthens preservation and must never abort global orphan cleanup.
  return await worktreePathExists(path.join(target, ".git"));
}

async function cleanupFailedCreate(repoRoot: string, worktreePath: string, branch: string) {
  const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  const deletedBranch = await runGit(repoRoot, ["branch", "-D", branch]);
  await runGit(repoRoot, ["worktree", "prune"]);
  if (removed.code !== 0 || deletedBranch.code !== 0) {
    const failure =
      removed.code !== 0
        ? commandError("git worktree remove", removed)
        : commandError("git branch -D", deletedBranch);
    throw new Error(`failed to clean up worktree creation: ${failure.message}`);
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
  } else if (await worktreePathExists(worktreePath)) {
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
  // Keep retry evidence unchanged: diagnostic rendering/truncation must never
  // grant cleanup or retry authority.
  const message = (failure.stderr || failure.stdout).trim().split("\n").slice(-12).join("\n");
  const createdBranch = message.includes(`Preparing worktree (new branch '${branch}')`);
  if (message.includes("unable to checkout working tree") || createdBranch) {
    return true;
  }
  const listed = (await listGitWorktrees(repoRoot)).some(
    (entry) => path.resolve(entry.path) === path.resolve(worktreePath),
  );
  if (listed || (await worktreePathExists(worktreePath))) {
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

async function runSetupScript(
  repoRoot: string,
  worktreePath: string,
  params: CreateManagedWorktreeParams,
): Promise<void> {
  const setupScript = path.join(repoRoot, ".openclaw", "worktree-setup.sh");
  const stat = await fs.stat(setupScript).catch(() => undefined);
  if (!stat?.isFile() || (stat.mode & 0o111) === 0) {
    return;
  }
  const timeoutMs = 120_000;
  params.onProgress?.("setup");
  // Checkout may outlive its caller. Revalidate before starting repository code,
  // then retain process ownership through cancellation and rollback.
  params.signal?.throwIfAborted();
  params.commitGuard?.();
  const result = await runCommandWithTimeout([setupScript], {
    timeoutMs,
    cwd: worktreePath,
    signal: params.signal,
    killProcessTree: true,
    env: {
      OPENCLAW_SOURCE_TREE_PATH: repoRoot,
      OPENCLAW_WORKTREE_PATH: worktreePath,
    },
  });
  params.signal?.throwIfAborted();
  if (result.code !== 0) {
    throw createCommandError("worktree setup", result, { timeoutMs });
  }
}

function splitNullBuffer(input: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== 0) {
      continue;
    }
    if (index > start) {
      fields.push(input.subarray(start, index));
    }
    start = index + 1;
  }
  if (start < input.length) {
    fields.push(input.subarray(start));
  }
  return fields;
}

function gitPathKey(gitPath: Buffer): string {
  return gitPath.toString("hex");
}

function checkoutPathFromGitBytes(checkoutRoot: string, gitPath: Buffer): string | Buffer {
  if (process.platform === "win32") {
    return path.join(checkoutRoot, ...gitPath.toString("utf8").split("/"));
  }
  return Buffer.concat([Buffer.from(checkoutRoot), Buffer.from(path.sep), gitPath]);
}

async function rawPathExists(target: string | Buffer): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function containsSnapshotGitMarker(
  checkoutRoot: string,
  snapshotPaths?: Iterable<Buffer>,
): Promise<boolean> {
  const visiblePaths = snapshotPaths ? [...snapshotPaths] : [];
  if (!snapshotPaths) {
    const indexEntries = splitNullBuffer(
      await requireGitBuffer(checkoutRoot, ["ls-files", "--stage", "-z"]),
    );
    if (indexEntries.some((entry) => entry.subarray(0, 7).toString() === "160000 ")) {
      return true;
    }
    const visibleGitPaths = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
    visiblePaths.push(...splitNullBuffer(await requireGitBuffer(checkoutRoot, visibleGitPaths)));
  }
  const checked = new Set<string>();
  const ignoredPaths = splitNullBuffer(
    await requireGitBuffer(checkoutRoot, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]),
  );
  for (const gitPath of [...visiblePaths, ...ignoredPaths]) {
    for (let end = gitPath.indexOf(47); end !== -1; end = gitPath.indexOf(47, end + 1)) {
      const directory = gitPath.subarray(0, end);
      const key = gitPathKey(directory);
      if (checked.has(key)) {
        continue;
      }
      checked.add(key);
      const marker = Buffer.concat([directory, Buffer.from("/.git")]);
      if (await rawPathExists(checkoutPathFromGitBytes(checkoutRoot, marker))) {
        return true;
      }
    }
  }
  return false;
}

async function snapshotWorktree(
  record: ManagedWorktreeRecord,
  reason: string,
  provisionedPaths: readonly string[],
  commitGuard?: () => void,
): Promise<string> {
  commitGuard?.();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worktree-index-"));
  const indexPath = path.join(tempDir, "index");
  const snapshotRef = `${SNAPSHOT_REF_PREFIX}/${record.id}`;
  const filemodeArgs = process.platform === "win32" ? [] : ["-c", "core.filemode=true"];
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "OpenClaw",
    GIT_AUTHOR_EMAIL: "openclaw@localhost",
    GIT_COMMITTER_NAME: "OpenClaw",
    GIT_COMMITTER_EMAIL: "openclaw@localhost",
  };
  try {
    const provisioned = new Set(provisionedPaths.map((entry) => gitPathKey(Buffer.from(entry))));
    const snapshotPaths = new Map<string, Buffer>();
    const addSnapshotPath = (entry: Buffer) => {
      const key = gitPathKey(entry);
      if (!provisioned.has(key)) {
        snapshotPaths.set(key, entry);
      }
    };
    const sparseConfig = await runGit(record.path, ["config", "--bool", "core.sparseCheckout"]);
    if (sparseConfig.code !== 0 && sparseConfig.code !== 1) {
      throw commandError("git config --bool core.sparseCheckout", sparseConfig);
    }
    const sparseCheckout = sparseConfig.code === 0 && sparseConfig.stdout.trim() === "true";
    const sparseCandidates: Buffer[] = [];
    for (const entry of splitNullBuffer(
      await requireGitBuffer(record.path, ["ls-files", "-v", "-z"]),
    )) {
      if (entry.length < 3) {
        continue;
      }
      const tag = String.fromCharCode(entry[0] ?? 0).toUpperCase();
      const trackedPath = entry.subarray(2);
      if (
        tag !== "S" ||
        (await rawPathExists(checkoutPathFromGitBytes(record.path, trackedPath))) ||
        !sparseCheckout
      ) {
        addSnapshotPath(trackedPath);
      } else {
        sparseCandidates.push(trackedPath);
      }
    }
    if (sparseCandidates.length > 0) {
      const included = await requireGitBuffer(
        record.path,
        ["sparse-checkout", "check-rules", "-z"],
        {
          input: Buffer.concat(sparseCandidates.flatMap((entry) => [entry, Buffer.from([0])])),
        },
      );
      for (const entry of splitNullBuffer(included)) {
        // Missing paths included by the active rules are deletions, even if their
        // index skip-worktree bit is stale. Truly sparse omissions stay at HEAD.
        addSnapshotPath(entry);
      }
    }
    for (const args of [
      ["diff-index", "--cached", "--name-only", "-z", "HEAD", "--"],
      ["ls-files", "-z", "--others", "--exclude-standard"],
    ]) {
      for (const entry of splitNullBuffer(await requireGitBuffer(record.path, args))) {
        addSnapshotPath(entry);
      }
    }
    const isStagedInput = createStagedInputPathMatcher(await fsRoot(record.path));
    for (const entry of splitNullBuffer(
      await requireGitBuffer(record.path, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        STAGED_INPUT_GIT_PATHSPEC,
      ]),
    )) {
      if (await isStagedInput(entry.toString("utf8"))) {
        addSnapshotPath(entry);
      }
    }
    if (await containsSnapshotGitMarker(record.path, snapshotPaths.values())) {
      throw new Error("nested git repositories cannot be snapshotted losslessly");
    }
    commitGuard?.();
    await requireGit(record.path, [...filemodeArgs, "read-tree", "HEAD"], { env });
    // This index came from a tree, so it has no checkout-local skip-worktree
    // bits and update-index is independent of the source worktree's sparse cone.
    await requireGit(
      record.path,
      [...filemodeArgs, "update-index", "--add", "--remove", "-z", "--stdin"],
      {
        env,
        input:
          snapshotPaths.size > 0
            ? Buffer.concat(
                [...snapshotPaths.values()].flatMap((entry) => [entry, Buffer.from([0])]),
              )
            : Buffer.alloc(0),
      },
    );
    commitGuard?.();
    const tree = await requireGit(record.path, [...filemodeArgs, "write-tree"], { env });
    for (const provisionedPath of provisionedPaths) {
      const overlap = await requireGit(record.path, [
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "--name-only",
        tree,
        "--",
        provisionedPath,
      ]);
      if (overlap) {
        throw new Error(`provisioned path entered Git snapshot: ${provisionedPath}`);
      }
    }
    const treeEntries = await requireGit(record.path, ["ls-tree", "-r", tree]);
    // Gitlinks omit nested worktree files, so accepting one would violate the full-tree snapshot.
    if (treeEntries.split("\n").some((entry) => entry.startsWith("160000 "))) {
      throw new Error("nested git repositories cannot be snapshotted losslessly");
    }
    const parent = await requireGit(record.path, ["rev-parse", "HEAD"]);
    commitGuard?.();
    const commit = await requireGit(
      record.path,
      [
        ...filemodeArgs,
        "commit-tree",
        tree,
        "-p",
        parent,
        "-m",
        `OpenClaw worktree snapshot: ${reason}`,
      ],
      { env },
    );
    commitGuard?.();
    await requireGit(record.repoRoot, ["update-ref", snapshotRef, commit]);
    return snapshotRef;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function requireSnapshotSpace(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
): Promise<void> {
  const provisioned = getRegistryWorktreeProvisionedPaths(env, record.id) ?? [];
  const paths = [
    ...splitNullBuffer(
      await requireGitBuffer(record.path, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ]),
    ),
    ...splitNullBuffer(
      await requireGitBuffer(record.path, [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        STAGED_INPUT_GIT_PATHSPEC,
      ]),
    ),
  ];
  const unique = new Map(paths.map((value) => [gitPathKey(value), value]));
  for (const value of provisioned) {
    unique.set(gitPathKey(Buffer.from(value)), Buffer.from(value));
  }
  const provisionedKeys = new Set(provisioned.map((value) => gitPathKey(Buffer.from(value))));
  let gitBytes = 0,
    provisionedBytes = 0;
  for (const [key, value] of unique) {
    try {
      const stat = await fs.lstat(checkoutPathFromGitBytes(record.path, value));
      if (provisionedKeys.has(key)) {
        provisionedBytes += stat.size;
      } else {
        gitBytes += stat.size;
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
  }
  const commonDir = await requireGit(record.repoRoot, ["rev-parse", "--git-common-dir"]);
  requireWorktreeDiskSpace(
    [
      { path: path.resolve(record.repoRoot, commonDir), bytes: 2 * gitBytes },
      { path: resolveStateDir(env), bytes: 2 * provisionedBytes },
      { path: os.tmpdir(), bytes: unique.size * 512 },
    ],
    "worktree safety snapshot",
    true,
  );
}

export class ManagedWorktreeService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: ServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  private async worktreesRoot(): Promise<string> {
    const root = path.join(resolveStateDir(this.env), "worktrees");
    await fs.mkdir(root, { recursive: true });
    // Git canonicalizes paths in `git worktree list`; minting below the real root keeps
    // lock-state and adoption comparisons aligned when the state path traverses symlinks.
    return await fs.realpath(root);
  }

  async create(params: CreateManagedWorktreeParams): Promise<ManagedWorktreeRecord> {
    params.signal?.throwIfAborted();
    const repository = await resolveRepository(params.repoRoot);
    return await this.withAllocationLease(params, async (guard) => {
      if (params.ownerId) {
        const existing = findLiveRegistryWorktreeByOwner(
          this.env,
          params.ownerKind ?? "manual",
          params.ownerId,
        );
        if (existing && (await worktreePathExists(existing.path))) {
          const validated = await this.rebindLiveRepository(existing, guard);
          if (validated.repoRoot !== repository.repoRoot) {
            throw new Error(
              `worktree owner ${params.ownerKind ?? "manual"} ${params.ownerId} is already bound to another repository`,
            );
          }
          guard.commitGuard?.();
          return validated;
        }
        if (existing) {
          guard.commitGuard?.();
          updateRegistryWorktree(this.env, existing.id, { removedAt: this.now() });
        }
      }
      return await this.createForRepository(
        { ...params, ...guard },
        repository,
        params.name ?? params.suggestedName ?? createCrustaceanSlug(),
      );
    });
  }

  private async withAllocationLease<T>(
    params: WorktreeMutationGuard,
    run: (guard: WorktreeMutationGuard) => Promise<T>,
  ): Promise<T> {
    // Count and disk headroom are shared across repositories. Hold one renewable lease
    // through checkout, setup, snapshots, and publication, including CLI processes.
    return await withOpenClawStateLease(
      {
        scope: WORKTREE_CREATE_LEASE_SCOPE,
        key: "capacity",
        database: { scope: "shared", options: { env: this.env } },
        leaseMs: WORKTREE_CREATE_LEASE_MS,
        waitMs: WORKTREE_CREATE_LEASE_WAIT_MS,
        leaseLabel: "managed worktree allocation lease",
        operationLabel: "agents.worktrees.allocation",
        signal: params.signal,
      },
      async (lease) =>
        await run({
          signal: lease.signal,
          commitGuard: () => {
            lease.assertOwned();
            params.commitGuard?.();
          },
        }),
    );
  }

  private async requireAllocationCapacity(
    target: string,
    repository: ResolvedRepository,
    bytes = 0,
  ) {
    const live = listRegistryWorktrees(this.env).filter((record) => record.removedAt === undefined);
    if (live.length >= MAX_WORKTREES) {
      throw new Error(
        `Managed worktree limit of ${MAX_WORKTREES} reached; archive a session or remove an unused worktree, then retry. Active and manual worktrees are preserved.`,
      );
    }
    this.requireAllocationSpace(target, repository, bytes);
  }

  private requireAllocationSpace(target: string, repository: ResolvedRepository, bytes = 0) {
    requireWorktreeDiskSpace(
      [
        { path: target, bytes },
        { path: repository.commonDir, bytes: 0 },
        { path: repository.sourceRoot, bytes: 0 },
        { path: resolveStateDir(this.env), bytes: 0 },
      ],
      "worktree allocation",
    );
  }

  private async createForRepository(
    params: CreateManagedWorktreeParams,
    repository: Awaited<ReturnType<typeof resolveRepository>>,
    inferredName: string,
  ): Promise<ManagedWorktreeRecord> {
    params.signal?.throwIfAborted();
    params.onProgress?.("checkout");
    const root = path.join(await this.worktreesRoot(), repository.fingerprint);
    const name = validateName(
      params.name ??
        (await generateName(
          this.env,
          repository.repoRoot,
          root,
          params,
          params.suggestedName ?? inferredName,
        )),
    );
    const worktreePath = path.join(root, name);
    const existing = findRegistryWorktreeByPath(this.env, worktreePath);
    // Name reuse only ever adopts the caller's own record. Without this guard a
    // caller-chosen name could bind a new owner to another session's or a
    // manual checkout and run inside it.
    if (existing?.name === name && !existing.removedAt && !worktreeOwnerMatches(existing, params)) {
      throw new Error(
        `worktree name is already in use by ${existing.ownerKind}${existing.ownerId ? ` ${existing.ownerId}` : ""}: ${name}`,
      );
    }
    if (existing?.name === name && existing.removedAt === undefined) {
      if (await worktreePathExists(existing.path)) {
        return await this.rebindLiveRepository(existing, params);
      }
      updateRegistryWorktree(this.env, existing.id, { removedAt: this.now() });
    }
    if (existing?.name === name && existing.removedAt !== undefined && existing.snapshotRef) {
      if (!worktreeOwnerMatches(existing, params)) {
        throw new Error(
          `worktree name is already in use by ${existing.ownerKind}${existing.ownerId ? ` ${existing.ownerId}` : ""}: ${name}`,
        );
      }
      return await this.restoreWithAllocation({
        id: existing.id,
        signal: params.signal,
        commitGuard: params.commitGuard,
      });
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
    // Default-base resolution fetches remote refs; it is an effect, not just discovery.
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    await this.requireAllocationCapacity(worktreePath, repository);
    params.commitGuard?.();
    const base = await resolveWorktreeBase(repository.repoRoot, params.baseRef, params.signal);
    const gitBytes = Math.max(
      await estimateWorktreeGitBytes(repository.repoRoot, base.gitOperand),
      base.remote ? await estimateWorktreeGitBytes(repository.repoRoot, "HEAD") : 0,
    );
    const provisionedBytes = await estimateProvisionedFileBytes(repository.sourceRoot);
    const setupStat =
      params.runSetupScript === false
        ? undefined
        : await fs
            .stat(path.join(repository.sourceRoot, ".openclaw", "worktree-setup.sh"))
            .catch(() => undefined);
    const runRepositorySetup = setupStat?.isFile() === true && (setupStat.mode & 0o111) !== 0;
    const setupBytes = runRepositorySetup
      ? Math.max(
          WORKTREE_SETUP_HEADROOM_BYTES,
          await directorySizeBytes(repository.sourceRoot, true),
        )
      : 0;
    this.requireAllocationSpace(
      worktreePath,
      repository,
      2 * (gitBytes + provisionedBytes) + setupBytes,
    );
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    await fs.mkdir(root, { recursive: true });
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    let gitBase = base.gitOperand;
    let recordBase = base.recordRef;
    const worktreeAddArgs = () => ["worktree", "add", "-b", branch, "--", worktreePath, gitBase];
    let added = await runGit(repository.repoRoot, worktreeAddArgs(), {
      timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
      signal: params.signal,
    });
    if (added.code !== 0 && base.remote) {
      if (!(await canResetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch, added))) {
        throw commandError("git worktree add", added);
      }
      await resetFailedWorktreeAdd(repository.repoRoot, worktreePath, branch);
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      gitBase = "HEAD";
      recordBase = "HEAD";
      added = await runGit(repository.repoRoot, worktreeAddArgs(), {
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
        signal: params.signal,
      });
    }
    if (added.code !== 0) {
      throw commandError("git worktree add", added);
    }
    let provisionedPaths: string[];
    try {
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      this.requireAllocationSpace(worktreePath, repository, 2 * provisionedBytes + setupBytes);
      provisionedPaths = await provisionIncludedFiles(repository.sourceRoot, worktreePath);
      if (runRepositorySetup) {
        this.requireAllocationSpace(worktreePath, repository, setupBytes);
        await runSetupScript(repository.sourceRoot, worktreePath, params);
      }
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      this.requireAllocationSpace(worktreePath, repository);
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
    insertRegistryWorktree(this.env, record, { provisionedPaths });
    return record;
  }

  async list(): Promise<ManagedWorktreeRecord[]> {
    const records = listRegistryWorktrees(this.env);
    for (const record of records) {
      if (record.removedAt === undefined && !(await worktreePathExists(record.path))) {
        const removedAt = this.now();
        updateRegistryWorktree(this.env, record.id, { removedAt });
        record.removedAt = removedAt;
      }
    }
    return records.filter((record) => record.removedAt === undefined || record.snapshotRef);
  }

  /** Returns persisted worktree facts without probing paths or mutating lifecycle state. */
  listRegistryRecords(): ManagedWorktreeRecord[] {
    return listRegistryWorktrees(this.env);
  }

  findLiveByOwner(
    ownerKind: ManagedWorktreeOwnerKind,
    ownerId: string,
  ): ManagedWorktreeRecord | undefined {
    return findLiveRegistryWorktreeByOwner(this.env, ownerKind, ownerId);
  }

  findLiveById(id: string): ManagedWorktreeRecord | undefined {
    const record = getRegistryWorktree(this.env, id);
    return record?.removedAt === undefined ? record : undefined;
  }

  /** Resolves the canonical registry root and the caller's own checkout root. */
  async resolveRepositoryPaths(repoRoot: string): Promise<{
    canonicalRoot: string;
    sourceRoot: string;
  }> {
    const resolved = await resolveRepository(repoRoot);
    return {
      canonicalRoot: resolved.repoRoot,
      sourceRoot: resolved.sourceRoot,
    };
  }

  /** Resolves the repository facts shared by managed worktrees and project discovery. */
  async resolveRepositoryIdentity(repoRoot: string): Promise<{
    checkoutRoot: string;
    repoRoot: string;
    originUrl: string;
    fingerprint: string;
  }> {
    const resolved = await resolveRepository(repoRoot);
    return {
      checkoutRoot: resolved.sourceRoot,
      repoRoot: resolved.repoRoot,
      originUrl: resolved.originUrl,
      fingerprint: resolved.fingerprint,
    };
  }

  /**
   * Lists selectable base refs for a repository without touching the network.
   * Base-ref pickers must stay snappy; resolveWorktreeBase() still fetches on create
   * when no explicit ref is chosen.
   */
  async listRepositoryBranches(
    repoRoot: string,
    options: { includeRepositoryStatus?: boolean } = {},
  ): Promise<ManagedWorktreeBranchesResult> {
    let repository: ResolvedRepository;
    if (options.includeRepositoryStatus) {
      try {
        const requested = await fs.realpath(repoRoot);
        if (!(await fs.stat(requested)).isDirectory()) {
          return { branches: [], repositoryStatus: "unavailable" };
        }
        if (!insideGitCheckout(requested)) {
          return { branches: [], repositoryStatus: "not_git" };
        }
        repository = await resolveRepositoryFromRealPath(requested, repoRoot);
      } catch {
        return { branches: [], repositoryStatus: "unavailable" };
      }
    } else {
      repository = await resolveRepository(repoRoot);
    }
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
      ...(options.includeRepositoryStatus ? { repositoryStatus: "git" as const } : {}),
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
    if (!record || record.removedAt !== undefined || !(await worktreePathExists(record.path))) {
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

  async remove(params: RemoveWorktreeParams): Promise<RemoveManagedWorktreeResult> {
    return await this.withAllocationLease(
      params,
      async (guard) => await this.removeWithAllocation({ ...params, ...guard }),
    );
  }

  private async removeWithAllocation(
    params: RemoveWorktreeParams,
  ): Promise<RemoveManagedWorktreeResult> {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    let record = this.requireLiveRecord(params.id);
    // Claim removal before any cleanliness or snapshot work so a live run lease
    // rejects it and an admitted run cannot start once the claim is held. The
    // opaque token makes the claim exclusive against competing removers; a caller
    // that already claimed (removeIfLossless) passes its token to keep one claim.
    const claimToken = params.claimToken ?? randomUUID();
    claimWorktreeRemoval(this.env, { worktreeId: record.id, token: claimToken });
    try {
      record = await this.rebindLiveRepository(record, params);
      const state = await lockState(record);
      if (state.kind === "live" || state.kind === "foreign") {
        throw new WorktreeRemovalLockError(
          state.kind === "live" ? "busy" : "foreign-lock",
          state.kind === "live"
            ? `worktree is locked by live OpenClaw pid ${state.pid}`
            : `worktree has a foreign lock${state.reason ? `: ${state.reason}` : ""}`,
        );
      }
      if (state.kind !== "none") {
        params.commitGuard?.();
        await requireGit(record.repoRoot, ["worktree", "unlock", record.path]);
      }
      let snapshotRef = record.snapshotRef;
      let snapshotError: string | undefined;
      try {
        await requireSnapshotSpace(this.env, record);
        params.commitGuard?.();
        const provisionedState = await snapshotProvisionedFiles(
          this.env,
          record.id,
          record.path,
          getRegistryWorktreeProvisionedPaths(this.env, record.id),
          params.commitGuard,
        );
        snapshotRef = await snapshotWorktree(
          record,
          params.reason,
          provisionedState.map((entry) => entry.path),
          params.commitGuard,
        );
        params.commitGuard?.();
        updateRegistryWorktree(this.env, record.id, {
          snapshotRef,
          provisionedState,
        });
      } catch (error) {
        snapshotError = error instanceof Error ? error.message : String(error);
        try {
          clearRegistryWorktreeProvisionedChunks(this.env, record.id);
        } catch (cleanupError) {
          throw new WorktreeSnapshotError(
            `${snapshotError}; provisioned snapshot cleanup failed: ${String(cleanupError)}`,
            { cause: cleanupError },
          );
        }
        if (!params.allowSnapshotLoss) {
          throw new WorktreeSnapshotError(snapshotError, { cause: error });
        }
      }
      params.signal?.throwIfAborted();
      params.commitGuard?.();
      const removed = await runGit(record.repoRoot, ["worktree", "remove", "--force", record.path]);
      if (removed.code !== 0) {
        throw commandError("git worktree remove", removed);
      }
      params.commitGuard?.();
      const branchDelete = await runGit(record.repoRoot, ["branch", "-D", record.branch]);
      if (branchDelete.code !== 0) {
        throw commandError("git branch -D", branchDelete);
      }
      await requireGit(record.repoRoot, ["worktree", "prune"]);
      await removeEmptyParents(path.dirname(record.path), await this.worktreesRoot());
      params.commitGuard?.();
      const removedAt = this.now();
      // Persist the run-end outcome atomically with finalization: a post-finalize
      // write could race a restore plus newer cleanup and overwrite the newer fact.
      updateRegistryWorktree(this.env, record.id, {
        removedAt,
        snapshotRef,
        ...(params.runEndCleanup ? { runEndCleanup: params.runEndCleanup } : {}),
      });
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

  async restore(params: { id: string } & WorktreeMutationGuard): Promise<ManagedWorktreeRecord> {
    return await this.withAllocationLease(
      params,
      async (guard) => await this.restoreWithAllocation({ ...params, ...guard }),
    );
  }

  private async restoreWithAllocation(
    params: { id: string } & WorktreeMutationGuard,
  ): Promise<ManagedWorktreeRecord> {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
    const record = getRegistryWorktree(this.env, params.id);
    if (!record?.snapshotRef || record.removedAt === undefined) {
      throw new Error(`worktree ${params.id} is not restorable`);
    }
    if (!(await worktreePathExists(record.repoRoot))) {
      throw new Error(`source repository no longer exists: ${record.repoRoot}`);
    }
    const repository = await resolveRepository(record.repoRoot);
    await this.requireAllocationCapacity(record.path, repository);
    const provisionedState = getRegistryWorktreeProvisionedState(this.env, record.id);
    if (provisionedState === undefined) {
      throw new Error(`worktree ${record.id} snapshot lacks provisioned file metadata`);
    }
    const provisionedBytes = provisionedState.reduce(
      (sum, entry) => sum + entry.chunks * SNAPSHOT_CHUNK_BYTES,
      0,
    );
    const gitBytes = await estimateWorktreeGitBytes(record.repoRoot, record.snapshotRef);
    this.requireAllocationSpace(record.path, repository, 2 * (gitBytes + provisionedBytes));
    const parent = await requireGit(record.repoRoot, ["rev-parse", `${record.snapshotRef}^`]);
    params.commitGuard?.();
    await fs.mkdir(path.dirname(record.path), { recursive: true });
    params.commitGuard?.();
    await requireGit(
      record.repoRoot,
      ["worktree", "add", "--detach", record.path, record.snapshotRef],
      { timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS, signal: params.signal },
    );
    let branchCreated = false;
    let restoredProvisionedPaths: string[];
    try {
      // Branch history stays at the original commit; the snapshot is restored as working state.
      params.commitGuard?.();
      await requireGit(record.repoRoot, ["branch", record.branch, parent]);
      branchCreated = true;
      params.commitGuard?.();
      await requireGit(record.path, ["symbolic-ref", "HEAD", `refs/heads/${record.branch}`]);
      params.commitGuard?.();
      await requireGit(record.path, ["reset"]);
      params.commitGuard?.();
      this.requireAllocationSpace(record.path, repository, 2 * provisionedBytes);
      await restoreProvisionedFiles(this.env, record.id, record.path, provisionedState);
      params.commitGuard?.();
      this.requireAllocationSpace(record.path, repository);
      restoredProvisionedPaths = provisionedState.map((state) => state.path);
    } catch (error) {
      const removed = await runGit(record.repoRoot, ["worktree", "remove", "--force", record.path]);
      const branchDeleted = branchCreated
        ? await runGit(record.repoRoot, ["branch", "-D", record.branch])
        : undefined;
      if (removed.code !== 0 || (branchDeleted && branchDeleted.code !== 0)) {
        const failure =
          branchDeleted && removed.code === 0
            ? commandError("git branch -D", branchDeleted)
            : commandError("git worktree remove", removed);
        throw new Error(`${String(error)}\nrestore cleanup failed: ${failure.message}`, {
          cause: error,
        });
      }
      throw error;
    }
    // Advance past the stored stamp even within the same millisecond: stale
    // cleanup writes fence on the activity stamp they observed, so a restore
    // must never revive the row with an identical value.
    const lastActiveAt = Math.max(this.now(), record.lastActiveAt + 1);
    updateRegistryWorktree(this.env, params.id, {
      removedAt: undefined,
      lastActiveAt,
      provisionedPaths: restoredProvisionedPaths,
      // The recorded cleanup outcome described the removed lifecycle; a restored
      // checkout starts a new one, so a stale removed-lossless must not show on
      // a live row until the next run-end cleanup records fresh truth.
      runEndCleanup: undefined,
    });
    // Clear any lease rows or removal marker stranded by a crash between git removal
    // and finalize so the restored worktree admits runs again.
    finalizeWorktreeRemoval(this.env, params.id);
    const restored = { ...record, lastActiveAt };
    delete restored.removedAt;
    delete restored.runEndCleanup;
    return restored;
  }

  async removeIfLossless(id: string): Promise<boolean> {
    let record = this.requireLiveRecord(id);
    const claimToken = randomUUID();
    const recordOutcome = (outcome: ManagedWorktreeRunEndCleanupOutcome, error?: unknown) => {
      // Retained/failed writes happen after this remover released or aborted its
      // claim, so racing removers may have finalized the row, or removed AND
      // restored it into a new lifecycle. The live condition blocks the first;
      // conditioning on the activity stamp this remover observed blocks the
      // second (restore bumps lastActiveAt). The winning removal persists its
      // outcome atomically inside remove()'s finalization update, never here.
      updateRegistryWorktree(
        this.env,
        id,
        {
          runEndCleanup: {
            outcome,
            at: this.now(),
            ...(outcome === "failed"
              ? { reason: truncateUtf16Safe(formatErrorMessage(error), 500) }
              : {}),
          },
        },
        { onlyIfLive: true, onlyIfActiveAt: record.lastActiveAt },
      );
    };
    // Run-end cleanup must leave a durable outcome even when safety retains the checkout.
    // QA and operators observe this product-boundary fact through worktrees.list.
    try {
      claimWorktreeRemoval(this.env, { worktreeId: id, token: claimToken });
    } catch (error) {
      if (error instanceof WorktreeRemovalContentionError) {
        if (error.kind === "finalized") {
          // The winning remover owns the terminal cleanup fact; a late contender
          // must return without replacing it with a false retained/failed outcome.
          return false;
        }
        // A live run lease or a competing remover holds the worktree; a lossless
        // auto-cleanup must not race it.
        recordOutcome("retained-busy");
        return false;
      }
      try {
        recordOutcome("failed", error);
      } catch {
        // Preserve the claim failure when the same infrastructure blocks recording it.
      }
      throw error;
    }
    try {
      record = await this.rebindLiveRepository(record);
      const status = await requireGit(record.path, ["status", "--porcelain"]);
      const unpushed = await requireGit(record.path, [
        "log",
        "HEAD",
        "--not",
        "--remotes",
        "--oneline",
      ]);
      const ignoredDrift = await hasUnsnapshotableProvisionedFiles(
        record.path,
        getRegistryWorktreeProvisionedPaths(this.env, record.id),
      );
      const retainedOutcome = status
        ? "retained-dirty"
        : unpushed
          ? "retained-unpushed"
          : ignoredDrift
            ? "retained-provisioned-drift"
            : (await containsSnapshotGitMarker(record.path))
              ? "retained-dirty"
              : undefined;
      if (retainedOutcome) {
        abortWorktreeRemoval(this.env, id, claimToken);
        recordOutcome(retainedOutcome);
        return false;
      }
    } catch (error) {
      abortWorktreeRemoval(this.env, id, claimToken);
      recordOutcome("failed", error);
      throw error;
    }
    try {
      await this.release(id);
      await this.remove({
        id,
        reason: "run-end",
        claimToken,
        runEndCleanup: { outcome: "removed-lossless", at: this.now() },
      });
    } catch (error) {
      abortWorktreeRemoval(this.env, id, claimToken);
      recordOutcome("failed", error);
      throw error;
    }
    return true;
  }

  async removeIfLosslessByPath(
    worktreePath: string,
    owner: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
  ): Promise<boolean> {
    const record = findLiveRegistryWorktreeByPath(this.env, worktreePath);
    if (!record || !worktreeOwnerMatches(record, owner)) {
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
        if (record.removedAt === undefined && !(await worktreePathExists(record.path))) {
          updateRegistryWorktree(this.env, record.id, { removedAt: now });
          record.removedAt = now;
        }
        // Manual worktrees remain until explicit removal; only run-owned worktrees expire.
        const expiresWhenIdle = record.ownerKind === "workboard" || record.ownerKind === "session";
        const retiredOwner =
          record.ownerId !== undefined &&
          params.shouldRemoveOwner?.(record.ownerKind, record.ownerId) === true;
        if (
          record.removedAt === undefined &&
          expiresWhenIdle &&
          (retiredOwner || now - record.lastActiveAt > IDLE_GC_MS)
        ) {
          if (await this.isProtectedFromAutoRemoval(record, params.shouldProtectOwner)) {
            continue;
          }
          await this.remove({
            id: record.id,
            reason: retiredOwner ? "owner-gc" : "idle-gc",
            commitGuard: () => this.assertOwnerAllowsCleanup(record, params, retiredOwner),
          });
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
        if (record.snapshotRef && (await worktreePathExists(record.repoRoot))) {
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
   * Shared auto-removal guard: owners, leases, nested repositories, and live or
   * foreign Git locks veto removal; a dead lock is cleared.
   */
  private async isProtectedFromAutoRemoval(
    record: ManagedWorktreeRecord,
    shouldProtectOwner?: (ownerKind: ManagedWorktreeOwnerKind, ownerId: string) => boolean,
  ): Promise<boolean> {
    if (
      record.ownerId !== undefined &&
      shouldProtectOwner?.(record.ownerKind, record.ownerId) === true
    ) {
      return true;
    }
    if (hasLiveWorktreeRunLease(this.env, record.id)) {
      return true;
    }
    if (
      await hasUnsnapshotableProvisionedFiles(
        record.path,
        getRegistryWorktreeProvisionedPaths(this.env, record.id),
      )
    ) {
      return true;
    }
    const state = await lockState(record);
    if (state.kind === "live" || state.kind === "foreign") {
      return true;
    }
    if (state.kind === "dead") {
      await requireGit(record.repoRoot, ["worktree", "unlock", record.path]);
    }
    return await containsSnapshotGitMarker(record.path);
  }

  /**
   * Enforces optional count/size retention across all live managed worktrees.
   * Manual worktrees count toward the totals but are never limit-evicted, so a
   * limit can stay exceeded when only protected worktrees remain.
   */
  private async enforceCleanupLimits(params: ManagedWorktreeGcParams): Promise<string[]> {
    const limits = params.limits ?? resolveWorktreeCleanupLimits();
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
        if (await this.isProtectedFromAutoRemoval(record, params.shouldProtectOwner)) {
          continue;
        }
        await this.remove({
          id: record.id,
          reason: "limit-gc",
          commitGuard: () => this.assertOwnerAllowsCleanup(record, params),
        });
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

  private assertOwnerAllowsCleanup(
    record: ManagedWorktreeRecord,
    params: ManagedWorktreeGcParams,
    retiredOwner = false,
  ) {
    if (
      record.ownerId !== undefined &&
      (params.shouldProtectOwner?.(record.ownerKind, record.ownerId) === true ||
        (retiredOwner && params.shouldRemoveOwner?.(record.ownerKind, record.ownerId) !== true))
    ) {
      throw new WorktreeRemovalLockError("busy", "worktree owner became active during cleanup");
    }
  }

  private requireLiveRecord(id: string): ManagedWorktreeRecord {
    const record = getRegistryWorktree(this.env, id);
    if (!record || record.removedAt !== undefined) {
      throw new Error(`unknown active worktree: ${id}`);
    }
    return record;
  }

  private async rebindLiveRepository(
    record: ManagedWorktreeRecord,
    guard: WorktreeMutationGuard = {},
  ): Promise<ManagedWorktreeRecord> {
    const worktreePath = await fs.realpath(record.path);
    const repository = await resolveRepositoryFromRealPath(worktreePath, record.path);
    if (repository.sourceRoot !== worktreePath) {
      throw new WorktreeRepositoryError(`repository does not own worktree: ${record.path}`);
    }
    const registeredRepository = await resolveRepository(record.repoRoot);
    if (registeredRepository.originUrl !== repository.originUrl) {
      throw new WorktreeRepositoryError(`repository origin does not match: ${record.path}`);
    }
    guard.signal?.throwIfAborted();
    guard.commitGuard?.();
    updateRegistryWorktree(this.env, record.id, {
      repositoryIdentity: {
        repoRoot: repository.repoRoot,
        repoFingerprint: repository.fingerprint,
      },
    });
    return { ...record, repoRoot: repository.repoRoot, repoFingerprint: repository.fingerprint };
  }

  private async reconcileOrphans(records: ManagedWorktreeRecord[]): Promise<number> {
    const managedPaths = new Set<string>();
    for (const record of records) {
      try {
        managedPaths.add(await canonicalPathKey(record.path));
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
    }
    const worktreesRoot = await this.worktreesRoot();
    const fingerprints = await fs.readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
    let deleted = 0;
    for (const fingerprint of fingerprints) {
      if (!fingerprint.isDirectory()) {
        continue;
      }
      const fingerprintPath = path.join(worktreesRoot, fingerprint.name);
      // A root entry can be a checkout, not a fingerprint container; descending
      // before applying the same preservation rule would expose its contents to deletion.
      if (await shouldPreserveOrphanCandidate(fingerprintPath, managedPaths)) {
        continue;
      }
      const names = await fs.readdir(fingerprintPath, { withFileTypes: true }).catch(() => []);
      for (const name of names) {
        if (!name.isDirectory()) {
          continue;
        }
        const candidate = path.join(fingerprintPath, name.name);
        if (await shouldPreserveOrphanCandidate(candidate, managedPaths)) {
          continue;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
