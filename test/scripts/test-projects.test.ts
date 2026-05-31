import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS,
  DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
  applyDefaultMultiSpecVitestCachePaths,
  applyDefaultVitestNoOutputTimeout,
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestArgs,
  buildVitestRunPlans,
  findUnmatchedExplicitTestTargets,
  formatFailedShardDigest,
  listFullExtensionVitestProjectConfigs,
  orderFullSuiteSpecsForParallelRun,
  shouldAcquireLocalHeavyCheckLock,
  resolveChangedTestTargetPlan,
  resolveChangedTargetArgs,
  resolveParallelFullSuiteConcurrency,
  shouldRetryVitestNoOutputTimeout,
} from "../../scripts/test-projects.test-support.mjs";
import { captureReaddirSyncCallsDuring } from "../../src/test-utils/fs-scan-assertions.js";
import { toRepoPath } from "../../src/test-utils/repo-files.js";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

const normalizeRepoPath = toRepoPath;

type VitestTestConfig = {
  dir?: string;
  exclude?: string[];
  include?: string[];
};

type VitestConfig = {
  test?: VitestTestConfig;
};

type VitestConfigFactory = (env?: Record<string, string | undefined>) => VitestConfig;

function isVitestConfigFactory(value: unknown): value is VitestConfigFactory {
  return typeof value === "function";
}

function findVitestConfigFactory(mod: Record<string, unknown>): VitestConfigFactory | null {
  for (const [name, value] of Object.entries(mod)) {
    if (
      name !== "default" &&
      /^create.*VitestConfig$/u.test(name) &&
      isVitestConfigFactory(value)
    ) {
      return value;
    }
  }
  return null;
}

async function loadRawVitestConfig(configPath: string): Promise<VitestConfig> {
  const previousArgv = process.argv;
  const previousIncludeFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
  process.argv = [previousArgv[0] ?? "node", previousArgv[1] ?? "vitest"];
  delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
  try {
    const mod = (await import(path.resolve(process.cwd(), configPath))) as Record<string, unknown>;
    return findVitestConfigFactory(mod)?.(process.env) ?? ((mod.default ?? {}) as VitestConfig);
  } finally {
    process.argv = previousArgv;
    if (previousIncludeFile === undefined) {
      delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
    } else {
      process.env.OPENCLAW_VITEST_INCLUDE_FILE = previousIncludeFile;
    }
  }
}

async function listMatchedTestFilesForConfig(configPath: string): Promise<string[]> {
  const testConfig = (await loadRawVitestConfig(configPath)).test ?? {};
  const dir = testConfig.dir ? path.resolve(process.cwd(), testConfig.dir) : process.cwd();
  const include = testConfig.include ?? [];
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    path.isAbsolute(pattern)
      ? normalizeRepoPath(path.relative(dir, pattern))
      : normalizeRepoPath(pattern),
  );
  return fg
    .sync(include, {
      absolute: false,
      cwd: dir,
      dot: false,
      ignore: exclude,
    })
    .map((file) => normalizeRepoPath(path.relative(process.cwd(), path.resolve(dir, file))))
    .toSorted((left, right) => left.localeCompare(right));
}

async function listFullSuiteTestFileMatches(): Promise<Map<string, string[]>> {
  const configs = [...new Set(fullSuiteVitestShards.flatMap((shard) => shard.projects))];
  const matches = new Map<string, string[]>();
  for (const config of configs) {
    for (const file of await listMatchedTestFilesForConfig(config)) {
      matches.set(file, [...(matches.get(file) ?? []), config]);
    }
  }
  return matches;
}

