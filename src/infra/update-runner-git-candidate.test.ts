import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

async function writeRuntime(root: string, sha: string) {
  const dist = path.join(root, "dist");
  await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "runtime", "node_modules"), { recursive: true });
  await fs.rm(path.join(root, "node_modules", "workspace-runtime"), { force: true });
  await fs.symlink(
    path.join(root, "packages", "runtime"),
    path.join(root, "node_modules", "workspace-runtime"),
    "junction",
  );
  await Promise.all([
    fs.writeFile(
      path.join(root, "packages", "runtime", "node_modules", "nested.cjs"),
      `module.exports = ${JSON.stringify(sha)};`,
    ),
    fs.writeFile(
      path.join(root, "node_modules", "identity.cjs"),
      `module.exports = ${JSON.stringify(sha)};`,
    ),
    fs.writeFile(
      path.join(dist, "entry.js"),
      "console.log(require('../node_modules/identity.cjs')); console.log(require('workspace-runtime'));",
    ),
    fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: sha, buildId: sha })),
    fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, "control-ui", "index.html"), "ready"),
  ]);
}

describe("Git candidate activation", () => {
  let directory: string;
  let root: string;
  let remote: string;
  let beforeSha: string;
  let events: string[];
  let stopped: boolean;
  let runCommand: CommandRunner;

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-candidate-")),
    );
    root = path.join(directory, "checkout");
    remote = path.join(directory, "remote");
    await fs.mkdir(remote);
    await git(remote, "init", "--initial-branch=main");
    await git(remote, "config", "user.name", "OpenClaw Test");
    await git(remote, "config", "user.email", "openclaw@example.com");
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager: "pnpm@12.0.0" }),
    );
    await fs.writeFile(path.join(remote, "openclaw.mjs"), "export {};\n");
    await fs.mkdir(path.join(remote, "packages", "runtime"), { recursive: true });
    await fs.writeFile(
      path.join(remote, "packages", "runtime", "index.js"),
      "module.exports = require('./node_modules/nested.cjs');",
    );
    await fs.writeFile(
      path.join(remote, ".gitignore"),
      "node_modules/\ndist/\n.artifacts/\n*.tmp\n",
    );
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "base");
    beforeSha = await git(remote, "rev-parse", "HEAD");
    await git(directory, "clone", "--quiet", remote, root);
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    await writeRuntime(root, beforeSha);
    events = [];
    stopped = false;
    runCommand = async (argv, options) => {
      if (argv[0] === "git") {
        return runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "pnpm") {
        if (argv[1] === "build") {
          expect(stopped).toBe(false);
          expect(options.cwd).not.toBe(root);
          await writeRuntime(options.cwd!, await git(options.cwd!, "rev-parse", "HEAD"));
          events.push("build");
        }
        return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
      }
      if (argv.includes("doctor")) {
        expect(stopped).toBe(true);
        events.push("migrate");
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function advanceRemote() {
    await fs.writeFile(path.join(remote, "candidate.txt"), "candidate\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "candidate");
    return git(remote, "rev-parse", "HEAD");
  }

  function update(opts: UpdateRunnerOptions = {}) {
    return updateGitCheckout({
      gitRoot: root,
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 5000,
      startedAt: Date.now(),
      opts: {
        channel: "dev",
        validateCandidate: async (candidateRoot) => {
          expect(stopped).toBe(false);
          expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
          expect(candidateRoot).not.toBe(root);
          events.push("validate");
        },
        beforeGitMutation: async () => {
          stopped = true;
          events.push("stop");
        },
        ...opts,
      },
    });
  }

  it.each(["dev", "stable", "beta"] as const)(
    "does not stop or build an already-current %s checkout",
    async (channel) => {
      await git(remote, "tag", "v2026.9.1");
      const result = await update({ channel });
      expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
      expect(stopped).toBe(false);
      expect(events).toEqual([]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    },
  );

  it("stages an already-current checkout when converting a package install to Git", async () => {
    const result = await update({
      prepareGitExposure: async (candidateRoot, sha) => {
        expect(stopped).toBe(false);
        expect(await git(candidateRoot, "rev-parse", "HEAD")).toBe(sha);
        events.push("prepare exposure");
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(events).toEqual(["build", "prepare exposure", "validate", "stop"]);
  });

  it("preserves source changes made during validation without stopping the service", async () => {
    await advanceRemote();
    const result = await update({
      validateCandidate: async () => {
        await fs.writeFile(path.join(root, "operator-change.txt"), "keep this change");
      },
    });
    expect(result).toMatchObject({ status: "skipped", reason: "dirty" });
    expect(stopped).toBe(false);
    expect(await fs.readFile(path.join(root, "operator-change.txt"), "utf8")).toBe(
      "keep this change",
    );
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
  });

  it.each([false, true])(
    "activates only the validated build, preserving local commits: %s",
    async (localCommit) => {
      const target = await advanceRemote();
      if (localCommit) {
        await fs.writeFile(path.join(root, "local.txt"), "operator change\n");
        await git(root, "add", "local.txt");
        await git(root, "commit", "-m", "local change");
        beforeSha = await git(root, "rev-parse", "HEAD");
        await writeRuntime(root, beforeSha);
      }
      const unrelated = path.join(root, "operator-project", "node_modules", "keep.cjs");
      await fs.mkdir(path.dirname(unrelated), { recursive: true });
      await fs.writeFile(unrelated, "operator-owned");
      const result = await update();
      expect(await fs.readFile(unrelated, "utf8")).toBe("operator-owned");
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(events).toEqual(["build", "validate", "stop", "migrate"]);
      const current = await git(root, "rev-parse", "HEAD");
      expect(result.before?.buildId).toBe(beforeSha);
      expect(result.after).toMatchObject({ sha: current, buildId: current });
      expect(await git(root, "merge-base", current, target)).toBe(target);
      if (localCommit) {
        expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator change\n");
      }
      const child = await runCommandWithTimeout(
        [process.execPath, path.join(root, "dist", "entry.js")],
        { timeoutMs: 5000 },
      );
      expect(child.stdout.trim().split("\n")).toEqual([current, current]);
      expect(await fs.readdir(path.join(root, ".artifacts"))).toEqual([]);
    },
  );

  it("leaves the old runtime serving when candidate validation fails", async () => {
    await advanceRemote();
    const failure = new Error("candidate canary failed");
    await expect(
      update({
        validateCandidate: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(stopped).toBe(false);
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    expect(await fs.readFile(path.join(root, "node_modules", "identity.cjs"), "utf8")).toContain(
      beforeSha,
    );
    expect(await fs.readdir(path.join(root, ".artifacts"))).toEqual([]);
  });

  it.each([true, false])(
    "verifies runtime recovery after activation failure (source restored: %s)",
    async (restoreSource) => {
      const candidateSha = await advanceRemote();
      const command = runCommand;
      let resetFaultInjected = false;
      runCommand = async (argv, options) => {
        if (
          !restoreSource &&
          argv[0] === "git" &&
          argv[2] === root &&
          argv[3] === "reset" &&
          argv[4] === "--hard" &&
          argv[5] === beforeSha
        ) {
          resetFaultInjected = true;
          return { code: 1, stdout: "", stderr: "source restoration failed" };
        }
        return command(argv, options);
      };
      const rename = fs.rename.bind(fs);
      const injected = new Error("activation blocked");
      let faultInjected = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (
          String(source).endsWith(`${path.sep}candidate`) &&
          destination === path.join(root, "node_modules")
        ) {
          faultInjected = true;
          throw injected;
        }
        return rename(source, destination);
      });
      const result = await update();
      expect(faultInjected).toBe(true);
      expect(resetFaultInjected).toBe(!restoreSource);
      expect(result).toMatchObject({
        status: "error",
        recovery: restoreSource
          ? { serviceRestartSafe: true, buildId: beforeSha }
          : { serviceRestartSafe: false, reason: "source-rollback-failed" },
      });
      expect(events).toEqual(["build", "validate", "stop"]);
      const expectedSha = restoreSource ? beforeSha : candidateSha;
      expect(await git(root, "rev-parse", "HEAD")).toBe(expectedSha);
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "git rollback verify HEAD",
          exitCode: restoreSource ? 0 : 1,
          stdoutTail: expectedSha,
          ...(restoreSource ? {} : { stderrTail: `expected ${beforeSha}, found ${candidateSha}` }),
        }),
      );
      const child = await runCommandWithTimeout(
        [process.execPath, path.join(root, "dist", "entry.js")],
        { timeoutMs: 5000 },
      );
      expect(child.stdout.trim().split("\n")).toEqual([beforeSha, beforeSha]);
    },
  );
});
