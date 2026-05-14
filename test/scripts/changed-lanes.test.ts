import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmptyChangedLanes,
  detectChangedLanes,
  isLiveDockerPackageScriptOnlyChange,
  isPackageScriptOnlyChange,
} from "../../scripts/changed-lanes.mjs";
import {
  buildChangedCheckCrabboxArgs,
  createChangedCheckChildEnv,
  createChangedCheckPlan,
  shouldDelegateChangedCheckToCrabbox,
} from "../../scripts/check-changed.mjs";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
type ExecFileSyncFailure = Error & { status?: number | null; stderr?: Buffer };
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

function expectLanes(
  lanes: ReturnType<typeof createEmptyChangedLanes>,
  expected: Partial<ReturnType<typeof createEmptyChangedLanes>>,
) {
  expect(lanes).toEqual({ ...createEmptyChangedLanes(), ...expected });
}

function parseChangedLaneOutput(output: string): {
  paths: string[];
  lanes: ReturnType<typeof createEmptyChangedLanes>;
} {
  return JSON.parse(output) as {
    paths: string[];
    lanes: ReturnType<typeof createEmptyChangedLanes>;
  };
}

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

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["scripts/new-check.mjs"]);
    expectLanes(result.lanes, { tooling: true });
  });

  it("includes deleted worktree files in the default local diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-deleted-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "shared", "obsolete.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    git(dir, ["add", "src/shared/obsolete.ts"]);
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

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["src/shared/obsolete.ts"]);
    expectLanes(result.lanes, { core: true, coreTests: true });
  });

  it("includes deleted staged files in the staged diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-changed-lanes-staged-deleted-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    mkdirSync(path.join(dir, "src", "shared"), { recursive: true });
    writeFileSync(
      path.join(dir, "src", "shared", "obsolete.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    git(dir, ["add", "src/shared/obsolete.ts"]);
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

    unlinkSync(path.join(dir, "src", "shared", "obsolete.ts"));
    git(dir, ["add", "src/shared/obsolete.ts"]);

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--staged"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["src/shared/obsolete.ts"]);
    expectLanes(result.lanes, { core: true, coreTests: true });
  });

  it("ignores the explicit path separator", () => {
    const result = detectChangedLanes(["--", "scripts/test-live-acp-bind-docker.sh"]);

    expect(result.paths).toEqual(["scripts/test-live-acp-bind-docker.sh"]);
    expect(result.lanes.liveDockerTooling).toBe(true);
    expect(result.lanes.all).toBe(false);
  });

  it("routes core production changes to core prod and core test lanes", () => {
    const result = detectChangedLanes(["src/shared/string-normalization.ts"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expectLanes(result.lanes, {
      core: true,
      coreTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core:test");
    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
    });
    expect(plan.commands.find((command) => command.args[0] === "lint:core")?.env).toEqual({
      PATH: "/usr/bin",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
    });
  });

  it("reenables local-check policy for changed typecheck commands", () => {
    const result = detectChangedLanes(["src/shared/string-normalization.ts"]);
    const plan = createChangedCheckPlan(result, {
      env: { OPENCLAW_LOCAL_CHECK: "0", PATH: "/usr/bin" },
    });

    expect(plan.commands.find((command) => command.args[0] === "tsgo:core")?.env).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_SPARSE_SKIP: "1",
      PATH: "/usr/bin",
    });
  });

  it("marks changed-check children as covered by the parent heavy-check lock", () => {
    expect(createChangedCheckChildEnv({ PATH: "/usr/bin" })).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it("delegates local Testbox-mode changed gates before running locally", () => {
    expect(
      shouldDelegateChangedCheckToCrabbox(["--base", "origin/main"], {
        OPENCLAW_TESTBOX: "1",
        PATH: "/usr/bin",
      }),
    ).toBe(true);

    expect(buildChangedCheckCrabboxArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual([
      "crabbox:run",
      "--",
      "--provider",
      "blacksmith-testbox",
      "--blacksmith-org",
      "openclaw",
      "--blacksmith-workflow",
      ".github/workflows/ci-check-testbox.yml",
      "--blacksmith-job",
      "check",
      "--blacksmith-ref",
      "main",
      "--idle-timeout",
      "90m",
      "--ttl",
      "240m",
      "--timing-json",
      "--",
      "CI=1",
      "NODE_OPTIONS=--max-old-space-size=4096",
      "OPENCLAW_TEST_PROJECTS_PARALLEL=6",
      "OPENCLAW_VITEST_MAX_WORKERS=1",
      "OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000",
      "OPENCLAW_TESTBOX=1",
      "OPENCLAW_TESTBOX_REMOTE_RUN=1",
      "pnpm",
      "check:changed",
      "--base",
      "origin/main",
      "--head",
      "HEAD",
    ]);
  });

  it("does not delegate dry-run, CI, or already-remote changed gates", () => {
    expect(shouldDelegateChangedCheckToCrabbox(["--dry-run"], { OPENCLAW_TESTBOX: "1" })).toBe(
      false,
    );
    expect(
      shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_TESTBOX: "1", GITHUB_ACTIONS: "true" }),
    ).toBe(false);
    expect(shouldDelegateChangedCheckToCrabbox([], { OPENCLAW_TESTBOX: "1", CI: "1" })).toBe(false);
    expect(
      shouldDelegateChangedCheckToCrabbox([], {
        OPENCLAW_TESTBOX: "1",
        OPENCLAW_TESTBOX_REMOTE_RUN: "1",
      }),
    ).toBe(false);
  });

  it("runs changed-check lint lanes under the parent heavy-check lock", () => {
    const result = detectChangedLanes(["extensions/discord/src/index.ts"]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });
    const lintCommand = plan.commands.find((command) => command.args[0] === "lint:extensions");

    expect(lintCommand?.env).toEqual({
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
      OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD: "1",
      PATH: "/usr/bin",
    });
  });

  it("routes core test-only changes to core test lanes only", () => {
    const result = detectChangedLanes(["src/shared/string-normalization.test.ts"]);

    expectLanes(result.lanes, {
      coreTests: true,
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

    expectLanes(result.lanes, {
      extensions: true,
      extensionTests: true,
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

    expectLanes(result.lanes, {
      extensionTests: true,
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
    expectLanes(result.lanes, {
      core: true,
      coreTests: true,
      extensions: true,
      extensionTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:core");
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions:test");
  });

  it("fails safe for root config changes", () => {
    const result = detectChangedLanes(["pnpm-lock.yaml"]);
    const plan = createChangedCheckPlan(result);

    expect(result.lanes.all).toBe(true);
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes gitignore changes to tooling instead of all lanes", () => {
    const result = detectChangedLanes([".gitignore"]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes root hygiene config changes to tooling instead of all lanes", () => {
    const result = detectChangedLanes([
      ".dockerignore",
      ".jscpd.json",
      ".npmignore",
      ".pre-commit-config.yaml",
      ".swiftformat",
      ".swiftlint.yml",
      "Makefile",
      "config/knip.config.ts",
      "config/markdownlint-cli2.jsonc",
      "config/shellcheckrc",
      "config/swiftformat",
      "config/swiftlint.yml",
      "deploy/fly.private.toml",
      "docker-setup.sh",
      "openclaw.podman.env",
      "setup-podman.sh",
      "skills/pyproject.toml",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes VS Code workspace settings to tooling instead of all lanes", () => {
    const result = detectChangedLanes([".vscode/settings.json", ".vscode/extensions.json"]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes legacy root sandbox Dockerfile moves to tooling instead of all lanes", () => {
    const result = detectChangedLanes([
      "Dockerfile.sandbox",
      "Dockerfile.sandbox-browser",
      "Dockerfile.sandbox-common",
      "scripts/docker/sandbox/Dockerfile",
      "scripts/docker/sandbox/Dockerfile.browser",
      "scripts/docker/sandbox/Dockerfile.common",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes live Docker ACP tooling changes through a focused gate", () => {
    const result = detectChangedLanes([
      "scripts/lib/live-docker-auth.sh",
      "scripts/test-docker-all.mjs",
      "scripts/test-live-acp-bind-docker.sh",
      "src/gateway/gateway-acp-bind.live.test.ts",
      "docs/help/testing-live.md",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      docs: true,
      liveDockerTooling: true,
    });
    expect(plan.commands.map((command) => command.name)).toEqual([
      "conflict markers",
      "changelog attributions",
      "guarded extension wildcard re-exports",
      "plugin-sdk wildcard re-exports",
      "duplicate scan target coverage",
      "dependency pin guard",
      "package patch guard",
      "typecheck core tests",
      "lint core",
      "lint scripts",
      "live Docker shell syntax",
      "live Docker scheduler dry run",
    ]);
    expect(plan.commands.find((command) => command.name === "live Docker shell syntax")).toEqual({
      name: "live Docker shell syntax",
      bin: "bash",
      args: [
        "-n",
        "scripts/lib/live-docker-auth.sh",
        "scripts/test-live-acp-bind-docker.sh",
        "scripts/test-live-cli-backend-docker.sh",
        "scripts/test-live-codex-harness-docker.sh",
        "scripts/test-live-gateway-models-docker.sh",
        "scripts/test-live-models-docker.sh",
        "scripts/test-live-subagent-announce-docker.sh",
      ],
    });
    const schedulerDryRun = plan.commands.find(
      (command) => command.name === "live Docker scheduler dry run",
    );
    expect(schedulerDryRun?.bin).toBe("node");
    expect(schedulerDryRun?.args).toEqual(["scripts/test-docker-all.mjs"]);
    expect(schedulerDryRun?.env?.OPENCLAW_DOCKER_ALL_DRY_RUN).toBe("1");
    expect(schedulerDryRun?.env?.OPENCLAW_DOCKER_ALL_LIVE_MODE).toBe("only");
  });

  it("routes live Docker package script-only changes through the focused gate", () => {
    const before = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "test:docker:all": "node scripts/test-docker-all.mjs",
        },
        dependencies: {
          leftpad: "1.0.0",
        },
      },
      null,
      2,
    )}\n`;
    const after = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "test:docker:all": "node scripts/test-docker-all.mjs",
          "test:docker:live-acp-bind:droid":
            "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
        },
        dependencies: {
          leftpad: "1.0.0",
        },
      },
      null,
      2,
    )}\n`;

    expect(isLiveDockerPackageScriptOnlyChange(before, after)).toBe(true);

    const result = detectChangedLanes(["package.json"], {
      packageJsonChangeKind: "liveDockerTooling",
    });
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      liveDockerTooling: true,
    });
    expect(plan.commands.map((command) => command.name)).toContain("live Docker scheduler dry run");
  });

  it("classifies live Docker package script changes from the git diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-live-docker-package-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            "test:docker:all": "node scripts/test-docker-all.mjs",
          },
        },
        null,
        2,
      )}\n`,
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
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            "test:docker:all": "node scripts/test-docker-all.mjs",
            "test:docker:live-acp-bind:droid":
              "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["package.json"]);
    expectLanes(result.lanes, { liveDockerTooling: true });
  });

  it("classifies normal package script changes from the git diff", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-package-scripts-");
    git(dir, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            test: "node scripts/test-projects.mjs",
          },
          dependencies: {
            leftpad: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
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
      `${JSON.stringify(
        {
          name: "fixture",
          scripts: {
            test: "node scripts/test-projects.mjs",
            "test:profile": "node scripts/profile-tests.mjs",
          },
          dependencies: {
            leftpad: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "changed-lanes.mjs"), "--json", "--base", "HEAD"],
      {
        cwd: dir,
        encoding: "utf8",
        env: createNestedGitEnv(),
      },
    );

    const result = parseChangedLaneOutput(output);

    expect(result.paths).toEqual(["package.json"]);
    expectLanes(result.lanes, { tooling: true });
  });

  it("keeps non-script package changes off the live Docker focused gate", () => {
    const before = `${JSON.stringify(
      { name: "fixture", scripts: {}, dependencies: { leftpad: "1.0.0" } },
      null,
      2,
    )}\n`;
    const after = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          "test:docker:live-acp-bind:droid":
            "OPENCLAW_LIVE_ACP_BIND_AGENT=droid bash scripts/test-live-acp-bind-docker.sh",
        },
        dependencies: { leftpad: "1.0.1" },
      },
      null,
      2,
    )}\n`;

    expect(isLiveDockerPackageScriptOnlyChange(before, after)).toBe(false);
  });

  it("routes package script-only changes through the tooling gate", () => {
    const before = `${JSON.stringify(
      { name: "fixture", scripts: { test: "node test.js" }, dependencies: { leftpad: "1.0.0" } },
      null,
      2,
    )}\n`;
    const after = `${JSON.stringify(
      {
        name: "fixture",
        scripts: {
          test: "node test.js",
          "test:profile": "node scripts/profile-tests.mjs",
        },
        dependencies: { leftpad: "1.0.0" },
      },
      null,
      2,
    )}\n`;

    expect(isPackageScriptOnlyChange(before, after)).toBe(true);

    const result = detectChangedLanes(["package.json"], {
      packageJsonChangeKind: "tooling",
    });
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
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
    ]);
    const plan = createChangedCheckPlan(result, { staged: true });

    expectLanes(result.lanes, {
      docs: true,
      releaseMetadata: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toEqual([
      "check:no-conflict-markers",
      "check:changelog-attributions",
      "lint:extensions:no-guarded-wildcard-reexports",
      "lint:extensions:no-plugin-sdk-wildcard-reexports",
      "dup:check:coverage",
      "deps:pins:check",
      "deps:patches:check",
      "release-metadata:check",
      "ios:version:check",
      "config:schema:check",
      "config:docs:check",
      "deps:root-ownership:check",
    ]);
  });

  it("keeps docs plus changelog entries on the docs-only changed gate", () => {
    const result = detectChangedLanes(["CHANGELOG.md", "docs/tools/index.md"]);
    const plan = createChangedCheckPlan(result);

    expect(result.docsOnly).toBe(true);
    expectLanes(result.lanes, {
      docs: true,
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain("release-metadata:check");
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
    expect(
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "check-release-metadata-only.mjs"), "--staged"],
        {
          cwd: dir,
          env: createNestedGitEnv(),
          stdio: "pipe",
        },
      ),
    ).toBeInstanceOf(Buffer);

    writeFileSync(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "fixture", version: "2026.4.21", dependencies: { leftpad: "1.0.1" } }, null, 2)}\n`,
      "utf8",
    );
    git(dir, ["add", "package.json"]);
    let failure: ExecFileSyncFailure | undefined;
    try {
      execFileSync(
        process.execPath,
        [path.join(repoRoot, "scripts", "check-release-metadata-only.mjs"), "--staged"],
        {
          cwd: dir,
          env: createNestedGitEnv(),
          stdio: "pipe",
        },
      );
    } catch (error) {
      failure = error as ExecFileSyncFailure;
    }

    expect(failure?.status).toBe(1);
    expect(failure?.stderr?.toString("utf8")).toContain(
      "[release-metadata] package.json changed outside the top-level version field",
    );
  });

  it("routes root test/support changes to the tooling test lane instead of all lanes", () => {
    const result = detectChangedLanes([
      "test/git-hooks-pre-commit.test.ts",
      "test-fixtures/legacy-root-fixture.json",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes legacy Swabble deletions as app surface during the app move", () => {
    const result = detectChangedLanes(["Swabble/Sources/SwabbleKit/WakeWordGate.swift"]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      apps: true,
    });
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("routes legacy root asset deletions as tooling during root cleanup", () => {
    const result = detectChangedLanes([
      "assets/avatar-placeholder.svg",
      "assets/chrome-extension/icons/icon128.png",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      tooling: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("routes A2UI bundle source changes as extension changes", () => {
    const result = detectChangedLanes([
      "extensions/canvas/src/host/a2ui-app/bootstrap.js",
      "extensions/canvas/src/host/a2ui-app/rolldown.config.mjs",
    ]);
    const plan = createChangedCheckPlan(result);

    expectLanes(result.lanes, {
      extensions: true,
      extensionTests: true,
    });
    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("tsgo:all");
  });

  it("keeps shared Vitest wiring changes out of check test execution", () => {
    const result = detectChangedLanes(["test/vitest/vitest.shared.config.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("keeps setup changes out of check test execution", () => {
    const result = detectChangedLanes(["test/setup.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("does not route generated plugin bundle artifacts as direct Vitest targets", () => {
    const result = detectChangedLanes([
      "extensions/demo/src/host/assets/.bundle.hash",
      "extensions/canvas/scripts/bundle-a2ui.test.ts",
    ]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:extensions");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
  });

  it("routes changed extension Vitest configs to only their owning shard", () => {
    const result = detectChangedLanes(["test/vitest/vitest.extension-discord.config.ts"]);
    const plan = createChangedCheckPlan(result);

    expect(plan.commands.map((command) => command.args[0])).toContain("lint:scripts");
    expect(plan.commands.map((command) => command.args[0])).not.toContain("test");
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
      liveDockerTooling: false,
      releaseMetadata: false,
      all: false,
    });
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { name: "changelog attributions", args: ["check:changelog-attributions"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "dependency pin guard", args: ["deps:pins:check"] },
      { name: "package patch guard", args: ["deps:patches:check"] },
    ]);
  });

  it("keeps docs-only changes cheap", () => {
    const result = detectChangedLanes(["docs/ci.md", "README.md"]);
    const plan = createChangedCheckPlan(result);

    expect(result.docsOnly).toBe(true);
    expect(plan.commands).toEqual([
      { name: "conflict markers", args: ["check:no-conflict-markers"] },
      { name: "changelog attributions", args: ["check:changelog-attributions"] },
      {
        name: "guarded extension wildcard re-exports",
        args: ["lint:extensions:no-guarded-wildcard-reexports"],
      },
      {
        name: "plugin-sdk wildcard re-exports",
        args: ["lint:extensions:no-plugin-sdk-wildcard-reexports"],
      },
      { name: "duplicate scan target coverage", args: ["dup:check:coverage"] },
      { name: "dependency pin guard", args: ["deps:pins:check"] },
      { name: "package patch guard", args: ["deps:patches:check"] },
    ]);
  });
});
