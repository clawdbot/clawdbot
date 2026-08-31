import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { insertRegistryWorktree } from "./registry.js";
import type { ManagedWorktreeOwnerKind, ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function initializeRepository(repo: string): Promise<void> {
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
}

async function addRemote(root: string, repo: string): Promise<string> {
  const remote = path.join(root, "remote.git");
  await git(root, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  return await fs.realpath(repo);
}

export async function initializeManagedWorktreeTestRepository(root: string): Promise<string> {
  const repo = path.join(root, "repo");
  await initializeRepository(repo);
  return await addRemote(root, repo);
}

export function useManagedWorktreeTestRepository(): (root: string) => Promise<string> {
  const templateDirs = useAutoCleanupTempDirTracker(afterAll);
  let templateRepo: string;
  beforeAll(async () => {
    const templateRoot = templateDirs.make("openclaw-worktree-template-");
    const repo = path.join(templateRoot, "repo");
    await initializeRepository(repo);
    templateRepo = repo;
  });

  // Only initial history is shared, within this suite. Each case still owns its
  // Git metadata and real remote; no fetched refs, locks, or state DB are copied.
  return async (root) => {
    const repo = path.join(root, "repo");
    await fs.cp(templateRepo, repo, { recursive: true, mode: fsConstants.COPYFILE_FICLONE });
    return await addRemote(root, repo);
  };
}

async function copyProvisionedFiles(params: {
  repoRoot: string;
  worktreePath: string;
  provisionedPaths: readonly string[];
}): Promise<void> {
  for (const provisionedPath of params.provisionedPaths) {
    const source = path.join(params.repoRoot, provisionedPath);
    const target = path.join(params.worktreePath, provisionedPath);
    const sourceStat = await fs.lstat(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
    if (process.platform !== "win32") {
      await fs.chmod(target, sourceStat.mode & 0o7777);
    }
  }
}

export async function materializeManagedWorktreeFixture(params: {
  env: NodeJS.ProcessEnv;
  name: string;
  now: number;
  ownerKind?: ManagedWorktreeOwnerKind;
  ownerId?: string;
  provisionedPaths?: readonly string[];
  repoRoot: string;
  stateDir: string;
}): Promise<ManagedWorktreeRecord> {
  const repoFingerprint = "downstream-fixture";
  const worktreePath = path.join(params.stateDir, "worktrees", repoFingerprint, params.name);
  const branch = `openclaw/${params.name}`;
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(params.repoRoot, "worktree", "add", "-b", branch, "--", worktreePath, "HEAD");
  const provisionedPaths = params.provisionedPaths ?? [];
  await copyProvisionedFiles({
    repoRoot: params.repoRoot,
    worktreePath,
    provisionedPaths,
  });
  const record: ManagedWorktreeRecord = {
    id: `fixture-${params.name}`,
    name: params.name,
    repoFingerprint,
    repoRoot: params.repoRoot,
    path: worktreePath,
    branch,
    baseRef: "HEAD",
    ownerKind: params.ownerKind ?? "manual",
    ...(params.ownerId ? { ownerId: params.ownerId } : {}),
    createdAt: params.now,
    lastActiveAt: params.now,
  };
  insertRegistryWorktree(params.env, record, { provisionedPaths });
  return record;
}
