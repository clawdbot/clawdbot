import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { insertRegistryWorktree } from "./registry.js";
import type { ManagedWorktreeOwnerKind, ManagedWorktreeRecord } from "./types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
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
