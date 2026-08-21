import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
} from "../../scripts/release-plan-contract.mjs";
import {
  deriveReleasePlanPolicy,
  produceReleasePlan,
  verifyReleasePlanLock,
  type ReleasePlanIntent,
} from "../../scripts/release-plan-producer.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeFixture(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(root: string, message: string): string {
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
      message,
    ],
    { cwd: root },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function createFixtureRepo(version = "2026.8.1-beta.2") {
  const root = tempDirs.make("openclaw-release-plan-");
  execFileSync("git", ["init", "-q", "-b", "tooling"], { cwd: root });

  writeFixture(root, "package.json", JSON.stringify({ name: "openclaw", version }));
  const candidateSha = commit(root, "candidate");
  const candidateRef = `refs/tags/v${version}`;
  execFileSync("git", ["tag", `v${version}`, candidateSha], { cwd: root });

  writeFixture(
    root,
    ".github/workflows/full-release-validation.yml",
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
  writeFixture(
    root,
    ".github/workflows/openclaw-release-publish.yml",
    [
      "name: Release Publish",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          promote_windows_release_assets() {",
      "            dispatch_workflow windows-node-release.yml",
      "          }",
      "          promote_android_release_asset() {",
      '            dispatch_workflow_at_ref "${RELEASE_TAG}" "${TARGET_SHA}" android-release.yml',
      "          }",
      "          dispatch_workflow plugin-npm-release.yml",
      "  publish_docker:",
      "    uses: ./.github/workflows/docker-release.yml",
      "  publish_vcr:",
      "    uses: ./.github/workflows/vercel-container-registry-publish.yml",
      "",
    ].join("\n"),
  );
  for (const name of [
    "android-release.yml",
    "docker-release.yml",
    "plugin-npm-release.yml",
    "vercel-container-registry-publish.yml",
    "windows-node-release.yml",
  ]) {
    writeFixture(root, `.github/workflows/${name}`, `name: ${name}\n`);
  }
  writeFixture(root, "scripts/release-plan-producer.mts", "// tooling-owned fixture\n");
  writeFixture(root, "package.json", JSON.stringify({ name: "openclaw", version: "2099.1.1" }));
  const toolingSha = commit(root, "tooling");
  return { candidateRef, candidateSha, root, toolingSha };
}

function sourceParams(
  fixture: ReturnType<typeof createFixtureRepo>,
  intent: ReleasePlanIntent = "publish",
) {
  return {
    repoRoot: fixture.root,
    intent,
    candidateSha: fixture.candidateSha,
    candidateRef: intent === "main-qualification" ? fixture.candidateSha : fixture.candidateRef,
    toolingSha: fixture.toolingSha,
    toolingFullRef: "refs/heads/tooling",
  } as const;
}

describe("release plan producer", () => {
  it("derives purpose, profile, tag, and soak from the canonical version parser", () => {
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
    expect(() => deriveReleasePlanPolicy("publish", "2026.08.1")).toThrow(
      "unsupported release version",
    );
  });

  it("reads candidate inventory and tooling policy from genuinely different commits", () => {
    const fixture = createFixtureRepo();
    expect(fixture.candidateSha).not.toBe(fixture.toolingSha);
    expect(() =>
      execFileSync(
        "git",
        ["cat-file", "-e", `${fixture.candidateSha}:scripts/release-plan-producer.mts`],
        { cwd: fixture.root, stdio: "ignore" },
      ),
    ).toThrow();
    expect(
      execFileSync(
        "git",
        ["cat-file", "-e", `${fixture.toolingSha}:scripts/release-plan-producer.mts`],
        { cwd: fixture.root, stdio: "ignore" },
      ),
    ).toBeNull();

    const plan = produceReleasePlan(sourceParams(fixture));
    expect(plan).toMatchObject({
      candidate_sha: fixture.candidateSha,
      purpose: "beta-publish",
      release_id: "2026.8.1-beta.2",
      tag: "v2026.8.1-beta.2",
      target_context_ref: fixture.candidateRef,
      version: "2026.8.1-beta.2",
    });
    expect(plan.tooling).toMatchObject({
      ref: "refs/heads/tooling",
      sha: fixture.toolingSha,
    });
    expect(plan.validation.allowed_groups).toEqual(["all", "ci", "package"]);
    expect(plan.inventory.packages).toEqual([
      { name: "openclaw", targets: ["npm"], version: "2026.8.1-beta.2" },
    ]);
    expect(plan.inventory.platforms).toEqual([
      { id: "android", source: ".github/workflows/android-release.yml" },
      { id: "docker", source: ".github/workflows/docker-release.yml" },
      {
        id: "vcr",
        source: ".github/workflows/vercel-container-registry-publish.yml",
      },
      { id: "windows", source: ".github/workflows/windows-node-release.yml" },
    ]);
  });

  it("requires exact candidate and tooling identity instead of checkout HEAD", () => {
    const fixture = createFixtureRepo();
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateSha: fixture.toolingSha }),
    ).toThrow("candidate ref does not resolve");
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), toolingSha: fixture.candidateSha }),
    ).toThrow("tooling full ref does not resolve");
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateRef: "refs/heads/tooling" }),
    ).toThrow("candidate ref does not resolve");
  });

  it("rejects recomputed locks with partial groups or bogus inventory", () => {
    const fixture = createFixtureRepo();
    const params = sourceParams(fixture);
    const plan = produceReleasePlan(params);
    const validLock = canonicalReleasePlanLockJson(createReleasePlanLock(plan));
    expect(verifyReleasePlanLock(validLock, params).plan).toEqual(plan);

    const partialGroups = structuredClone(plan);
    partialGroups.validation.allowed_groups = ["all", "ci"];
    const partialPlatforms = structuredClone(plan);
    partialPlatforms.inventory.platforms = partialPlatforms.inventory.platforms.slice(0, -1);
    const bogusPackages = structuredClone(plan);
    bogusPackages.inventory.packages.push({
      name: "zz-not-published",
      targets: ["npm"],
      version: plan.version,
    });
    for (const changed of [partialGroups, partialPlatforms, bogusPackages]) {
      const redigested = canonicalReleasePlanLockJson(createReleasePlanLock(changed));
      expect(() => verifyReleasePlanLock(redigested, params)).toThrow(
        "repository-derived authority",
      );
    }
  });
});
