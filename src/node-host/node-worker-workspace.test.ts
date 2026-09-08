import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { NodeWorkerWorkspaceSeedInput } from "../worker/node-workspace-protocol.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const identity = {
  gatewayNamespace: "gateway-1",
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 1,
};
const key = "a".repeat(64);
const maxAgeMs = 6 * 60 * 60 * 1_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("node worker workspace seeds", () => {
  let home: string;
  let seeds: string;
  let workspace: string;
  let runtime: NodeWorkerWorkspaceRuntime;

  const execSeed = (seed: NodeWorkerWorkspaceSeedInput, sessionId = identity.sessionId) =>
    runtime.exec({
      ...identity,
      sessionId,
      argv: ["openclaw-internal-workspace-seed"],
      seed,
    });

  beforeEach(async () => {
    home = tempDirs.make("workspace-seeds-");
    seeds = path.join(home, ".openclaw-worker", "git-seeds", identity.gatewayNamespace);
    runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(home, "state", "node-host"),
      env: { ...process.env, HOME: home },
    });
    const result = await runtime.exec({ ...identity, argv: ["node", "-e", ""] });
    workspace = result.workspaceDir;
  });

  it("stores a snapshot outside state and replaces the whole workspace on apply", async () => {
    await expect(fsp.stat(path.dirname(seeds))).rejects.toMatchObject({ code: "ENOENT" });
    const git = async (...args: string[]) => {
      const result = await runtime.exec({ ...identity, argv: ["git", ...args] });
      expect(result.code).toBe(0);
      return result.stdout.trim();
    };
    await git("init");
    await fsp.writeFile(path.join(workspace, "tracked.txt"), "original");
    await fsp.symlink("tracked.txt", path.join(workspace, "link.txt"));
    await git("add", ".");
    await git(
      "-c",
      "user.name=Seed Test",
      "-c",
      "user.email=seed@example.test",
      "commit",
      "-m",
      "seed",
    );
    const commit = await git("rev-parse", "HEAD");
    expect((await execSeed({ action: "store", key, maxAgeMs })).stdout).toBe("stored\n");
    await fsp.writeFile(path.join(workspace, "tracked.txt"), "changed");
    await fsp.writeFile(path.join(workspace, "session-only.txt"), "private");
    const seedDir = path.join(seeds, key);
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(seedDir, old, old);

    const result = await execSeed({ action: "apply", key });

    expect(result).toMatchObject({ workspaceDir: workspace, code: 0, stdout: "applied\n" });
    expect(await fsp.readdir(workspace)).toEqual([".git", "link.txt", "tracked.txt"]);
    expect(await fsp.readFile(path.join(workspace, "tracked.txt"), "utf8")).toBe("original");
    expect(await fsp.readlink(path.join(workspace, "link.txt"))).toBe("tracked.txt");
    // Apply leaves the store-freshness clock untouched so a used seed still refreshes.
    expect((await fsp.stat(seedDir)).mtimeMs).toBeLessThanOrEqual(old.getTime());
    expect(await git("rev-parse", "HEAD")).toBe(commit);
    expect(await git("status", "--porcelain")).toBe("");
    await fsp.writeFile(path.join(workspace, "tracked.txt"), "later edit");
    const next = await execSeed({ action: "apply", key }, "session-2");
    expect(await fsp.readFile(path.join(next.workspaceDir, "tracked.txt"), "utf8")).toBe(
      "original",
    );
  });

  it("returns absent and empties an existing workspace when no seed exists", async () => {
    await fsp.writeFile(path.join(workspace, "stale.txt"), "stale");
    expect((await execSeed({ action: "apply", key })).stdout).toBe("absent\n");
    expect(await fsp.readdir(workspace)).toEqual([]);
  });

  it("keeps a fresh seed and replaces it only after its freshness window", async () => {
    await fsp.writeFile(path.join(workspace, "tracked.txt"), "original");
    await execSeed({ action: "store", key, maxAgeMs });
    await fsp.writeFile(path.join(workspace, "tracked.txt"), "updated");
    expect((await execSeed({ action: "store", key, maxAgeMs })).stdout).toBe("fresh\n");
    expect(await fsp.readFile(path.join(seeds, key, "tracked.txt"), "utf8")).toBe("original");
    const old = new Date(Date.now() - maxAgeMs - 1_000);
    await fsp.utimes(path.join(seeds, key), old, old);
    expect((await execSeed({ action: "store", key, maxAgeMs })).stdout).toBe("stored\n");
    expect(await fsp.readFile(path.join(seeds, key, "tracked.txt"), "utf8")).toBe("updated");
  });

  it("prunes old and excess seeds while preserving recent temporary copies", async () => {
    await fsp.mkdir(seeds, { recursive: true });
    const entries = Array.from({ length: 7 }, (_, index) => String(index).repeat(64));
    const expired = "e".repeat(64);
    const oldTmp = `.tmp-${key}-crashed`;
    const activeTmp = `.tmp-${key}-active`;
    for (const [index, entry] of [...entries, expired, oldTmp, activeTmp].entries()) {
      const dir = path.join(seeds, entry);
      await fsp.mkdir(dir);
      const age =
        entry === expired
          ? 31 * 24 * 60 * 60 * 1_000
          : entry === oldTmp
            ? 3_600_001
            : (index + 1) * 1_000;
      const time = new Date(Date.now() - age);
      await fsp.utimes(dir, time, time);
    }

    await execSeed({ action: "store", key, maxAgeMs });

    expect((await fsp.readdir(seeds)).toSorted()).toEqual(
      [activeTmp, ...entries.slice(0, 5), key].toSorted(),
    );
  });

  it.each(["apply", "store"] as const)(
    "rejects a symlinked seed on %s without touching its target",
    async (action) => {
      const outside = path.join(home, "outside");
      await fsp.mkdir(outside);
      await fsp.writeFile(path.join(outside, "marker"), "untouched");
      await fsp.mkdir(seeds, { recursive: true });
      await fsp.symlink(outside, path.join(seeds, key), "dir");
      await expect(
        execSeed(action === "apply" ? { action, key } : { action, key, maxAgeMs }),
      ).rejects.toThrow("seed");
      expect(await fsp.readFile(path.join(outside, "marker"), "utf8")).toBe("untouched");
    },
  );

  it("rejects a store without an existing source workspace", async () => {
    await fsp.rm(workspace, { recursive: true });
    await expect(execSeed({ action: "store", key, maxAgeMs })).rejects.toThrow(
      "workspace seed source",
    );
    await expect(fsp.stat(path.join(seeds, key))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes competing stores of the same repository across sessions", async () => {
    await fsp.writeFile(path.join(workspace, "tracked.txt"), "first");
    const other = await runtime.exec({
      ...identity,
      sessionId: "session-2",
      argv: ["node", "-e", ""],
    });
    await fsp.writeFile(path.join(other.workspaceDir, "tracked.txt"), "second");
    const results = await Promise.all([
      execSeed({ action: "store", key, maxAgeMs }),
      execSeed({ action: "store", key, maxAgeMs }, "session-2"),
    ]);
    expect(results.map((result) => result.stdout).toSorted()).toEqual(["fresh\n", "stored\n"]);
    expect(await fsp.readdir(seeds)).toEqual([key]);
  });
});
