import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner } from "./update-runner-types.js";

const gitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_COUNT: "0",
  LC_ALL: "C",
};

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...gitEnv },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("Git updater release tag refresh", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function fixture(releaseRemote = "upstream", forkRemote?: string) {
    const directory = tempDirs.make("openclaw-update-tags-");
    const upstream = path.join(directory, "upstream.git");
    const seed = path.join(directory, "seed");
    const root = path.join(directory, "installed");
    git(directory, "init", "--bare", "--initial-branch=main", upstream);
    git(directory, "clone", upstream, seed);
    git(seed, "config", "user.name", "OpenClaw Test");
    git(seed, "config", "user.email", "openclaw@example.invalid");
    writeFileSync(
      path.join(seed, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
    );
    git(seed, "add", ".");
    git(seed, "commit", "-m", "original release");
    const oldTag = git(seed, "rev-parse", "HEAD");
    git(seed, "tag", "v2026.9.1");
    git(seed, "commit", "--allow-empty", "-m", "installed commit");
    const release = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "origin", "main", "--tags");
    git(directory, "clone", "--origin", releaseRemote, upstream, root);
    git(root, "checkout", "--detach");
    git(root, "tag", "local-only", oldTag);
    if (forkRemote) {
      const fork = path.join(directory, "fork.git");
      git(directory, "clone", "--bare", upstream, fork);
      git(root, "remote", "add", forkRemote, fork);
    }
    // The installed commit is already the corrected release. Main advances
    // independently, so the no-op update still has to refresh branches and tags.
    git(seed, "tag", "-f", "v2026.9.1");
    git(seed, "commit", "--allow-empty", "-m", "next development commit");
    const branch = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "origin", "main", "+refs/tags/v2026.9.1:refs/tags/v2026.9.1");
    return { root, seed, oldTag, release, branch, releaseRemote };
  }

  async function update(setup: ReturnType<typeof fixture>, inspect: boolean) {
    const fetches: {
      argv: string[];
      code: number | null;
      tag: string;
      local: string;
      branch: string;
    }[] = [];
    const runCommand: CommandRunner = async (argv, options) => {
      if (argv[0] !== "git") {
        throw new Error(`Unexpected build command: ${argv[0]}`);
      }
      const commandOptions = { ...options, env: { ...options.env, ...gitEnv } };
      const result = await runCommandWithTimeout(argv, commandOptions);
      const fetchIndex = argv.indexOf("fetch");
      if (fetchIndex !== -1) {
        const read = async (ref: string) => {
          const value = await runCommandWithTimeout(
            [...argv.slice(0, fetchIndex), "rev-parse", ref],
            commandOptions,
          );
          return value.code === 0 ? value.stdout.trim() : "";
        };
        fetches.push({
          argv: argv.slice(fetchIndex),
          code: result.code,
          tag: await read("refs/tags/v2026.9.1"),
          local: await read("refs/tags/local-only"),
          branch: await read(`refs/remotes/${setup.releaseRemote}/main`),
        });
      }
      return result;
    };
    const result = await updateGitCheckout({
      gitRoot: setup.root,
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 5000,
      startedAt: Date.now(),
      opts: { channel: "stable", ...(inspect ? { inspectGitTarget: async () => undefined } : {}) },
    });
    return { result, fetches };
  }

  it("reproduces the original clobber rejection with a colliding fork tag", () => {
    const setup = fixture("upstream", "fork");
    const result = spawnSync("git", ["-C", setup.root, "fetch", "--all", "--prune", "--tags"], {
      encoding: "utf8",
      env: { ...process.env, ...gitEnv },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("would clobber existing tag");
    expect(git(setup.root, "rev-parse", "v2026.9.1")).toBe(setup.oldTag);
  });

  for (const inspect of [false, true]) {
    describe(inspect ? "private inspection" : "direct checkout", () => {
      it.each([
        { releaseRemote: "upstream", forkRemote: "afork", tracked: true },
        { releaseRemote: "upstream", forkRemote: "zfork", tracked: true },
        { releaseRemote: "upstream", forkRemote: "origin", tracked: true },
        { releaseRemote: "origin", forkRemote: "fork", tracked: false },
        { releaseRemote: "upstream", forkRemote: undefined, tracked: false },
      ])(
        "refreshes only $releaseRemote tags with fork $forkRemote",
        async ({ releaseRemote, forkRemote, tracked }) => {
          const setup = fixture(releaseRemote, forkRemote);
          if (!tracked) {
            git(setup.root, "config", "--unset", "branch.main.remote");
          }
          git(setup.root, "config", "fetch.prune", "true");
          git(setup.root, "config", "fetch.pruneTags", "true");
          const { result, fetches } = await update(setup, inspect);
          expect(result, JSON.stringify(result)).toMatchObject({
            status: "skipped",
            reason: "already-current",
          });
          expect(fetches).toHaveLength(2);
          expect(fetches[0]).toMatchObject({ code: 0, tag: setup.oldTag, branch: setup.branch });
          expect(fetches[1]).toMatchObject({
            code: 0,
            tag: setup.release,
            local: setup.oldTag,
            branch: setup.branch,
          });
          expect(fetches[1]?.argv).toEqual([
            "fetch",
            "--no-tags",
            "--no-prune",
            "--no-prune-tags",
            releaseRemote,
            "+refs/tags/*:refs/tags/*",
          ]);
          expect(git(setup.root, "rev-parse", "v2026.9.1")).toBe(
            inspect ? setup.oldTag : setup.release,
          );
          expect(git(setup.root, "rev-parse", "local-only")).toBe(setup.oldTag);
          expect(git(setup.root, "rev-parse", "HEAD")).toBe(setup.release);
        },
      );

      it("rejects a non-fast-forward protected branch before forcing tags", async () => {
        const setup = fixture();
        git(setup.root, "branch", "protected", setup.release);
        git(setup.root, "config", "remote.upstream.fetch", "refs/heads/main:refs/heads/protected");
        git(setup.seed, "push", "--force", "origin", `${setup.oldTag}:refs/heads/main`);
        const { result, fetches } = await update(setup, inspect);
        expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
        expect(result.steps.find((step) => step.name.includes("fetch"))?.stderrTail).toContain(
          "non-fast-forward",
        );
        expect(fetches).toHaveLength(1);
        expect(fetches[0]?.tag).toBe(setup.oldTag);
        expect(git(setup.root, "rev-parse", "protected")).toBe(setup.release);
      });

      it("requires an explicit authority for ambiguous non-origin remotes", async () => {
        const setup = fixture("upstream", "fork");
        git(setup.root, "config", "--unset", "branch.main.remote");
        const { result, fetches } = await update(setup, inspect);
        expect(result).toMatchObject({ status: "error", reason: "fetch-failed" });
        expect(result.steps.at(-1)?.stderrTail).toContain("Set branch.main.remote");
        expect(fetches).toHaveLength(1);
        expect(git(setup.root, "rev-parse", "v2026.9.1")).toBe(setup.oldTag);
      });
    });
  }
});
