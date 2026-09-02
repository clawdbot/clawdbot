import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { findLiveRegistryWorktreeByPath, getRegistryWorktree } from "./registry.js";
import { IDLE_GC_MS, ManagedWorktreeService, SNAPSHOT_RETENTION_MS } from "./service.js";
import {
  useManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

async function initializeNestedRepository(root: string, name: string): Promise<string> {
  const nested = path.join(root, name);
  await fs.mkdir(nested, { recursive: true });
  await git(nested, "init", "-b", "main");
  return nested;
}

describe("ManagedWorktreeService garbage collection", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;

  async function materializeDownstreamFixture(
    name: string,
    params: {
      ownerKind?: "manual" | "session" | "workboard";
      ownerId?: string;
      provisionedPaths?: readonly string[];
      repoRoot?: string;
    } = {},
  ) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now,
      repoRoot: params.repoRoot ?? repo,
      stateDir,
      ...params,
    });
  }

  const materializeRunOwnedFixture = (
    name: string,
    ownerKind: "session" | "workboard",
    ownerId?: string,
  ) => materializeDownstreamFixture(name, { ownerKind, ownerId });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worktree-gc-"));
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("exempts manual worktrees and garbage collects idle run-owned worktrees", async () => {
    const manual = await materializeDownstreamFixture("manual-idle");
    const created = await materializeRunOwnedFixture("idle-dead", "workboard");
    await git(repo, "worktree", "lock", "--reason", "openclaw pid=999999", created.path);
    now += IDLE_GC_MS + 1;

    const result = await service.gc();
    expect(result.removed).toEqual([created.id]);
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeTruthy();
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    expect(await fs.stat(manual.path)).toBeTruthy();
  });

  it("preserves an ignored unregistered nested linked worktree without cleanup warnings", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".claude/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore agent checkout state");

    const created = await materializeRunOwnedFixture("ignored-nested", "workboard");
    const nested = path.join(created.path, ".claude", "worktrees", "nested-agent");
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await git(repo, "worktree", "add", "--detach", nested, "HEAD");
    expect((await fs.stat(path.join(nested, ".git"))).isFile()).toBe(true);
    await fs.writeFile(path.join(nested, "local.txt"), "ignored agent state\n");
    expect(findLiveRegistryWorktreeByPath(env, nested)).toBeUndefined();
    expect(await git(created.path, "ls-files", "--others", "--exclude-standard")).toBe("");
    now += IDLE_GC_MS + 1;

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-linked");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect((await service.gc()).removed).toEqual([]);
      expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe(
        "ignored agent state\n",
      );
      expect(await git(repo, "worktree", "list", "--porcelain")).toContain(nested);
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    } finally {
      warnLogs.cleanup();
    }
  });

  it.each([
    ["an ignored nested foreign repository", true],
    ["an empty ignored nested foreign repository", false],
  ])("preserves %s", async (_description, hasLocalState) => {
    await fs.writeFile(path.join(repo, ".gitignore"), "vendor/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore vendored repositories");

    const created = await materializeRunOwnedFixture("ignored-foreign", "workboard");
    const nested = await initializeNestedRepository(created.path, "vendor/dependency");
    const localState = path.join(nested, "local.txt");
    if (hasLocalState) {
      await fs.writeFile(localState, "keep foreign repository state\n");
    } else {
      expect(await fs.readdir(nested)).toEqual([".git"]);
      expect(
        await git(created.path, "ls-files", "--others", "--ignored", "--exclude-standard"),
      ).toContain("vendor/dependency/");
    }
    expect(await git(created.path, "ls-files", "--others", "--exclude-standard")).toBe("");
    now += IDLE_GC_MS + 1;

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-foreign");
    try {
      expect((await service.gc()).removed).toEqual([]);
      expect((await service.gc()).removed).toEqual([]);
      expect(await warnLogs.findText(`idle cleanup failed for ${created.id}`)).toBeUndefined();
      expect((await fs.stat(path.join(nested, ".git"))).isDirectory()).toBe(true);
      if (hasLocalState) {
        expect(await fs.readFile(localState, "utf8")).toBe("keep foreign repository state\n");
      }
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    } finally {
      warnLogs.cleanup();
    }
  });

  it("garbage collects modified provisioned files into the immutable snapshot", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=old-source\n");

    const created = await materializeDownstreamFixture("idle-rotated", {
      ownerKind: "workboard",
      provisionedPaths: [".env.local"],
    });
    await fs.rm(path.join(repo, ".worktreeinclude"));
    await fs.writeFile(path.join(created.path, ".env.local"), "value=rotated-only-copy\n");
    now += IDLE_GC_MS + 1;

    expect((await service.gc()).removed).toEqual([created.id]);
    await fs.writeFile(path.join(repo, ".env.local"), "value=newer-source\n");
    const restored = await service.restore({ id: created.id });
    expect(await fs.readFile(path.join(restored.path, ".env.local"), "utf8")).toBe(
      "value=rotated-only-copy\n",
    );
  });

  it("uses owner activity to protect only active idle session worktrees", async () => {
    const active = await materializeRunOwnedFixture(
      "active-session",
      "session",
      "agent:main:active",
    );
    const inactive = await materializeRunOwnedFixture(
      "inactive-session",
      "session",
      "agent:main:inactive",
    );
    now += IDLE_GC_MS + 1;
    const shouldProtectOwner = vi.fn(
      (_ownerKind: string, ownerId: string) => ownerId === "agent:main:active",
    );

    const result = await service.gc({ shouldProtectOwner });

    expect(result.removed).toEqual([inactive.id]);
    expect(shouldProtectOwner).toHaveBeenCalledWith("session", "agent:main:active");
    expect(shouldProtectOwner).toHaveBeenCalledWith("session", "agent:main:inactive");
    expect(getRegistryWorktree(env, active.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, inactive.id)?.removedAt).toBeDefined();
  });

  it("protects foreign locks during idle garbage collection", async () => {
    const created = await materializeRunOwnedFixture("foreign-lock", "session");
    await git(repo, "worktree", "lock", "--reason", "other-tool", created.path);
    now += IDLE_GC_MS + 1;

    expect((await service.gc()).removed).toEqual([]);
    expect(await fs.stat(created.path)).toBeTruthy();
  });

  it("protects a visible nested repository while collecting another idle worktree", async () => {
    const removable = await materializeRunOwnedFixture("removable", "workboard");
    now += 1;
    const nestedRecord = await materializeRunOwnedFixture("nested-idle", "workboard");
    const nested = await initializeNestedRepository(nestedRecord.path, "nested");
    await fs.writeFile(path.join(nested, "local.txt"), "visible nested state\n");
    now += IDLE_GC_MS + 1;

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-visible");
    try {
      expect((await service.gc()).removed).toEqual([removable.id]);
      expect(await warnLogs.findText(`idle cleanup failed for ${nestedRecord.id}`)).toBeUndefined();
      expect(getRegistryWorktree(env, nestedRecord.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe(
        "visible nested state\n",
      );
      await expect(fs.stat(removable.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warnLogs.cleanup();
    }
  });

  it("continues garbage collection when one repository control path is missing", async () => {
    const otherRepo = await initializeRepository(path.join(root, "other"));
    const removable = await materializeDownstreamFixture("other-removable", {
      repoRoot: otherRepo,
      ownerKind: "session",
    });
    now += 1;
    const broken = await materializeDownstreamFixture("missing-control", {
      ownerKind: "session",
    });
    await fs.rename(repo, path.join(root, "moved-repo"));
    now += IDLE_GC_MS + 1;

    const result = await service.gc();

    expect(result.removed).toEqual([removable.id]);
    expect(getRegistryWorktree(env, broken.id)?.removedAt).toBeUndefined();
  });

  it("evicts the least recently active run-owned worktrees over the count limit", async () => {
    const manual = await materializeDownstreamFixture("manual-kept");
    const oldest = await materializeRunOwnedFixture("count-oldest", "session", "agent:main:oldest");
    now += 1;
    const middle = await materializeRunOwnedFixture("count-middle", "workboard", "card-middle");
    now += 1;
    const newest = await materializeRunOwnedFixture("count-newest", "session", "agent:main:newest");

    const result = await service.gc({ limits: { maxCount: 2 } });

    expect(result.removed).toEqual([oldest.id, middle.id]);
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, oldest.id)?.snapshotRef).toBeTruthy();
    await expect(fs.stat(oldest.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips active owners during count-limit eviction", async () => {
    const activeOldest = await materializeRunOwnedFixture(
      "limit-active",
      "session",
      "agent:main:active",
    );
    now += 1;
    const idle = await materializeRunOwnedFixture("limit-idle", "session", "agent:main:idle");
    const shouldProtectOwner = vi.fn(
      (_ownerKind: string, ownerId: string) => ownerId === "agent:main:active",
    );

    const result = await service.gc({ limits: { maxCount: 1 }, shouldProtectOwner });

    expect(result.removed).toEqual([idle.id]);
    expect(getRegistryWorktree(env, activeOldest.id)?.removedAt).toBeUndefined();
  });

  it.each([
    { limit: "count", limits: { maxCount: 1 } },
    { limit: "size", limits: { maxTotalSizeBytes: 60_000 } },
  ])("protects nested repositories during $limit limit eviction", async ({ limits }) => {
    const protectedRecord = await materializeRunOwnedFixture("limit-nested", "workboard");
    const nested = await initializeNestedRepository(protectedRecord.path, "nested");
    await fs.writeFile(path.join(nested, "local.txt"), "protected nested state\n");
    now += 1;
    const removable = await materializeRunOwnedFixture("limit-removable", "workboard");
    await fs.writeFile(path.join(removable.path, "blob.bin"), Buffer.alloc(100_000));

    const warnLogs = createWarnLogCapture("openclaw-worktree-gc-nested-limit");
    try {
      expect((await service.gc({ limits })).removed).toEqual([removable.id]);
      expect(
        await warnLogs.findText(`cleanup limit removal failed for ${protectedRecord.id}`),
      ).toBeUndefined();
      expect(getRegistryWorktree(env, protectedRecord.id)?.removedAt).toBeUndefined();
      expect(await fs.readFile(path.join(nested, "local.txt"), "utf8")).toBe(
        "protected nested state\n",
      );
      await expect(fs.stat(removable.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      warnLogs.cleanup();
    }
  });

  it("evicts oldest worktrees until total size fits the size limit", async () => {
    const oldest = await materializeRunOwnedFixture(
      "size-oldest",
      "session",
      "agent:main:size-old",
    );
    await fs.writeFile(path.join(oldest.path, "blob.bin"), Buffer.alloc(10_000));
    now += 1;
    const newest = await materializeRunOwnedFixture(
      "size-newest",
      "session",
      "agent:main:size-new",
    );

    const result = await service.gc({ limits: { maxTotalSizeBytes: 6_000 } });

    expect(result.removed).toEqual([oldest.id]);
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, oldest.id)?.snapshotRef).toBeTruthy();
  });

  it("keeps unmeasurable worktrees out of size accounting instead of counting zero", async () => {
    if (process.getuid?.() === 0) {
      return; // chmod-based EACCES cannot be simulated as root
    }
    const unreadable = await materializeRunOwnedFixture(
      "size-unreadable",
      "session",
      "agent:main:size-unreadable",
    );
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
    const oldest = await materializeRunOwnedFixture(
      "race-oldest",
      "session",
      "agent:main:race-old",
    );
    now += 1;
    const middle = await materializeRunOwnedFixture(
      "race-middle",
      "session",
      "agent:main:race-mid",
    );
    now += 1;
    const newest = await materializeRunOwnedFixture(
      "race-newest",
      "session",
      "agent:main:race-new",
    );
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
    const created = await materializeRunOwnedFixture("under-limit", "session", "agent:main:under");

    const result = await service.gc({
      limits: { maxCount: 5, maxTotalSizeBytes: 1024 ** 3 },
    });

    expect(result.removed).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("enforces one hundred live checkouts by default without evicting manual work", async () => {
    for (let index = 0; index < 99; index += 1) {
      await materializeDownstreamFixture(`manual-${index}`);
    }
    const oldest = await materializeRunOwnedFixture("default-oldest", "session");
    now += 1;
    const newest = await materializeRunOwnedFixture("default-newest", "session");
    expect((await service.gc()).removed).toEqual([oldest.id]);
    expect(
      service.listRegistryRecords().filter((record) => record.removedAt === undefined),
    ).toHaveLength(100);
    expect(getRegistryWorktree(env, newest.id)?.removedAt).toBeUndefined();
  });

  it("cleans recent retired owners while preserving a live lock and manual checkout", async () => {
    const retired = await materializeRunOwnedFixture(
      "archived-recent",
      "session",
      "agent:main:archived",
    );
    const busy = await materializeRunOwnedFixture("archived-busy", "session", "agent:main:busy");
    const manual = await materializeDownstreamFixture("archived-manual", {
      ownerId: "agent:main:archived",
    });
    await git(repo, "worktree", "lock", "--reason", `openclaw pid=${process.pid}`, busy.path);
    await fs.writeFile(path.join(retired.path, "uncommitted.txt"), "archived work\n");
    const result = await service.gc({ shouldRemoveOwner: () => true });
    expect(result.removed).toEqual([retired.id]);
    expect(getRegistryWorktree(env, busy.id)?.removedAt).toBeUndefined();
    expect(getRegistryWorktree(env, manual.id)?.removedAt).toBeUndefined();
    const restored = await service.restore({ id: retired.id });
    expect(await fs.readFile(path.join(restored.path, "uncommitted.txt"), "utf8")).toBe(
      "archived work\n",
    );
  });

  it("prunes expired snapshot refs and registry rows", async () => {
    const created = await materializeDownstreamFixture("expired");
    const removed = await service.remove({ id: created.id, reason: "retention" });
    now += SNAPSHOT_RETENTION_MS + 1;

    const result = await service.gc();
    expect(result.snapshotsPruned).toBe(1);
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", removed.snapshotRef!)).rejects.toThrow();
  });
});
