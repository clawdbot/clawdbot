import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import {
  assertSafeGitPublicationWorkspace,
  captureGitHubPublicationWorkspaceSnapshot,
} from "./github-publication-git-transport.js";

let root: string;

async function runGit(
  argv: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
) {
  return await runCommandBuffered(argv, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    ...(options.input === undefined ? {} : { input: options.input }),
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
  });
}

async function git(...args: string[]): Promise<string> {
  const result = await runGit(["git", ...args]);
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8"));
  }
  return result.stdout.toString("utf8").trim();
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-publication-hooks-")));
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "OpenClaw Test");
  await git("config", "user.email", "openclaw@example.test");
  await fs.writeFile(path.join(root, "artifact.txt"), "base\n");
  await git("add", "artifact.txt");
  await git("commit", "-m", "base");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("GitHub publication Git hooks", () => {
  it("accepts checkout-configured hooks while snapshot commands keep every hook disabled", async () => {
    const hooks = path.join(root, "git-hooks");
    const sentinel = path.join(root, ".hook-ran");
    await fs.mkdir(hooks);
    for (const hook of ["reference-transaction", "pre-push", "post-index-change"]) {
      await fs.writeFile(path.join(hooks, hook), `#!/bin/sh\nprintf hook > '${sentinel}'\n`, {
        mode: 0o755,
      });
    }
    await git("config", "core.hooksPath", "git-hooks");
    await fs.writeFile(path.join(root, "artifact.txt"), "accepted\n");

    await expect(assertSafeGitPublicationWorkspace(root, runGit)).resolves.toBeUndefined();
    await expect(captureGitHubPublicationWorkspaceSnapshot({ cwd: root })).resolves.toMatchObject({
      sourceHeadCommit: expect.stringMatching(/^[a-f0-9]{40}$/u),
      sourceIndexTree: expect.stringMatching(/^[a-f0-9]{40}$/u),
      workspaceTree: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures a repository whose recursive tree listing exceeds the default output cap", async () => {
    // ~2000 long-pathed files push `git ls-tree -r` past the executor's 256KB
    // default; the attribute scan must use its own listing bound (regression:
    // real repositories failed capture as "attributes could not be verified").
    const segment = "a".repeat(60);
    for (let dir = 0; dir < 40; dir += 1) {
      const dirPath = path.join(root, `${segment}-${dir}`);
      await fs.mkdir(dirPath);
      await Promise.all(
        Array.from({ length: 50 }, (_, file) =>
          fs.writeFile(path.join(dirPath, `${segment}-${file}.txt`), "x\n"),
        ),
      );
    }
    await git("add", "-A");
    await git("commit", "-q", "-m", "large tree");

    await expect(captureGitHubPublicationWorkspaceSnapshot({ cwd: root })).resolves.toMatchObject({
      workspaceTree: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
  });

  it.each(["replace refs", "grafts"])("rejects Git replacement metadata from %s", async (kind) => {
    const head = await git("rev-parse", "HEAD");
    if (kind === "replace refs") {
      await git("update-ref", `refs/replace/${head}`, head);
    } else {
      await fs.writeFile(path.join(root, ".git", "info", "grafts"), `${head}\n`);
    }

    await expect(assertSafeGitPublicationWorkspace(root, runGit)).rejects.toThrow(
      "replacement metadata",
    );
  });
});
