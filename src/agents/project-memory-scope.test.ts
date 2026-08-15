import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveProjectKey } from "./project-memory-scope.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

async function makeRepo(remote?: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-scope-"));
  cleanup.push(root);
  await git(root, "init");
  if (remote) {
    await git(root, "remote", "add", "origin", remote);
  }
  return root;
}

describe("project memory scope", () => {
  it.each([
    ["https://GitHub.COM/OpenClaw/OpenClaw.git", "github.com/OpenClaw/OpenClaw"],
    ["git@GITHUB.com:OpenClaw/OpenClaw.git", "github.com/OpenClaw/OpenClaw"],
    ["https://github.com/OpenClaw/Repo;Prod.git", "github.com/OpenClaw/Repo%3bProd"],
  ])("normalizes origin %s", async (remote, expected) => {
    await expect(resolveProjectKey(await makeRepo(remote))).resolves.toBe(expected);
  });

  it("keeps case-distinct SSH repository paths isolated", async () => {
    const upper = await makeRepo("ssh://git@example.com/srv/Foo.git");
    const lower = await makeRepo("ssh://git@example.com/srv/foo.git");

    await expect(
      Promise.all([resolveProjectKey(upper), resolveProjectKey(lower)]),
    ).resolves.toEqual(["example.com/srv/Foo", "example.com/srv/foo"]);
  });

  it("uses an absolute path key when origin is absent", async () => {
    const repo = await makeRepo();
    await expect(resolveProjectKey(repo)).resolves.toBe(`path:${path.resolve(repo)}`);
  });

  it("preserves filesystem case so local path identities remain distinct", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-case-"));
    cleanup.push(parent);
    const repo = path.join(parent, "MiXeD-Repo");
    await fs.mkdir(repo);
    await git(repo, "init");
    const key = await resolveProjectKey(repo);
    const caseVariant = key.replace("MiXeD-Repo", "mixed-repo");
    expect(key).toBe(`path:${repo}`);
    expect(caseVariant).not.toBe(key);
    expect(new Set([key, caseVariant]).size).toBe(2);
  });

  it("escapes the list delimiter in local repository paths", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-delimiter-"));
    cleanup.push(parent);
    const repo = path.join(parent, "acme;prod<blue>");
    await fs.mkdir(repo);
    await git(repo, "init");
    await expect(resolveProjectKey(repo)).resolves.toBe(
      `path:${repo
        .replaceAll("%", "%25")
        .replaceAll(";", "%3b")
        .replaceAll("<", "%3c")
        .replaceAll(">", "%3e")}`,
    );
  });

  it("converges a linked worktree and its source repository", async () => {
    const repo = await makeRepo("https://github.com/OpenClaw/OpenClaw.git");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await fs.writeFile(path.join(repo, "README.md"), "test\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "test");
    const worktree = `${repo}-worktree`;
    cleanup.push(worktree);
    await git(repo, "worktree", "add", worktree, "-b", "test-worktree");
    await expect(
      Promise.all([resolveProjectKey(repo), resolveProjectKey(worktree)]),
    ).resolves.toEqual(["github.com/OpenClaw/OpenClaw", "github.com/OpenClaw/OpenClaw"]);
  });

  it.runIf(process.platform !== "win32")(
    "falls back to the path key when the git lookup hangs",
    async () => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-hang-"));
      cleanup.push(parent);
      const fakeBinDir = path.join(parent, "fake-bin");
      await fs.mkdir(fakeBinDir);
      const fakeGitPath = path.join(fakeBinDir, "git");
      await fs.writeFile(
        fakeGitPath,
        `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
        "utf-8",
      );
      await fs.chmod(fakeGitPath, 0o755);
      const repo = path.join(parent, "repo");
      await fs.mkdir(repo);
      await git(repo, "init");
      await git(repo, "remote", "add", "origin", "https://github.com/OpenClaw/OpenClaw.git");

      const started = Date.now();
      const key = await withEnvAsync(
        { PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}` },
        () => resolveProjectKey(repo),
      );
      const elapsed = Date.now() - started;

      expect(key).toBe(`path:${repo}`);
      expect(elapsed).toBeLessThan(15_000);
    },
    20_000,
  );
});
