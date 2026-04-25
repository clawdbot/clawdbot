import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mjs";
import {
  CHANGED_CHECK_VITEST_NO_OUTPUT_TIMEOUT_MS,
  createChangedCheckPlan,
  createChangedCheckVitestEnv,
} from "../../scripts/check-changed.mjs";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

function createNestedGitEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return env;
}

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createNestedGitEnv(),
  }).trim();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("scripts/changed-lanes", () => {
  it("includes untracked worktree files in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(dir, "README.md"), "initial\n", "utf8");
    git(dir, ["add", "README.md"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "new-check.mjs"), "export {};\n", "utf8");

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    expect(JSON.parse(output)).toMatchObject({
      paths: ["scripts/new-check.mjs"],
      lanes: { tooling: true },
    });
  });

  it("routes core production changes to core prod and core test lanes", () => {
    const result = detectChangedLanes(["src/shared/string-normalization.ts"]);

    expect(result.lanes).toMatchObject({
      core: true,
      coreTests: true,
      extensions: false,
      extensionTests: false,
      all: false,
    });
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:core",
    );
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:core:test",
    );
  });

  it("routes core test-only changes to core test lanes only", () => {
    const result = detectChangedLanes(["src/shared/string-normalization.test.ts"]);

    expect(result.lanes).toMatchObject({
      core: false,
      coreTests: true,
      extensions: false,
      extensionTests: false,
      all: false,
    });
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:core:test",
    );
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).not.toContain(
      "tsgo:core",
    );
  });

  it("routes extension production changes to extension prod and extension test lanes", () => {
    const result = detectChangedLanes(["extensions/discord/src/index.ts"]);

    expect(result.lanes).toMatchObject({
      core: false,
      coreTests: false,
      extensions: true,
      extensionTests: true,
      all: false,
    });
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:extensions",
    );
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:extensions:test",
    );
  });

  it("routes extension test-only changes to extension test lanes only", () => {
    const result = detectChangedLanes(["extensions/discord/src/index.test.ts"]);

    expect(result.lanes).toMatchObject({
      core: false,
      coreTests: false,
      extensions: false,
      extensionTests: true,
      all: false,
    });
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).toContain(
      "tsgo:extensions:test",
    );
    expect(createChangedCheckPlan(result).commands.map((command) => command.args[0])).not.toContain(
      "tsgo:extensions",
    );
  });

  it("expands public core/plugin contracts to extension validation", () => {
    const result = detectChangedLanes(["src/plugin-sdk/core.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(result.extensionImpactFromCore).toBe(true);
    expect(result.lanes).toMatchObject({
      core: true,
      coreTests: true,
      extensions: true,
      extensionTests: true,
      all: false,
    });
    expect(plan.runExtensionTests).toBe(true);
    expect(plan.testTargets).toEqual(["src/plugin-sdk/core.ts"]);
  });

  it("fails safe for root config changes", () => {
    const result = detectChangedLanes(["pnpm-lock.yaml"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.all).toBe(true);
    expect(plan.runFullTests).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:all");
  });

  it("routes gitignore changes to tooling instead of all lanes", () => {
    const result = detectChangedLanes([".gitignore"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes).toMatchObject({
      tooling: true,
      all: false,
    });
    expect(plan.runFullTests).toBe(false);
    expect(plan.runChangedTestsBroad).toBe(false);
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("keeps release metadata commits off the full changed gate", () => {
    const result = detectChangedLanes([
      "CHANGELOG.md",
      "apps/android/app/build.gradle.kts",
      "apps/ios/CHANGELOG.md",
      "apps/ios/Config/Version.xcconfig",
      "apps/ios/fastlane/metadata/en-US/release_notes.txt",
      "apps/ios/version.json",
      "apps/macos/Sources/OpenClaw/Resources/Info.plist",
      "docs/.generated/config-baseline.sha256",
      "package.json",
      "src/config/schema.base.generated.ts",
    ]);
    const plan = createChangedCheckPlan(result, { staged: true });

    expect(result.lanes).toMatchObject({
      releaseMetadata: true,
      all: false,
      core: false,
      apps: false,
    });
    expect(plan.runFullTests).toBe(false);
    expect(plan.commands.map((command) => command.args[0])).toEqual([
      "check:no-conflict-markers",
      "release-metadata:check",
      "ios:version:check",
      "config:schema:check",
      "config:docs:check",
      "deps:root-ownership:check",
    ]);
  });

  it("guards release metadata package changes to the top-level version field", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-release-metadata-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.20", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    git(dir, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "initial",
    ]);

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    expect(() =>
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "check-release-metadata-only.mjs"), "--staged"],
        {
          cwd: dir,
          env: createNestedGitEnv(),
          stdio: "pipe",
        },
      ),
    ).not.toThrow();

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.1" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    expect(() =>
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "check-release-metadata-only.mjs"), "--staged"],
        {
          cwd: dir,
          env: createNestedGitEnv(),
          stdio: "pipe",
        },
      ),
    ).toThrow();
  });

  it("routes root test/support changes to the tooling test lane instead of all lanes", () => {
    const result = detectChangedLanes(["test/git-hooks-pre-commit.test.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes).toMatchObject({
      tooling: true,
      all: false,
    });
    expect(plan.testTargets).toEqual(["test/git-hooks-pre-commit.test.ts"]);
    expect(plan.runFullTests).toBe(false);
  });

  it("keeps shared Vitest wiring changes on the broad changed test path", () => {
    const result = detectChangedLanes(["test/vitest/vitest.shared.config.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.testTargets).toEqual([]);
    expect(plan.runChangedTestsBroad).toBe(true);
    expect(plan.runFullTests).toBe(false);
  });

  it("keeps setup changes on the broad changed test path", () => {
    const result = detectChangedLanes(["test/setup.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.testTargets).toEqual([]);
    expect(plan.runChangedTestsBroad).toBe(true);
    expect(plan.runFullTests).toBe(false);
  });

  it("does not route generated A2UI artifacts as direct Vitest targets", () => {
    const result = detectChangedLanes([
      "src/canvas-host/a2ui/.bundle.hash",
      "test/scripts/bundle-a2ui.test.ts",
    ]);
    const plan = createChangedCheckPlan(result);

    expect(plan.testTargets).toEqual(["test/scripts/bundle-a2ui.test.ts"]);
    expect(plan.runChangedTestsBroad).toBe(false);
  });

  it("routes changed extension Vitest configs to only their owning shard", () => {
    const result = detectChangedLanes(["test/vitest/vitest.extension-discord.config.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.testTargets).toEqual(["test/vitest/vitest.extension-discord.config.ts"]);
    expect(plan.runChangedTestsBroad).toBe(false);
    expect(plan.runFullTests).toBe(false);
  });

  it("keeps an empty changed path list as a no-op", () => {
    const result = detectChangedLanes([]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes).toEqual({
      core: false,
      coreTests: false,
      extensions: false,
      extensionTests: false,
      apps: false,
      docs: false,
      tooling: false,
      releaseMetadata: false,
      all: false,
    });
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
    ]);
    expect(plan.runChangedTestsBroad).toBe(false);
    expect(plan.runFullTests).toBe(false);
  });

  it("keeps docs-only changes cheap", () => {
    const result = detectChangedLanes(["docs/ci.md", "README.md"]);
    const plan = createChangedCheckPlan(result);

    expect(result.docsOnly).toBe(true);
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
    ]);
    expect(plan.runChangedTestsBroad).toBe(false);
    expect(plan.runFullTests).toBe(false);
  });

  it("sets a ten-minute Vitest watchdog for changed checks", () => {
    expect(CHANGED_CHECK_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("600000");
    expect(createChangedCheckVitestEnv({ PATH: "/usr/bin" })).toMatchObject({
      PATH: "/usr/bin",
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: CHANGED_CHECK_VITEST_NO_OUTPUT_TIMEOUT_MS,
      OPENCLAW_VITEST_NO_OUTPUT_RETRY: "0",
      OPENCLAW_TEST_PROJECTS_SERIAL: "1",
      OPENCLAW_VITEST_MAX_WORKERS: "1",
    });

    expect(
      createChangedCheckVitestEnv({
        OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "45000",
        OPENCLAW_VITEST_NO_OUTPUT_RETRY: "1",
      }),
    ).toMatchObject({
      OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "45000",
      OPENCLAW_VITEST_NO_OUTPUT_RETRY: "1",
    });
  });

  it("does not force serial changed-check tests in CI or when workers are explicit", () => {
    expect(createChangedCheckVitestEnv({ CI: "true" })).not.toHaveProperty(
      "OPENCLAW_VITEST_MAX_WORKERS",
    );
    expect(createChangedCheckVitestEnv({ OPENCLAW_VITEST_MAX_WORKERS: "4" })).toMatchObject({
      OPENCLAW_VITEST_MAX_WORKERS: "4",
    });
    expect(
      createChangedCheckVitestEnv({ OPENCLAW_TEST_PROJECTS_PARALLEL: "4" }),
    ).not.toHaveProperty("OPENCLAW_TEST_PROJECTS_SERIAL");
  });
});
