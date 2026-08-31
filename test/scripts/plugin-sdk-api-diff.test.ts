import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for Plugin SDK API diff child");
    }
    await new Promise((resolveWait) => {
      setTimeout(resolveWait, 25);
    });
  }
}

describe("Plugin SDK API diff CLI", () => {
  it("interrupts a running child and removes its registered worktree", async () => {
    // Keep revision checkout bounded so startup reaches the child this test cancels.
    const repo = tempDirs.make("plugin-sdk-api-diff-repo-");
    const runnerTemp = tempDirs.make("plugin-sdk-api-diff-temp-");
    const binDir = tempDirs.make("plugin-sdk-api-diff-bin-");
    const pnpmMarker = join(binDir, "pnpm-started");
    const runnerSentinel = join(runnerTemp, "runner-owned.txt");
    writeFileSync(runnerSentinel, "preserve\n");

    git(repo, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--no-gpg-sign",
      "--quiet",
      "-m",
      "fixture",
    ]);

    const fakePnpm = join(binDir, "pnpm");
    writeFileSync(
      fakePnpm,
      "#!/bin/sh\n: > \"$PNPM_MARKER\"\ntrap 'exit 143' INT TERM\nwhile :; do sleep 1; done\n",
    );
    chmodSync(fakePnpm, 0o755);

    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("scripts/plugin-sdk-api-diff.mts"),
        "--base",
        "HEAD",
        "--head",
        "HEAD",
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          PNPM_MARKER: pnpmMarker,
          RUNNER_TEMP: runnerTemp,
          // The fixture owns Git state; the source CLI still needs its workspace aliases.
          TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let closed = false;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const close = new Promise<number | null>((resolveClose) => {
      child.once("close", (code) => {
        closed = true;
        resolveClose(code);
      });
    });
    try {
      await waitFor(() => existsSync(pnpmMarker) || closed, 10_000);
      expect(closed, stderr).toBe(false);
      const revisionRoot = git(repo, ["worktree", "list", "--porcelain", "-z"])
        .split("\0")
        .filter((record) => record.startsWith("worktree "))
        .map((record) => resolve(record.slice("worktree ".length)))
        .find((root) => dirname(dirname(root)) === runnerTemp);
      assert(revisionRoot, "expected a registered revision worktree under runner temp");
      const temporaryRoot = dirname(revisionRoot);
      expect(existsSync(temporaryRoot)).toBe(true);
      const interruptedAt = Date.now();
      child.kill("SIGTERM");
      const exitCode = await Promise.race([
        close,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Plugin SDK API diff ignored SIGTERM")), 5_000);
        }),
      ]);

      expect(exitCode).toBe(143);
      expect(Date.now() - interruptedAt).toBeLessThan(5_000);
      expect(git(repo, ["worktree", "list"])).not.toContain(runnerTemp);
      // Cleanup owns its temporary root, not runner instrumentation beside it.
      expect(existsSync(temporaryRoot)).toBe(false);
      expect(readFileSync(runnerSentinel, "utf8")).toBe("preserve\n");
    } finally {
      if (!closed) {
        child.kill("SIGKILL");
        await close;
      }
    }
  }, 15_000);
});
