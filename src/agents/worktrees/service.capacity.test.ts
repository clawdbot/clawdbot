import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commandExec from "../../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { getRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import {
  initializeManagedWorktreeTestRepository,
  materializeManagedWorktreeFixture,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);
const GiB = 1024 ** 3;

describe("ManagedWorktreeService capacity", () => {
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  let availableBytes: number;
  let totalBytes: number;

  async function git(cwd: string, ...args: string[]) {
    return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
  }

  async function fill(count: number) {
    for (let index = 0; index < count; index += 1) {
      await materializeManagedWorktreeFixture({
        env,
        stateDir,
        repoRoot: repo,
        name: `kept-${index}`,
        now: Date.now(),
      });
    }
  }

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worktree-capacity-")),
    );
    repo = await initializeManagedWorktreeTestRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({ env });
    const stats = fsSync.statfsSync(root);
    availableBytes = 100 * GiB;
    totalBytes = 1024 * GiB;
    vi.spyOn(fsSync, "statfsSync").mockImplementation(() => ({
      ...stats,
      bsize: 4096,
      bavail: Math.floor(availableBytes / 4096),
      blocks: totalBytes / 4096,
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    { total: 20, available: 3 },
    { total: 100, available: 9 },
    { total: 1024, available: 15 },
  ])("refuses creation below the reserve on a $total GiB volume", async ({ total, available }) => {
    totalBytes = total * GiB;
    availableBytes = available * GiB;
    await expect(
      service.create({ repoRoot: repo, name: "no-space", baseRef: "HEAD" }),
    ).rejects.toThrow(/disk space/i);
    expect(service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/no-space")).toBe("");
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("no-space");
  });

  it("budgets ignored files selected for provisioning before allocating", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "fixture.bin\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "fixture.bin\n");
    await fs.writeFile(path.join(repo, "fixture.bin"), Buffer.alloc(10 * 1024 ** 2));
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "provision ignored fixture");
    availableBytes = 16 * GiB + 8 * 1024 ** 2;
    await expect(
      service.create({ repoRoot: repo, name: "provision-space", baseRef: "HEAD" }),
    ).rejects.toThrow(/disk space/i);
    expect(service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/provision-space")).toBe("");
  });

  it("budgets repository setup separately from a small Git checkout", async () => {
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, '#!/bin/sh\nprintf ran > "$OPENCLAW_SOURCE_TREE_PATH/setup-ran"\n', {
      mode: 0o755,
    });
    availableBytes = 18 * GiB;
    await expect(
      service.create({ repoRoot: repo, name: "setup-budget", baseRef: "HEAD" }),
    ).rejects.toThrow(/disk space/i);
    await expect(fs.stat(path.join(repo, "setup-ran"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.listRegistryRecords()).toEqual([]);
  });

  it("requires a readable capacity sample before creating a checkout", async () => {
    vi.mocked(fsSync.statfsSync).mockImplementation(() => {
      throw new Error("volume unavailable");
    });
    await expect(
      service.create({ repoRoot: repo, name: "unknown-space", baseRef: "HEAD" }),
    ).rejects.toThrow(/determine.*disk space|disk space.*unavailable/i);
    expect(service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/unknown-space")).toBe("");
  });

  it("serializes distinct repositories competing for the thirtieth checkout", async () => {
    await fill(29);
    const otherRepo = await initializeManagedWorktreeTestRepository(path.join(root, "other"));
    const otherService = new ManagedWorktreeService({ env });
    const outcomes = await Promise.allSettled([
      service.create({ repoRoot: repo, name: "last-one", baseRef: "HEAD" }),
      otherService.create({ repoRoot: otherRepo, name: "last-two", baseRef: "HEAD" }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          message: expect.stringMatching(/30.*archive|30.*remove/i),
        }),
      }),
    ]);
    expect(
      service.listRegistryRecords().filter((record) => record.removedAt === undefined),
    ).toHaveLength(30);
    expect(
      await fs.readFile(
        path.join(stateDir, "worktrees", "downstream-fixture", "kept-0", "README.md"),
        "utf8",
      ),
    ).toBe("base\n");
  });

  it("reuses a valid owned checkout even at capacity and below the reserve", async () => {
    const params = {
      repoRoot: repo,
      name: "owned",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:owned",
    };
    const created = await service.create(params);
    await fill(29);
    availableBytes = GiB;
    expect(await service.create(params)).toEqual(created);
    expect(service.listRegistryRecords()).toHaveLength(30);
  });

  it.each(["space", "count"])(
    "preserves a removed snapshot when restore lacks %s",
    async (reason) => {
      const created = await service.create({ repoRoot: repo, name: "restore", baseRef: "HEAD" });
      await fs.writeFile(path.join(created.path, "uncommitted.txt"), "keep me\n");
      await service.remove({ id: created.id, reason: "archive" });
      const before = getRegistryWorktree(env, created.id);
      if (reason === "count") {
        await fill(30);
      } else {
        availableBytes = GiB;
      }
      await expect(service.restore({ id: created.id })).rejects.toThrow(
        reason === "count" ? /30/ : /disk space/i,
      );
      expect(getRegistryWorktree(env, created.id)).toEqual(before);
      await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(repo, "show", `${before!.snapshotRef}:uncommitted.txt`)).toBe("keep me");
    },
  );

  it("checks space again before repository setup and rolls back its unbound checkout", async () => {
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    const marker = path.join(repo, "setup-ran");
    await fs.mkdir(path.dirname(script));
    await fs.writeFile(script, '#!/bin/sh\nprintf ran > "$OPENCLAW_SOURCE_TREE_PATH/setup-ran"\n', {
      mode: 0o755,
    });
    const realRun = commandExec.runCommandWithTimeout;
    vi.spyOn(commandExec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      const result = await realRun(argv, options);
      if (argv[0] === "git" && argv[3] === "worktree" && argv[4] === "add") {
        availableBytes = GiB;
      }
      return result;
    });
    await expect(
      service.create({ repoRoot: repo, name: "setup-space", baseRef: "HEAD" }),
    ).rejects.toThrow(/disk space/i);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.listRegistryRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", "openclaw/setup-space")).toBe("");
  });

  it("preserves dirty work when there is insufficient room for its safety snapshot", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "snapshot-space",
      baseRef: "HEAD",
    });
    await fs.writeFile(path.join(created.path, "uncommitted.txt"), "only copy\n");
    availableBytes = 64 * 1024 ** 2;
    await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
      /disk space/i,
    );
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(created.path, "uncommitted.txt"), "utf8")).toBe(
      "only copy\n",
    );
    expect(await git(repo, "branch", "--list", "--format=%(refname)", created.branch)).toBe(
      `refs/heads/${created.branch}`,
    );
  });

  it("rejects reuse of a broken Git link without destroying its work", async () => {
    const params = {
      repoRoot: repo,
      name: "broken-link",
      baseRef: "HEAD",
      ownerKind: "session" as const,
      ownerId: "agent:main:broken",
    };
    const created = await service.create(params);
    await fs.writeFile(path.join(created.path, "uncommitted.txt"), "only copy\n");
    const marker = await fs.readFile(path.join(created.path, ".git"), "utf8");
    await fs.rm(marker.trim().slice("gitdir: ".length), { recursive: true });
    await expect(service.create(params)).rejects.toThrow(
      /Git metadata.*preserved|preserved.*Git metadata/i,
    );
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(created.path, "uncommitted.txt"), "utf8")).toBe(
      "only copy\n",
    );
  });
});
