import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveReleasePlanPolicy,
  produceReleasePlan,
} from "../../scripts/release-plan-producer.mts";

const tempDirs: string[] = [];

function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-plan-"));
  tempDirs.push(root);
  mkdirSync(join(root, "extensions"), { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.8.1" }),
  );
  writeFileSync(
    join(root, ".github/workflows/full-release-validation.yml"),
    [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      rerun_group:",
      "        options:",
      "          - package",
      "          - all",
      "          - ci",
      "",
    ].join("\n"),
  );
  const platforms = [
    ["android", ".github/workflows/android-release.yml"],
    ["docker", ".github/workflows/docker-release.yml"],
    ["windows", ".github/workflows/windows-node-release.yml"],
  ] as const;
  for (const [, source] of platforms) {
    writeFileSync(join(root, source), "name: fixture\n");
  }
  writeFileSync(
    join(root, "scripts/release-plan-inventory.json"),
    JSON.stringify({
      schema: "openclaw.release-plan-inventory.v1",
      platforms: platforms.map(([id, source]) => ({ id, source })),
    }),
  );
  execFileSync("git", ["init", "-q", "-b", "tooling"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("release plan producer", () => {
  it("derives purpose, profile, tag, and soak from intent and version", () => {
    expect(deriveReleasePlanPolicy("publish", "2026.8.1-beta.2")).toEqual({
      profile: "beta",
      purpose: "beta-publish",
      soak: false,
      tag: "v2026.8.1-beta.2",
    });
    expect(deriveReleasePlanPolicy("publish", "2026.8.1")).toEqual({
      profile: "stable",
      purpose: "stable-publish",
      soak: true,
      tag: "v2026.8.1",
    });
    expect(deriveReleasePlanPolicy("postpublish-confidence", "2026.8.1")).toEqual({
      profile: "full",
      purpose: "postpublish-confidence",
      soak: true,
      tag: "v2026.8.1",
    });
    expect(deriveReleasePlanPolicy("main-qualification", "2026.8.1")).toEqual({
      profile: "full",
      purpose: "main-qualification",
      soak: true,
      tag: null,
    });
  });

  it("derives identity, groups, and inventory from an exact clean checkout", () => {
    const repoRoot = createFixtureRepo();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const plan = produceReleasePlan({
      repoRoot,
      intent: "main-qualification",
      toolingFullRef: "refs/heads/tooling",
    });

    expect(plan).toMatchObject({
      candidate_sha: sha,
      purpose: "main-qualification",
      release_id: "2026.8.1",
      tag: null,
      target_context_ref: sha,
      version: "2026.8.1",
    });
    expect(plan.tooling).toEqual({
      ref: "refs/heads/tooling",
      repository: "openclaw/openclaw",
      sha,
      workflow_path: ".github/workflows/full-release-validation.yml",
    });
    expect(plan.validation.allowed_groups).toEqual(["all", "ci", "package"]);
    expect(plan.inventory.packages).toEqual([
      { name: "openclaw", targets: ["npm"], version: "2026.8.1" },
    ]);
    expect(plan.inventory.platforms.map((platform) => platform.id)).toEqual([
      "android",
      "docker",
      "windows",
    ]);
  });

  it("rejects a checkout whose bytes are not represented by candidate HEAD", () => {
    const repoRoot = createFixtureRepo();
    writeFileSync(join(repoRoot, "package.json"), '{"name":"openclaw","version":"2026.8.2"}');

    expect(() =>
      produceReleasePlan({
        repoRoot,
        intent: "publish",
        toolingFullRef: "refs/heads/tooling",
      }),
    ).toThrow("source checkout must be clean");
  });
});
