import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectClawHubPublishablePluginPackages } from "../../scripts/lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "../../scripts/lib/plugin-npm-release.ts";
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
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TOOLING_CLOSURE = [
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/release-plan-producer.mts",
  "scripts/release-plan-contract.mjs",
  "scripts/release-validation-intent.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-version.mjs",
];

function writeFixture(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(root: string, message: string, options: { allowEmpty?: boolean } = {}): string {
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
      ...(options.allowEmpty ? ["--allow-empty"] : []),
      "-m",
      message,
    ],
    { cwd: root },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function copyToolingClosure(root: string) {
  for (const path of TOOLING_CLOSURE) {
    writeFixture(root, path, readFileSync(resolve(path), "utf8"));
  }
}

function createFixtureRepo(
  version = "2026.8.1-beta.2",
  options: {
    conflictingPlatformId?: boolean;
    corePackageNameCollision?: boolean;
    duplicateCrossTargetPackageName?: boolean;
    malformedPlugin?: boolean;
    malformedPluginJson?: boolean;
  } = {},
) {
  const root = tempDirs.make("openclaw-release-plan-");
  execFileSync("git", ["init", "-q", "-b", "tooling"], { cwd: root });

  writeFixture(
    root,
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version,
      dependencies: { "@openclaw/ai": "workspace:*" },
    }),
  );
  for (const [path, name] of [
    ["packages/ai", "@openclaw/ai"],
    ["packages/gateway-client", "@openclaw/gateway-client"],
    ["packages/gateway-protocol", "@openclaw/gateway-protocol"],
  ]) {
    writeFixture(
      root,
      `${path}/package.json`,
      JSON.stringify({
        name,
        version,
        openclaw: { release: { publishToNpm: true } },
      }),
    );
  }
  if (options.corePackageNameCollision) {
    writePublishablePluginFixture(root, {
      extensionId: "shadow-ai",
      packageName: "@openclaw/ai",
      version,
      publishTo: "both",
    });
  } else if (options.duplicateCrossTargetPackageName) {
    writePublishablePluginFixture(root, {
      extensionId: "duplicate-npm",
      packageName: "@openclaw/duplicate",
      version,
      publishTo: "npm",
    });
    writePublishablePluginFixture(root, {
      extensionId: "duplicate-clawhub",
      packageName: "@openclaw/duplicate",
      version,
      publishTo: "clawhub",
    });
  } else if (options.malformedPluginJson) {
    writeFixture(root, "extensions/broken/package.json", "{ not-json\n");
  } else if (options.malformedPlugin) {
    writeFixture(
      root,
      "extensions/broken/package.json",
      JSON.stringify({
        name: "@openclaw/broken",
        version,
        type: "commonjs",
        private: true,
        repository: { type: "git", url: "https://github.com/openclaw/openclaw" },
        openclaw: {
          extensions: ["./index.ts"],
          compat: { pluginApi: `>=${version}` },
          build: { openclawVersion: version },
          install: { npmSpec: "@openclaw/broken" },
          release: { publishToNpm: true },
        },
      }),
    );
  }
  const candidateSha = commit(root, "candidate");
  const candidateRef = `refs/tags/v${version}`;

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
      ...(options.conflictingPlatformId
        ? ["  publish_windows:", "    uses: ./.github/workflows/docker-release.yml"]
        : []),
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    ".github/workflows/openclaw-npm-release.yml",
    [
      "name: NPM Release",
      "jobs:",
      "  preflight:",
      "    steps:",
      "      - name: Pack publishable core packages",
      "        env:",
      "          CORE_PACKAGE_DIRS: packages/ai packages/gateway-protocol packages/gateway-client",
      "        run: |",
      '          if [[ "$package_dir" == "packages/ai" ]] && ! node -e \'const pkg = require("./package.json"); process.exit(pkg.dependencies?.["@openclaw/ai"] ? 0 : 1)\'; then',
      "            exit 0",
      "          fi",
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
  copyToolingClosure(root);
  writeFixture(root, "package.json", JSON.stringify({ name: "openclaw", version: "2099.1.1" }));
  const toolingSha = commit(root, "tooling");
  const toolingFullRef = `refs/tags/release-publish/${toolingSha.slice(0, 12)}-1`;
  return { candidateRef, candidateSha, root, toolingFullRef, toolingSha };
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
    toolingFullRef: fixture.toolingFullRef,
    runGh: trustedToolingGh(fixture.toolingFullRef, fixture.toolingSha),
  } as const;
}

