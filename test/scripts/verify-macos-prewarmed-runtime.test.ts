import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createFixture(): { repoRoot: string; runtimeBin: string; runtimeRoot: string } {
  const root = tempDirs.make("openclaw-prewarmed-runtime-verify-");
  const repoRoot = path.join(root, "repo");
  const runtimeBin = path.join(root, "runtime-bin");
  const runtimeRoot = path.join(root, "runtime");
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(runtimeBin);
  fs.mkdirSync(path.join(runtimeRoot, "dist", "extensions"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ files: ["dist/", "!dist/extensions/external/**"] })}\n`,
  );
  return { repoRoot, runtimeBin, runtimeRoot };
}

function verifyFixture(repoRoot: string, runtimeBin: string, runtimeRoot: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/verify-macos-prewarmed-runtime.mts",
      "--repo-root",
      repoRoot,
      "--runtime-root",
      runtimeRoot,
      "--runtime-bin",
      runtimeBin,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

describe("verify macOS prewarmed runtime", () => {
  it("rejects a missing runtime root", () => {
    const fixture = createFixture();
    fs.rmSync(fixture.runtimeRoot, { recursive: true });

    const result = verifyFixture(fixture.repoRoot, fixture.runtimeBin, fixture.runtimeRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Prewarmed runtime root is missing");
  });

  it("accepts Stable-equivalent core runtime contents", () => {
    const fixture = createFixture();

    const result = verifyFixture(fixture.repoRoot, fixture.runtimeBin, fixture.runtimeRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("verified Stable-equivalent core runtime contents");
  });

  it("rejects externalized plugins in the core runtime", () => {
    const fixture = createFixture();
    fs.mkdirSync(path.join(fixture.runtimeRoot, "dist", "extensions", "external"));

    const result = verifyFixture(fixture.repoRoot, fixture.runtimeBin, fixture.runtimeRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Prewarmed runtime contains external plugins: external");
  });

  it("rejects a managed Codex executable", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.runtimeBin, "codex"), "fixture\n");

    const result = verifyFixture(fixture.repoRoot, fixture.runtimeBin, fixture.runtimeRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Prewarmed runtime contains a managed Codex executable");
  });
});
