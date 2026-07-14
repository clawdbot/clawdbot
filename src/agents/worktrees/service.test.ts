import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { getRegistryWorktree } from "./registry.js";
import {
  IDLE_GC_MS,
  ManagedWorktreeService,
  resolveWorktreeCleanupLimits,
  SNAPSHOT_RETENTION_MS,
} from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin?.end(input);
  });
}

async function initializeRepository(root: string, name = "repo"): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

async function addRemote(root: string, repo: string): Promise<string> {
  const remote = path.join(root, "remote.git");
  await execFileAsync("git", ["clone", "--bare", repo, remote]);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "-a");
  return remote;
}

describe("ManagedWorktreeService", () => {
  let templateRoot: string;
  let templateRepo: string;
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  beforeAll(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    templateRoot = await fs.mkdtemp(path.join(tempRoot, "openclaw-managed-worktrees-template-"));
    templateRepo = await initializeRepository(templateRoot);
  });

  afterAll(async () => {
    await fs.rm(templateRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-managed-worktrees-"));
    repo = path.join(root, "repo");
    await fs.cp(templateRepo, repo, { recursive: true });
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "openclaw-state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates from origin HEAD and returns the existing live named worktree", async () => {
    await addRemote(root, repo);
    const created = await service.create({ repoRoot: repo, name: "remote-task" });
    const repeated = await service.create({ repoRoot: repo, name: "remote-task" });

    expect(created.baseRef).toBe("origin/main");
    expect(created.branch).toBe("openclaw/remote-task");
    expect(created.path).toContain(path.join("worktrees", created.repoFingerprint, "remote-task"));
    expect(await git(created.path, "branch", "--show-current")).toBe(created.branch);
    expect(repeated).toEqual(created);
  });

  it("lists repository branches default-first with deterministic ordering", async () => {
    await addRemote(root, repo);
    await git(repo, "branch", "feature-a");
    await git(repo, "push", "origin", "feature-a");
    await git(repo, "branch", "-D", "feature-a");
    await git(repo, "branch", "zeta-local");
    await git(repo, "checkout", "-b", "current-work");

    const result = await service.listRepositoryBranches(repo);
    expect(result.defaultBranch).toBe("main");
    expect(result.headBranch).toBe("current-work");
    // Remote-only branches keep their remote-qualified form so the returned
    // name always resolves as a git worktree base ref.
    expect(result.branches.map((branch) => branch.name)).toEqual([
      "main",
      "current-work",
      "origin/feature-a",
      "zeta-local",
    ]);
    expect(result.branches.find((branch) => branch.name === "origin/feature-a")?.kind).toBe(
      "remote",
    );
    expect(result.branches.find((branch) => branch.name === "main")?.kind).toBe("local");
  });

  it("creates a worktree from a remote-only branch ref returned by the picker", async () => {
    await addRemote(root, repo);
    await git(repo, "checkout", "-b", "remote-only");
    await fs.writeFile(path.join(repo, "remote-only.txt"), "remote\n");
    await git(repo, "add", "remote-only.txt");
    await git(repo, "commit", "-m", "remote only commit");
    await git(repo, "push", "origin", "remote-only");
    const remoteCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "remote-only");

    const listed = await service.listRepositoryBranches(repo);
    const remoteRef = listed.branches.find((branch) => branch.kind === "remote")?.name;
    expect(remoteRef).toBe("origin/remote-only");
    const created = await service.create({
      repoRoot: repo,
      name: "from-remote",
      baseRef: remoteRef,
    });
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteCommit);
    expect(
      await git(created.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    ).toBe("origin/remote-only");
  });

  it("lists local branches without a remote", async () => {
    await git(repo, "branch", "side");
    const result = await service.listRepositoryBranches(repo);
    expect(result.defaultBranch).toBeUndefined();
    expect(result.headBranch).toBe("main");
    expect(result.branches.map((branch) => branch.name)).toEqual(["main", "side"]);
    expect(result.branches.every((branch) => branch.kind === "local")).toBe(true);
  });

  it("creates a worktree from an explicit base ref", async () => {
    await git(repo, "checkout", "-b", "base-branch");
    await fs.writeFile(path.join(repo, "base.txt"), "base branch file\n");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "base branch commit");
    const baseCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");

    const created = await service.create({
      repoRoot: repo,
      name: "based-task",
      baseRef: "base-branch",
    });
    expect(created.baseRef).toBe("base-branch");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(baseCommit);
  });

  it("normalizes dashed refs and revision expressions before creating branches", async () => {
    const initialCommit = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "history.txt"), "second\n");
    await git(repo, "add", "history.txt");
    await git(repo, "commit", "-m", "second commit");
    const secondCommit = await git(repo, "rev-parse", "HEAD");
    await fs.appendFile(path.join(repo, "history.txt"), "third\n");
    await git(repo, "add", "history.txt");
    await git(repo, "commit", "-m", "third commit");
    const thirdCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/tags/--force", thirdCommit);
    await git(repo, "reset", "--hard", initialCommit);

    const fromRef = await service.create({
      repoRoot: repo,
      name: "dashed-ref",
      baseRef: "--force",
    });
    const fromExpression = await service.create({
      repoRoot: repo,
      name: "dashed-expression",
      baseRef: "--force~1",
    });

    expect(fromRef.baseRef).toBe("--force");
    expect(await git(fromRef.path, "rev-parse", "HEAD")).toBe(thirdCommit);
    expect(fromExpression.baseRef).toBe("--force~1");
    expect(await git(fromExpression.path, "rev-parse", "HEAD")).toBe(secondCommit);
  });

  it("preserves Git's bare-dash previous-checkout shorthand", async () => {
    await git(repo, "checkout", "-b", "previous");
    await fs.writeFile(path.join(repo, "previous.txt"), "previous\n");
    await git(repo, "add", "previous.txt");
    await git(repo, "commit", "-m", "previous checkout commit");
    const previousCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");

    const created = await service.create({
      repoRoot: repo,
      name: "previous-checkout",
      baseRef: "-",
    });

    expect(created.baseRef).toBe("-");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(previousCommit);
  });

  it("rejects ambiguous dashed refs instead of choosing by ref precedence", async () => {
    const initialCommit = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "tag.txt"), "tag\n");
    await git(repo, "add", "tag.txt");
    await git(repo, "commit", "-m", "tag candidate");
    const tagCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "reset", "--hard", initialCommit);
    await fs.writeFile(path.join(repo, "branch.txt"), "branch\n");
    await git(repo, "add", "branch.txt");
    await git(repo, "commit", "-m", "branch candidate");
    const branchCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/tags/--ambiguous", tagCommit);
    await git(repo, "update-ref", "refs/heads/--ambiguous", branchCommit);
    await git(repo, "config", "core.warnAmbiguousRefs", "false");

    await expect(
      service.create({
        repoRoot: repo,
        name: "ambiguous-ref",
        baseRef: "--ambiguous",
      }),
    ).rejects.toThrow(/git rev-parse --symbolic-full-name --verify failed/);

    expect(await git(repo, "branch", "--list", "openclaw/ambiguous-ref")).toBe("");
    expect(await service.list()).toEqual([]);
  });

  it.each(["--lock", "--orphan"])(
    "rejects absent dashed base %s without creating worktree state",
    async (baseRef) => {
      const before = await git(repo, "worktree", "list", "--porcelain");
      const name = baseRef.slice(2);

      await expect(service.create({ repoRoot: repo, name, baseRef })).rejects.toThrow(
        /git rev-parse --symbolic-full-name --verify failed/,
      );

      expect(await git(repo, "worktree", "list", "--porcelain")).toBe(before);
      expect(await git(repo, "branch", "--list", `openclaw/${name}`)).toBe("");
      expect(await service.list()).toEqual([]);
      await expect(fs.stat(path.join(env.OPENCLAW_STATE_DIR!, "worktrees"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects name reuse across owners instead of adopting a foreign worktree", async () => {
    await service.create({
      repoRoot: repo,
      name: "shared-name",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:one",
    });
    await expect(
      service.create({
        repoRoot: repo,
        name: "shared-name",
        ownerKind: "session",
        ownerId: "agent:main:dashboard:two",
      }),
    ).rejects.toThrow(/already in use by session/);
    await expect(service.create({ repoRoot: repo, name: "shared-name" })).rejects.toThrow(
      /already in use by session/,
    );
    // The rightful owner still reuses its record.
    const reused = await service.create({
      repoRoot: repo,
      name: "shared-name",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:one",
    });
    expect(reused.ownerId).toBe("agent:main:dashboard:one");
  });

  it("does not remove a concurrent successful create during remote fallback", async () => {
    await addRemote(root, repo);

    const results = await Promise.allSettled([
      service.create({ repoRoot: repo, name: "concurrent" }),
      service.create({ repoRoot: repo, name: "concurrent" }),
    ]);
    const created = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
        result.status === "fulfilled",
    )?.value;

    expect(created).toBeDefined();
    if (!created) {
      throw new Error("expected one concurrent create to succeed");
    }
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(created.path);
    expect(await git(created.path, "branch", "--show-current")).toBe("openclaw/concurrent");
  });

  it("falls back to local HEAD when fetch fails", async () => {
    await git(repo, "remote", "add", "origin", path.join(root, "missing.git"));
    const created = await service.create({ repoRoot: repo, name: "offline" });
    expect(created.baseRef).toBe("HEAD");
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("keeps registry operations anchored to the primary checkout", async () => {
    const linked = path.join(root, "linked-source");
    await git(repo, "worktree", "add", "-b", "linked-source", linked, "HEAD");
    const linkedRoot = await fs.realpath(linked);
    const created = await service.create({ repoRoot: linkedRoot, name: "linked-task" });
    expect(created.repoRoot).toBe(repo);
    await git(repo, "worktree", "remove", "--force", linkedRoot);

    await service.acquire(created.id);
    await service.release(created.id);
    await service.remove({ id: created.id, reason: "linked-source-removed" });
    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("retries worktree add from local HEAD when the resolved remote base is stale", async () => {
    await addRemote(root, repo);
    const blob = await git(repo, "rev-parse", "HEAD:README.md");
    const tooLongForCheckout = "x".repeat(300);
    const tree = await gitWithInput(
      repo,
      ["mktree"],
      `100644 blob ${blob}\t${tooLongForCheckout}\n`,
    );
    const remoteCommit = await git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "bad remote");
    await git(repo, "push", "--force", "origin", `${remoteCommit}:refs/heads/main`);
    const created = await service.create({ repoRoot: repo, name: "stale-remote" });
    expect(created.baseRef).toBe("HEAD");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(await git(repo, "rev-parse", "HEAD"));
  });

  it("preserves a pre-existing branch when a managed name collides", async () => {
    await addRemote(root, repo);
    await git(repo, "branch", "openclaw/existing-name", "HEAD");
    const branchTip = await git(repo, "rev-parse", "openclaw/existing-name");

    await expect(service.create({ repoRoot: repo, name: "existing-name" })).rejects.toThrow(
      "branch already exists",
    );

    expect(await git(repo, "rev-parse", "openclaw/existing-name")).toBe(branchTip);
  });

  it("copies only included ignored regular files without following symlinks", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "cache/\nlinked\nlinked-dir/\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "cache/*.txt\nlinked\nlinked-dir/**\n");
    await fs.mkdir(path.join(repo, "cache"));
    await fs.writeFile(path.join(repo, "cache", "keep.txt"), "keep\n", { mode: 0o744 });
    await fs.writeFile(path.join(repo, "cache", "skip.bin"), "skip\n");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "secret\n");
    await fs.symlink(outside, path.join(repo, "linked"));
    const outsideDir = path.join(root, "outside-dir");
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "escape.txt"), "secret\n");
    await fs.symlink(outsideDir, path.join(repo, "linked-dir"));

    const created = await service.create({ repoRoot: repo, name: "includes" });
    const copied = path.join(created.path, "cache", "keep.txt");
    expect(await fs.readFile(copied, "utf8")).toBe("keep\n");
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o744);
    await expect(fs.stat(path.join(created.path, "cache", "skip.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(created.path, "linked"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(created.path, "linked-dir", "escape.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites a base-ref file with an ignored source candidate", async () => {
    await fs.writeFile(path.join(repo, "collision.txt"), "from base\n");
    await git(repo, "add", "collision.txt");
    await git(repo, "commit", "-m", "base collision");
    await git(repo, "checkout", "-b", "source");
    await git(repo, "rm", "collision.txt");
    await fs.writeFile(path.join(repo, ".gitignore"), "collision.txt\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore local collision");
    await fs.writeFile(path.join(repo, "collision.txt"), "from source\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "collision.txt\n");

    const created = await service.create({
      repoRoot: repo,
      name: "no-overwrite",
      baseRef: "main",
    });

    expect(await fs.readFile(path.join(created.path, "collision.txt"), "utf8")).toBe("from base\n");
  });

  it("runs an executable setup script with source and worktree paths", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.writeFile(
      script,
      '#!/bin/sh\nprintf "%s\\n%s\\n" "$OPENCLAW_SOURCE_TREE_PATH" "$OPENCLAW_WORKTREE_PATH" > setup-paths.txt\n',
      { mode: 0o755 },
    );
    const created = await service.create({ repoRoot: repo, name: "setup" });
    expect(
      (await fs.readFile(path.join(created.path, "setup-paths.txt"), "utf8")).split("\n"),
    ).toEqual([repo, created.path, ""]);
  });

  it("removes the worktree and branch when setup fails", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.writeFile(script, "#!/bin/sh\necho setup-broke >&2\nexit 9\n", { mode: 0o755 });
    await expect(service.create({ repoRoot: repo, name: "broken-setup" })).rejects.toThrow(
      "setup-broke",
    );
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("broken-setup");
    expect(await git(repo, "branch", "--list", "openclaw/broken-setup")).toBe("");
  });

  it("restores tracked and untracked state while reprovisioning ignored files", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\nprovisioned.env\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "provisioned.env\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, "provisioned.env"), "source secret\n");
    const created = await service.create({ repoRoot: repo, name: "roundtrip" });
    const originalHead = await git(created.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(created.path, "README.md"), "changed\n");
    await fs.writeFile(path.join(created.path, "untracked.txt"), "untracked\n");
    await fs.writeFile(path.join(created.path, "ignored.txt"), "ignored\n");

    const removed = await service.remove({ id: created.id, reason: "test" });
    expect(removed).toMatchObject({ removed: true, snapshotRef: expect.any(String) });
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "show-ref", "--verify", removed.snapshotRef!)).not.toBe("");
    const snapshotFiles = await git(repo, "ls-tree", "-r", "--name-only", removed.snapshotRef!);
    expect(snapshotFiles).not.toContain("ignored.txt");
    expect(snapshotFiles).not.toContain("provisioned.env");

    now += IDLE_GC_MS + 1;
    const restored = await service.restore({ id: created.id });
    expect(restored.removedAt).toBeUndefined();
    expect(restored.lastActiveAt).toBe(now);
    expect((await service.gc()).removed).toEqual([]);
    expect(await git(restored.path, "branch", "--show-current")).toBe(created.branch);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await git(restored.path, "log", "--format=%s", created.branch)).not.toContain(
      "OpenClaw worktree snapshot",
    );
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("changed\n");
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(await fs.readFile(path.join(restored.path, "provisioned.env"), "utf8")).toBe(
      "source secret\n",
    );
    await expect(fs.stat(path.join(restored.path, "ignored.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await git(restored.path, "status", "--porcelain")).split("\n")).toEqual([
      "M README.md",
      "?? untracked.txt",
    ]);
    expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(restored.path, "diff", "--name-only")).toBe("README.md");
  });

  it("refuses to overwrite a branch recreated before restore", async () => {
    const created = await service.create({ repoRoot: repo, name: "restore-collision" });
    await service.remove({ id: created.id, reason: "test" });
    await git(repo, "branch", created.branch, "HEAD");
    const branchTip = await git(repo, "rev-parse", created.branch);

    await expect(service.restore({ id: created.id })).rejects.toThrow("already exists");

    expect(await git(repo, "rev-parse", created.branch)).toBe(branchTip);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a nested repository cannot be captured in full", async () => {
    const created = await service.create({ repoRoot: repo, name: "nested-repository" });
    const nested = await initializeRepository(created.path, "nested");
    await fs.writeFile(path.join(nested, "untracked-secret.txt"), "do not lose\n");

    await expect(service.remove({ id: created.id, reason: "test" })).rejects.toThrow(
      "nested git repositories cannot be snapshotted losslessly",
    );

    expect(await fs.readFile(path.join(nested, "untracked-secret.txt"), "utf8")).toBe(
      "do not lose\n",
    );
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("rematerializes a named workboard checkout from its retained snapshot", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "wb-card",
      ownerKind: "workboard",
      ownerId: "card",
    });
    await fs.writeFile(path.join(created.path, "worker.txt"), "worker state\n");
    await service.remove({ id: created.id, reason: "run-end" });

    const reusedFromSource = await service.create({
      repoRoot: repo,
      name: "wb-card",
      baseRef: created.branch,
      ownerKind: "workboard",
      ownerId: "card",
    });

    expect(reusedFromSource.id).toBe(created.id);
    expect(await fs.readFile(path.join(reusedFromSource.path, "worker.txt"), "utf8")).toBe(
      "worker state\n",
    );
  });

  it("removes lossless run-end worktrees but keeps dirty and unpushed work", async () => {
    await addRemote(root, repo);
    const clean = await service.create({ repoRoot: repo, name: "clean" });
    await service.acquire(clean.id);
    expect(await service.removeIfLossless(clean.id)).toBe(true);

    const dirty = await service.create({ repoRoot: repo, name: "dirty" });
    await service.acquire(dirty.id);
    await fs.writeFile(path.join(dirty.path, "dirty.txt"), "dirty\n");
    expect(await service.removeIfLossless(dirty.id)).toBe(false);
    expect(
      (await service.list()).find((entry) => entry.id === dirty.id)?.removedAt,
    ).toBeUndefined();

    const committed = await service.create({ repoRoot: repo, name: "committed" });
    await service.acquire(committed.id);
    await fs.writeFile(path.join(committed.path, "commit.txt"), "commit\n");
    await git(committed.path, "add", "commit.txt");
    await git(committed.path, "commit", "-m", "unpushed");
    expect(await service.removeIfLossless(committed.id)).toBe(false);
  });

  it("exempts manual worktrees and garbage collects idle run-owned worktrees", async () => {
    const manual = await service.create({ repoRoot: repo, name: "manual-idle" });
    const created = await service.create({
      repoRoot: repo,
      name: "idle-dead",
      ownerKind: "workboard",
    });
    await git(repo, "worktree", "lock", "--reason", "openclaw pid=999999", created.path);
    now += IDLE_GC_MS + 1;

    const result = await service.gc();
    expect(result.removed).toEqual([created.id]);
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeTruthy();
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(manual.path)).toBeTruthy();
  });

  it("uses owner activity to protect only active idle session worktrees", async () => {
    const active = await service.create({
      repoRoot: repo,
      name: "active-session",
      ownerKind: "session",
      ownerId: "agent:main:active",
    });
    const inactive = await service.create({
      repoRoot: repo,
      name: "inactive-session",
      ownerKind: "session",
      ownerId: "agent:main:inactive",
    });
    now += IDLE_GC_MS + 1;
    const isOwnerActive = vi.fn(
      (_ownerKind: string, ownerId: string) => ownerId === "agent:main:active",
    );

    const result = await service.gc({ isOwnerActive });

    expect(result.removed).toEqual([inactive.id]);
    expect(isOwnerActive).toHaveBeenCalledWith("session", "agent:main:active");
    expect(isOwnerActive).toHaveBeenCalledWith("session", "agent:main:inactive");
    expect(getRegistryWorktree(env, active.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, inactive.id)?.removedAt).toBeDefined();
  });

  it("protects foreign locks during idle garbage collection", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "foreign-lock",
      ownerKind: "session",
    });
    await git(repo, "worktree", "lock", "--reason", "other-tool", created.path);
    now += IDLE_GC_MS + 1;

    expect((await service.gc()).removed).toEqual([]);
    expect(await fs.stat(created.path)).toBeTruthy();
  });

  it("continues garbage collection after one worktree cannot be snapshotted", async () => {
    const removable = await service.create({
      repoRoot: repo,
      name: "removable",
      ownerKind: "workboard",
    });
    now += 1;
    const nestedRecord = await service.create({
      repoRoot: repo,
      name: "nested-idle",
      ownerKind: "workboard",
    });
    await initializeRepository(nestedRecord.path, "nested");
    now += IDLE_GC_MS + 1;

    const result = await service.gc();

    expect(result.removed).toEqual([removable.id]);
    expect(getRegistryWorktree(env, nestedRecord.id)?.removedAt).toBeUndefined();
    await expect(fs.stat(removable.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues garbage collection when one repository control path is missing", async () => {
    const otherRepo = await initializeRepository(root, "other-repo");
    const removable = await service.create({
      repoRoot: otherRepo,
      name: "other-removable",
      ownerKind: "session",
    });
    now += 1;
    const broken = await service.create({
      repoRoot: repo,
      name: "missing-control",
      ownerKind: "session",
    });
    await fs.rename(repo, path.join(root, "moved-repo"));
    now += IDLE_GC_MS + 1;

    const result = await service.gc();

    expect(result.removed).toEqual([removable.id]);
    expect(getRegistryWorktree(env, broken.id)?.removedAt).toBeUndefined();
  });

  it("deletes unregistered orphan debris but preserves git-listed worktrees", async () => {
    const debris = path.join(env.OPENCLAW_STATE_DIR!, "worktrees", "orphan-fingerprint", "debris");
    await fs.mkdir(debris, { recursive: true });
    await fs.writeFile(path.join(debris, "file"), "debris");
    const foreign = path.join(env.OPENCLAW_STATE_DIR!, "worktrees", "foreign-fingerprint", "live");
    await fs.mkdir(path.dirname(foreign), { recursive: true });
    await git(repo, "worktree", "add", "--detach", foreign, "HEAD");

    const result = await service.gc();
    expect(result.orphansDeleted).toBe(1);
    await expect(fs.stat(debris)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(foreign)).toBeTruthy();
    await git(repo, "worktree", "remove", "--force", foreign);
  });

  it("evicts the least recently active run-owned worktrees over the count limit", async () => {
    const manual = await service.create({ repoRoot: repo, name: "manual-kept" });
    const oldest = await service.create({
      repoRoot: repo,
      name: "count-oldest",
      ownerKind: "session",
      ownerId: "agent:main:oldest",
    });
    now += 1;
    const middle = await service.create({
      repoRoot: repo,
      name: "count-middle",
      ownerKind: "workboard",
      ownerId: "card-middle",
    });
    now += 1;
    const newest = await service.create({
      repoRoot: repo,
      name: "count-newest",
      ownerKind: "session",
      ownerId: "agent:main:newest",
    });

    const result = await service.gc({ limits: { maxCount: 2 } });

    expect(result.removed).toEqual([oldest.id, middle.id]);
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, oldest.id)?.snapshotRef).toBeTruthy();
    await expect(fs.stat(oldest.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips active owners during count-limit eviction", async () => {
    const activeOldest = await service.create({
      repoRoot: repo,
      name: "limit-active",
      ownerKind: "session",
      ownerId: "agent:main:active",
    });
    now += 1;
    const idle = await service.create({
      repoRoot: repo,
      name: "limit-idle",
      ownerKind: "session",
      ownerId: "agent:main:idle",
    });
    const isOwnerActive = vi.fn(
      (_ownerKind: string, ownerId: string) => ownerId === "agent:main:active",
    );

    const result = await service.gc({ limits: { maxCount: 1 }, isOwnerActive });

    expect(result.removed).toEqual([idle.id]);
    expect(getRegistryWorktree(env, activeOldest.id)?.removedAt).toBeUndefined();
  });

  it("evicts oldest worktrees until total size fits the size limit", async () => {
    const oldest = await service.create({
      repoRoot: repo,
      name: "size-oldest",
      ownerKind: "session",
      ownerId: "agent:main:size-old",
    });
    await fs.writeFile(path.join(oldest.path, "blob.bin"), Buffer.alloc(10_000));
    now += 1;
    const newest = await service.create({
      repoRoot: repo,
      name: "size-newest",
      ownerKind: "session",
      ownerId: "agent:main:size-new",
    });

    const result = await service.gc({ limits: { maxTotalSizeBytes: 6_000 } });

    expect(result.removed).toEqual([oldest.id]);
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, oldest.id)?.snapshotRef).toBeTruthy();
  });

  it("keeps unmeasurable worktrees out of size accounting instead of counting zero", async () => {
    if (process.getuid?.() === 0) {
      return; // chmod-based EACCES cannot be simulated as root
    }
    const unreadable = await service.create({
      repoRoot: repo,
      name: "size-unreadable",
      ownerKind: "session",
      ownerId: "agent:main:size-unreadable",
    });
    await fs.writeFile(path.join(unreadable.path, "blob.bin"), Buffer.alloc(10_000));
    const locked = path.join(unreadable.path, "locked");
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o000);
    try {
      const result = await service.gc({ limits: { maxTotalSizeBytes: 6_000 } });
      // The failed measurement excludes the record from the size total, so the
      // limit pass does not evict against a bogus zero-byte reading.
      expect(result.removed).toEqual([]);
      expect(getRegistryWorktree(env, unreadable.id)?.removedAt).toBeUndefined();
    } finally {
      await fs.chmod(locked, 0o755);
    }
  });

  it("counts a competing removal instead of evicting an extra worktree", async () => {
    const oldest = await service.create({
      repoRoot: repo,
      name: "race-oldest",
      ownerKind: "session",
      ownerId: "agent:main:race-old",
    });
    now += 1;
    const middle = await service.create({
      repoRoot: repo,
      name: "race-middle",
      ownerKind: "session",
      ownerId: "agent:main:race-mid",
    });
    now += 1;
    const newest = await service.create({
      repoRoot: repo,
      name: "race-newest",
      ownerKind: "session",
      ownerId: "agent:main:race-new",
    });
    const realRemove = service.remove.bind(service);
    const removeSpy = vi
      .spyOn(service, "remove")
      .mockImplementationOnce(async (params: Parameters<typeof realRemove>[0]) => {
        // Simulate a concurrent cleanup winning the removal claim first.
        await realRemove({ ...params, reason: "concurrent-gc" });
        throw new Error("removal already claimed");
      });

    const result = await service.gc({ limits: { maxCount: 2 } });

    // The stale-count correction stops the pass at two live worktrees instead
    // of evicting middle as well.
    expect(result.removed).toEqual([]);
    expect(getRegistryWorktree(env, oldest.id)?.removedAt).toBeDefined();
    expect(getRegistryWorktree(env, middle.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    removeSpy.mockRestore();
  });

  it("leaves everything in place when limits are not exceeded", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "under-limit",
      ownerKind: "session",
      ownerId: "agent:main:under",
    });

    const result = await service.gc({
      limits: { maxCount: 5, maxTotalSizeBytes: 1024 ** 3 },
    });

    expect(result.removed).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("maps cleanup config onto limits with 0 and unset disabling each bound", () => {
    expect(resolveWorktreeCleanupLimits(undefined)).toEqual({});
    expect(resolveWorktreeCleanupLimits({ cleanup: { maxCount: 0, maxTotalSizeGb: 0 } })).toEqual(
      {},
    );
    expect(resolveWorktreeCleanupLimits({ cleanup: { maxCount: 25, maxTotalSizeGb: 50 } })).toEqual(
      { maxCount: 25, maxTotalSizeBytes: 50 * 1024 ** 3 },
    );
    expect(resolveWorktreeCleanupLimits({ cleanup: { maxTotalSizeGb: 0.5 } })).toEqual({
      maxTotalSizeBytes: 512 * 1024 ** 2,
    });
  });

  it("prunes expired snapshot refs and registry rows", async () => {
    const created = await service.create({ repoRoot: repo, name: "expired" });
    const removed = await service.remove({ id: created.id, reason: "retention" });
    now += SNAPSHOT_RETENTION_MS + 1;

    const result = await service.gc();
    expect(result.snapshotsPruned).toBe(1);
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
  });
});
