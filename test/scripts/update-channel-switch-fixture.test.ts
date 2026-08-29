import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectGitRuntimeErrors } from "../../src/infra/update-git-runtime.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("builds the package-derived Git fixture with its own checkout identity", async () => {
  const root = tempDirs.make("update-channel-git-fixture-");
  const packageCommit = "a".repeat(40);
  const runtimeEntry = "export {};\n";
  mkdirSync(join(root, "dist"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.8.1" }),
  );
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "dist/entry.js"), runtimeEntry);
  writeFileSync(
    join(root, "dist/build-info.json"),
    JSON.stringify({ commit: packageCommit, version: "2026.8.1" }),
  );
  execFileSync(process.execPath, [
    "scripts/e2e/lib/update-channel-switch/assertions.mjs",
    "prepare-git-fixture",
    root,
  ]);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  const sha = git(["rev-parse", "HEAD"]);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: { build: string };
  };
  expect(await collectGitRuntimeErrors({ root, sha })).not.toEqual([]);
  execSync(manifest.scripts.build, { cwd: root });
  expect(await collectGitRuntimeErrors({ root, sha })).toEqual([]);
  expect(JSON.parse(readFileSync(join(root, "dist/build-info.json"), "utf8"))).toEqual({
    commit: sha,
    version: "2026.8.1",
  });
  expect(readFileSync(join(root, "dist/entry.js"), "utf8")).toBe(runtimeEntry);
  expect(git(["status", "--porcelain"])).toBe("");
});