function listNormalFullSuiteTestFiles(): string[] {
  const e2eNamedIntegrationTests = new Set([
    "src/gateway/gateway.test.ts",
    "src/gateway/server.startup-matrix-migration.integration.test.ts",
    "src/gateway/sessions-history-http.test.ts",
  ]);
  return fg
    .sync(["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], {
      cwd: process.cwd(),
      dot: false,
      ignore: ["**/.*/**", "**/dist/**", "**/node_modules/**", "**/vendor/**"],
    })
    .map(normalizeRepoPath)
    .filter(
      (file) =>
        !file.includes(".live.test.") &&
        !file.includes(".e2e.test.") &&
        !file.startsWith("test/fixtures/") &&
        !e2eNamedIntegrationTests.has(file),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

function hasGitGatewayFileListing(cwd: string): boolean {
  const result = spawnSync("git", ["ls-files", "--", "src/gateway"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function withTinyGitRepo(files: Record<string, string>, test: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-projects-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const absolute = path.join(cwd, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, source);
    }
    const init = spawnSync("git", ["init"], { cwd, stdio: "ignore" });
    expect(init.status).toBe(0);
    const add = spawnSync("git", ["add", "."], { cwd, stdio: "ignore" });
    expect(add.status).toBe(0);
    test(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function withTinyFileTree(files: Record<string, string>, test: (cwd: string) => void): void {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-projects-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const absolute = path.join(cwd, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, source);
    }
    test(cwd);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe("scripts/test-projects changed-target routing", () => {
  beforeAll(() => {
    buildVitestRunPlans(["src/commands/onboard-non-interactive.test-helpers.ts"]);
    findUnmatchedExplicitTestTargets(["test/vitest/vitest.shared.config.ts"], process.cwd());
  });

  it("maps changed source files into scoped lane targets", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "packages/normalization-core/src/string-normalization.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual([
      "packages/normalization-core/src/string-normalization.test.ts",
      "src/utils/provider-utils.test.ts",
    ]);
  });

  it("keeps changed mode focused by default for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/vitest/vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual(["src/utils/provider-utils.test.ts"]);
  });

  it("keeps the broad changed run available for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["test/vitest/vitest.shared.config.ts", "src/utils/provider-utils.ts"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("keeps test runner implementation edits on runner tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "scripts/check-changed.mjs",
        "scripts/test-projects.test-support.d.mts",
        "scripts/test-projects.test-support.mjs",
        "test/scripts/changed-lanes.test.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: ["test/scripts/changed-lanes.test.ts", "test/scripts/test-projects.test.ts"],
    });
  });

  it("routes Docker pull retry helper changes through its regression test", () => {
    expect(resolveChangedTestTargetPlan(["scripts/ci-docker-pull-retry.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/ci-docker-pull-retry.test.ts"],
    });
  });

  it("routes control UI i18n script changes through its regression test", () => {
    expect(resolveChangedTestTargetPlan(["scripts/control-ui-i18n.ts"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/control-ui-i18n.test.ts", "src/scripts/control-ui-i18n.test.ts"],
    });
  });

  it("routes top-level scripts through conventional owner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/bench-test-changed.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/bench-test-changed.test.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/control-ui-i18n-report.ts"])).toEqual({
      mode: "targets",
      targets: ["src/scripts/control-ui-i18n-report.test.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/check-file-utils.ts"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/check-file-utils.test.ts"],
    });
  });

  it("routes nested scripts through conventional owner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/e2e/openwebui-probe.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/openwebui-probe.test.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/lib/docker-e2e-plan.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/docker-e2e-plan.test.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/github/real-behavior-proof-check.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/real-behavior-proof-check.test.ts"],
    });
  });

  it("routes Z.AI fallback repro script changes through its regression test", () => {
    expect(resolveChangedTestTargetPlan(["scripts/zai-fallback-repro.ts"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/zai-fallback-repro.test.ts"],
    });
  });

  it("routes group visible reply config changes through channel delivery regressions", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/config/types.messages.ts",
        "src/config/zod-schema.core.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes source reply prompt changes through prompt and channel delivery regressions", () => {
    expect(resolveChangedTestTargetPlan(["src/agents/system-prompt.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/agents/system-prompt.test.ts",
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes source reply delivery mode changes through channel delivery regressions", () => {
    expect(
      resolveChangedTestTargetPlan(["src/auto-reply/reply/source-reply-delivery-mode.ts"]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes channel reply pipeline SDK changes through SDK and channel delivery regressions", () => {
    expect(resolveChangedTestTargetPlan(["src/plugin-sdk/channel-reply-pipeline.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes reply runtime SDK exports through plugin SDK contract tests", () => {
    expect(resolveChangedTestTargetPlan(["src/plugin-sdk/reply-runtime.ts"])).toEqual({
      mode: "targets",
      targets: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"],
    });
  });

  it("keeps extension batch runner edits on extension script tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/test-extension-batch.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/test-extension.test.ts"],
    });
  });

  it("keeps check runner edits on check runner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/check.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/check.test.ts"],
    });
  });

  it("keeps build runner edits on build runner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/build-all.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/build-all.test.ts"],
    });
  });

  it("keeps force-test runner edits on its safe CLI tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/test-force.ts"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/test-force.test.ts"],
    });
  });

  it("keeps live-test runner edits on live-test runner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/test-live.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/test-live.test.ts"],
    });
  });

  it("keeps tsdown build runner edits on tsdown build tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/tsdown-build.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/tsdown-build.test.ts"],
    });
  });

  it("keeps verify runner edits on verify runner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/verify.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/verify.test.ts"],
    });
  });

  it("keeps sharded oxlint runner edits on oxlint runner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/run-oxlint-shards.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/run-oxlint.test.ts"],
    });
  });

  it("keeps env wrapper edits on env wrapper tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/run-with-env.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/run-with-env.test.ts"],
    });
  });

  it("keeps Crabbox config edits on package acceptance tests", () => {
    expect(resolveChangedTestTargetPlan([".crabbox.yaml"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/package-acceptance-workflow.test.ts"],
    });
  });

  it("keeps Crabbox runner script edits on their regression tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/crabbox-wrapper.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/crabbox-wrapper.test.ts"],
    });
  });

  it("keeps Crabbox and Testbox workflow edits on workflow regression tests", () => {
    for (const workflowPath of [
      ".github/workflows/ci-check-testbox.yml",
      ".github/workflows/crabbox-hydrate.yml",
    ]) {
      expect(resolveChangedTestTargetPlan([workflowPath])).toEqual({
        mode: "targets",
        targets: [
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      });
    }
  });

  it("keeps workflow sanity script edits on workflow guard tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/check-workflows.mjs"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/check-composite-action-input-interpolation.test.ts",
        "test/scripts/check-no-conflict-markers.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/check-workflows.test.ts",
      ],
    });
  });

  it("keeps workflow helper guard edits on their regression tests", () => {
    expect(
      resolveChangedTestTargetPlan(["scripts/check-composite-action-input-interpolation.py"]),
    ).toEqual({
      mode: "targets",
      targets: ["test/scripts/check-composite-action-input-interpolation.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/check-no-conflict-markers.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/check-no-conflict-markers.test.ts"],
    });
  });

  it("keeps CI, dependency, and docs tooling edits on owner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/ci-changed-scope.mjs"])).toEqual({
      mode: "targets",
      targets: ["src/scripts/ci-changed-scope.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/check-dependency-pins.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/check-dependency-pins.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/dependency-vulnerability-gate.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/dependency-vulnerability-gate.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/dependency-changes-report.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/dependency-changes-report.test.ts"],
    });

    expect(
      resolveChangedTestTargetPlan(["scripts/dependency-ownership-surface-report.mjs"]),
    ).toEqual({
      mode: "targets",
      targets: ["test/scripts/dependency-ownership-surface-report.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/docs-link-audit.mjs"])).toEqual({
      mode: "targets",
      targets: ["src/scripts/docs-link-audit.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/check-changelog-attributions.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/check-changelog-attributions.test.ts"],
    });
  });

  it("keeps package, release, and install tooling edits on owner tests", () => {
    const expectedTargets = new Map([
      ["scripts/generate-npm-shrinkwrap.mjs", ["test/scripts/generate-npm-shrinkwrap.test.ts"]],
      [
        "scripts/package-openclaw-for-docker.mjs",
        ["test/scripts/package-openclaw-for-docker.test.ts"],
      ],
      ["scripts/package-mac-app.sh", ["test/scripts/package-mac-app.test.ts"]],
      ["scripts/package-mac-dist.sh", ["test/scripts/package-mac-dist.test.ts"]],
      ["scripts/package-changelog.mjs", ["test/scripts/package-changelog.test.ts"]],
      ["scripts/openclaw-prepack.ts", ["test/openclaw-prepack.test.ts"]],
      ["scripts/openclaw-npm-release-check.ts", ["test/openclaw-npm-release-check.test.ts"]],
      [
        "scripts/openclaw-npm-postpublish-verify.ts",
        ["test/openclaw-npm-postpublish-verify.test.ts"],
      ],
      [
        "scripts/postinstall-bundled-plugins.mjs",
        ["test/scripts/postinstall-bundled-plugins.test.ts"],
      ],
      ["scripts/prepare-git-hooks.mjs", ["test/scripts/prepare-git-hooks.test.ts"]],
      [
        "scripts/preinstall-package-manager-warning.mjs",
        ["test/scripts/preinstall-package-manager-warning.test.ts"],
      ],
    ]);

    for (const [source, targets] of expectedTargets) {
      expect(resolveChangedTestTargetPlan([source]), source).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps shared script library edits on owner tests", () => {
    const expectedTargets = new Map([
      [
        "scripts/lib/local-heavy-check-runtime.mjs",
        ["test/scripts/local-heavy-check-runtime.test.ts"],
      ],
      ["scripts/lib/managed-child-process.mjs", ["test/scripts/managed-child-process.test.ts"]],
      ["scripts/lib/source-file-scan-cache.mjs", ["test/scripts/source-file-scan-cache.test.ts"]],
      ["scripts/lib/dev-tooling-safety.ts", ["test/scripts/dev-tooling-safety.test.ts"]],
      ["scripts/lib/npm-verify-exec.ts", ["test/scripts/npm-verify-exec.test.ts"]],
      ["scripts/lib/arg-utils.mjs", ["test/scripts/arg-utils.test.ts"]],
      ["scripts/lib/test-group-report.mjs", ["test/scripts/test-group-report.test.ts"]],
      ["scripts/lib/ts-guard-utils.mjs", ["test/scripts/ts-guard-utils.test.ts"]],
      ["scripts/lib/format-generated-module.mjs", ["test/scripts/format-generated-module.test.ts"]],
      [
        "scripts/lib/bundled-plugin-source-utils.mjs",
        ["test/scripts/bundled-plugin-source-utils.test.ts"],
      ],
      [
        "scripts/lib/bundled-plugin-build-entries.mjs",
        ["test/scripts/bundled-plugin-build-entries.test.ts"],
      ],
    ]);

    for (const [source, targets] of expectedTargets) {
      expect(resolveChangedTestTargetPlan([source]), source).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("routes explicit tooling implementation files to owner tests", () => {
    expect(
      findUnmatchedExplicitTestTargets([
        "scripts/build-all.mjs",
        "scripts/check.mjs",
        "scripts/check-dynamic-import-warts.mjs",
        "scripts/run-oxlint-shards.mjs",
        "scripts/test-force.ts",
        "scripts/tsdown-build.mjs",
        "scripts/verify.mjs",
      ]),
    ).toEqual([]);

    expect(
      buildVitestRunPlans([
        "scripts/build-all.mjs",
        "scripts/check.mjs",
        "scripts/check-dynamic-import-warts.mjs",
        "scripts/run-oxlint-shards.mjs",
        "scripts/test-force.ts",
        "scripts/tsdown-build.mjs",
        "scripts/verify.mjs",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/check.test.ts",
          "test/scripts/test-force.test.ts",
          "test/scripts/verify.test.ts",
        ],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/build-all.test.ts",
          "test/scripts/check-dynamic-import-warts.test.ts",
          "test/scripts/run-oxlint.test.ts",
          "test/scripts/tsdown-build.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit source files through precise owner tests before broad globs", () => {
    expect(buildVitestRunPlans(["src/gateway/server-startup-early.ts"])).toEqual([
      {
        config: "test/vitest/vitest.gateway.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/gateway/server-startup-early.test.ts"],
        watchMode: false,
      },
    ]);
    expect(buildVitestRunPlans(["src/commands/onboarding-plugin-install.ts"])).toEqual([
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/onboarding-plugin-install.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit imported source files through import-graph tests", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    withTinyGitRepo(
      {
        "src/runtime.ts": "export const value = 'x';\n",
        "src/runtime.consumer.test.ts": "import { value } from './runtime.js';\nvoid value;\n",
      },
      (cwd) => {
        plans = buildVitestRunPlans(["src/runtime.ts"], cwd);
      },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["src/runtime.consumer.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("deduplicates explicit source tests that share import-graph owners", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    withTinyGitRepo(
      {
        "src/runtime-a.ts": "export const a = 'a';\n",
        "src/runtime-b.ts": "export const b = 'b';\n",
        "src/runtime.consumer.test.ts":
          "import { a } from './runtime-a.js';\nimport { b } from './runtime-b.js';\nvoid [a, b];\n",
      },
      (cwd) => {
        plans = buildVitestRunPlans(["src/runtime-a.ts", "src/runtime-b.ts"], cwd);
      },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["src/runtime.consumer.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes many explicit source files through one import-graph-backed owner set", () => {
    let plans: ReturnType<typeof buildVitestRunPlans> = [];
    const files: Record<string, string> = {};
    const imports: string[] = [];
    const refs: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      files[`src/runtime-${index}.ts`] = `export const value${index} = ${index};\n`;
      imports.push(`import { value${index} } from './runtime-${index}.js';`);
      refs.push(`value${index}`);
    }
    files["src/runtime.consumer.test.ts"] = `${imports.join("\n")}\nvoid [${refs.join(", ")}];\n`;

    withTinyFileTree(files, (cwd) => {
      plans = buildVitestRunPlans(
        Array.from({ length: 13 }, (_, index) => `src/runtime-${index}.ts`),
        cwd,
      );
    });

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["src/runtime.consumer.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("does not route live tests through the normal changed-test lane", () => {
    expect(
      resolveChangedTestTargetPlan(["src/gateway/gateway-codex-harness.live.test.ts"]),
    ).toEqual({
      mode: "targets",
      targets: [],
    });
  });

  it("routes changed extension vitest configs to their own shard", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "test/vitest/vitest.extension-discord.config.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-discord.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes the shell helper test to the isolated tooling shard", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "test/scripts/openclaw-e2e-instance.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/openclaw-e2e-instance.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes Docker E2E script targets to their owner tooling tests", () => {
    const targets = [
      "scripts/e2e/kitchen-sink-plugin-docker.sh",
      "scripts/e2e/kitchen-sink-rpc-docker.sh",
      "scripts/e2e/kitchen-sink-rpc-walk.mjs",
      "scripts/e2e/onboard-docker.sh",
      "scripts/e2e/plugin-lifecycle-matrix-docker.sh",
      "scripts/e2e/release-media-memory-docker.sh",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(buildVitestRunPlans(targets, process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/kitchen-sink-rpc-walk.test.ts",
          "test/scripts/openclaw-test-state.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/release-media-memory-scenario.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("includes the isolated tooling shard for broad shell helper targets", () => {
    expect(buildVitestRunPlans(["test/scripts"], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/openclaw-e2e-instance.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("includes the isolated tooling shard for broad shell helper globs", () => {
    expect(buildVitestRunPlans(["test/scripts/*.test.ts"], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/openclaw-e2e-instance.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps broad shell helper watch targets in one tooling shard", () => {
    expect(buildVitestRunPlans(["--watch", "test/scripts"], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/**/*.test.ts"],
        watchMode: true,
      },
    ]);
  });

  it("preserves post-separator Vitest args without parsing them as targets", () => {
    for (const [arg, watchMode] of [
      ["--reporter=verbose", false],
      ["--watch", true],
    ] as const) {
      expect(buildVitestRunPlans(["test/scripts/run-vitest.test.ts", "--", arg])).toEqual([
        {
          config: "test/vitest/vitest.tooling.config.ts",
          forwardedArgs: [arg],
          includePatterns: ["test/scripts/run-vitest.test.ts"],
          watchMode,
        },
      ]);
    }
  });

  it("keeps pnpm-style leading separators out of target routing", () => {
    expect(buildVitestRunPlans(["--", "test/scripts/run-vitest.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/run-vitest.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("prints wrapper help without starting a broad local suite", () => {
    const result = spawnSync(process.execPath, ["scripts/test-projects.mjs", "--help"], {
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/test-projects.mjs");
    expect(result.stderr).not.toContain("[test] starting");
  });

  it("allows explicit split Vitest config targets without treating them as unmatched tests", () => {
    expect(
      findUnmatchedExplicitTestTargets(
        [
          "test/vitest/vitest.agents-core.config.ts",
          "test/vitest/vitest.agents-embedded-agent.config.ts",
          "test/vitest/vitest.agents-support.config.ts",
          "test/vitest/vitest.agents-tools.config.ts",
        ],
        process.cwd(),
      ),
    ).toEqual([]);
  });

  it("routes explicit test-support helper files to affected tests", () => {
    expect(
      findUnmatchedExplicitTestTargets(["src/commands/onboard-non-interactive.test-helpers.ts"]),
    ).toEqual([]);

    expect(buildVitestRunPlans(["src/commands/onboard-non-interactive.test-helpers.ts"])).toEqual([
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/onboard-non-interactive.gateway.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("rejects explicit test-support helper files with no importing tests", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-targets-"));
    try {
      fs.mkdirSync(path.join(tempDir, "src", "lonely"), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "src", "lonely", "runtime.test-helpers.ts"),
        "export {};\n",
      );

      expect(
        findUnmatchedExplicitTestTargets(["src/lonely/runtime.test-helpers.ts"], tempDir),
      ).toEqual([
        {
          target: "src/lonely/runtime.test-helpers.ts",
          reason: "target-matched-no-test-files",
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("routes contract roots to separate contract shards", () => {
    const plans = buildVitestRunPlans([
      "src/channels/plugins/contracts/channel-catalog.contract.test.ts",
      "src/plugins/contracts/loader.contract.test.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.contracts-channel-surface.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/channels/plugins/contracts/channel-catalog.contract.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.contracts-plugin.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/contracts/loader.contract.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes misc extensions to the misc extension shard", () => {
    const plans = buildVitestRunPlans(["extensions/thread-ownership"], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-misc.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/thread-ownership/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes browser extension changes to the browser extension lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "extensions/browser/src/browser/cdp.helpers.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-browser.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/browser/src/browser/cdp.helpers.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps shared test helpers cheap by default when no precise target exists", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/helpers/poll.ts",
      ]),
    ).toStrictEqual([]);
  });

  it("routes imported shared test helpers through affected tests", () => {
    let targets: string[] = [];
    withTinyGitRepo(
      {
        "test/helpers/temp-dir.ts": "export const tempDir = 'x';\n",
        "src/foo.test.ts":
          "import { tempDir } from '../test/helpers/temp-dir.js';\nvoid tempDir;\n",
      },
      (cwd) => {
        targets = resolveChangedTestTargetPlan(["test/helpers/temp-dir.ts"], { cwd }).targets;
      },
    );

    expect(targets).toEqual(["src/foo.test.ts"]);
  });

  it("keeps the broad changed run available for shared test helpers", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["test/helpers/poll.ts"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("routes channel contract helper edits through the tests that import them", () => {
    const plan = resolveChangedTestTargetPlan([
      "src/channels/plugins/contracts/test-helpers/manifest.ts",
    ]);

    expect(plan.mode).toBe("targets");
    expect(plan.targets).toContain("src/channels/plugins/contracts/registry.contract.test.ts");
    expect(plan.targets).not.toContain("extensions/discord/src/directory-contract.test.ts");
  });

  it("routes channel SDK helper edits through the tests that import them", () => {
    expect(resolveChangedTestTargetPlan(["src/plugin-sdk/test-helpers/directory-ids.ts"])).toEqual({
      mode: "targets",
      targets: [
        "extensions/discord/src/directory-contract.test.ts",
        "extensions/slack/src/directory-contract.test.ts",
        "extensions/telegram/src/directory-contract.test.ts",
      ],
    });
  });

  it("routes channel contract helper edits through contract shards", () => {
    const plan = resolveChangedTestTargetPlan([
      "src/channels/plugins/contracts/test-helpers/registry-backed-contract-shards.ts",
    ]);

    expect(plan.mode).toBe("targets");
    expect(plan.targets).toContain(
      "src/channels/plugins/contracts/plugin.registry-backed-shard-a.contract.test.ts",
    );
    expect(plan.targets).toContain(
      "src/channels/plugins/contracts/threading.registry-backed-shard-h.contract.test.ts",
    );
    expect(plan.targets).not.toContain("extensions/discord/src/channel-actions.contract.test.ts");
  });

  it("routes precise plugin contract helpers without broad-running every shard", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "src/plugins/contracts/tts-contract-suites.ts",
      ]),
    ).toEqual([
      "src/plugins/contracts/core-extension-facade-boundary.test.ts",
      "src/plugins/contracts/tts.contract.test.ts",
    ]);
  });

  it("keeps unknown root surfaces cheap by default", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "unknown/file.txt",
      ]),
    ).toStrictEqual([]);
  });

  it("keeps the broad changed run available for unknown root surfaces", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["unknown/file.txt"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("skips changed docs files that cannot map to test lanes", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "docs/help/testing.md",
      ]),
    ).toStrictEqual([]);
  });

  it("skips root agent guidance changes instead of broad-running tests", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => ["AGENTS.md"]),
    ).toStrictEqual([]);
  });

  it("skips app-only changes because app tests are separate from Vitest lanes", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "apps/macos/OpenClaw/AppDelegate.swift",
      ]),
    ).toStrictEqual([]);
  });

  it("keeps public plugin SDK changes focused by default", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/provider-entry.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/provider-entry.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("adds extension tests for public plugin SDK changes in broad changed mode", () => {
    const plans = buildVitestRunPlans(
      ["--changed", "origin/main"],
      process.cwd(),
      () => ["src/plugin-sdk/provider-entry.ts"],
      { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/provider-entry.test.ts"],
        watchMode: false,
      },
      ...listFullExtensionVitestProjectConfigs().map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    ]);
  });

  it("routes LM Studio changes to the provider extension lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "extensions/lmstudio/src/runtime.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-providers.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/lmstudio/src/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes QA extension changes to the QA extension lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "extensions/qa-lab/src/scenario-catalog.test.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-qa.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/qa-lab/src/scenario-catalog.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit active-memory and Codex extension tests to their shards", () => {
    expect(
      buildVitestRunPlans([
        "extensions/active-memory/index.test.ts",
        "extensions/codex/index.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-active-memory.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/active-memory/index.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.extension-codex.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/codex/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes the top-level extensions target to every extension shard", () => {
    expect(buildVitestRunPlans(["extensions"], process.cwd())).toEqual(
      listFullExtensionVitestProjectConfigs().map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    );
  });

  it("narrows default-lane changed source files to affected tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/sdk/src/index.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["packages/sdk/src/index.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes changed source files to sibling tests when present", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/agents/live-model-turn-probes.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/agents/live-model-turn-probes.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed ui support files to the ui lane without dead include globs", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "ui/src/styles/base.css",
      "ui/src/test-helpers/lit-warnings.setup.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes changed ui build helpers to their importing tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "ui/config/control-ui-chunking.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/control-ui-chunking.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit ui test targets to the unit ui lane", () => {
    expect(buildVitestRunPlans(["ui/src/ui/chat/grouped-render.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/chat/grouped-render.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["ui/src/ui/views/chat.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/views/chat.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["ui/src/ui/views/dreaming.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/views/dreaming.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes control ui e2e tests to the ui e2e lane", () => {
    expect(buildVitestRunPlans(["ui/src/ui/e2e/chat-flow.e2e.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.ui-e2e.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/e2e/chat-flow.e2e.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["ui/src/test-helpers/control-ui-e2e.ts"])).toEqual([
      {
        config: "test/vitest/vitest.ui-e2e.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["ui/src/ui/e2e"])).toEqual([
      {
        config: "test/vitest/vitest.ui-e2e.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/e2e/**/*.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestArgs(["ui/src/ui/e2e"])).toContain("--configLoader");
  });

  it("routes changed unit ui tests to the unit ui lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "ui/src/ui/chat/grouped-render.test.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/chat/grouped-render.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes auto-reply route source files to route regression tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/auto-reply/reply/dispatch-from-config.ts",
        "src/auto-reply/reply/effective-reply-route.ts",
        "src/auto-reply/reply/effective-reply-route.test.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
        "src/auto-reply/reply/effective-reply-route.test.ts",
      ],
    });
  });

  it("routes ACP command source files to ACP command regression tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/auto-reply/reply/commands-acp.ts",
        "src/auto-reply/reply/commands-acp.test.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.test.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/commands-acp.test.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.test.ts",
      ],
    });
  });

  it("routes Google Meet CLI edits to the lightweight CLI tests", () => {
    expect(resolveChangedTestTargetPlan(["extensions/google-meet/src/cli.ts"])).toEqual({
      mode: "targets",
      targets: ["extensions/google-meet/src/cli.test.ts"],
    });
  });

  it("routes Google Meet OAuth edits to the lightweight OAuth tests", () => {
    expect(resolveChangedTestTargetPlan(["extensions/google-meet/src/oauth.ts"])).toEqual({
      mode: "targets",
      targets: ["extensions/google-meet/src/oauth.test.ts"],
    });
  });

  it("routes Google Meet entry edits to the plugin entry tests", () => {
    expect(resolveChangedTestTargetPlan(["extensions/google-meet/index.ts"])).toEqual({
      mode: "targets",
      targets: ["extensions/google-meet/index.test.ts"],
    });
  });

  it("routes memory doctor and embedding default edits to focused tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/commands/doctor-memory-search.ts",
        "src/memory-host-sdk/host/embedding-defaults.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/commands/doctor-memory-search.test.ts",
        "packages/memory-host-sdk/src/host/embeddings.test.ts",
      ],
    });
  });

  it("routes commitment model-selection runtime edits away from broad gateway dependents", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/agents/model-selection.test.ts",
        "src/commitments/model-selection.runtime.ts",
        "src/commitments/runtime.test.ts",
        "src/commitments/runtime.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: ["src/agents/model-selection.test.ts", "src/commitments/runtime.test.ts"],
    });
  });

  it("routes provider auth choice edits to focused auth-choice tests", () => {
    expect(resolveChangedTestTargetPlan(["src/plugins/provider-auth-choice.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/commands/auth-choice.apply.plugin-provider.test.ts",
        "src/commands/auth-choice.test.ts",
      ],
    });
  });

  it("routes provider env var edits to focused secret tests", () => {
    expect(resolveChangedTestTargetPlan(["src/secrets/provider-env-vars.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/secrets/provider-env-vars.dynamic.test.ts",
        "src/secrets/provider-env-vars.test.ts",
      ],
    });
  });

  it("routes changed utils and shared files to their light scoped lanes", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/normalization-core/src/string-normalization.ts",
      "src/utils/provider-utils.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["packages/normalization-core/src/string-normalization.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.utils.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/utils/provider-utils.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit plugin-sdk light tests to the lighter plugin-sdk lane", () => {
    const plans = buildVitestRunPlans(["src/plugin-sdk/temp-path.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.plugin-sdk-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/temp-path.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit commands light tests to the lighter commands lane", () => {
    const plans = buildVitestRunPlans(["src/commands/status-json-runtime.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-json-runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit-fast light tests to the cache-friendly unit-fast lane", () => {
    const plans = buildVitestRunPlans(
      ["src/commands/status-overview-values.test.ts"],
      process.cwd(),
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-overview-values.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes fake-timer unit-fast tests to the serial fake-timer lane", () => {
    const plans = buildVitestRunPlans(["src/acp/control-plane/manager.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast-fake-timers.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/acp/control-plane/manager.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed commands source allowlist files to sibling light tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/status-overview-values.ts",
      "src/commands/gateway-status/helpers.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "src/commands/status-overview-values.test.ts",
          "src/commands/gateway-status/helpers.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin-sdk source files with sibling tests narrowly by default", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/facade-runtime.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/facade-runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin-sdk source files with sibling tests plus extensions in broad changed mode", () => {
    const plans = buildVitestRunPlans(
      ["--changed", "origin/main"],
      process.cwd(),
      () => ["src/plugin-sdk/facade-runtime.ts"],
      { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/facade-runtime.test.ts"],
        watchMode: false,
      },
      ...listFullExtensionVitestProjectConfigs().map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    ]);
  });

  it("routes command source files with sibling tests narrowly on the command lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/channels.add.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/channels.add.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps changed mode to precise targets by default", () => {
    expect(resolveChangedTestTargetPlan(["package.json", "src/commands/channels.add.ts"])).toEqual({
      mode: "targets",
      targets: ["src/commands/channels.add.test.ts"],
    });
  });

  it("skips import-graph scans once a diff already needs broad fallback", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const before = readFileSync.mock.calls.length;
    const plan = resolveChangedTestTargetPlan([
      ".crabbox.yaml",
      "scripts/check.mjs",
      "src/gateway/server.impl.ts",
    ]);
    const repoSourceReads = readFileSync.mock.calls
      .slice(before)
      .filter(([file]) => typeof file === "string" && normalizeRepoPath(file).includes("/src/"));
    readFileSync.mockRestore();

    expect(plan).toEqual({
      mode: "targets",
      targets: ["test/scripts/package-acceptance-workflow.test.ts", "test/scripts/check.test.ts"],
    });
    expect(repoSourceReads).toEqual([]);
  });

  it("keeps broad changed fallback available through explicit env", () => {
    expect(
      resolveChangedTestTargetPlan(["package.json", "src/commands/channels.add.ts"], {
        env: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      }),
    ).toEqual({
      mode: "broad",
      targets: [],
    });
  });

  it("uses import-graph targets in default changed mode", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const before = readFileSync.mock.calls.length;
    const targets = resolveChangedTestTargetPlan(["test/helpers/normalize-text.ts"]).targets;
    const repoSourceReads = readFileSync.mock.calls
      .slice(before)
      .filter(([file]) => typeof file === "string" && normalizeRepoPath(file).includes("/src/"));
    readFileSync.mockRestore();

    expect(targets).toContain("src/auto-reply/status.test.ts");
    expect(repoSourceReads.length).toBeLessThan(100);
  });

  it.each([
    "test/vitest/vitest.agents-core.config.ts",
    "test/vitest/vitest.agents-embedded-agent.config.ts",
    "test/vitest/vitest.agents-support.config.ts",
    "test/vitest/vitest.agents-tools.config.ts",
  ])("routes split agents vitest config %s to itself", (target) => {
    const plans = buildVitestRunPlans([target], process.cwd());

    expect(plans).toEqual([
      {
        config: target,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it.each([
    "src/gateway/gateway.test.ts",
    "src/gateway/server.startup-matrix-migration.integration.test.ts",
    "src/gateway/sessions-history-http.test.ts",
  ])("routes gateway integration fixture %s to the e2e lane", (target) => {
    const plans = buildVitestRunPlans([target], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.e2e.config.ts",
        forwardedArgs: [target],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it.each(["src/tui/tui-pty-harness.e2e.test.ts", "src/tui/tui-pty-local.e2e.test.ts"])(
    "routes TUI PTY integration target %s to the PTY lane",
    (target) => {
      const plans = buildVitestRunPlans([target], process.cwd());

      expect(plans).toEqual([
        {
          config: "test/vitest/vitest.tui-pty.config.ts",
          forwardedArgs: [],
          includePatterns: [target],
          watchMode: false,
        },
      ]);
    },
  );
});

describe("scripts/test-projects local heavy-check lock", () => {
  const localCheckEnv = () => ({
    ...process.env,
    OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: undefined,
    OPENCLAW_TEST_PROJECTS_FORCE_LOCK: undefined,
  });

  it("skips the lock for a single scoped tooling run", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.tooling.config.ts",
            includePatterns: ["test/scripts/committer.test.ts"],
            watchMode: false,
          },
        ],
        localCheckEnv(),
      ),
    ).toBe(false);
  });

  it("keeps the lock for non-tooling runs", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.unit.config.ts",
            includePatterns: ["src/infra/vitest-config.test.ts"],
            watchMode: false,
          },
        ],
        localCheckEnv(),
      ),
    ).toBe(true);
  });

  it("skips the lock when a parent changed gate already holds it", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.unit.config.ts",
            includePatterns: ["src/infra/vitest-config.test.ts"],
            watchMode: false,
          },
        ],
        {
          ...localCheckEnv(),
          OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
        },
      ),
    ).toBe(false);
  });

  it("allows forcing the lock back on", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.tooling.config.ts",
            includePatterns: ["test/scripts/committer.test.ts"],
            watchMode: false,
          },
        ],
        {
          ...localCheckEnv(),
          OPENCLAW_TEST_PROJECTS_FORCE_LOCK: "1",
        },
      ),
    ).toBe(true);
  });
});

describe("scripts/test-projects full-suite sharding", () => {
  let fullSuiteMatches: Map<string, string[]>;
  let normalFullSuiteTestFiles: string[];
  let leafShardPlans: ReturnType<typeof buildFullSuiteVitestRunPlans>;
  let leafShardGatewayTreeReads: unknown[][];
  let leafShardHasGitGatewayListing: boolean;

  beforeAll(async () => {
    [fullSuiteMatches, normalFullSuiteTestFiles] = await Promise.all([
      listFullSuiteTestFileMatches(),
      Promise.resolve(listNormalFullSuiteTestFiles()),
    ]);

    const previous = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const gatewayServerConfig = "test/vitest/vitest.gateway-server.config.ts";
    process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
    try {
      leafShardHasGitGatewayListing = hasGitGatewayFileListing(process.cwd());
      const captured = captureReaddirSyncCallsDuring(() =>
        buildFullSuiteVitestRunPlans([], process.cwd()),
      );
      leafShardPlans = captured.result;
      leafShardGatewayTreeReads = captured.calls.filter(([target]) =>
        typeof target === "string" ? normalizeRepoPath(target).includes("src/gateway") : false,
      );
      if (!leafShardPlans.some((plan) => plan.config === gatewayServerConfig)) {
        throw new Error("expected gateway server leaf shard plans");
      }
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previous;
      }
    }
  });

  it("interleaves heavy and light configs for cold parallel full-suite runs", () => {
    const specs = [
      "test/vitest/vitest.gateway.config.ts",
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.commands.config.ts",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.extension-msteams.config.ts",
    ].map((config) => ({ config }));

    expect(orderFullSuiteSpecsForParallelRun(specs).map((spec) => spec.config)).toEqual([
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.extension-msteams.config.ts",
      "test/vitest/vitest.gateway.config.ts",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.commands.config.ts",
    ]);
  });

  it("covers each normal full-suite test file exactly once", () => {
    const missing = normalFullSuiteTestFiles.filter((file) => !fullSuiteMatches.has(file));
    const duplicated = [...fullSuiteMatches.entries()]
      .filter(([, configs]) => configs.length > 1)
      .map(([file, configs]) => `${file}: ${configs.join(", ")}`)
      .toSorted((left, right) => left.localeCompare(right));

    expect(missing).toStrictEqual([]);
    expect(duplicated).toStrictEqual([]);
  });

  it("covers the fast TUI PTY lane in full-suite routing", () => {
    expect(fullSuiteMatches.get("src/tui/tui-pty-harness.e2e.test.ts")).toEqual([
      "test/vitest/vitest.tui-pty.config.ts",
    ]);
  });

  it("uses the large host-aware local profile on roomy local hosts", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        61,
        {},
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toBe(10);
  });

  it("keeps CI full-suite runs serial even on roomy hosts", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        61,
        {
          CI: "true",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toBe(1);
  });

  it("keeps explicit parallel overrides ahead of the host-aware profile", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_PROJECTS_PARALLEL: "3",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toBe(3);
  });

  it("keeps serial untargeted runs on aggregate shards", () => {
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const previousSerial = process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    delete process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    process.env.OPENCLAW_TEST_PROJECTS_SERIAL = "1";
    try {
      expect(buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config)).toEqual([
        "test/vitest/vitest.full-core-unit-fast.config.ts",
        "test/vitest/vitest.full-core-unit-src.config.ts",
        "test/vitest/vitest.full-core-unit-security.config.ts",
        "test/vitest/vitest.full-core-unit-ui.config.ts",
        "test/vitest/vitest.full-core-unit-support.config.ts",
        "test/vitest/vitest.full-core-support-boundary.config.ts",
        "test/vitest/vitest.full-core-contracts.config.ts",
        "test/vitest/vitest.full-core-bundled.config.ts",
        "test/vitest/vitest.full-core-runtime.config.ts",
        "test/vitest/vitest.full-agentic.config.ts",
        "test/vitest/vitest.full-auto-reply.config.ts",
        "test/vitest/vitest.full-extensions.config.ts",
      ]);
    } finally {
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
      if (previousSerial === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_SERIAL = previousSerial;
      }
    }
  });

  it("expands untargeted local runs to leaf project configs by default", () => {
    const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const previousSerial = process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    const previousCi = process.env.CI;
    const previousActions = process.env.GITHUB_ACTIONS;
    const previousVitestMaxWorkers = process.env.OPENCLAW_VITEST_MAX_WORKERS;
    const previousTestWorkers = process.env.OPENCLAW_TEST_WORKERS;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.OPENCLAW_VITEST_MAX_WORKERS;
    delete process.env.OPENCLAW_TEST_WORKERS;
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.gateway-server.config.ts");
      expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-core-unit-fast.config.ts");
    } finally {
      if (previousLeafShards === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previousLeafShards;
      }
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
      if (previousSerial === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_SERIAL = previousSerial;
      }
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
      if (previousActions === undefined) {
        delete process.env.GITHUB_ACTIONS;
      } else {
        process.env.GITHUB_ACTIONS = previousActions;
      }
      if (previousVitestMaxWorkers === undefined) {
        delete process.env.OPENCLAW_VITEST_MAX_WORKERS;
      } else {
        process.env.OPENCLAW_VITEST_MAX_WORKERS = previousVitestMaxWorkers;
      }
      if (previousTestWorkers === undefined) {
        delete process.env.OPENCLAW_TEST_WORKERS;
      } else {
        process.env.OPENCLAW_TEST_WORKERS = previousTestWorkers;
      }
    }
  });

  it("can skip the aggregate extension shard when CI runs dedicated extension shards", () => {
    const previous = process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const previousSerial = process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    process.env.OPENCLAW_TEST_PROJECTS_SERIAL = "1";
    process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = "1";
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
      expect(configs).toContain("test/vitest/vitest.full-auto-reply.config.ts");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
      } else {
        process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = previous;
      }
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
      if (previousSerial === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_SERIAL = previousSerial;
      }
    }
  });

  it("can expand full-suite shards to project configs for perf experiments", () => {
    const gatewayServerConfig = "test/vitest/vitest.gateway-server.config.ts";
    const plans = leafShardPlans;

    if (leafShardHasGitGatewayListing) {
      expect(leafShardGatewayTreeReads).toEqual([]);
    }
    expect(leafShardPlans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.unit-fast-fake-timers.config.ts",
      "test/vitest/vitest.unit-src.config.ts",
      "test/vitest/vitest.unit-security.config.ts",
      "test/vitest/vitest.unit-ui.config.ts",
      "test/vitest/vitest.unit-support.config.ts",
      "test/vitest/vitest.boundary.config.ts",
      "test/vitest/vitest.tooling.config.ts",
      "test/vitest/vitest.tooling-isolated.config.ts",
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
      "test/vitest/vitest.contracts-plugin.config.ts",
      "test/vitest/vitest.bundled.config.ts",
      "test/vitest/vitest.infra.config.ts",
      "test/vitest/vitest.hooks.config.ts",
      "test/vitest/vitest.acp.config.ts",
      "test/vitest/vitest.runtime-config.config.ts",
      "test/vitest/vitest.secrets.config.ts",
      "test/vitest/vitest.logging.config.ts",
      "test/vitest/vitest.process.config.ts",
      "test/vitest/vitest.cron.config.ts",
      "test/vitest/vitest.media.config.ts",
      "test/vitest/vitest.media-understanding.config.ts",
      "test/vitest/vitest.shared-core.config.ts",
      "test/vitest/vitest.tasks.config.ts",
      "test/vitest/vitest.tui.config.ts",
      "test/vitest/vitest.tui-pty.config.ts",
      "test/vitest/vitest.ui.config.ts",
      "test/vitest/vitest.utils.config.ts",
      "test/vitest/vitest.wizard.config.ts",
      "test/vitest/vitest.gateway-core.config.ts",
      "test/vitest/vitest.gateway-client.config.ts",
      "test/vitest/vitest.gateway-methods.config.ts",
      gatewayServerConfig,
      gatewayServerConfig,
      gatewayServerConfig,
      gatewayServerConfig,
      "test/vitest/vitest.cli.config.ts",
      "test/vitest/vitest.commands-light.config.ts",
      "test/vitest/vitest.commands.config.ts",
      "test/vitest/vitest.agents-core.config.ts",
      "test/vitest/vitest.agents-embedded-agent.config.ts",
      "test/vitest/vitest.agents-support.config.ts",
      "test/vitest/vitest.agents-tools.config.ts",
      "test/vitest/vitest.daemon.config.ts",
      "test/vitest/vitest.plugin-sdk-light.config.ts",
      "test/vitest/vitest.plugin-sdk.config.ts",
      "test/vitest/vitest.plugins.config.ts",
      "test/vitest/vitest.channels.config.ts",
      "test/vitest/vitest.auto-reply-core.config.ts",
      "test/vitest/vitest.auto-reply-top-level.config.ts",
      "test/vitest/vitest.auto-reply-reply.config.ts",
      "test/vitest/vitest.extension-active-memory.config.ts",
      "test/vitest/vitest.extension-acpx.config.ts",
      "test/vitest/vitest.extension-codex.config.ts",
      "test/vitest/vitest.extension-diffs.config.ts",
      "test/vitest/vitest.extension-discord.config.ts",
      "test/vitest/vitest.extension-feishu.config.ts",
      "test/vitest/vitest.extension-imessage.config.ts",
      "test/vitest/vitest.extension-irc.config.ts",
      "test/vitest/vitest.extension-line.config.ts",
      "test/vitest/vitest.extension-mattermost.config.ts",
      "test/vitest/vitest.extension-matrix.config.ts",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.extension-messaging.config.ts",
      "test/vitest/vitest.extension-msteams.config.ts",
      "test/vitest/vitest.extension-provider-openai.config.ts",
      "test/vitest/vitest.extension-providers.config.ts",
      "test/vitest/vitest.extension-signal.config.ts",
      "test/vitest/vitest.extension-slack.config.ts",
      "test/vitest/vitest.extension-telegram.config.ts",
      "test/vitest/vitest.extension-voice-call.config.ts",
      "test/vitest/vitest.extension-whatsapp.config.ts",
      "test/vitest/vitest.extension-zalo.config.ts",
      "test/vitest/vitest.extension-browser.config.ts",
      "test/vitest/vitest.extension-qa.config.ts",
      "test/vitest/vitest.extension-media.config.ts",
      "test/vitest/vitest.extensions.config.ts",
      "test/vitest/vitest.extension-misc.config.ts",
    ]);

    const gatewayPlans = plans.filter((plan) => plan.config === gatewayServerConfig);
    const gatewayTargets = gatewayPlans.flatMap((plan) => plan.forwardedArgs);
    const gatewayChunkSizes = gatewayPlans.map((plan) => plan.forwardedArgs.length);
    expect(gatewayPlans).toHaveLength(4);
    expect(gatewayTargets.length).toBeGreaterThan(90);
    expect(new Set(gatewayTargets).size).toBe(gatewayTargets.length);
    expect(gatewayTargets).toContain("src/gateway/server-network-runtime.e2e.test.ts");
    expect(gatewayTargets).not.toContain("src/gateway/gateway.test.ts");
    expect(Math.max(...gatewayChunkSizes) - Math.min(...gatewayChunkSizes)).toBeLessThanOrEqual(1);
    expect(plans.filter((plan) => plan.config !== gatewayServerConfig)).toEqual(
      plans
        .filter((plan) => plan.config !== gatewayServerConfig)
        .map((plan) => ({
          config: plan.config,
          forwardedArgs: [],
          includePatterns: null,
          watchMode: false,
        })),
    );
  });

  it("runs explicit leaf project config targets as whole configs", () => {
    const args = [
      "test/vitest/vitest.agents-core.config.ts",
      "test/vitest/vitest.agents-embedded-agent.config.ts",
      "test/vitest/vitest.agents-support.config.ts",
      "test/vitest/vitest.agents-tools.config.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(args, process.cwd())).toEqual([]);
    expect(buildVitestRunPlans(args, process.cwd())).toEqual(
      args.map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    );
  });

  it("keeps shared Vitest config helpers out of whole-config targets", () => {
    const args = ["test/vitest/vitest.shared.config.ts"];

    expect(findUnmatchedExplicitTestTargets(args, process.cwd())).toEqual([
      {
        target: "test/vitest/vitest.shared.config.ts",
        reason: "target-matched-no-test-files",
        includePattern: "test/vitest/**/*.test.ts",
      },
    ]);
    expect(buildVitestRunPlans(args, process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/vitest/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("rejects typoed explicit leaf project config targets", () => {
    expect(
      findUnmatchedExplicitTestTargets(["test/vitest/vitest.agents-croe.config.ts"], process.cwd()),
    ).toEqual([
      {
        target: "test/vitest/vitest.agents-croe.config.ts",
        reason: "path-does-not-exist",
      },
    ]);
  });

  it("rejects watch mode with multiple explicit leaf project config targets", () => {
    expect(() =>
      buildVitestRunPlans(
        [
          "--watch",
          "test/vitest/vitest.agents-core.config.ts",
          "test/vitest/vitest.agents-tools.config.ts",
        ],
        process.cwd(),
      ),
    ).toThrow(
      "watch mode with mixed test suites is not supported; target one suite at a time or use a dedicated suite command",
    );
  });

  it("skips extension project configs when leaf sharding and the aggregate extension shard is disabled", () => {
    const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const previousSkipExtensions = process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
    process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
    process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = "1";
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).not.toContain("test/vitest/vitest.extensions.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.extension-providers.config.ts");
      expect(configs).toContain("test/vitest/vitest.auto-reply-reply.config.ts");
    } finally {
      if (previousLeafShards === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previousLeafShards;
      }
      if (previousSkipExtensions === undefined) {
        delete process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
      } else {
        process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = previousSkipExtensions;
      }
    }
  });

  it("expands full-suite shards before running them in parallel", () => {
    const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = "6";
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
    } finally {
      if (previousLeafShards === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previousLeafShards;
      }
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
    }
  });

  it("keeps untargeted watch mode on the native root config", () => {
    expect(buildFullSuiteVitestRunPlans(["--watch"], process.cwd())).toEqual([
      {
        config: "vitest.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: true,
      },
    ]);
  });
});

describe("scripts/test-projects parallel cache paths", () => {
  it("assigns isolated Vitest fs-module cache paths per parallel shard", () => {
    const specs = applyParallelVitestCachePaths(
      [
        { config: "test/vitest/vitest.gateway.config.ts", env: {}, pnpmArgs: [] },
        { config: "test/vitest/vitest.extension-matrix.config.ts", env: {}, pnpmArgs: [] },
      ],
      { cwd: "/repo", env: {} },
    );

    expect(specs.map((spec) => spec.env)).toEqual([
      {
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
          "/repo",
          "node_modules",
          ".experimental-vitest-cache",
          "0-test-vitest-vitest.gateway.config.ts",
        ),
      },
      {
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
          "/repo",
          "node_modules",
          ".experimental-vitest-cache",
          "1-test-vitest-vitest.extension-matrix.config.ts",
        ),
      },
    ]);
  });

  it("keeps an explicit global cache path", () => {
    const [spec] = applyParallelVitestCachePaths(
      [{ config: "test/vitest/vitest.gateway.config.ts", env: {}, pnpmArgs: [] }],
      { cwd: "/repo", env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" } },
    );

    expect(spec?.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();
  });
});

describe("scripts/test-projects failed shard digest", () => {
  it("prints failed configs with focused rerun commands", () => {
    expect(
      formatFailedShardDigest([
        {
          code: 1,
          config: "test/vitest/vitest.extension-codex.config.ts",
          includePatterns: null,
          noOutputTimedOut: false,
          signal: null,
        },
      ]),
    ).toEqual([
      "[test] failed shard digest (1):",
      "[test] - test/vitest/vitest.extension-codex.config.ts (exit 1)",
      "[test]   rerun: node scripts/run-vitest.mjs run --config test/vitest/vitest.extension-codex.config.ts --reporter=verbose",
    ]);
  });

  it("prints target-based reruns when a shard used include patterns", () => {
    expect(
      formatFailedShardDigest([
        {
          code: 143,
          config: "test/vitest/vitest.unit.config.ts",
          includePatterns: ["src/foo bar.test.ts"],
          noOutputTimedOut: true,
          signal: "SIGTERM",
        },
      ]),
    ).toEqual([
      "[test] failed shard digest (1):",
      "[test] - test/vitest/vitest.unit.config.ts (exit 143, signal SIGTERM, no-output timeout) includes='src/foo bar.test.ts'",
      "[test]   rerun: pnpm test 'src/foo bar.test.ts' -- --reporter=verbose",
    ]);
  });
});

describe("scripts/test-projects Vitest stall watchdog", () => {
  it("adds default no-output watchdog settings to non-watch specs", () => {
    const [spec] = applyDefaultVitestNoOutputTimeout(
      [
        {
          config: "test/vitest/vitest.extension-feishu.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { env: { PATH: "/usr/bin" } },
    );

    expect(spec?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe(
      DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
    );
    expect(spec?.env.OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS).toBe(
      DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS,
    );
  });

  it("keeps explicit watchdog settings and watch mode untouched", () => {
    const specs = applyDefaultVitestNoOutputTimeout(
      [
        {
          config: "test/vitest/vitest.extension-feishu.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: true,
        },
        {
          config: "test/vitest/vitest.extension-memory.config.ts",
          env: {
            OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS: "25000",
            OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0",
            PATH: "/usr/bin",
          },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { env: { PATH: "/usr/bin" } },
    );

    expect(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBeUndefined();
    expect(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS).toBeUndefined();
    expect(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("0");
    expect(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_HEARTBEAT_MS).toBe("25000");
  });

  it("allows changed checks to disable automatic silent-run retries", () => {
    expect(shouldRetryVitestNoOutputTimeout({})).toBe(true);
    expect(shouldRetryVitestNoOutputTimeout({ CI: "true" })).toBe(false);
    expect(shouldRetryVitestNoOutputTimeout({ GITHUB_ACTIONS: "true" })).toBe(false);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "1" })).toBe(true);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "0" })).toBe(false);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "false" })).toBe(
      false,
    );
  });
});

