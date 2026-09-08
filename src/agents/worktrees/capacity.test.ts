import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { estimateWorktreeGitBytes } from "./capacity.js";
import { runGit } from "./git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("worktree Git size estimates", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function partialClone() {
    const root = tempDirs.make("openclaw-partial-worktree-");
    const source = path.join(root, "source");
    const origin = path.join(root, "origin.git");
    const clone = path.join(root, "clone");
    await git(root, "init", "--template=", "-b", "main", source);
    await git(source, "config", "user.name", "OpenClaw Test");
    await git(source, "config", "user.email", "openclaw-test@example.invalid");
    await git(source, "config", "commit.gpgSign", "false");
    await fs.writeFile(path.join(source, "base.txt"), "base\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "initial");
    await git(root, "clone", "--bare", source, origin);
    await git(origin, "config", "uploadpack.allowFilter", "true");
    await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    await git(root, "clone", "--filter=blob:none", pathToFileURL(origin).href, clone);
    await fs.writeFile(path.join(source, "small.txt"), "small\n");
    await fs.writeFile(path.join(source, "large.txt"), "x".repeat(5000));
    await git(source, "add", ".");
    await git(source, "commit", "-m", "add absent blobs");
    await git(source, "push", origin, "main");
    await git(clone, "fetch", "origin");
    const commit = await git(clone, "rev-parse", "origin/main");
    vi.stubEnv("GIT_NO_LAZY_FETCH", "1");
    const missing = (
      await git(
        clone,
        "rev-list",
        "--objects",
        "--missing=print",
        "--no-object-names",
        "--max-count=1",
        commit,
      )
    )
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
    expect(missing).toHaveLength(2);
    // The production executor inherits this guard, so old objectsize cannot hydrate the fixture.
    await expect(runGit(clone, ["cat-file", "-e", missing[0]!])).resolves.toMatchObject({
      code: 1,
    });
    return { clone, commit, missing };
  }

  it.each(["remote promisor", "partialclone extension"])(
    "prefetches missing blobs once from the %s and skips fetching local objects",
    async (remoteConfig) => {
      const { clone, commit, missing } = await partialClone();
      if (remoteConfig === "partialclone extension") {
        await git(clone, "config", "extensions.partialclone", "origin");
        await git(clone, "config", "--unset", "remote.origin.promisor");
      }
      const commandSpy = vi.spyOn(gitExec, "executeGitCommand");
      await expect(estimateWorktreeGitBytes(clone, commit)).resolves.toBe(16_384);
      const fetches = commandSpy.mock.calls.filter(([, args]) => args[0] === "fetch");
      expect(fetches).toHaveLength(1);
      expect(fetches[0]).toEqual([
        clone,
        [
          "fetch",
          "origin",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          "--stdin",
        ],
        expect.objectContaining({ timeoutMs: 300_000, input: `${missing.join("\n")}\n` }),
      ]);
      expect(
        commandSpy.mock.calls.find(([, args]) => args[0] === "ls-tree")?.[2]?.env,
      ).toMatchObject({
        GIT_NO_LAZY_FETCH: "1",
      });
      commandSpy.mockClear();
      await expect(estimateWorktreeGitBytes(clone, commit)).resolves.toBe(16_384);
      expect(commandSpy.mock.calls.filter(([, args]) => args[0] === "fetch")).toHaveLength(0);
    },
  );

  it("explains missing objects when no promisor remote can repair the clone", async () => {
    const { clone, commit } = await partialClone();
    await git(clone, "config", "--unset", "remote.origin.promisor");
    const commandSpy = vi.spyOn(gitExec, "executeGitCommand");
    await expect(estimateWorktreeGitBytes(clone, commit)).rejects.toThrow(
      `Repository is missing 2 objects for ${commit}; fetch or repair the clone.`,
    );
    expect(commandSpy.mock.calls.filter(([, args]) => args[0] === "fetch")).toHaveLength(0);
  });
});
