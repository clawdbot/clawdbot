// QA Lab product proof for the managed-worktree child CLI lifecycle.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ManagedWorktreeGcResult,
  ManagedWorktreeRecord,
  RemoveManagedWorktreeResult,
} from "../../../../src/agents/worktrees/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

const execFileAsync = promisify(execFile);
const WORKTREE_NAME = "qa-managed-worktree";

type CommandResult = Awaited<ReturnType<OpenClawTestInstance["cli"]>>;
type WorktreeListJson = { worktrees: ManagedWorktreeRecord[] };

let instance: OpenClawTestInstance | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await instance?.cleanup();
  instance = undefined;
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

function parseCommandJson<T>(label: string, result: CommandResult): T {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trimEnd();
}

async function initializeRepository(root: string): Promise<{ baseCommit: string; repo: string }> {
  const repo = path.join(root, "source");
  await fs.mkdir(path.join(repo, ".openclaw"), { recursive: true });
  await fs.mkdir(path.join(repo, "generated"), { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\ngenerated/\n");
  await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\ngenerated/**\n");
  const setupScript = path.join(repo, ".openclaw", "worktree-setup.sh");
  await fs.writeFile(
    setupScript,
    '#!/bin/sh\nset -eu\nprintf "%s\\n%s\\n" "$OPENCLAW_SOURCE_TREE_PATH" "$OPENCLAW_WORKTREE_PATH" > "$OPENCLAW_WORKTREE_PATH/setup-marker.txt"\n',
  );
  await fs.chmod(setupScript, 0o755);
  await git(repo, "add", "README.md", ".gitignore", ".worktreeinclude", setupScript);
  await git(repo, "commit", "-m", "initialize managed worktree fixture");

  await fs.writeFile(path.join(repo, ".env.local"), "TOKEN=fixture\n");
  await fs.chmod(path.join(repo, ".env.local"), 0o600);
  await fs.writeFile(path.join(repo, "generated", "tool.sh"), "#!/bin/sh\necho generated\n");
  await fs.chmod(path.join(repo, "generated", "tool.sh"), 0o755);

  return {
    baseCommit: await git(repo, "rev-parse", "HEAD"),
    repo: await fs.realpath(repo),
  };
}

describe("managed worktrees child CLI product proof", () => {
  it(
    "provisions, snapshots, restores, and preserves a manual worktree through gc",
    { timeout: 180_000 },
    async () => {
      const canonicalTmp = await fs.realpath(os.tmpdir());
      tempRoot = await fs.mkdtemp(path.join(canonicalTmp, "openclaw-managed-worktree-cli-"));
      const { baseCommit, repo } = await initializeRepository(tempRoot);
      instance = await createOpenClawTestInstance({ name: "qa-managed-worktree-cli" });
      const stateDir = await fs.realpath(instance.stateDir);

      const created = parseCommandJson<ManagedWorktreeRecord>(
        "worktrees create",
        await instance.cli(["worktrees", "create", repo, "--name", WORKTREE_NAME, "--json"]),
      );
      expect(created).toMatchObject({
        name: WORKTREE_NAME,
        repoRoot: repo,
        branch: `openclaw/${WORKTREE_NAME}`,
        baseRef: "HEAD",
        ownerKind: "manual",
      });
      expect(created.id).toEqual(expect.any(String));
      expect(created.repoFingerprint).toEqual(expect.any(String));
      expect(created.createdAt).toEqual(expect.any(Number));
      expect(created.lastActiveAt).toEqual(expect.any(Number));
      expect(await fs.realpath(created.path)).toBe(
        path.join(stateDir, "worktrees", created.repoFingerprint, WORKTREE_NAME),
      );
      expect(await git(repo, "rev-parse", `refs/heads/${created.branch}`)).toBe(baseCommit);

      const provisionedEnv = path.join(created.path, ".env.local");
      const provisionedTool = path.join(created.path, "generated", "tool.sh");
      await expect(fs.readFile(provisionedEnv, "utf8")).resolves.toBe("TOKEN=fixture\n");
      await expect(fs.readFile(provisionedTool, "utf8")).resolves.toContain("echo generated");
      expect((await fs.stat(provisionedEnv)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(provisionedTool)).mode & 0o777).toBe(0o755);

      const setupPaths = (await fs.readFile(path.join(created.path, "setup-marker.txt"), "utf8"))
        .trim()
        .split("\n");
      expect(setupPaths).toHaveLength(2);
      expect(await fs.realpath(setupPaths[0]!)).toBe(repo);
      expect(await fs.realpath(setupPaths[1]!)).toBe(await fs.realpath(created.path));

      await fs.writeFile(path.join(created.path, "README.md"), "dirty tracked change\n");
      await fs.writeFile(path.join(created.path, "notes.txt"), "restored note\n");

      const removed = parseCommandJson<RemoveManagedWorktreeResult>(
        "worktrees remove",
        await instance.cli(["worktrees", "remove", created.id, "--json"]),
      );
      const expectedSnapshotRef = `refs/openclaw/snapshots/${created.id}`;
      expect(removed).toEqual({ removed: true, snapshotRef: expectedSnapshotRef });
      const snapshotCommit = await git(repo, "rev-parse", expectedSnapshotRef);
      expect(await git(repo, "show-ref", "--verify", expectedSnapshotRef)).toContain(
        expectedSnapshotRef,
      );
      await expect(fs.access(created.path)).rejects.toMatchObject({ code: "ENOENT" });

      const removedList = parseCommandJson<WorktreeListJson>(
        "worktrees list after remove",
        await instance.cli(["worktrees", "list", "--json"]),
      );
      expect(removedList.worktrees).toContainEqual(
        expect.objectContaining({ id: created.id, removedAt: expect.any(Number) }),
      );

      const restored = parseCommandJson<ManagedWorktreeRecord>(
        "worktrees restore",
        await instance.cli(["worktrees", "restore", created.id, "--json"]),
      );
      expect(restored).toMatchObject({
        id: created.id,
        branch: created.branch,
        path: created.path,
      });
      expect(restored.removedAt).toBeUndefined();
      const status = await git(restored.path, "status", "--porcelain");
      expect(status.split("\n")).toEqual(expect.arrayContaining([" M README.md", "?? notes.txt"]));
      await expect(fs.readFile(path.join(restored.path, "README.md"), "utf8")).resolves.toBe(
        "dirty tracked change\n",
      );
      await expect(fs.readFile(path.join(restored.path, "notes.txt"), "utf8")).resolves.toBe(
        "restored note\n",
      );
      await expect(fs.readFile(provisionedEnv, "utf8")).resolves.toBe("TOKEN=fixture\n");
      await expect(fs.readFile(provisionedTool, "utf8")).resolves.toContain("echo generated");
      expect((await fs.stat(provisionedEnv)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(provisionedTool)).mode & 0o777).toBe(0o755);
      expect(await git(repo, "rev-parse", `refs/heads/${created.branch}`)).toBe(baseCommit);
      expect((await git(repo, "log", "--format=%H", created.branch)).split("\n")).not.toContain(
        snapshotCommit,
      );

      const gc = parseCommandJson<ManagedWorktreeGcResult>(
        "worktrees gc",
        await instance.cli(["worktrees", "gc", "--json"]),
      );
      expect(gc).toEqual({
        removed: [],
        orphansDeleted: expect.any(Number),
        snapshotsPruned: expect.any(Number),
      });
      const activeList = parseCommandJson<WorktreeListJson>(
        "worktrees list after gc",
        await instance.cli(["worktrees", "list", "--json"]),
      );
      expect(activeList.worktrees).toContainEqual(
        expect.objectContaining({ id: created.id, ownerKind: "manual" }),
      );
      expect(
        activeList.worktrees.find((record) => record.id === created.id)?.removedAt,
      ).toBeUndefined();
      await expect(fs.access(created.path)).resolves.toBeUndefined();
    },
  );
});