describe("scripts/test-projects Vitest cache isolation", () => {
  it("assigns isolated fs-module caches to multi-spec non-watch runs", () => {
    const specs = applyDefaultMultiSpecVitestCachePaths(
      [
        {
          config: "test/vitest/vitest.unit-fast.config.ts",
          env: {},
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.extension-memory.config.ts",
          env: {},
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { cwd: "/repo", env: {} },
    );

    expect(specs.map((spec) => spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH)).toEqual([
      path.join(
        "/repo",
        "node_modules",
        ".experimental-vitest-cache",
        "0-test-vitest-vitest.unit-fast.config.ts",
      ),
      path.join(
        "/repo",
        "node_modules",
        ".experimental-vitest-cache",
        "1-test-vitest-vitest.extension-memory.config.ts",
      ),
    ]);
  });

  it("keeps single-spec and watch runs on the default cache", () => {
    const single = [
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: false,
      },
    ];
    expect(applyDefaultMultiSpecVitestCachePaths(single, { cwd: "/repo", env: {} })).toBe(single);

    const watch = [
      {
        config: "vitest.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: true,
      },
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: false,
      },
    ];
    expect(applyDefaultMultiSpecVitestCachePaths(watch, { cwd: "/repo", env: {} })).toBe(watch);
  });
});
