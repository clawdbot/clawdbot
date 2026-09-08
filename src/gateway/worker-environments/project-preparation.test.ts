import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { createWorkerProjectPreparation } from "./project-preparation.js";
import { prepareWorkerProjectSnapshot, workerProjectSeedKey } from "./workspace-git-base.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = await fs.realpath(tempDirs.make("project-preparation-"));
  const repository = path.join(root, "repository");
  const home = path.join(root, "worker-home");
  await fs.mkdir(repository);
  await fs.mkdir(home);
  await requireGit(repository, ["init", "--quiet"]);
  await requireGit(repository, ["config", "user.name", "Project Test"]);
  await requireGit(repository, ["config", "user.email", "project@example.invalid"]);
  await fs.writeFile(path.join(repository, "input.txt"), "prepared base\n");
  await requireGit(repository, ["add", "."]);
  await requireGit(repository, ["commit", "--quiet", "-m", "base"]);
  const project = (await prepareWorkerProjectSnapshot({
    localPath: repository,
    namespace: "gateway",
  }))!;
  const runScript = vi.fn(async (script: string) =>
    execFileSync("sh", ["-c", script], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const upload = vi.fn(async (source: string, destination: string) => {
    await fs.copyFile(source, destination);
  });
  const operation = (requireCurrent = () => {}) =>
    createWorkerProjectPreparation({ project, namespace: "gateway", requireCurrent });
  const seed = path.join(
    home,
    ".openclaw-worker",
    "git-seeds",
    "gateway",
    workerProjectSeedKey(project),
  );
  return { repository, home, project, seed, operation, runScript, upload };
}

describe("project checkout preparation", () => {
  it("bounds retained checkouts and abandoned staging while preserving the current project", async () => {
    const f = await fixture();
    const namespace = path.dirname(f.seed);
    await fs.mkdir(namespace, { recursive: true });
    for (let index = 0; index < 8; index++) {
      const sibling = path.join(namespace, index.toString(16).repeat(64));
      await fs.mkdir(sibling);
      const future = new Date(Date.now() + (index + 1) * 60_000);
      await fs.utimes(sibling, future, future);
    }
    const stale = path.join(namespace, `.tmp-${"a".repeat(64)}-stale`);
    const fresh = path.join(namespace, `.tmp-${"b".repeat(64)}-fresh`);
    await fs.mkdir(stale);
    await fs.mkdir(fresh);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await fs.utimes(stale, old, old);
    const operation = f.operation();
    await operation.project.prepare(f);
    operation.close();
    const retained = await fs.readdir(namespace);
    expect(retained.filter((name) => /^[a-f0-9]{64}$/u.test(name))).toHaveLength(6);
    expect(retained).toContain(path.basename(f.seed));
    expect(retained).toContain(path.basename(fresh));
    expect(retained).not.toContain(path.basename(stale));
  });

  it.each([".openclaw-worker", ".openclaw-worker/git-seeds"])(
    "rejects a symlinked %s parent before writing outside the worker cache",
    async (relative) => {
      const f = await fixture();
      const outside = path.join(f.home, "outside");
      await fs.mkdir(outside);
      const link = path.join(f.home, relative);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(outside, link);
      const operation = f.operation();
      await expect(operation.project.prepare(f)).rejects.toThrow(
        "Project seed directory escaped its owner",
      );
      operation.close();
      expect(await fs.readdir(outside)).toEqual([]);
      expect(f.upload).not.toHaveBeenCalled();
    },
  );

  it("captures the pinned clean base and reuses it without another Git pack upload", async () => {
    const f = await fixture();
    await requireGit(f.repository, [
      "remote",
      "add",
      "origin",
      "https://example.invalid/private.git",
    ]);
    await fs.writeFile(path.join(f.repository, "input.txt"), "later commit\n");
    await requireGit(f.repository, ["commit", "--quiet", "-am", "later"]);
    await fs.writeFile(path.join(f.repository, "private.txt"), "session-only input\n");
    const first = f.operation();
    expect(await first.project.prepare(f)).toEqual({
      seedKey: workerProjectSeedKey(f.project),
      cacheHit: false,
    });
    first.close();
    expect(await fs.readFile(path.join(f.seed, "input.txt"), "utf8")).toBe("prepared base\n");
    expect(await fs.readdir(f.seed)).toEqual(expect.arrayContaining([".git", "input.txt"]));
    expect(await fs.stat(path.join(f.seed, "private.txt")).catch(() => undefined)).toBeUndefined();
    expect(await requireGit(f.seed, ["remote"])).toBe("");
    expect(await requireGit(f.seed, ["status", "--porcelain"])).toBe("");
    expect(f.upload).toHaveBeenCalledTimes(1);
    const second = f.operation();
    expect(await second.project.prepare(f)).toEqual({
      seedKey: workerProjectSeedKey(f.project),
      cacheHit: true,
    });
    expect(f.upload).toHaveBeenCalledTimes(1);
    second.close();
  });

  it("rejects modified pack bytes before publishing a reusable checkout", async () => {
    const f = await fixture();
    const operation = f.operation();
    await expect(
      operation.project.prepare({
        runScript: f.runScript,
        upload: async (source, destination) => {
          const bytes = await fs.readFile(source);
          bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
          await fs.writeFile(destination, bytes);
        },
      }),
    ).rejects.toThrow("Project pack digest does not match");
    operation.close();
    expect(await fs.readdir(path.dirname(f.seed))).toEqual([]);
  });

  it("revokes retained callbacks when the provision owner changes during preparation", async () => {
    const f = await fixture();
    let current = true;
    const operation = f.operation(() => {
      if (!current) {
        throw new Error("owner replaced");
      }
    });
    await expect(
      operation.project.prepare({
        runScript: async (script) => {
          const result = await f.runScript(script);
          current = false;
          return result;
        },
        upload: f.upload,
      }),
    ).rejects.toThrow("owner replaced");
    expect(operation.project.signal.aborted).toBe(true);
    expect(f.upload).not.toHaveBeenCalled();
    expect(() => operation.project.prepare(f)).toThrow("owner replaced");
    operation.close();
  });
});
