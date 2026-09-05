import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("ManagedWorktreeService canonical paths", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  async function cloneRepository(name: string, originUrl?: string): Promise<string> {
    const target = path.join(root, name);
    await execFileAsync("git", ["clone", "--no-hardlinks", repo, target]);
    await git(
      target,
      "remote",
      "set-url",
      "origin",
      originUrl ?? (await git(repo, "config", "--get", "remote.origin.url")),
    );
    return await fs.realpath(target);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-canonical-paths-"),
    );
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    await fs.mkdir(stateDir, { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({ env });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("keeps registry operations anchored to the primary checkout", async () => {
    const linked = path.join(root, "linked-source");
    await git(repo, "worktree", "add", "-b", "linked-source", linked, "HEAD");
    const linkedRoot = await fs.realpath(linked);
    const created = await service.create({
      repoRoot: linkedRoot,
      name: "linked-task",
      baseRef: "HEAD",
    });
    expect(created.repoRoot).toBe(repo);
    await git(repo, "worktree", "remove", "--force", linkedRoot);

    await service.acquire(created.id);
    await service.release(created.id);
    await service.remove({ id: created.id, reason: "linked-source-removed" });
    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("base\n");
  });

  it("repairs removal to the live checkout repository before snapshotting", async () => {
    const canonicalLiveRepo = await cloneRepository("live-normal");
    const liveIdentity = await service.resolveRepositoryIdentity(canonicalLiveRepo);
    const staleIdentity = await service.resolveRepositoryIdentity(repo);
    const created = await service.create({
      repoRoot: canonicalLiveRepo,
      name: "repository-rebind-normal",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:normal",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "normal tracked change\n");
    await fs.writeFile(path.join(created.path, "untracked.txt"), "normal untracked change\n");
    const staleHead = await git(repo, "rev-parse", "HEAD");
    const snapshotRef = `refs/openclaw/snapshots/${created.id}`;
    await git(repo, "branch", created.branch, staleHead);
    await git(repo, "update-ref", snapshotRef, staleHead);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET repo_root = ?, repo_fingerprint = ? WHERE id = ?")
      .run(staleIdentity.repoRoot, staleIdentity.fingerprint, created.id);

    const removed = await service.remove({
      id: created.id,
      reason: "repository-rebind",
    });

    expect(removed).toEqual({ removed: true, snapshotRef });
    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      repoRoot: liveIdentity.repoRoot,
      repoFingerprint: liveIdentity.fingerprint,
      path: created.path,
      branch: created.branch,
      baseRef: created.baseRef,
      ownerKind: "session",
      ownerId: "agent:main:normal",
      snapshotRef,
    });
    expect(await git(canonicalLiveRepo, "show-ref", "--verify", snapshotRef)).not.toBe("");
    expect(await git(canonicalLiveRepo, "branch", "--list", created.branch)).toBe("");
    expect(await git(repo, "rev-parse", snapshotRef)).toBe(staleHead);
    expect(await git(repo, "rev-parse", created.branch)).toBe(staleHead);

    const restored = await service.restore({ id: created.id });
    expect(restored.repoRoot).toBe(liveIdentity.repoRoot);
    expect(restored.path).toBe(created.path);
    expect(await git(restored.path, "branch", "--show-current")).toBe(created.branch);
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "normal tracked change\n",
    );
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "normal untracked change\n",
    );
  });

  it("rejects a live checkout from a different-origin repository before mutation", async () => {
    const differentOrigin = path.join(root, "different-origin.git");
    await execFileAsync("git", ["clone", "--bare", repo, differentOrigin]);
    const liveRepo = await cloneRepository("live-different-origin", differentOrigin);
    const staleIdentity = await service.resolveRepositoryIdentity(repo);
    const created = await service.create({
      repoRoot: liveRepo,
      name: "repository-rebind-different-origin",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:different-origin",
    });
    await fs.writeFile(path.join(created.path, "README.md"), "do not snapshot or remove\n");
    const liveBranch = await git(liveRepo, "rev-parse", created.branch);
    const staleHead = await git(repo, "rev-parse", "HEAD");
    const snapshotRef = `refs/openclaw/snapshots/${created.id}`;
    await git(repo, "branch", created.branch, staleHead);
    await git(repo, "update-ref", snapshotRef, staleHead);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET repo_root = ?, repo_fingerprint = ? WHERE id = ?")
      .run(staleIdentity.repoRoot, staleIdentity.fingerprint, created.id);
    const registered = getRegistryWorktree(env, created.id);

    await expect(service.remove({ id: created.id, reason: "different-origin" })).rejects.toThrow(
      "origin",
    );

    expect(getRegistryWorktree(env, created.id)).toEqual(registered);
    expect(registered).toMatchObject({
      repoRoot: staleIdentity.repoRoot,
      repoFingerprint: staleIdentity.fingerprint,
      path: created.path,
      ownerId: "agent:main:different-origin",
    });
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
      "do not snapshot or remove\n",
    );
    expect(await git(liveRepo, "rev-parse", created.branch)).toBe(liveBranch);
    await expect(git(liveRepo, "show-ref", "--verify", snapshotRef)).rejects.toThrow();
    expect(await git(repo, "rev-parse", created.branch)).toBe(staleHead);
    expect(await git(repo, "rev-parse", snapshotRef)).toBe(staleHead);
  });

  it("repairs the live repository before lossless cleanup releases its Git lock", async () => {
    const liveRepo = await cloneRepository("live-lossless");
    const liveIdentity = await service.resolveRepositoryIdentity(liveRepo);
    const staleIdentity = await service.resolveRepositoryIdentity(repo);
    const created = await service.create({
      repoRoot: liveIdentity.repoRoot,
      name: "repository-rebind-lossless",
      baseRef: "HEAD",
      ownerKind: "workboard",
      ownerId: "card-repository-rebind",
    });
    await service.acquire(created.id);
    openOpenClawStateDatabase({ env })
      .db.prepare("UPDATE worktrees SET repo_root = ?, repo_fingerprint = ? WHERE id = ?")
      .run(staleIdentity.repoRoot, staleIdentity.fingerprint, created.id);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);

    expect(getRegistryWorktree(env, created.id)).toMatchObject({
      repoRoot: liveIdentity.repoRoot,
      repoFingerprint: liveIdentity.fingerprint,
      removedAt: expect.any(Number),
      runEndCleanup: { outcome: "removed-lossless" },
    });
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "canonicalizes managed paths minted below a symlinked state directory",
    async () => {
      const realStateDir = await fs.mkdtemp(path.join(root, "real-state-"));
      const linkedStateDir = path.join(root, "linked-state");
      await fs.symlink(realStateDir, linkedStateDir, "dir");
      const linkedStateService = new ManagedWorktreeService({
        env: { ...process.env, OPENCLAW_STATE_DIR: linkedStateDir },
      });

      const created = await linkedStateService.create({
        repoRoot: repo,
        name: "canonical-state",
        baseRef: "HEAD",
      });
      const expectedPath = path.join(
        await fs.realpath(realStateDir),
        "worktrees",
        created.repoFingerprint,
        "canonical-state",
      );
      expect(created.path).toBe(expectedPath);

      await linkedStateService.acquire(created.id);
      await expect(linkedStateService.removeIfLossless(created.id)).resolves.toBe(true);
      await expect(fs.stat(expectedPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
