import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBuildIdentityEnvironment } from "../../scripts/lib/build-identity.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const buildIdentityUrl = new URL("../../scripts/lib/build-identity.mts", import.meta.url).href;
const tsxPreloadUrl = new URL("../../scripts/tsx.mjs", import.meta.url).href;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readGitCommitInChild(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      tsxPreloadUrl,
      "--input-type=module",
      "--eval",
      `const { readCurrentGitCommit } = await import(${JSON.stringify(buildIdentityUrl)}); process.stdout.write(JSON.stringify(readCurrentGitCommit()));`,
    ],
    {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as string | null;
}

describe("readCurrentGitCommit", () => {
  it("reads HEAD from the inherited cwd and returns null when Git cannot resolve it", () => {
    const root = tempDirs.make("openclaw-build-identity-");
    const repo = join(root, "repo");
    const outsideRepo = join(root, "outside");
    mkdirSync(repo);
    mkdirSync(outsideRepo);

    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "fixture.txt"), "fixture\n");
    execFileSync("git", ["add", "fixture.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=OpenClaw Tests",
        "-c",
        "user.email=openclaw-tests@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: repo, stdio: "ignore" },
    );
    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();

    expect(readGitCommitInChild(repo)).toBe(expected);
    expect(readGitCommitInChild(outsideRepo)).toBeNull();

    const envWithoutGit = { ...process.env };
    for (const key of Object.keys(envWithoutGit)) {
      if (key.toLowerCase() === "path") {
        delete envWithoutGit[key];
      }
    }
    envWithoutGit.PATH = "";
    expect(readGitCommitInChild(repo, envWithoutGit)).toBeNull();
  });
});

describe("resolveBuildIdentityEnvironment", () => {
  it.each([
    {
      env: { GIT_COMMIT: "A".repeat(40), GIT_SHA: "b".repeat(40) },
      expected: "a".repeat(40),
      readsCheckout: false,
    },
    {
      env: { GIT_SHA: "B".repeat(40), GITHUB_SHA: "c".repeat(40) },
      expected: "b".repeat(40),
      readsCheckout: false,
    },
    {
      env: { GITHUB_SHA: "c".repeat(40) },
      expected: "d".repeat(40),
      readsCheckout: true,
    },
  ])("preserves build source precedence %#", ({ env, expected, readsCheckout }) => {
    const readGitCommit = vi.fn(() => "D".repeat(40));
    const resolved = resolveBuildIdentityEnvironment({
      commitLabel: "build commit",
      env,
      now: () => new Date("2026-07-10T12:34:56.000Z"),
      readGitCommit,
    });

    expect(resolved.GIT_COMMIT).toBe(expected);
    expect(readGitCommit).toHaveBeenCalledTimes(readsCheckout ? 1 : 0);
  });

  it("uses workflow identity only when the checkout cannot be read", () => {
    expect(
      resolveBuildIdentityEnvironment({
        commitLabel: "runtime pack commit",
        env: {
          GITHUB_SHA: "e".repeat(40),
          OPENCLAW_BUILD_TIMESTAMP: " 2026-07-10T01:02:03.000Z ",
        },
        now: () => new Date("2026-07-11T12:34:56.000Z"),
        readGitCommit: () => null,
      }),
    ).toMatchObject({
      GIT_COMMIT: "e".repeat(40),
      OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.000Z",
    });
  });

  it("uses the owner label in malformed commit diagnostics", () => {
    expect(() =>
      resolveBuildIdentityEnvironment({
        commitLabel: "runtime pack commit",
        env: { GIT_COMMIT: "deadbeef" },
        readGitCommit: () => null,
      }),
    ).toThrow("runtime pack commit must be a full 40-character hexadecimal SHA");
  });
});
