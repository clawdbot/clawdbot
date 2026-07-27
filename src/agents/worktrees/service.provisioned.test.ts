import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteRegistryWorktree,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedPaths,
  insertRegistryWorktree,
} from "./registry.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initializeRepository(root: string, gitTemplate: string): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main", `--template=${gitTemplate}`);
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

async function addRemote(root: string, repo: string): Promise<void> {
  const remote = path.join(root, "remote.git");
  await execFileAsync("git", ["clone", "--bare", repo, remote]);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "-a");
}

describe("ManagedWorktreeService provisioned state", () => {
  let templateRoot: string;
  let templateRepo: string;
  let gitTemplate: string;
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  beforeAll(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    templateRoot = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-state-template-"));
    gitTemplate = path.join(templateRoot, "git-template");
    await fs.mkdir(path.join(gitTemplate, "hooks"), { recursive: true });
    templateRepo = await initializeRepository(templateRoot, gitTemplate);
  });

  afterAll(async () => {
    await fs.rm(templateRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-state-"));
    repo = path.join(root, "repo");
    await fs.cp(templateRepo, repo, { mode: fsConstants.COPYFILE_FICLONE, recursive: true });
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("snapshots large provisioned files without buffering them in the service", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "large.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "large.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    const source = Buffer.alloc(2 * 1024 * 1024, 0x61);
    await fs.writeFile(path.join(repo, "large.local"), source);
    await addRemote(root, repo);

    const created = await service.create({ repoRoot: repo, name: "large-local" });
    await service.acquire(created.id);
    const copyPath = path.join(created.path, "large.local");
    const copy = Buffer.from(source);
    copy[copy.length - 1] = 0x62;
    await fs.writeFile(copyPath, copy);

    expect(await service.removeIfLossless(created.id)).toBe(true);
    await fs.writeFile(path.join(repo, "large.local"), Buffer.from("new source"));
    const restored = await service.restore({ id: created.id });
    expect((await fs.readFile(path.join(restored.path, "large.local"))).at(-1)).toBe(0x62);
  });

  it("keeps provisioned files protected after manifest removal or pattern changes", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\nsettings.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\nsettings.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=source\n");
    await fs.writeFile(path.join(repo, "settings.local"), "theme=source\n");
    await addRemote(root, repo);

    const manifestRemoved = await service.create({ repoRoot: repo, name: "manifest-removed" });
    const patternRemoved = await service.create({ repoRoot: repo, name: "pattern-removed" });
    const restorable = await service.create({ repoRoot: repo, name: "manifest-restorable" });
    await service.acquire(manifestRemoved.id);
    await service.acquire(patternRemoved.id);
    await service.acquire(restorable.id);

    await fs.rm(path.join(repo, ".worktreeinclude"));
    await fs.writeFile(path.join(manifestRemoved.path, ".env.local"), "value=rotated\n");
    expect(await service.removeIfLossless(manifestRemoved.id)).toBe(true);
    const restoredManifest = await service.restore({ id: manifestRemoved.id });
    expect(await fs.readFile(path.join(restoredManifest.path, ".env.local"), "utf8")).toBe(
      "value=rotated\n",
    );

    await fs.writeFile(path.join(repo, ".worktreeinclude"), "settings.local\n");
    await fs.writeFile(path.join(patternRemoved.path, ".env.local"), "value=pattern-rotated\n");
    expect(await service.removeIfLossless(patternRemoved.id)).toBe(true);
    const restoredPattern = await service.restore({ id: patternRemoved.id });
    expect(await fs.readFile(path.join(restoredPattern.path, ".env.local"), "utf8")).toBe(
      "value=pattern-rotated\n",
    );

    await fs.rm(path.join(repo, ".worktreeinclude"));
    expect(await service.removeIfLossless(restorable.id)).toBe(true);
    const restored = await service.restore({ id: restorable.id });
    expect(await fs.readFile(path.join(restored.path, ".env.local"), "utf8")).toBe(
      "value=source\n",
    );
    expect(await fs.readFile(path.join(restored.path, "settings.local"), "utf8")).toBe(
      "theme=source\n",
    );
  });

  it("fails closed for pre-ledger worktrees whose ignored state is unknown", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore local environment");
    await addRemote(root, repo);
    const legacyPath = path.join(root, "legacy-worktree");
    await git(repo, "worktree", "add", "-b", "openclaw/legacy", legacyPath, "HEAD");
    insertRegistryWorktree(env, {
      id: "legacy",
      name: "legacy",
      repoFingerprint: "legacy-fingerprint",
      repoRoot: repo,
      path: legacyPath,
      branch: "openclaw/legacy",
      baseRef: "HEAD",
      ownerKind: "session",
      createdAt: now,
      lastActiveAt: now,
    });
    await fs.writeFile(path.join(legacyPath, ".env.local"), "unknown-user-state\n");
    expect(await git(legacyPath, "status", "--porcelain")).toBe("");

    expect(await service.removeIfLossless("legacy")).toBe(false);
    await expect(service.remove({ id: "legacy", reason: "manual" })).rejects.toThrow(
      "provisioned path ledger is unavailable",
    );
    expect(await fs.readFile(path.join(legacyPath, ".env.local"), "utf8")).toBe(
      "unknown-user-state\n",
    );
  });

  it("fails closed when a provisioned path becomes tracked or unignored", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=source\n");

    const tracked = await service.create({ repoRoot: repo, name: "tracked-provisioned" });
    await git(tracked.path, "add", "-f", ".env.local");
    await git(tracked.path, "commit", "-m", "track provisioned file");
    await expect(service.remove({ id: tracked.id, reason: "manual" })).rejects.toThrow(
      "provisioned path is now tracked",
    );
    await git(tracked.path, "rm", "--cached", ".env.local");
    await expect(service.remove({ id: tracked.id, reason: "manual" })).rejects.toThrow(
      "provisioned path is tracked at HEAD",
    );

    const unignored = await service.create({ repoRoot: repo, name: "unignored-provisioned" });
    await fs.writeFile(path.join(unignored.path, ".gitignore"), "");
    await expect(service.remove({ id: unignored.id, reason: "manual" })).rejects.toThrow(
      "provisioned path is no longer ignored",
    );
    expect(await fs.readFile(path.join(unignored.path, ".env.local"), "utf8")).toBe(
      "value=source\n",
    );
  });

  it.skipIf(process.platform === "win32")(
    "round trips literal pathspec characters and POSIX backslashes",
    async () => {
      const wildcardName = "literal*.local";
      const backslashName = "foo\\bar.local";
      await fs.writeFile(path.join(repo, "literal-one.local"), "tracked\n");
      await fs.writeFile(path.join(repo, ".gitignore"), "literal*.local\nfoo\\\\bar.local\n");
      await fs.writeFile(path.join(repo, ".worktreeinclude"), "literal*.local\nfoo\\\\bar.local\n");
      await git(repo, "add", ".gitignore", ".worktreeinclude");
      await git(repo, "add", "-f", "literal-one.local");
      await git(repo, "commit", "-m", "configure literal worktree provisioning");
      await fs.writeFile(path.join(repo, wildcardName), "wildcard source\n");
      await fs.writeFile(path.join(repo, backslashName), "backslash source\n");

      const created = await service.create({ repoRoot: repo, name: "literal-paths" });
      await fs.writeFile(path.join(created.path, wildcardName), "wildcard local\n");
      await fs.writeFile(path.join(created.path, backslashName), "backslash local\n");
      await service.remove({ id: created.id, reason: "test" });
      const restored = await service.restore({ id: created.id });

      expect(await fs.readFile(path.join(restored.path, wildcardName), "utf8")).toBe(
        "wildcard local\n",
      );
      expect(await fs.readFile(path.join(restored.path, backslashName), "utf8")).toBe(
        "backslash local\n",
      );
    },
  );

  it("upgrades the provisioned ledger when restoring a pre-ledger snapshot", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=source\n");
    await addRemote(root, repo);

    const created = await service.create({ repoRoot: repo, name: "legacy-restore" });
    await service.remove({ id: created.id, reason: "test" });
    const removed = getRegistryWorktree(env, created.id)!;
    deleteRegistryWorktree(env, created.id);
    insertRegistryWorktree(env, removed);

    const restored = await service.restore({ id: created.id });
    expect(getRegistryWorktreeProvisionedPaths(env, created.id)).toEqual([".env.local"]);
    await fs.writeFile(path.join(restored.path, ".env.local"), "value=restored-local\n");
    expect(await service.removeIfLossless(created.id)).toBe(true);
    const roundTripped = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(roundTripped.path, ".env.local"), "utf8")).toBe(
      "value=restored-local\n",
    );
  });

  it("snapshots deleted skip-worktree files still included by sparse rules", async () => {
    const created = await service.create({ repoRoot: repo, name: "stale-sparse-bit" });
    await git(created.path, "sparse-checkout", "set", "--no-cone", "/*");
    await git(created.path, "update-index", "--skip-worktree", "README.md");
    await fs.rm(path.join(created.path, "README.md"));

    await service.remove({ id: created.id, reason: "test" });
    const restored = await service.restore({ id: created.id });

    await expect(fs.stat(path.join(restored.path, "README.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform !== "linux")(
    "snapshots non-UTF-8 Git paths byte-for-byte",
    async () => {
      const rawName = Buffer.from([0x72, 0x61, 0x77, 0xff]);
      const sourcePath = Buffer.concat([Buffer.from(repo), Buffer.from(path.sep), rawName]);
      await fs.writeFile(sourcePath, "source\n");
      await git(repo, "add", "-A");
      await git(repo, "commit", "-m", "add raw path");

      const created = await service.create({ repoRoot: repo, name: "raw-path" });
      const worktreePath = Buffer.concat([
        Buffer.from(created.path),
        Buffer.from(path.sep),
        rawName,
      ]);
      await fs.writeFile(worktreePath, "local bytes\n");
      await service.remove({ id: created.id, reason: "test" });
      const restored = await service.restore({ id: created.id });
      const restoredPath = Buffer.concat([
        Buffer.from(restored.path),
        Buffer.from(path.sep),
        rawName,
      ]);

      expect(await fs.readFile(restoredPath, "utf8")).toBe("local bytes\n");
    },
  );
});