function trustedToolingGh(toolingFullRef: string, toolingSha: string) {
  return (args: string[]) => {
    const endpoint = args[1];
    if (
      endpoint ===
      `repos/openclaw/openclaw/git/ref/tags/${toolingFullRef.slice("refs/tags/".length)}`
    ) {
      return JSON.stringify({
        ref: toolingFullRef,
        object: { type: "commit", sha: toolingSha },
      });
    }
    throw new Error(`unexpected GitHub API request: ${args.join(" ")}`);
  };
}

describe("release plan producer", () => {
  it("derives purpose, profile, tag, and soak from the canonical version parser", () => {
    expect(deriveReleasePlanPolicy("publish", "2026.8.1-beta.2")).toEqual({
      intent: "release-beta",
      profile: "beta",
      publishable: true,
      purpose: "beta-publish",
      soak: false,
      tag: "v2026.8.1-beta.2",
    });
    expect(deriveReleasePlanPolicy("publish", "2026.8.1")).toEqual({
      intent: "release-stable",
      profile: "stable",
      publishable: true,
      purpose: "stable-publish",
      soak: true,
      tag: "v2026.8.1",
    });
    expect(deriveReleasePlanPolicy("postpublish-confidence", "2026.8.1-beta.2")).toEqual({
      intent: "diagnostic-full",
      profile: "full",
      publishable: false,
      purpose: "postpublish-confidence",
      soak: true,
      tag: "v2026.8.1-beta.2",
    });
    expect(deriveReleasePlanPolicy("main-qualification", "2026.8.1-beta.2")).toEqual({
      intent: "main-weekly",
      profile: "full",
      publishable: false,
      purpose: "main-qualification",
      soak: true,
      tag: null,
    });
    expect(() => deriveReleasePlanPolicy("publish", "2026.08.1")).toThrow(
      "unsupported release version",
    );
  });

  it("reads candidate inventory and tooling policy from genuinely different commits", () => {
    const fixture = createFixtureRepo();
    expect(fixture.candidateSha).not.toBe(fixture.toolingSha);
    expect(() =>
      execFileSync("git", ["cat-file", "-e", fixture.candidateRef], {
        cwd: fixture.root,
        stdio: "ignore",
      }),
    ).toThrow();
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
    expect(() =>
      execFileSync("git", ["cat-file", "-e", fixture.toolingFullRef], {
        cwd: fixture.root,
        stdio: "ignore",
      }),
    ).toThrow();

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
      ref: fixture.toolingFullRef,
      sha: fixture.toolingSha,
    });
    expect(plan.validation).toEqual({
      allowed_groups: ["all", "ci", "package"],
      intent: "release-beta",
      profile: "beta",
      soak: false,
    });
    expect(plan.inventory.packages).toEqual([
      { name: "@openclaw/ai", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "@openclaw/gateway-client", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "@openclaw/gateway-protocol", targets: ["npm"], version: "2026.8.1-beta.2" },
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

  it("requires the final tag only for postpublish confidence", () => {
    const fixture = createFixtureRepo();
    expect(produceReleasePlan(sourceParams(fixture))).toMatchObject({
      purpose: "beta-publish",
      target_context_ref: fixture.candidateRef,
    });
    expect(() => produceReleasePlan(sourceParams(fixture, "postpublish-confidence"))).toThrow(
      "published candidate tag does not resolve",
    );

    execFileSync(
      "git",
      ["tag", fixture.candidateRef.slice("refs/tags/".length), fixture.candidateSha],
      {
        cwd: fixture.root,
      },
    );
    expect(produceReleasePlan(sourceParams(fixture, "postpublish-confidence"))).toMatchObject({
      purpose: "postpublish-confidence",
      target_context_ref: fixture.candidateRef,
      validation: {
        intent: "diagnostic-full",
        profile: "full",
        soak: true,
      },
    });
  });

  it("requires exact candidate and tooling identity instead of checkout HEAD", () => {
    const fixture = createFixtureRepo();
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateSha: "f".repeat(40) }),
    ).toThrow("candidate SHA does not resolve");
    expect(() =>
      produceReleasePlan({
        ...sourceParams(fixture),
        runGh: trustedToolingGh(fixture.toolingFullRef, fixture.candidateSha),
      }),
    ).toThrow(
      "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA",
    );
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateRef: "refs/heads/tooling" }),
    ).toThrow("candidate ref must be");
  });

  it("rejects a locally forged protected tooling tag that GitHub does not own", () => {
    const fixture = createFixtureRepo();
    const forgedFullRef = `refs/tags/release-publish/${fixture.toolingSha.slice(0, 12)}-999`;
    execFileSync("git", ["tag", forgedFullRef.slice("refs/tags/".length), fixture.toolingSha], {
      cwd: fixture.root,
    });

    expect(() =>
      produceReleasePlan({
        ...sourceParams(fixture),
        toolingFullRef: forgedFullRef,
        runGh: () => {
          throw new Error("HTTP 404");
        },
      }),
    ).toThrow("protected release tooling tag is missing or unreadable");
  });

  it("rejects a caller producer that differs from the exact tooling commit", () => {
    const fixture = createFixtureRepo();
    writeFixture(fixture.root, "scripts/release-plan-producer.mts", "// placeholder producer\n");
    const toolingSha = commit(fixture.root, "different producer");
    const toolingFullRef = `refs/tags/release-publish/${toolingSha.slice(0, 12)}-2`;

    expect(() =>
      produceReleasePlan({
        ...sourceParams(fixture),
        toolingSha,
        toolingFullRef,
        runGh: trustedToolingGh(toolingFullRef, toolingSha),
      }),
    ).toThrow("tooling import closure differs from tooling SHA");
  });

  it("rejects malformed publishable plugins while producing the plan", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", { malformedPlugin: true });
    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      /Publishable plugin metadata validation failed:[\s\S]*private must not be true[\s\S]*type must be "module"[\s\S]*README\.md must exist/u,
    );
  });

  it("fails closed on malformed candidate manifests across both publishers and ReleasePlan", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", { malformedPluginJson: true });
    const error = "plugin candidate manifest is malformed JSON: extensions/broken/package.json";
    expect(() => collectPublishablePluginPackages(fixture.root)).toThrow(error);
    expect(() => collectClawHubPublishablePluginPackages(fixture.root)).toThrow(error);
    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(error);
  });

  it("rejects duplicate package names split across npm and ClawHub plugin sources", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      duplicateCrossTargetPackageName: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "package @openclaw/duplicate is declared by multiple plugin sources",
    );
  });

  it("rejects a plugin package name that collides with a core package source", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      corePackageNameCollision: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "package inventory source mismatch for @openclaw/ai: extensions/shadow-ai/package.json and packages/ai/package.json",
    );
  });

  it("rejects conflicting platform publication sources with the same id", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      conflictingPlatformId: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "declares conflicting platform windows: .github/workflows/windows-node-release.yml and .github/workflows/docker-release.yml",
    );
  });

  it("matches the exact current publisher inventory: 93 npm and 89 ClawHub packages", () => {
    const root = tempDirs.make("openclaw-release-plan-current-");
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve("."),
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", resolve("."), root]);
    execFileSync("git", ["checkout", "-q", "--detach", candidateSha], { cwd: root });
    copyToolingClosure(root);
    const toolingSha = commit(root, "tooling overlay", { allowEmpty: true });
    execFileSync("git", ["update-ref", "refs/heads/main", toolingSha], { cwd: root });

    const plan = produceReleasePlan({
      repoRoot: root,
      intent: "main-qualification",
      candidateSha,
      candidateRef: candidateSha,
      toolingSha,
      toolingFullRef: "refs/heads/main",
      runGh: () => JSON.stringify({ status: "identical" }),
    });
    const npmPackages = plan.inventory.packages.filter((entry) => entry.targets.includes("npm"));
    const clawHubPackages = plan.inventory.packages.filter((entry) =>
      entry.targets.includes("clawhub"),
    );
    expect(npmPackages).toHaveLength(93);
    expect(clawHubPackages).toHaveLength(89);
    const coreNpmPackages = new Set([
      "@openclaw/ai",
      "@openclaw/gateway-client",
      "@openclaw/gateway-protocol",
      "openclaw",
    ]);
    expect(
      npmPackages
        .map((entry) => entry.name)
        .filter((name) => !coreNpmPackages.has(name))
        .toSorted(),
    ).toEqual(
      collectPublishablePluginPackages(root)
        .map((plugin) => plugin.packageName)
        .toSorted(),
    );
    expect(clawHubPackages.map((entry) => entry.name).toSorted()).toEqual(
      collectClawHubPublishablePluginPackages(root)
        .map((plugin) => plugin.packageName)
        .toSorted(),
    );
    expect(npmPackages.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "@openclaw/ai",
        "@openclaw/gateway-client",
        "@openclaw/gateway-protocol",
        "openclaw",
      ]),
    );
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
