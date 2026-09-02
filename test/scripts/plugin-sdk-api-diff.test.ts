import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTestTimeout } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "."]);
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
    message,
  ]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
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
    const invocationCounts = join(runnerTemp, ".git-invocation-counts.json");
    const runnerSentinel = join(runnerTemp, "runner-owned.txt");
    writeFileSync(invocationCounts, "{}\n");
    writeFileSync(runnerSentinel, "preserve\n");

    git(repo, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    commit(repo, "fixture");

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
      const exitCode = await withTestTimeout(close, 5_000, "Plugin SDK API diff ignored SIGTERM");

      expect(exitCode).toBe(143);
      expect(Date.now() - interruptedAt).toBeLessThan(5_000);
      expect(git(repo, ["worktree", "list"])).not.toContain(runnerTemp);
      // Cleanup owns its temporary root, not runner instrumentation beside it.
      expect(existsSync(temporaryRoot)).toBe(false);
      expect(existsSync(invocationCounts)).toBe(true);
      expect(readFileSync(runnerSentinel, "utf8")).toBe("preserve\n");
    } finally {
      if (!closed) {
        child.kill("SIGKILL");
        await close;
      }
    }
  }, 15_000);

  it.each([false, true])(
    "reuses unique SDK revisions across selectors (shared predecessor: %s)",
    (shared) => {
      const repo = tempDirs.make("plugin-sdk-selector-repo-");
      const runnerTemp = tempDirs.make("plugin-sdk-selector-temp-");
      const binDir = tempDirs.make("plugin-sdk-selector-bin-");
      const installLog = join(binDir, "installs");
      const evidencePath = join(binDir, "evidence.json");
      git(repo, ["init", "--quiet", "--initial-branch=main"]);
      mkdirSync(join(repo, "src/plugin-sdk"), { recursive: true });
      mkdirSync(join(repo, "scripts/lib"), { recursive: true });
      writeFileSync(join(repo, ".gitignore"), "node_modules\n");
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ version: "2026.8.2", type: "module" }),
      );
      writeFileSync(
        join(repo, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            target: "ESNext",
            types: [],
            skipLibCheck: true,
          },
        }),
      );
      writeFileSync(join(repo, "scripts/lib/plugin-sdk-entrypoints.json"), '["fixture"]');
      writeFileSync(join(repo, "scripts/lib/plugin-sdk-private-local-only-subpaths.json"), "[]");
      const source = join(repo, "src/plugin-sdk/fixture.ts");
      writeFileSync(source, "export type Fixture = string;\n");
      const latestSha = commit(repo, "latest");
      git(repo, ["tag", "v2026.7.31"]);
      writeFileSync(source, "export type Fixture = number;\n");
      const betaSha = commit(repo, "beta");
      git(repo, ["tag", "v2026.8.1-beta.1"]);
      writeFileSync(source, "export type Fixture = boolean;\n");
      const headSha = commit(repo, "candidate");
      symlinkSync(resolve("node_modules"), join(repo, "node_modules"), "dir");
      const fakePnpm = join(binDir, "pnpm");
      writeFileSync(fakePnpm, '#!/bin/sh\nprintf "%s\\n" "$PWD" >> "$PNPM_MARKER"\n');
      chmodSync(fakePnpm, 0o755);
      const bases = { beta: shared ? "v2026.7.31" : "v2026.8.1-beta.1", latest: "v2026.7.31" };
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          import.meta.resolve("tsx"),
          resolve("scripts/plugin-sdk-api-diff.mts"),
          "--bases-json",
          JSON.stringify(bases),
          "--head",
          "HEAD",
          "--evidence",
          evidencePath,
        ],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
            PNPM_MARKER: installLog,
            RUNNER_TEMP: runnerTemp,
            TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
          },
          timeout: 30_000,
        },
      );
      expect(child.status, child.stderr).toBe(0);
      const installed = readFileSync(installLog, "utf8")
        .trim()
        .split("\n")
        .map((path) => basename(path));
      expect(installed.toSorted()).toEqual(
        [latestSha, ...(shared ? [] : [betaSha]), headSha].toSorted(),
      );
      const bundle = JSON.parse(readFileSync(evidencePath, "utf8"));
      expect(bundle.schema).toBe("openclaw.plugin-sdk-api-release-evidence-set/v1");
      expect(bundle.selectors.beta.baseRef).toBe(bases.beta);
      expect(bundle.selectors.latest.baseRef).toBe(bases.latest);
      expect(bundle.selectors.beta.headSha).toBe(headSha);
      expect(bundle.selectors.latest.headSha).toBe(headSha);
      expect(bundle.selectors.beta.diff.exports[0].before.declaration).toContain(
        shared ? "string" : "number",
      );
      expect(bundle.selectors.latest.diff.exports[0].before.declaration).toContain("string");
      expect(bundle.selectors.beta.diff.exports[0].after.declaration).toContain("boolean");
      expect(git(repo, ["worktree", "list"])).not.toContain(runnerTemp);
    },
    35_000,
  );
});
