import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalPathFromExistingAncestor, isPathInside } from "../infra/fs-safe.js";
import {
  executeGitCommand as runGit,
  requireGitCommand as requireGit,
  requireGitCommandBuffer as requireGitBuffer,
} from "../infra/git-exec.js";
import {
  GIT_BACKUP_MANIFEST,
  GIT_BACKUP_SCHEMA,
  GIT_BACKUP_TABLES,
  dumpGitBackupDatabase,
  gitBackupScopePath,
  parseGitBackupManifest,
  restoreGitBackupDirectory,
  type GitBackupIdentity,
  type GitBackupManifest,
  type GitBackupRestoreResult,
} from "./git-backup-codec.js";
import { ensurePrivateSnapshotRepositoryRoot } from "./local-repository.js";
import { createOpenClawSnapshotCopy } from "./openclaw-snapshot-copy.js";
import type { SnapshotDatabaseRef } from "./snapshot-provider.js";

const GIT_BACKUP_MATERIALIZE_MAX_BYTES = 1024 * 1024 * 1024;
const GIT_BACKUP_DIAGNOSTIC_MAX_LENGTH = 500;
const GIT_BACKUP_NON_BACKUP_HISTORY_WARNING =
  "repository history contains non-backup commits; use a dedicated backup repository";

type GitBackupCreateResult = {
  repositoryPath: string;
  commit?: string;
  noChanges: boolean;
  pushed: boolean;
  pushWarning?: string;
  manifests: GitBackupManifest[];
};

function sanitizeGitBackupDiagnostic(value: string): string {
  return value.replace(/:\/\/[^@\s]+@/gu, "://***@").slice(0, GIT_BACKUP_DIAGNOSTIC_MAX_LENGTH);
}

function gitBackupRepositoryPrivacyRemediation(repositoryPath: string, cause: unknown): string {
  if (process.platform === "win32") {
    const detail =
      cause instanceof Error && cause.message
        ? ` ${sanitizeGitBackupDiagnostic(cause.message)}`
        : "";
    return (
      `${detail} Remove non-user ACL grants from ${repositoryPath} or choose a private local directory. ` +
      "Do not use a shared or synced folder for SQLite backups."
    );
  }
  return `Fix its ownership and run chmod 700 ${repositoryPath}.`;
}

async function assertGitRepository(repositoryPath: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const topLevel = await requireGit(repositoryPath, ["rev-parse", "--show-toplevel"], { env });
  const [canonicalTopLevel, canonicalRepository] = await Promise.all([
    fs.realpath(topLevel),
    fs.realpath(repositoryPath),
  ]);
  if (canonicalTopLevel !== canonicalRepository) {
    throw new Error(`Backup repository must be the Git worktree root: ${repositoryPath}`);
  }
}

/** Initialize or adopt an operator-owned Git backup repository. */
export async function initializeGitBackupRepository(params: {
  repositoryPath: string;
  stateDir: string;
  remote?: string;
  gitEnv?: NodeJS.ProcessEnv;
}): Promise<{ repositoryPath: string }> {
  const repositoryPath = path.resolve(params.repositoryPath);
  const stateDir = path.resolve(params.stateDir);
  const [canonicalRepositoryPath, canonicalStateDir] = await Promise.all([
    canonicalPathFromExistingAncestor(repositoryPath),
    canonicalPathFromExistingAncestor(stateDir),
  ]);
  if (
    isPathInside(canonicalStateDir, canonicalRepositoryPath) ||
    isPathInside(canonicalRepositoryPath, canonicalStateDir)
  ) {
    throw new Error(
      `Git backup repository must be outside the OpenClaw state directory: ${stateDir}`,
    );
  }
  try {
    await ensurePrivateSnapshotRepositoryRoot(repositoryPath);
  } catch (error) {
    throw new Error(
      `Git backup repository must be owned by the current user and not writable by other users: ${repositoryPath}. ${gitBackupRepositoryPrivacyRemediation(repositoryPath, error)}`,
      { cause: error },
    );
  }
  const probe = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"], {
    env: params.gitEnv,
  });
  if (probe.code !== 0) {
    await requireGit(repositoryPath, ["init"], { env: params.gitEnv });
  }
  await assertGitRepository(repositoryPath, params.gitEnv);
  const remote = params.remote?.trim();
  if (remote) {
    const existing = await runGit(repositoryPath, ["remote", "get-url", "origin"], {
      env: params.gitEnv,
    });
    if (existing.code === 0 && existing.stdout.trim() !== remote) {
      throw new Error(
        `Git backup repository already has a different origin: ${sanitizeGitBackupDiagnostic(existing.stdout.trim())}`,
      );
    }
    if (existing.code !== 0) {
      await requireGit(repositoryPath, ["remote", "add", "origin", remote], {
        env: params.gitEnv,
      });
    }
  }
  return { repositoryPath };
}

