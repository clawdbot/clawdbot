import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { acquireGitSource } from "./git-source.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

describe("Git source acquisition", () => {
  it("preserves each caller's ref selection against a local repository", async () => {
    await withTestDir({ prefix: "openclaw-git-source-" }, async (root) => {
      const sourceDir = path.join(root, "source");
      await fs.mkdir(sourceDir);
      await git(sourceDir, "init", "--initial-branch=main");
      const commit = async (contents: string) => {
        await fs.writeFile(path.join(sourceDir, "payload.txt"), contents);
        await git(sourceDir, "add", "payload.txt");
        await git(
          sourceDir,
          "-c",
          "user.name=OpenClaw Test",
          "-c",
          "user.email=test@openclaw.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          contents,
        );
        return await git(sourceDir, "rev-parse", "HEAD");
      };
      const mainCommit = await commit("main");
      await git(sourceDir, "switch", "-c", "feature/skill");
      const featureCommit = await commit("feature");
      await git(sourceDir, "tag", "v1");
      await git(sourceDir, "switch", "main");

      const cases = [
        { ref: undefined, refMode: "detached", expected: mainCommit, payload: "main" },
        {
          ref: "feature/skill",
          refMode: "resolve-remote",
          expected: featureCommit,
          payload: "feature",
        },
        {
          ref: "origin/feature/skill",
          refMode: "resolve-remote",
          expected: featureCommit,
          payload: "feature",
        },
        {
          ref: "feature/skill",
          refMode: "shallow-branch",
          expected: featureCommit,
          payload: "feature",
        },
        { ref: "v1", refMode: "shallow-branch", expected: featureCommit, payload: "feature" },
        { ref: featureCommit, refMode: "detached", expected: featureCommit, payload: "feature" },
      ] as const;
      for (const [index, entry] of cases.entries()) {
        const repoDir = path.join(root, `checkout-${index}`);
        const result = await acquireGitSource({
          url: pathToFileURL(sourceDir).href,
          label: "fixture",
          repoDir,
          ref: entry.ref,
          refMode: entry.refMode,
        });
        expect(result).toEqual({ ok: true, commit: entry.expected });
        expect(await fs.readFile(path.join(repoDir, "payload.txt"), "utf8")).toBe(entry.payload);
      }

      const repoDir = path.join(root, "missing-ref");
      const failed = await acquireGitSource({
        url: pathToFileURL(sourceDir).href,
        label: "fixture",
        repoDir,
        ref: "missing",
        refMode: "resolve-remote",
        cleanupOnFailure: () => fs.rm(repoDir, { recursive: true, force: true }),
      });
      expect(failed).toEqual({ ok: false, error: "failed to resolve ref missing in fixture" });
      await expect(fs.access(repoDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(sourceDir, "payload.txt"), "utf8")).toBe("main");
    });
  });
});