async function isBackupOwnedScope(scopePath: string): Promise<boolean> {
  const identity = await fs
    .lstat(scopePath)
    .catch((error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null,
    );
  if (identity === undefined) {
    return true;
  }
  if (!identity?.isDirectory()) {
    return false;
  }
  try {
    const entries = await fs.readdir(scopePath);
    if (entries.length === 0) {
      return true;
    }
    parseGitBackupManifest(
      await fs.readFile(path.join(scopePath, GIT_BACKUP_MANIFEST), "utf8"),
      scopePath,
    );
    return true;
  } catch {
    return false;
  }
}

async function assertBackupOwnedScope(scopePath: string): Promise<void> {
  if (!(await isBackupOwnedScope(scopePath))) {
    throw new Error(
      `Refusing to replace non-backup-owned path ${scopePath}; the repository must be dedicated to OpenClaw backups.`,
    );
  }
}

async function removeStaleAgentScopes(repositoryPath: string): Promise<void> {
  const agentsPath = path.join(repositoryPath, "agents");
  let entries: string[];
  try {
    entries = await fs.readdir(agentsPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const scopes = entries.map((entry) => path.join(agentsPath, entry));
  await Promise.all(scopes.map(async (scope) => await assertBackupOwnedScope(scope)));
  await Promise.all(scopes.map(async (scope) => await fs.rm(scope, { recursive: true })));
}

async function copyStagedScope(
  stagingRoot: string,
  repositoryPath: string,
  identity: GitBackupIdentity,
): Promise<void> {
  const relative = gitBackupScopePath(identity);
  const source = path.join(stagingRoot, relative);
  const target = path.join(repositoryPath, relative);
  await assertBackupOwnedScope(target);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.cp(source, target, { recursive: true, force: false });
}

async function commitGitBackup(params: {
  repositoryPath: string;
  message: string;
  scopes: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const email = await runGit(params.repositoryPath, ["config", "--get", "user.email"], {
    env: params.env,
  });
  const identityArgs =
    email.code === 0 && email.stdout.trim()
      ? []
      : ["-c", "user.name=OpenClaw", "-c", "user.email=backup@openclaw.local"];
  await requireGit(
    params.repositoryPath,
    [...identityArgs, "commit", "-m", params.message, "--", ...params.scopes],
    { env: params.env },
  );
  return await requireGit(params.repositoryPath, ["rev-parse", "HEAD"], { env: params.env });
}

/** Snapshot selected databases, update the deterministic tree, and commit one Git revision. */
export async function createGitBackup(params: {
  repositoryPath: string;
  stateDir: string;
  databases: Array<SnapshotDatabaseRef & { identity: GitBackupIdentity }>;
  all?: boolean;
  excludeSecrets?: boolean;
  push?: boolean;
  now?: Date;
  gitEnv?: NodeJS.ProcessEnv;
}): Promise<GitBackupCreateResult> {
  const repositoryPath = path.resolve(params.repositoryPath);
  await initializeGitBackupRepository({
    repositoryPath,
    stateDir: params.stateDir,
    gitEnv: params.gitEnv,
  });
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-backup-"));
  await fs.chmod(stagingRoot, 0o700);
  const manifests: GitBackupManifest[] = [];
  try {
    for (const database of params.databases) {
      const outputPath = path.join(stagingRoot, gitBackupScopePath(database.identity));
      await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const copyPath = path.join(
        stagingRoot,
        `${database.identity.role}-${manifests.length}.sqlite`,
      );
      await createOpenClawSnapshotCopy({ database, targetPath: copyPath });
      manifests.push(
        await dumpGitBackupDatabase({
          snapshotPath: copyPath,
          outputPath,
          identity: database.identity,
          excludeSecrets: params.excludeSecrets,
        }),
      );
      await fs.rm(copyPath, { force: true });
    }
    if (params.all) {
      await removeStaleAgentScopes(repositoryPath);
    }
    for (const database of params.databases) {
      await copyStagedScope(stagingRoot, repositoryPath, database.identity);
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  // Keep both owned roots present so Git accepts both scoped pathspecs even on a first global-only
  // or agent-only backup. Empty directories remain untracked.
  await Promise.all(
    ["global", "agents"].map(async (scope) =>
      fs.mkdir(path.join(repositoryPath, scope), { recursive: true, mode: 0o700 }),
    ),
  );
  await requireGit(repositoryPath, ["add", "-A", "--", "global", "agents"], {
    env: params.gitEnv,
  });
  const changed = await requireGit(
    repositoryPath,
    ["status", "--porcelain", "--", "global", "agents"],
    {
      env: params.gitEnv,
    },
  );
  let commit: string | undefined;
  if (changed) {
    const now = params.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Git backup timestamp is invalid.");
    }
    const stagedBackupPaths = await requireGit(
      repositoryPath,
      ["diff", "--cached", "--name-only", "--", "global", "agents"],
      { env: params.gitEnv },
    );
    const commitScopes = ["global", "agents"].filter((scope) =>
      stagedBackupPaths.split("\n").some((entry) => entry.startsWith(`${scope}/`)),
    );
    commit = await commitGitBackup({
      repositoryPath,
      message: `openclaw backup ${now.toISOString()}`,
      scopes: commitScopes,
      env: params.gitEnv,
    });
  }
  let pushed = false;
  let pushWarning: string | undefined;
  if (params.push) {
    // Staging is path-scoped, but push ships HEAD's full ancestry. A dedicated
    // repository is the supported remote shape.
    const nonBackupCommitCount = await requireGit(
      repositoryPath,
      ["rev-list", "HEAD", "--invert-grep", "--grep=^openclaw backup ", "--count"],
      { env: params.gitEnv },
    );
    if (nonBackupCommitCount !== "0") {
      pushWarning = GIT_BACKUP_NON_BACKUP_HISTORY_WARNING;
    } else {
      const pushedResult = await runGit(repositoryPath, ["push", "-u", "origin", "HEAD"], {
        env: params.gitEnv,
      });
      if (pushedResult.code === 0) {
        pushed = true;
      } else {
        pushWarning = sanitizeGitBackupDiagnostic(
          (pushedResult.stderr || pushedResult.stdout).trim() || "git push failed",
        );
      }
    }
  }
  return {
    repositoryPath,
    ...(commit ? { commit } : {}),
    noChanges: !changed,
    pushed,
    ...(pushWarning ? { pushWarning } : {}),
    manifests,
  };
}

async function resolveGitCommit(repositoryPath: string, ref?: string): Promise<string> {
  return await requireGit(repositoryPath, [
    "rev-parse",
    "--verify",
    `${ref?.trim() || "HEAD"}^{commit}`,
  ]);
}

/** Materialize one database scope from a Git ref into a private temporary directory. */
async function materializeGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
}): Promise<{ commit: string; path: string; cleanup: () => Promise<void> }> {
  const repositoryPath = path.resolve(params.repositoryPath);
  await assertGitRepository(repositoryPath);
  const commit = await resolveGitCommit(repositoryPath, params.ref);
  const scope = gitBackupScopePath(params.identity).split(path.sep).join("/");
  const files = (
    await requireGit(repositoryPath, ["ls-tree", "-r", "--name-only", commit, "--", scope])
  )
    .split("\n")
    .filter(Boolean);
  const required = new Set([`${scope}/${GIT_BACKUP_MANIFEST}`, `${scope}/${GIT_BACKUP_SCHEMA}`]);
  if ([...required].some((entry) => !files.includes(entry))) {
    throw new Error(`Git backup ref ${commit} does not contain ${scope}.`);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-restore-"));
  await fs.chmod(root, 0o700);
  const outputPath = path.join(root, scope);
  try {
    for (const file of files) {
      if (
        file !== `${scope}/${GIT_BACKUP_MANIFEST}` &&
        file !== `${scope}/${GIT_BACKUP_SCHEMA}` &&
        !file.startsWith(`${scope}/${GIT_BACKUP_TABLES}/`)
      ) {
        throw new Error(`Git backup ref contains an unexpected file: ${file}`);
      }
      const relative = file.slice(scope.length + 1);
      const destination = path.join(outputPath, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      // Table dumps can be tens of megabytes on real agent databases; the
      // 1MB exec default would truncate them into a hash-mismatch failure.
      await fs.writeFile(
        destination,
        await requireGitBuffer(repositoryPath, ["show", `${commit}:${file}`], {
          maxOutputBytes: GIT_BACKUP_MATERIALIZE_MAX_BYTES,
        }),
        { mode: 0o600 },
      );
    }
    return {
      commit,
      path: outputPath,
      cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Restore one database from a Git ref to a caller-selected fresh path. */
export async function restoreGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
  targetPath: string;
}): Promise<GitBackupRestoreResult & { commit: string }> {
  const materialized = await materializeGitBackupRef(params);
  try {
    return {
      ...(await restoreGitBackupDirectory({
        sourcePath: materialized.path,
        targetPath: params.targetPath,
        expectedIdentity: params.identity,
      })),
      commit: materialized.commit,
    };
  } finally {
    await materialized.cleanup();
  }
}

/** Verify a Git snapshot by restoring it privately and comparing every table digest. */
export async function verifyGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
}): Promise<GitBackupRestoreResult & { commit: string }> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-verify-"));
  await fs.chmod(scratch, 0o700);
  try {
    return await restoreGitBackupRef({
      ...params,
      targetPath: path.join(scratch, "database.sqlite"),
    });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Return bounded Git backup log entries for CLI rendering. */
export async function readGitBackupLog(params: {
  repositoryPath: string;
  limit: number;
}): Promise<Array<{ commit: string; date: string; message: string }>> {
  await assertGitRepository(params.repositoryPath);
  const result = await runGit(params.repositoryPath, [
    "log",
    `--max-count=${params.limit}`,
    "--pretty=format:%H%x09%cI%x09%s",
  ]);
  if (result.code !== 0) {
    if (result.stderr.includes("does not have any commits yet")) {
      return [];
    }
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit = "", date = "", ...message] = line.split("\t");
      return { commit, date, message: message.join("\t") };
    });
}
