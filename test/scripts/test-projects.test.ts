// Test Projects tests cover test projects script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_CONTRACT_CONFIG_PATTERNS,
  DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_HEARTBEAT_MS,
  DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
  applyDefaultMultiSpecVitestCachePaths,
  applyDefaultVitestNoOutputTimeout,
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestArgs,
  buildVitestRunPlans,
  createVitestRunSpecs,
  findUnmatchedExplicitTestTargets,
  formatFailedShardDigest,
  formatNoChangedTestTargetLines,
  listFullExtensionVitestProjectConfigs,
  orderFullSuiteSpecsForParallelRun,
  shouldAcquireLocalHeavyCheckLock,
  resolveChangedTestTargetPlanForArgs,
  resolveChangedTestTargetPlan,
  resolveChangedTargetArgs,
  resolveParallelFullSuiteConcurrency,
  shouldRetryVitestNoOutputTimeout,
  withRetryNoOutputTimeout,
  writeVitestIncludeFile,
} from "../../scripts/test-projects.test-support.mjs";
import { captureReaddirSyncCallsDuring } from "../../src/test-utils/fs-scan-assertions.js";
import { toRepoPath } from "../../src/test-utils/repo-files.js";
import { agentsCoreIsolatedTestFiles } from "../vitest/vitest.agents-paths.mjs";
import {
  channelConfigContractPatterns,
  channelRegistryContractPatterns,
  channelSessionContractPatterns,
  channelSurfaceContractPatterns,
} from "../vitest/vitest.contracts-shared.ts";
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

  it("skips deleted direct test files in changed mode", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/deleted-changed-target.test.ts",
      ]),
    ).toStrictEqual([]);
  });

  it("records broad fallback paths skipped by focused changed mode", () => {
    expect(
      resolveChangedTestTargetPlan([
        "test/vitest/vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["test/vitest/vitest.shared.config.ts"],
      targets: ["src/utils/provider-utils.test.ts"],
    });
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

  it("routes live command retry helper changes through its regression test", () => {
    expect(resolveChangedTestTargetPlan(["scripts/ci-live-command-retry.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/ci-live-command-retry.test.ts"],
    });
  });

  it.each(["extensions/codex/package.json", "extensions/codex/src/app-server/version.ts"])(
    "routes Codex version changes through cross-plugin contract tests for %s",
    (changedPath) => {
      expect(resolveChangedTestTargetPlan([changedPath])).toEqual({
        mode: "targets",
        targets: [
          "extensions/codex/src/manifest.test.ts",
          "extensions/openai/openai-provider.test.ts",
        ],
      });
    },
  );

  it("routes release wrapper changes through their owner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/apple-release-source-check.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/apple-release-source-check.test.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/ios-release-prepare.sh"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/ios-release-prepare.test.ts",
        "test/scripts/ios-release-wrapper-args.test.ts",
      ],
    });
    expect(resolveChangedTestTargetPlan(["scripts/android-release.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/android-release-wrapper-args.test.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/android-release-upload.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/android-release-wrapper-args.test.ts"],
    });
    expect(
      resolveChangedTestTargetPlan(["apps/android/scripts/build-release-artifacts.ts"]),
    ).toEqual({
      mode: "targets",
      targets: ["test/scripts/android-release-artifacts.test.ts"],
    });
    expect(resolveChangedTestTargetPlan([".github/workflows/android-release.yml"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
      ],
    });
    expect(resolveChangedTestTargetPlan(["scripts/release-fast-pretag-check.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/package-acceptance-workflow.test.ts"],
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
      targets: ["test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/lib/docker-e2e-plan.mjs"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/docker-all-scheduler.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
      ],
    });
    expect(resolveChangedTestTargetPlan(["scripts/github/real-behavior-proof-check.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/vitest/vitest.tooling.config.ts"],
    });
    expect(resolveChangedTestTargetPlan(["scripts/github/resolve-openclaw-ref.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/resolve-openclaw-ref.test.ts"],
    });
  });

  it("routes nested e2e library helpers through owner tests", () => {
    const expectedTargets = new Map([
      [
        "scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs",
        ["test/scripts/bundled-plugin-install-uninstall-probe.test.ts"],
      ],
      [
        "scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs",
        ["test/scripts/browser-cdp-snapshot.test.ts"],
      ],
      [
        "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs",
        ["test/scripts/browser-cdp-snapshot.test.ts"],
      ],
      [
        "scripts/e2e/lib/codex-app-server-fixture.mjs",
        [
          "test/scripts/codex-media-path-client.test.ts",
          "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs",
        ["test/scripts/codex-media-path-client.test.ts"],
      ],
      [
        "scripts/e2e/lib/codex-media-path/scenario.sh",
        ["test/scripts/codex-media-path-client.test.ts"],
      ],
      [
        "scripts/e2e/lib/codex-media-path/jsonl-request-tail.mjs",
        [
          "test/scripts/codex-media-path-client.test.ts",
          "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/codex-media-path/limits.mjs",
        ["test/scripts/codex-media-path-client.test.ts"],
      ],
      [
        "scripts/e2e/lib/codex-media-path/write-config.mjs",
        ["test/scripts/codex-media-path-client.test.ts"],
      ],
      [
        "scripts/e2e/lib/gateway-network/limits.mjs",
        ["test/scripts/gateway-network-client.test.ts"],
      ],
      [
        "scripts/e2e/lib/gateway-network/ws-frames.mjs",
        ["test/scripts/gateway-network-client.test.ts"],
      ],
      [
        "scripts/e2e/lib/npm-telegram-live/prepare-package.mjs",
        ["test/scripts/npm-telegram-live.test.ts"],
      ],
      [
        "scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs",
        ["test/scripts/kitchen-sink-plugin-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/live-plugin-tool/assertions.mjs",
        ["test/scripts/live-plugin-tool-assertions.test.ts"],
      ],
      ["scripts/e2e/lib/plugins/assertions.mjs", ["test/scripts/plugins-assertions.test.ts"]],
      [
        "scripts/e2e/lib/release-user-journey/assertions.mjs",
        ["test/scripts/release-user-journey-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/release-assertion-files.mjs",
        [
          "test/scripts/release-scenarios-assertions.test.ts",
          "test/scripts/release-user-journey-assertions.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/openai-chat-tools/write-config.mjs",
        ["test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts"],
      ],
      [
        "scripts/e2e/lib/openai-chat-tools/scenario.sh",
        ["test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts"],
      ],
      [
        "scripts/e2e/openai-chat-tools-docker.sh",
        [
          "test/e2e/qa-lab/runtime/openai-compatible-chat-tools.e2e.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs",
        [
          "test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts",
          "test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts",
        ],
      ],
      [
        "scripts/e2e/openai-web-search-minimal-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/e2e/qa-lab/runtime/openai-web-search-minimal.e2e.test.ts",
          "test/e2e/qa-lab/runtime/openai-web-search-minimal-assertions.e2e.test.ts",
        ],
      ],
      [
        "scripts/e2e/openwebui-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts",
          "test/scripts/fixture-config.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/openwebui/http-probe.mjs",
        ["test/e2e/qa-lab/runtime/openwebui-probe.e2e.test.ts"],
      ],
      [
        "test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts",
        ["test/e2e/qa-lab/runtime/qa-otel-smoke.e2e.test.ts"],
      ],
      ["scripts/e2e/lib/text-file-utils.mjs", ["test/scripts/e2e-text-file-utils.test.ts"]],
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        ["test/scripts/plugins-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/release-scenarios/write-cli-plugin.mjs",
        ["test/scripts/release-scenarios-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs",
        ["test/scripts/release-user-journey-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/upgrade-survivor/run.sh",
        ["test/scripts/upgrade-survivor-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/upgrade-survivor/config-recipe/plugins-configured-installs.json",
        ["test/scripts/upgrade-survivor-config-recipe.test.ts"],
      ],
      ["scripts/e2e/lib/run-with-pty.mjs", ["test/scripts/e2e-run-with-pty.test.ts"]],
    ]);

    for (const [source, targets] of expectedTargets) {
      expect(resolveChangedTestTargetPlan([source]), source).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps shared PR worktree helper edits on the full tooling owner suite", () => {
    expect(resolveChangedTestTargetPlan(["scripts/pr-lib/worktree.sh"])).toEqual({
      mode: "targets",
      targets: ["test/vitest/vitest.tooling.config.ts"],
    });
  });

  it("routes nested e2e shell helpers through their sourced owner tests", () => {
    const expectedTargets = new Map([
      [
        "scripts/e2e/lib/bun-global-install/assertions.mjs",
        ["test/scripts/test-install-sh-docker.test.ts"],
      ],
      [
        "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
        ["test/scripts/bundled-plugin-install-uninstall-probe.test.ts"],
      ],
      [
        "scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh",
        ["test/scripts/bundled-plugin-install-uninstall-probe.test.ts"],
      ],
      [
        "scripts/e2e/lib/auth-profile-store-assertions.mjs",
        [
          "test/scripts/release-scenarios-assertions.test.ts",
          "test/scripts/npm-onboard-channel-agent-assertions.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/codex-npm-plugin-live/assertions.mjs",
        [
          "test/scripts/codex-install-assertions.test.ts",
          "test/scripts/docker-build-helper.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/codex-install-utils.mjs",
        ["test/scripts/codex-install-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/codex-on-demand/assertions.mjs",
        ["test/scripts/codex-install-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/clawhub-fixture-server.cjs",
        [
          "test/scripts/clawhub-fixture-server.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/config-reload/assert-log.mjs",
        ["test/scripts/e2e-mock-config-limits.test.ts"],
      ],
      [
        "scripts/e2e/lib/config-reload/mutate-metadata.mjs",
        ["test/scripts/config-reload-mutate-metadata.test.ts"],
      ],
      ["scripts/e2e/lib/env-limits.mjs", ["test/scripts/e2e-helper-env-limits.test.ts"]],
      [
        "scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs",
        ["test/scripts/docker-stats-resource-ceiling.test.ts"],
      ],
      [
        "scripts/e2e/lib/doctor-install-switch/scenario.sh",
        ["test/scripts/docker-build-helper.test.ts"],
      ],
      [
        "scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs",
        ["test/scripts/doctor-install-switch-wrapper.test.ts"],
      ],
      [
        "scripts/e2e/lib/doctor-install-switch/shims/loginctl",
        ["test/scripts/docker-build-helper.test.ts"],
      ],
      [
        "scripts/e2e/lib/doctor-install-switch/shims/systemctl",
        ["test/scripts/docker-build-helper.test.ts"],
      ],
      [
        "scripts/e2e/lib/fixture.mjs",
        [
          "test/scripts/fixture-config.test.ts",
          "test/scripts/fixtures-workspace.test.ts",
          "test/scripts/fixture-plugin-commands.test.ts",
        ],
      ],
      ["scripts/e2e/lib/fixtures/config.mjs", ["test/scripts/fixture-config.test.ts"]],
      ["scripts/e2e/lib/fixtures/common.mjs", ["test/scripts/fixture-common.test.ts"]],
      [
        "scripts/e2e/lib/fixtures/mock-openai-config.mjs",
        ["test/scripts/mock-openai-config.test.ts"],
      ],
      ["scripts/e2e/lib/fixtures/plugins.mjs", ["test/scripts/fixture-plugin-commands.test.ts"]],
      [
        "scripts/e2e/lib/incremental-line-reader.mjs",
        [
          "test/scripts/incremental-line-reader.test.ts",
          "test/scripts/config-reload-log-scanner.test.ts",
          "test/scripts/codex-media-path-client.test.ts",
          "test/e2e/qa-lab/runtime/codex-auth-product-proof.e2e.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/kitchen-sink-plugin/sweep.sh",
        ["test/scripts/kitchen-sink-plugin-assertions.test.ts"],
      ],
      [
        "scripts/e2e/lib/mcp-code-mode-validation.ts",
        ["test/scripts/mcp-code-mode-gateway-client.test.ts"],
      ],
      [
        "scripts/e2e/codex-media-path-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/codex-media-path-client.test.ts",
        ],
      ],
      [
        "scripts/e2e/codex-npm-plugin-live-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      [
        "scripts/e2e/codex-on-demand-docker.sh",
        ["test/scripts/docker-build-helper.test.ts", "test/scripts/docker-e2e-plan.test.ts"],
      ],
      [
        "scripts/e2e/system-agent-first-run-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/docker-e2e-system-agent.test.ts",
        ],
      ],
      [
        "test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts",
        [
          "test/scripts/docker-e2e-system-agent.test.ts",
          "src/cli/program/register.onboard.test.ts",
          "src/cli/run-main.test.ts",
          "src/cli/run-main.exit.test.ts",
          "src/commands/system-agent-with-inference.test.ts",
          "src/system-agent/assistant.configured.test.ts",
          "src/system-agent/assistant.test.ts",
          "src/system-agent/system-agent.test.ts",
          "src/system-agent/operations.test.ts",
          "src/system-agent/overview.test.ts",
          "src/system-agent/setup-inference.test.ts",
          "src/system-agent/audit.test.ts",
        ],
      ],
      [
        "scripts/e2e/system-agent-first-run-spec.json",
        [
          "test/scripts/docker-e2e-system-agent.test.ts",
          "src/system-agent/operations.test.ts",
          "src/system-agent/audit.test.ts",
        ],
      ],
      [
        "scripts/e2e/system-agent-rescue-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/docker-e2e-system-agent.test.ts",
        ],
      ],
      [
        "scripts/e2e/system-agent-rescue-docker-client.ts",
        [
          "test/scripts/docker-e2e-system-agent.test.ts",
          "src/system-agent/rescue-policy.test.ts",
          "src/system-agent/rescue-message.test.ts",
          "src/system-agent/operations.test.ts",
          "src/system-agent/audit.test.ts",
        ],
      ],
      [
        "scripts/e2e/commitments-safety-docker-client.ts",
        [
          "test/scripts/docker-e2e-clients.test.ts",
          "src/commitments/runtime.test.ts",
          "src/commitments/store.test.ts",
        ],
      ],
      [
        "scripts/e2e/commitments-safety-docker.sh",
        [
          "test/scripts/docker-e2e-clients.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "src/commitments/runtime.test.ts",
          "src/commitments/store.test.ts",
        ],
      ],
      [
        "scripts/e2e/session-runtime-context-docker-client.ts",
        [
          "test/scripts/docker-e2e-clients.test.ts",
          "src/agents/embedded-agent-runner/run/runtime-context-prompt.test.ts",
          "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
        ],
      ],
      [
        "scripts/e2e/session-runtime-context-docker.sh",
        [
          "test/scripts/docker-e2e-clients.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "src/agents/embedded-agent-runner/run/runtime-context-prompt.test.ts",
          "src/agents/embedded-agent-runner/transcript-rewrite.test.ts",
        ],
      ],
      ["scripts/e2e/mcp-channels-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
      ["scripts/e2e/docker-openai-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
      ["scripts/e2e/mcp-code-mode-gateway-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
      ["scripts/e2e/mock-openai-server.mjs", ["test/scripts/e2e-mock-config-limits.test.ts"]],
      [
        "scripts/e2e/cron-mcp-cleanup-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-observability.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
          "test/scripts/docker-e2e-seeds.test.ts",
        ],
      ],
      [
        "scripts/e2e/cron-mcp-cleanup-docker-client.ts",
        [
          "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
          "src/gateway/server.cron.test.ts",
          "src/gateway/server-methods/agent.test.ts",
          "src/cron/isolated-agent/run.fast-mode.test.ts",
          "src/cron/active-jobs-manual-run.test.ts",
        ],
      ],
      ["scripts/e2e/cron-mcp-cleanup-seed.ts", ["test/scripts/docker-e2e-seeds.test.ts"]],
      [
        "scripts/e2e/lib/onboard/scenario.sh",
        ["test/scripts/e2e-shell-tempfiles.test.ts", "test/scripts/openclaw-test-state.test.ts"],
      ],
      [
        "scripts/e2e/lib/onboard/assert-config.mjs",
        ["test/scripts/onboard-config-fixtures.test.ts"],
      ],
      [
        "scripts/e2e/lib/onboard/write-config.mjs",
        ["test/scripts/onboard-config-fixtures.test.ts"],
      ],
      ["scripts/e2e/lib/package-compat.mjs", ["test/scripts/docker-build-helper.test.ts"]],
      [
        "scripts/e2e/agents-delete-shared-workspace-docker.sh",
        [
          "test/scripts/docker-e2e-plan.test.ts",
          "src/scripts/ci-changed-scope.test.ts",
          "src/commands/agents.delete.test.ts",
        ],
      ],
      [
        "scripts/e2e/browser-cdp-snapshot-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/browser-cdp-snapshot.test.ts",
          "test/scripts/e2e-helper-env-limits.test.ts",
        ],
      ],
      [
        "scripts/e2e/channel-plugin-trust-docker.sh",
        ["test/scripts/docker-build-helper.test.ts", "test/scripts/test-projects.test.ts"],
      ],
      [
        "scripts/e2e/config-reload-source-docker.sh",
        [
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/fixture-config.test.ts",
          "test/scripts/e2e-mock-config-limits.test.ts",
          "src/gateway/config-reload.test.ts",
        ],
      ],
      [
        "scripts/e2e/gateway-network-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/gateway-network-client.test.ts",
          "src/scripts/ci-changed-scope.test.ts",
        ],
      ],
      [
        "scripts/e2e/npm-onboard-channel-agent-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/npm-onboard-channel-agent-assertions.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
        ],
      ],
      ["scripts/e2e/npm-telegram-live-docker.sh", ["test/scripts/npm-telegram-live.test.ts"]],
      ["scripts/e2e/npm-telegram-live-runner.ts", ["test/scripts/npm-telegram-live.test.ts"]],
      [
        "scripts/e2e/multi-node-update-docker.sh",
        ["test/scripts/docker-build-helper.test.ts", "test/scripts/docker-e2e-plan.test.ts"],
      ],
      [
        "scripts/e2e/doctor-install-switch-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      [
        "scripts/e2e/update-channel-switch-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      [
        "scripts/e2e/skill-install-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/e2e-shell-tempfiles.test.ts",
        ],
      ],
      [
        "scripts/e2e/upgrade-survivor-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/upgrade-survivor-probe-gateway.test.ts",
          "test/scripts/upgrade-survivor-assertions.test.ts",
          "test/scripts/openclaw-test-state.test.ts",
        ],
      ],
      [
        "scripts/e2e/bundled-plugin-install-uninstall-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/bundled-plugin-install-uninstall-probe.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh",
        ["test/scripts/plugin-update-unchanged-docker.test.ts"],
      ],
      [
        "scripts/e2e/lib/plugin-update/probe.mjs",
        ["test/scripts/plugin-update-unchanged-docker.test.ts"],
      ],
      [
        "scripts/e2e/lib/plugin-update/registry-server.mjs",
        ["test/scripts/plugin-update-unchanged-docker.test.ts"],
      ],
      [
        "scripts/e2e/lib/plugin-update/unchanged-scenario.sh",
        ["test/scripts/plugin-update-unchanged-docker.test.ts"],
      ],
      [
        "scripts/e2e/plugin-update-unchanged-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/plugin-update-unchanged-docker.test.ts",
        ],
      ],
      [
        "scripts/e2e/update-corrupt-plugin-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/plugin-update-unchanged-docker.test.ts",
        ],
      ],
      [
        "scripts/e2e/plugins-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/plugins-assertions.test.ts",
        ],
      ],
      ["scripts/e2e/lib/plugins/clawhub.sh", ["test/scripts/plugins-assertions.test.ts"]],
      ["scripts/e2e/lib/plugins/fixtures.sh", ["test/scripts/plugins-assertions.test.ts"]],
      ["scripts/e2e/lib/plugins/marketplace.sh", ["test/scripts/plugins-assertions.test.ts"]],
      ["scripts/e2e/lib/plugins/sweep.sh", ["test/scripts/plugins-assertions.test.ts"]],
      [
        "scripts/e2e/lib/release-plugin-marketplace/scenario.sh",
        ["test/scripts/docker-build-helper.test.ts"],
      ],
      [
        "scripts/e2e/lib/release-typed-onboarding/scenario.sh",
        ["test/scripts/docker-build-helper.test.ts"],
      ],
      [
        "scripts/e2e/lib/release-upgrade-user-journey/scenario.sh",
        ["test/scripts/docker-build-helper.test.ts"],
      ],
      [
        "scripts/e2e/release-plugin-marketplace-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      [
        "scripts/e2e/release-typed-onboarding-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      [
        "scripts/e2e/release-upgrade-user-journey-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      [
        "scripts/e2e/release-user-journey-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/release-user-journey-assertions.test.ts",
        ],
      ],
      [
        "scripts/e2e/lib/skills/clawhub-install-proof.sh",
        ["test/scripts/e2e-shell-tempfiles.test.ts"],
      ],
      [
        "scripts/e2e/lib/update-channel-switch/assertions.mjs",
        ["test/scripts/docker-build-helper.test.ts"],
      ],
      [
        "scripts/e2e/live-plugin-tool-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/live-plugin-tool-assertions.test.ts",
        ],
      ],
      [
        "scripts/e2e/openai-image-auth-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/openai-image-auth-docker-client.test.ts",
          "extensions/openai/image-generation-provider.test.ts",
        ],
      ],
      [
        "test/e2e/qa-lab/runtime/openai-image-auth-docker-client.ts",
        [
          "test/scripts/openai-image-auth-docker-client.test.ts",
          "extensions/openai/image-generation-provider.test.ts",
          "src/image-generation/openai-compatible-image-provider.test.ts",
        ],
      ],
      [
        "scripts/e2e/plugin-binding-command-escape-docker.sh",
        [
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      ["scripts/e2e/qr-import-docker.sh", ["test/scripts/docker-build-helper.test.ts"]],
    ]);

    for (const [source, targets] of expectedTargets) {
      expect(resolveChangedTestTargetPlan([source]), source).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("routes unmatched script changes to the tooling suite instead of skipping tests", () => {
    const targets = ["scripts/check-no-raw-http2-imports.mjs"];

    expect(resolveChangedTestTargetPlan(targets)).toEqual({
      mode: "targets",
      targets: ["test/vitest/vitest.tooling.config.ts"],
    });
    expect(buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => targets)).toEqual(
      [
        {
          config: "test/vitest/vitest.tooling.config.ts",
          forwardedArgs: [],
          includePatterns: null,
          watchMode: false,
        },
      ],
    );
  });

  it("routes Z.AI fallback repro script changes through its regression test", () => {
    expect(resolveChangedTestTargetPlan(["scripts/zai-fallback-repro.ts"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/zai-fallback-repro.test.ts"],
    });
  });

  it("routes code-mode namespace live repro changes through its regression test", () => {
    expect(resolveChangedTestTargetPlan(["scripts/repro/code-mode-namespace-live.ts"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/code-mode-namespace-live.test.ts"],
    });
  });

  it("routes code-mode namespace live Docker repro changes through its regression tests", () => {
    expect(
      resolveChangedTestTargetPlan(["scripts/repro/code-mode-namespace-live-docker.sh"]),
    ).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/code-mode-namespace-live.test.ts",
        "test/scripts/docker-build-helper.test.ts",
      ],
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

  it("keeps scripts tsconfig edits on oxlint config tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/tsconfig.json"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/oxlint-config.test.ts"],
    });
  });

  it("keeps the scripts typecheck project on its routing tests", () => {
    expect(resolveChangedTestTargetPlan(["tsconfig.scripts.json"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/changed-lanes.test.ts", "test/scripts/test-projects.test.ts"],
    });
  });

  it("keeps docs i18n behavior fixture edits on behavior baseline tests", () => {
    for (const fixturePath of [
      "scripts/docs-i18n/testdata/behavior/fenced-singleton-retry/case.json",
      "scripts/docs-i18n/testdata/behavior/fenced-singleton-retry/source.txt",
    ]) {
      expect(resolveChangedTestTargetPlan([fixturePath]), fixturePath).toEqual({
        mode: "targets",
        targets: ["test/scripts/docs-i18n.test.ts"],
      });
    }
  });

  it("keeps docs i18n Go edits on their module and workflow guards", () => {
    const cases = [
      ["scripts/docs-i18n/main.go", ["test/scripts/docs-i18n.test.ts"]],
      ["scripts/docs-i18n/main_test.go", ["test/scripts/docs-i18n.test.ts"]],
      [
        "scripts/docs-i18n/go.mod",
        ["test/scripts/docs-i18n.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
      ],
    ] as const;
    for (const [modulePath, targets] of cases) {
      expect(resolveChangedTestTargetPlan([modulePath]), modulePath).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps k8s manifest edits on manifest tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/k8s/manifests/configmap.yaml"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/k8s-manifests.test.ts"],
    });
  });

  it("keeps Crabbox runner script edits on their regression tests", () => {
    for (const scriptPath of [
      "scripts/crabbox-wrapper.mjs",
      "scripts/crabbox-wrapper-providers.mjs",
    ]) {
      expect(resolveChangedTestTargetPlan([scriptPath]), scriptPath).toEqual({
        mode: "targets",
        targets: ["test/scripts/crabbox-wrapper.test.ts"],
      });
    }
  });

  it("keeps build stamp script edits on the build stamp regression test", () => {
    expect(resolveChangedTestTargetPlan(["scripts/build-stamp.mjs"])).toEqual({
      mode: "targets",
      targets: ["src/infra/build-stamp.test.ts"],
    });
  });

  it("keeps bundled plugin metadata copier edits on runtime owner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/copy-bundled-plugin-metadata.mjs"])).toEqual({
      mode: "targets",
      targets: ["src/plugins/copy-bundled-plugin-metadata.test.ts", "src/infra/run-node.test.ts"],
    });
  });

  it("keeps CI workflow edits on workflow guard tests", () => {
    expect(resolveChangedTestTargetPlan([".github/workflows/ci.yml"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/ci-workflow-guards.test.ts",
        "test/scripts/changed-lanes.test.ts",
        "test/scripts/check-workflows.test.ts",
        "test/scripts/plugin-contract-test-plan.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
        "test/scripts/verify-pr-hosted-gates.test.ts",
      ],
    });
  });

  it("keeps generated locale publisher and inventory edits on workflow guards", () => {
    for (const actionPath of [
      ".github/actions/create-generated-pr-tokens/action.yml",
      ".github/actions/publish-generated-pr/action.yml",
    ]) {
      expect(resolveChangedTestTargetPlan([actionPath])).toEqual({
        mode: "targets",
        targets: ["test/scripts/ci-workflow-guards.test.ts"],
      });
    }
    expect(resolveChangedTestTargetPlan(["scripts/native-app-i18n.ts"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/native-app-i18n.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
    });
  });

  it("keeps PR automation workflow edits on workflow guard tests", () => {
    for (const workflowPath of [
      ".github/workflows/auto-response.yml",
      ".github/workflows/clawsweeper-dispatch.yml",
      ".github/workflows/labeler.yml",
      ".github/workflows/real-behavior-proof.yml",
    ]) {
      expect(resolveChangedTestTargetPlan([workflowPath])).toEqual({
        mode: "targets",
        targets: ["test/scripts/ci-workflow-guards.test.ts"],
      });
    }
  });

  it("keeps security-sensitive guard workflow edits on guard workflow tests", () => {
    expect(
      resolveChangedTestTargetPlan([".github/workflows/security-sensitive-guard.yml"]),
    ).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/security-sensitive-guard-workflow.test.ts",
        "test/scripts/ci-workflow-guards.test.ts",
      ],
    });
  });

  it("keeps Crabbox and Testbox workflow edits on workflow regression tests", () => {
    const workflowTargets = new Map([
      [
        ".github/workflows/ci-check-testbox.yml",
        [
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/changed-lanes.test.ts",
        ],
      ],
      [
        ".github/workflows/ci-check-arm-testbox.yml",
        [
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
      [
        ".github/workflows/crabbox-hydrate.yml",
        [
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
        ],
      ],
    ]);
    for (const [workflowPath, targets] of workflowTargets) {
      expect(resolveChangedTestTargetPlan([workflowPath])).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("routes Periphery workflow edits through their scope regression tests", () => {
    const workflowTargets = new Map([
      [
        ".github/workflows/ios-periphery.yml",
        [
          "test/scripts/ios-periphery-comment-workflow.test.ts",
          "test/scripts/periphery-scope-workflows.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        ".github/workflows/macos-periphery.yml",
        [
          "test/scripts/ios-periphery-comment-workflow.test.ts",
          "test/scripts/periphery-scope-workflows.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        ".github/workflows/shared-openclawkit-periphery.yml",
        [
          "test/scripts/periphery-intersection.test.ts",
          "test/scripts/periphery-scope-workflows.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
    ]);

    for (const [workflowPath, targets] of workflowTargets) {
      expect(resolveChangedTestTargetPlan([workflowPath]), workflowPath).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps Mantis proof workflow edits on workflow evidence regression tests", () => {
    const packageAcceptanceTargets = [
      "test/scripts/package-acceptance-workflow.test.ts",
      "test/scripts/ci-workflow-guards.test.ts",
    ];
    const workflowTargets = new Map([
      [".github/workflows/mantis-discord-smoke.yml", packageAcceptanceTargets],
      [".github/workflows/mantis-discord-status-reactions.yml", packageAcceptanceTargets],
      [".github/workflows/mantis-discord-thread-attachment.yml", packageAcceptanceTargets],
      [".github/workflows/mantis-slack-desktop-smoke.yml", packageAcceptanceTargets],
      [
        ".github/workflows/mantis-telegram-desktop-proof.yml",
        [
          "test/scripts/mantis-telegram-desktop-proof-workflow.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        ".github/workflows/mantis-web-ui-chat-proof.yml",
        [
          "test/scripts/mantis-web-ui-chat-proof-workflow.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
    ]);

    for (const [workflowPath, targets] of workflowTargets) {
      expect(resolveChangedTestTargetPlan([workflowPath])).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps release-check workflow edits on release workflow regression tests", () => {
    expect(resolveChangedTestTargetPlan([".github/workflows/openclaw-release-checks.yml"])).toEqual(
      {
        mode: "targets",
        targets: [
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/openclaw-cross-os-release-checks.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      },
    );
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
      targets: ["src/scripts/ci-changed-scope.test.ts", "test/scripts/control-ui-i18n.test.ts"],
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

    expect(resolveChangedTestTargetPlan(["scripts/github/dependency-guard.mjs"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/dependency-guard-script.test.ts",
        "test/scripts/dependency-guard-workflow.test.ts",
      ],
    });

    expect(resolveChangedTestTargetPlan(["scripts/github/guard-shared.mjs"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/dependency-guard-script.test.ts",
        "test/scripts/dependency-guard-workflow.test.ts",
        "test/scripts/security-sensitive-guard-script.test.ts",
        "test/scripts/security-sensitive-guard-workflow.test.ts",
      ],
    });

    expect(
      resolveChangedTestTargetPlan(["scripts/github/run-openclaw-cross-os-release-checks.sh"]),
    ).toEqual({
      mode: "targets",
      targets: ["test/scripts/openclaw-cross-os-release-workflow.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/github/security-sensitive-guard.mjs"])).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/security-sensitive-guard-script.test.ts",
        "test/scripts/security-sensitive-guard-workflow.test.ts",
      ],
    });

    expect(
      resolveChangedTestTargetPlan(["scripts/dependency-ownership-surface-report.mjs"]),
    ).toEqual({
      mode: "targets",
      targets: ["test/scripts/dependency-ownership-surface-report.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/clawtributors-map.json"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/update-clawtributors.test.ts"],
    });

    expect(resolveChangedTestTargetPlan(["scripts/docs-list.js"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/docs-list.test.ts"],
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
      ["scripts/npm-runner.d.mts", ["test/scripts/npm-runner.test.ts"]],
      ["scripts/pnpm-runner.d.mts", ["test/scripts/pnpm-runner.test.ts"]],
      [
        "scripts/lib/cross-os-release-checks/runtime.ts",
        ["test/scripts/openclaw-cross-os-release-checks.test.ts"],
      ],
      [
        "scripts/install.sh",
        [
          "test/scripts/install-sh.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
          "test/scripts/website-installer-sync-workflow.test.ts",
          "test/scripts/openclaw-cross-os-release-checks.test.ts",
          "src/scripts/ci-changed-scope.test.ts",
        ],
      ],
      [
        "scripts/install.ps1",
        [
          "test/scripts/install-ps1.test.ts",
          "test/scripts/website-installer-sync-workflow.test.ts",
          "test/scripts/openclaw-cross-os-release-checks.test.ts",
          "src/scripts/ci-changed-scope.test.ts",
        ],
      ],
      ["scripts/podman/openclaw.container.in", ["test/scripts/test-install-sh-docker.test.ts"]],
      [
        "scripts/package-openclaw-for-docker.mjs",
        ["test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts"],
      ],
      ["scripts/ios-run.sh", ["test/scripts/ios-run.test.ts"]],
      ["scripts/ios-write-version-xcconfig.sh", ["test/scripts/ios-version.test.ts"]],
      ["scripts/create-dmg.sh", ["test/scripts/create-dmg.test.ts"]],
      ["scripts/make_appcast.sh", ["test/scripts/make-appcast.test.ts"]],
      ["scripts/package-mac-app.sh", ["test/scripts/package-mac-app.test.ts"]],
      ["scripts/package-mac-dist.sh", ["test/scripts/package-mac-dist.test.ts"]],
      [
        "scripts/lib/build-metadata.sh",
        [
          "src/docker-setup.e2e.test.ts",
          "test/scripts/apple-release-source-check.test.ts",
          "test/scripts/ios-version.test.ts",
          "test/scripts/package-mac-app.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ],
      ],
      [
        "scripts/lib/swift-toolchain.sh",
        ["test/scripts/package-mac-app.test.ts", "test/scripts/package-mac-dist.test.ts"],
      ],
      ["scripts/e2e/bun-global-install-smoke.sh", ["test/scripts/test-install-sh-docker.test.ts"]],
      [
        "scripts/sparkle-build.ts",
        [
          "test/appcast.test.ts",
          "test/release-check.test.ts",
          "test/scripts/package-mac-app.test.ts",
          "test/scripts/package-mac-dist.test.ts",
        ],
      ],
      ["scripts/package-changelog.mjs", ["test/scripts/package-changelog.test.ts"]],
      [
        "scripts/test-install-sh-e2e-docker.sh",
        ["test/scripts/docker-build-helper.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
      ],
      ["scripts/openclaw-prepack.ts", ["test/openclaw-prepack.test.ts"]],
      ["scripts/openclaw-npm-release-check.ts", ["test/openclaw-npm-release-check.test.ts"]],
      [
        "scripts/openclaw-npm-postpublish-verify.ts",
        ["test/openclaw-npm-postpublish-verify.test.ts"],
      ],
      ["scripts/verify-pr-hosted-gates.mjs", ["test/scripts/verify-pr-hosted-gates.test.ts"]],
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

  it("routes script declaration edits through implementation owner tests", () => {
    const declarationMirrors = new Map([
      ["scripts/build-stamp.d.mts", "scripts/build-stamp.mjs"],
      ["scripts/ci-changed-scope.d.mts", "scripts/ci-changed-scope.mjs"],
      ["scripts/copy-bundled-plugin-metadata.d.mts", "scripts/copy-bundled-plugin-metadata.mjs"],
      ["scripts/docs-link-audit.d.mts", "scripts/docs-link-audit.mjs"],
      [
        "scripts/lib/bundled-plugin-build-entries.d.mts",
        "scripts/lib/bundled-plugin-build-entries.mjs",
      ],
      ["scripts/lib/config-boundary-guard.d.mts", "scripts/lib/config-boundary-guard.mjs"],
      [
        "scripts/lib/deprecated-config-api-guard.d.mts",
        "scripts/lib/deprecated-config-api-guard.mjs",
      ],
      [
        "scripts/lib/extension-source-classifier.d.mts",
        "scripts/lib/extension-source-classifier.mjs",
      ],
      [
        "scripts/lib/local-build-metadata-paths.d.mts",
        "scripts/lib/local-build-metadata-paths.mjs",
      ],
      ["scripts/lib/local-build-metadata.d.mts", "scripts/lib/local-build-metadata.mjs"],
      ["scripts/lib/plugin-sdk-entries.d.mts", "scripts/lib/plugin-sdk-entries.mjs"],
      ["scripts/lib/vitest-local-scheduling.d.mts", "scripts/lib/vitest-local-scheduling.mjs"],
      ["scripts/run-node.d.mts", "scripts/run-node.mjs"],
      ["scripts/stage-bundled-plugin-runtime.d.mts", "scripts/stage-bundled-plugin-runtime.mjs"],
      ["scripts/watch-node.d.mts", "scripts/watch-node.mjs"],
    ]);

    for (const [declarationPath, implementationPath] of declarationMirrors) {
      expect(resolveChangedTestTargetPlan([declarationPath]), declarationPath).toEqual(
        resolveChangedTestTargetPlan([implementationPath]),
      );
    }
  });

  it("keeps QA Lab gateway smoke script edits on QA e2e tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/dev/gateway-smoke.ts"])).toEqual({
      mode: "targets",
      targets: ["test/e2e/qa-lab/runtime/gateway-smoke.e2e.test.ts"],
    });
  });

  it("keeps extensionless helper script edits on owner tests", () => {
    const expectedTargets = new Map([
      ["scripts/committer", ["test/scripts/committer.test.ts"]],
      ["scripts/gh-read", ["test/scripts/gh-read.test.ts"]],
      [
        "scripts/pr",
        ["test/scripts/pr-operation-lock.test.ts", "test/scripts/pr-wrappers.test.ts"],
      ],
      ["scripts/pr-lib/operation-lock.sh", ["test/scripts/pr-operation-lock.test.ts"]],
      ["scripts/pr-lib/process-group-runner.mjs", ["test/scripts/pr-operation-lock.test.ts"]],
      ["scripts/pr-merge", ["test/scripts/pr-wrappers.test.ts"]],
      ["scripts/pr-prepare", ["test/scripts/pr-wrappers.test.ts"]],
      ["scripts/pr-review", ["test/scripts/pr-wrappers.test.ts"]],
    ]);

    for (const [source, targets] of expectedTargets) {
      expect(resolveChangedTestTargetPlan([source]), source).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps auth monitoring helper edits on owner tests", () => {
    const expectedTargets = new Map([
      ["scripts/auth-monitor.sh", ["test/scripts/auth-monitor.test.ts"]],
      ["scripts/mobile-reauth.sh", ["test/scripts/auth-monitor.test.ts"]],
      ["scripts/setup-auth-system.sh", ["test/scripts/auth-monitor.test.ts"]],
      ["scripts/systemd/openclaw-auth-monitor.service", ["test/scripts/auth-monitor.test.ts"]],
      ["scripts/systemd/openclaw-auth-monitor.timer", ["test/scripts/auth-monitor.test.ts"]],
      ["scripts/termux-auth-widget.sh", ["test/scripts/auth-monitor.test.ts"]],
      ["scripts/termux-quick-auth.sh", ["test/scripts/auth-monitor.test.ts"]],
      ["scripts/termux-sync-widget.sh", ["test/scripts/auth-monitor.test.ts"]],
      ["test/scripts/auth-monitor.test.ts", ["test/scripts/auth-monitor.test.ts"]],
    ]);

    for (const [source, targets] of expectedTargets) {
      expect(resolveChangedTestTargetPlan([source]), source).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps docs spellcheck config edits on owner tests", () => {
    const expectedTargets = new Map([
      ["scripts/codespell-dictionary.txt", ["test/scripts/docs-spellcheck.test.ts"]],
      ["scripts/codespell-ignore.txt", ["test/scripts/docs-spellcheck.test.ts"]],
      ["scripts/docs-spellcheck.sh", ["test/scripts/docs-spellcheck.test.ts"]],
      ["test/scripts/docs-spellcheck.test.ts", ["test/scripts/docs-spellcheck.test.ts"]],
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
        "scripts/lib/local-heavy-check-runtime.d.mts",
        ["test/scripts/local-heavy-check-runtime.test.ts"],
      ],
      [
        "scripts/lib/local-heavy-check-runtime.mjs",
        ["test/scripts/local-heavy-check-runtime.test.ts"],
      ],
      ["scripts/lib/managed-child-process.mjs", ["test/scripts/managed-child-process.test.ts"]],
      [
        "scripts/lib/windows-taskkill.mjs",
        ["test/scripts/managed-child-process.test.ts", "test/scripts/run-with-env.test.ts"],
      ],
      [
        "scripts/lib/windows-taskkill.d.mts",
        ["test/scripts/managed-child-process.test.ts", "test/scripts/run-with-env.test.ts"],
      ],
      ["scripts/lib/source-file-scan-cache.mjs", ["test/scripts/source-file-scan-cache.test.ts"]],
      ["scripts/lib/dev-tooling-safety.ts", ["test/scripts/dev-tooling-safety.test.ts"]],
      [
        "scripts/lib/local-build-metadata.mjs",
        [
          "src/infra/build-stamp.test.ts",
          "test/scripts/runtime-postbuild-stamp.test.ts",
          "src/infra/run-node.test.ts",
          "src/infra/package-dist-inventory.test.ts",
          "test/release-check.test.ts",
          "test/openclaw-npm-release-check.test.ts",
          "test/scripts/check-gateway-watch-regression.test.ts",
          "test/scripts/check-openclaw-package-tarball.test.ts",
          "test/scripts/openclaw-cross-os-release-checks.test.ts",
        ],
      ],
      [
        "scripts/lib/local-build-metadata-paths.mjs",
        [
          "src/infra/build-stamp.test.ts",
          "test/scripts/runtime-postbuild-stamp.test.ts",
          "src/infra/run-node.test.ts",
          "src/infra/package-dist-inventory.test.ts",
          "test/release-check.test.ts",
          "test/openclaw-npm-release-check.test.ts",
          "test/scripts/check-gateway-watch-regression.test.ts",
          "test/scripts/check-openclaw-package-tarball.test.ts",
          "test/scripts/openclaw-cross-os-release-checks.test.ts",
        ],
      ],
      [
        "scripts/lib/deprecated-plugin-sdk-usage.mjs",
        ["test/scripts/check-deprecated-api-usage.test.ts"],
      ],
      [
        "scripts/lib/dependency-ownership.json",
        ["test/scripts/dependency-ownership-surface-report.test.ts"],
      ],
      [
        "scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json",
        [
          "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
          "src/plugins/contracts/plugin-sdk-index.test.ts",
          "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
          "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
          "src/plugins/contracts/extension-package-project-boundaries.test.ts",
          "test/scripts/plugin-sdk-surface-report.test.ts",
          "test/scripts/build-all.test.ts",
          "test/release-check.test.ts",
          "test/scripts/prepare-extension-package-boundary-artifacts.test.ts",
          "test/scripts/ts-topology.test.ts",
          "test/vitest/vitest.tooling.config.ts",
        ],
      ],
      [
        "scripts/lib/plugin-sdk-deprecated-public-subpaths.json",
        [
          "test/scripts/check-deprecated-api-usage.test.ts",
          "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
          "test/scripts/plugin-sdk-surface-report.test.ts",
          "test/scripts/build-all.test.ts",
        ],
      ],
      [
        "scripts/lib/plugin-sdk-entrypoints.json",
        [
          "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
          "src/plugins/contracts/plugin-sdk-index.test.ts",
          "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
          "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
          "src/plugins/contracts/extension-package-project-boundaries.test.ts",
          "test/scripts/plugin-sdk-surface-report.test.ts",
          "test/scripts/build-all.test.ts",
          "test/release-check.test.ts",
          "test/scripts/prepare-extension-package-boundary-artifacts.test.ts",
          "test/scripts/ts-topology.test.ts",
          "test/vitest/vitest.tooling.config.ts",
        ],
      ],
      [
        "scripts/lib/plugin-sdk-entries.mjs",
        [
          "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
          "src/plugins/contracts/plugin-sdk-index.test.ts",
          "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
          "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
          "src/plugins/contracts/extension-package-project-boundaries.test.ts",
          "test/scripts/plugin-sdk-surface-report.test.ts",
          "test/scripts/build-all.test.ts",
          "test/release-check.test.ts",
          "test/scripts/prepare-extension-package-boundary-artifacts.test.ts",
          "test/scripts/ts-topology.test.ts",
          "test/vitest/vitest.tooling.config.ts",
        ],
      ],
      [
        "scripts/lib/plugin-sdk-private-local-only-subpaths.json",
        [
          "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
          "src/plugins/contracts/plugin-sdk-index.test.ts",
          "src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts",
          "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
          "src/plugins/contracts/extension-package-project-boundaries.test.ts",
          "test/scripts/plugin-sdk-surface-report.test.ts",
          "test/scripts/build-all.test.ts",
          "test/release-check.test.ts",
          "test/scripts/prepare-extension-package-boundary-artifacts.test.ts",
          "test/scripts/ts-topology.test.ts",
          "test/vitest/vitest.tooling.config.ts",
        ],
      ],
      [
        "scripts/lib/official-external-channel-catalog.json",
        [
          "src/plugins/official-external-plugin-catalog.test.ts",
          "test/release-check.test.ts",
          "test/official-channel-catalog.test.ts",
        ],
      ],
      [
        "scripts/lib/official-external-plugin-catalog.json",
        ["src/plugins/official-external-plugin-catalog.test.ts", "test/release-check.test.ts"],
      ],
      [
        "scripts/lib/official-external-provider-catalog.json",
        ["src/plugins/official-external-plugin-catalog.test.ts", "test/release-check.test.ts"],
      ],
      [
        "scripts/lib/recommended-tool-installs.json",
        ["src/plugins/recommended-tool-installs.test.ts", "test/release-check.test.ts"],
      ],
      ["scripts/lib/direct-run.mjs", ["test/scripts/changed-lanes.test.ts"]],
      ["scripts/lib/npm-verify-exec.ts", ["test/scripts/npm-verify-exec.test.ts"]],
      [
        "scripts/lib/plugin-npm-runtime-build.mjs",
        [
          "test/scripts/plugin-npm-runtime-build-args.test.ts",
          "test/plugin-npm-runtime-build.test.ts",
        ],
      ],
      [
        "scripts/lib/plugin-npm-package-manifest.mjs",
        [
          "test/scripts/plugin-npm-package-manifest-args.test.ts",
          "test/plugin-npm-package-manifest.test.ts",
        ],
      ],
      ["scripts/lib/arg-utils.mjs", ["test/scripts/arg-utils.test.ts"]],
      [
        "scripts/lib/android-version.ts",
        ["test/scripts/android-version.test.ts", "test/scripts/android-pin-version.test.ts"],
      ],
      ["scripts/lib/ios-version.ts", ["test/scripts/ios-version.test.ts"]],
      [
        ".github/images/live-media-runner/Dockerfile",
        ["test/scripts/package-acceptance-workflow.test.ts"],
      ],
      [
        ".github/actions/detect-docs-changes/action.yml",
        ["test/scripts/ci-workflow-guards.test.ts"],
      ],
      [
        ".github/actions/docker-e2e-plan/action.yml",
        [
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        ".github/actions/ensure-base-commit/action.yml",
        ["test/scripts/ci-workflow-guards.test.ts"],
      ],
      [
        ".github/actions/setup-node-env/action.yml",
        [
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        ".github/actions/setup-node-env/dependency-fingerprint.mjs",
        ["test/scripts/ci-workflow-guards.test.ts"],
      ],
      [
        ".github/actions/setup-pnpm-store-cache/action.yml",
        [
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        ".github/actions/setup-pnpm-store-cache/ensure-node.sh",
        ["test/scripts/setup-pnpm-store-cache-ensure-node.test.ts"],
      ],
      [
        ".github/workflows/live-media-runner-image.yml",
        [
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
        [
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
          "test/scripts/release-workflow-matrix-plan.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ],
      ],
      [
        ".github/workflows/package-acceptance.yml",
        [
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [".github/workflows/workflow-sanity.yml", ["test/scripts/ci-workflow-guards.test.ts"]],
      [
        ".github/workflows/docker-release.yml",
        ["src/dockerfile.test.ts", "test/scripts/ci-workflow-guards.test.ts"],
      ],
      [
        ".github/workflows/full-release-validation.yml",
        [
          "src/dockerfile.test.ts",
          "test/scripts/package-acceptance-workflow.test.ts",
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/ci-workflow-guards.test.ts",
        ],
      ],
      [
        "Dockerfile",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "src/dockerfile.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ],
      ],
      [
        "scripts/docker/cleanup-smoke/Dockerfile",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "test/scripts/docker-build-helper.test.ts",
        ],
      ],
      ["scripts/docker/cleanup-smoke/run.sh", ["test/scripts/docker-build-helper.test.ts"]],
      [
        "scripts/docker/install-sh-e2e/Dockerfile",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ],
      ],
      [
        "scripts/docker/install-sh-e2e/run.sh",
        ["test/scripts/docker-build-helper.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
      ],
      [
        "scripts/docker/install-sh-common/cli-verify.sh",
        ["test/scripts/test-install-sh-docker.test.ts"],
      ],
      [
        "scripts/docker/install-sh-common/version-parse.sh",
        ["test/scripts/test-install-sh-docker.test.ts"],
      ],
      [
        "scripts/docker/install-sh-nonroot/Dockerfile",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ],
      ],
      ["scripts/docker/install-sh-nonroot/run.sh", ["test/scripts/test-install-sh-docker.test.ts"]],
      [
        "scripts/docker/install-sh-smoke/Dockerfile",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ],
      ],
      ["scripts/docker/install-sh-smoke/run.sh", ["test/scripts/test-install-sh-docker.test.ts"]],
      [
        "scripts/docker/sandbox/Dockerfile",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "src/dockerfile.test.ts",
        ],
      ],
      [
        "scripts/docker/sandbox/Dockerfile.browser",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "src/agents/sandbox/browser.create.test.ts",
        ],
      ],
      ["scripts/docker/sandbox/Dockerfile.common", ["src/docker-build-cache.test.ts"]],
      [
        "scripts/e2e/Dockerfile",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
        ],
      ],
      [
        "scripts/e2e/Dockerfile.qr-import",
        [
          "src/docker-build-cache.test.ts",
          "src/docker-image-digests.test.ts",
          "test/scripts/docker-build-helper.test.ts",
        ],
      ],
      [
        "scripts/e2e/plugin-binding-command-escape.Dockerfile",
        [
          "src/docker-image-digests.test.ts",
          "test/scripts/docker-build-helper.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
        ],
      ],
      [
        "scripts/lib/package-dist-imports.mjs",
        [
          "test/scripts/check-package-dist-imports.test.ts",
          "test/scripts/check-openclaw-package-tarball.test.ts",
          "test/scripts/postinstall-bundled-plugins.test.ts",
          "test/release-check.test.ts",
        ],
      ],
      [
        "scripts/lib/build-metadata.sh",
        [
          "src/docker-setup.e2e.test.ts",
          "test/scripts/apple-release-source-check.test.ts",
          "test/scripts/ios-version.test.ts",
          "test/scripts/package-mac-app.test.ts",
          "test/scripts/test-install-sh-docker.test.ts",
        ],
      ],
      [
        "scripts/lib/plistbuddy.sh",
        [
          "test/scripts/create-dmg.test.ts",
          "test/scripts/package-mac-app.test.ts",
          "test/scripts/package-mac-dist.test.ts",
        ],
      ],
      [
        "scripts/lib/swift-toolchain.sh",
        ["test/scripts/package-mac-app.test.ts", "test/scripts/package-mac-dist.test.ts"],
      ],
      [
        "scripts/lib/npm-publish-plan.mjs",
        [
          "test/npm-publish-plan.test.ts",
          "test/openclaw-npm-release-check.test.ts",
          "test/openclaw-npm-postpublish-verify.test.ts",
          "test/plugin-npm-release.test.ts",
          "test/plugin-clawhub-release.test.ts",
          "test/scripts/release-upgrade-baseline.test.ts",
          "test/scripts/android-version.test.ts",
          "test/scripts/ios-version.test.ts",
          "test/scripts/upgrade-survivor-baselines.test.ts",
          "test/scripts/upgrade-survivor-config-recipe.test.ts",
        ],
      ],
      [
        "scripts/lib/npm-pack-budget.mjs",
        ["test/release-check.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
      ],
      [
        "scripts/lib/npm-pack-budget.d.mts",
        ["test/release-check.test.ts", "test/scripts/test-install-sh-docker.test.ts"],
      ],
      [
        "scripts/lib/workspace-bootstrap-smoke.mjs",
        ["test/release-check.test.ts", "test/openclaw-npm-release-check.test.ts"],
      ],
      [
        "scripts/openclaw-release-clawhub-runtime-state.ts",
        ["test/scripts/openclaw-release-clawhub-runtime-state.test.ts"],
      ],
      [
        "scripts/openclaw-release-clawhub-plan.ts",
        ["test/scripts/release-wrapper-scripts.test.ts"],
      ],
      ["scripts/lib/openclaw-release-clawhub-plan.ts", ["test/plugin-clawhub-release.test.ts"]],
      [
        "scripts/lib/plugin-clawhub-release.ts",
        ["test/plugin-clawhub-release.test.ts", "test/plugin-npm-release.test.ts"],
      ],
      [
        "scripts/lib/plugin-npm-release.ts",
        ["test/plugin-npm-release.test.ts", "test/plugin-clawhub-release.test.ts"],
      ],
      ["scripts/plugin-clawhub-release-check.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
      ["scripts/plugin-clawhub-release-plan.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
      ["scripts/plugin-npm-release-check.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
      ["scripts/plugin-npm-release-plan.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
      [
        "scripts/plugin-release-pretag-pack-check.ts",
        ["test/scripts/plugin-release-pretag-pack-check.test.ts"],
      ],
      [
        "scripts/plan-release-workflow-matrix.mjs",
        ["test/scripts/release-workflow-matrix-plan.test.ts"],
      ],
      ["scripts/release-verify-beta.ts", ["test/scripts/release-wrapper-scripts.test.ts"]],
      [
        "scripts/validate-release-publish-approval.mjs",
        ["test/scripts/validate-release-publish-approval.test.ts"],
      ],
      [
        "scripts/lib/plugin-package-dependencies.mjs",
        ["test/scripts/plugin-package-dependencies.test.ts"],
      ],
      [
        "scripts/lib/plugin-npm-runtime-assets.mjs",
        ["test/scripts/plugin-npm-runtime-build-args.test.ts"],
      ],
      [
        "scripts/lib/generated-text-asset.mjs",
        [
          "extensions/browser/scripts/build-copilot-runtime.test.ts",
          "test/scripts/build-diffs-viewer-runtime.test.ts",
          "test/scripts/bundled-plugin-assets.test.ts",
        ],
      ],
      [
        "scripts/lib/static-extension-assets.mjs",
        [
          "test/scripts/bundled-plugin-assets.test.ts",
          "test/scripts/runtime-postbuild.test.ts",
          "src/infra/run-node.test.ts",
          "test/scripts/plugin-npm-runtime-build-args.test.ts",
        ],
      ],
      ["scripts/lib/test-group-report.mjs", ["test/scripts/test-group-report.test.ts"]],
      ["scripts/lib/stable-release-closeout.mjs", ["test/stable-release-closeout.test.ts"]],
      [
        "scripts/lib/extension-source-classifier.mjs",
        [
          "test/scripts/extension-source-classifier.test.ts",
          "src/channels/plugins/contracts/channel-import-guardrails.test.ts",
        ],
      ],
      ["scripts/lib/ts-topology/analyze.ts", ["test/scripts/ts-topology.test.ts"]],
      ["scripts/lib/ts-topology/reports.ts", ["test/scripts/ts-topology.test.ts"]],
      ["scripts/lib/ts-topology/scope.ts", ["test/scripts/ts-topology.test.ts"]],
      ["scripts/lib/ts-guard-utils.mjs", ["test/scripts/ts-guard-utils.test.ts"]],
      [
        "scripts/lib/tsgo-sparse-guard.mjs",
        ["test/scripts/run-tsgo.test.ts", "test/scripts/changed-lanes.test.ts"],
      ],
      ["scripts/write-package-dist-inventory.ts", ["test/scripts/test-install-sh-docker.test.ts"]],
      ["scripts/lib/format-generated-module.mjs", ["test/scripts/format-generated-module.test.ts"]],
      [
        "scripts/lib/bundled-plugin-source-utils.mjs",
        ["test/scripts/bundled-plugin-source-utils.test.ts"],
      ],
      [
        "scripts/lib/bundled-runtime-sidecar-paths.json",
        [
          "src/plugins/bundled-plugin-metadata.test.ts",
          "src/infra/update-global.test.ts",
          "src/infra/update-runner.test.ts",
          "test/openclaw-npm-postpublish-verify.test.ts",
        ],
      ],
      [
        "scripts/lib/bundled-plugin-build-entries.mjs",
        ["test/scripts/bundled-plugin-build-entries.test.ts", "test/release-check.test.ts"],
      ],
      ["scripts/lib/changed-extensions.mjs", ["test/scripts/test-extension.test.ts"]],
      ["scripts/lib/extension-vitest-paths.mjs", ["test/scripts/test-extension.test.ts"]],
    ]);

    for (const [source, targets] of expectedTargets) {
      expect(resolveChangedTestTargetPlan([source]), source).toEqual({
        mode: "targets",
        targets,
      });
    }
  });

  it("keeps plugin SDK boundary tooling edits on owner tests", () => {
    const expectedTargets = new Map([
      [
        "scripts/check-extension-plugin-sdk-boundary.mjs",
        ["test/extension-import-boundaries.test.ts"],
      ],
      [
        "scripts/check-sdk-package-extension-import-boundary.mjs",
        ["test/extension-import-boundaries.test.ts"],
      ],
      [
        "scripts/check-plugin-extension-import-boundary.mjs",
        ["test/plugin-extension-import-boundary.test.ts"],
      ],
      [
        "scripts/lib/config-boundary-guard.mjs",
        [
          "src/plugins/contracts/config-boundary-guard.test.ts",
          "src/plugins/contracts/deprecated-internal-config-api.test.ts",
        ],
      ],
      [
        "scripts/lib/deprecated-config-api-guard.mjs",
        ["src/plugins/contracts/deprecated-internal-config-api.test.ts"],
      ],
      [
        "scripts/lib/extension-package-boundary.ts",
        ["src/plugins/contracts/extension-package-project-boundaries.test.ts"],
      ],
      [
        "scripts/check-src-extension-import-boundary.mjs",
        ["test/extension-import-boundaries.test.ts"],
      ],
      [
        "scripts/lib/guard-inventory-utils.mjs",
        [
          "test/extension-import-boundaries.test.ts",
          "test/plugin-extension-import-boundary.test.ts",
          "test/architecture-smells.test.ts",
          "test/web-provider-boundary.test.ts",
          "test/test-helper-extension-import-boundary.test.ts",
          "test/scripts/extension-import-boundary-checker.test.ts",
          "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
        ],
      ],
      [
        "scripts/check-test-helper-extension-import-boundary.mjs",
        ["test/test-helper-extension-import-boundary.test.ts"],
      ],
      [
        "scripts/write-plugin-sdk-entry-dts.ts",
        [
          "test/scripts/build-all.test.ts",
          "test/scripts/prepare-extension-package-boundary-artifacts.test.ts",
        ],
      ],
      ["scripts/fixtures/packed-plugin-sdk-type-smoke.ts", ["test/release-check.test.ts"]],
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

  it("routes gateway package targets through the gateway-client lane", () => {
    expect(
      buildVitestRunPlans([
        "packages/gateway-client/src/timeouts.test.ts",
        "packages/gateway-protocol/src/frame-guards.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.gateway-client.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "packages/gateway-client/src/timeouts.test.ts",
          "packages/gateway-protocol/src/frame-guards.test.ts",
        ],
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

  it("routes the bundled provider auth parity test to the isolated tooling shard", () => {
    expect(
      buildVitestRunPlans(["test/plugins/bundled-provider-auth-literal-parity.test.ts"]),
    ).toEqual([
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/plugins/bundled-provider-auth-literal-parity.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it.each([
    "test/scripts/check-extension-package-tsc-boundary.test.ts",
    "test/scripts/control-ui-i18n.test.ts",
  ])("routes process-group test %s to the isolated tooling shard", (testFile) => {
    expect(buildVitestRunPlans([testFile])).toEqual([
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: [testFile],
        watchMode: false,
      },
    ]);
  });

  it.each(agentsCoreIsolatedTestFiles)(
    "routes isolated agent test %s to the isolated agents-core shard",
    (testFile) => {
      expect(buildVitestRunPlans([testFile])).toEqual([
        {
          config: "test/vitest/vitest.agents-core-isolated.config.ts",
          forwardedArgs: [],
          includePatterns: [testFile],
          watchMode: false,
        },
      ]);
    },
  );

  it("routes Docker E2E script targets to their owner tooling tests", () => {
    const targets = [
      "scripts/e2e/kitchen-sink-plugin-docker.sh",
      "scripts/e2e/kitchen-sink-rpc-docker.sh",
      "scripts/e2e/kitchen-sink-rpc-walk.mjs",
      "scripts/e2e/onboard-docker.sh",
      "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs",
      "scripts/e2e/plugin-lifecycle-matrix-docker.sh",
      "scripts/e2e/release-media-memory-docker.sh",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(buildVitestRunPlans(targets, process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling-docker.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/docker-build-helper.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/plugin-prerelease-test-plan.test.ts",
          "test/scripts/kitchen-sink-rpc-walk.test.ts",
          "test/scripts/openclaw-test-state.test.ts",
          "test/scripts/plugin-lifecycle-measure.test.ts",
          "test/scripts/docker-e2e-plan.test.ts",
          "test/scripts/release-media-memory-scenario.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("routes changed Parallels process helpers to their owner tooling tests", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "scripts/e2e/parallels/filesystem.ts",
        "scripts/e2e/parallels/guest-transports.ts",
        "scripts/e2e/parallels/host-command.ts",
        "scripts/e2e/parallels/host-server.ts",
        "scripts/e2e/parallels/linux-smoke.ts",
        "scripts/e2e/parallels/phase-runner.ts",
        "scripts/e2e/parallels/macos-smoke.ts",
        "scripts/e2e/parallels-macos-smoke.sh",
        "scripts/e2e/parallels-linux-smoke.sh",
        "scripts/e2e/parallels-npm-update-smoke.sh",
        "scripts/e2e/parallels/npm-update-smoke.ts",
        "scripts/e2e/parallels/npm-update-scripts.ts",
        "scripts/e2e/parallels/smoke-common.ts",
        "scripts/e2e/parallels/update-job-timeout.ts",
        "scripts/e2e/parallels/windows-smoke.ts",
        "scripts/e2e/parallels-windows-smoke.sh",
        "scripts/e2e/lib/parallels-package/build-info-commit.mjs",
        "scripts/e2e/lib/parallels-macos-common.sh",
        "scripts/e2e/lib/parallels-package-common.sh",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/parallels-smoke-model.test.ts",
          "test/scripts/parallels-npm-update-smoke.test.ts",
          "test/scripts/parallels-update-job-timeout.test.ts",
          "test/scripts/parallels-lib-helpers.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("routes mac restart helpers through restart-mac owner tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/lib/restart-mac-gateway.sh"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/restart-mac.test.ts"],
    });
  });

  it("routes Parallels common shell helpers through lib helper owner tests", () => {
    for (const changedPath of [
      "scripts/e2e/lib/parallels-macos-common.sh",
      "scripts/e2e/lib/parallels-package-common.sh",
    ]) {
      expect(resolveChangedTestTargetPlan([changedPath]), changedPath).toEqual({
        mode: "targets",
        targets: ["test/scripts/parallels-lib-helpers.test.ts"],
      });
    }
  });

  it("routes MCP and cron Docker E2E script targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/mcp-channels-docker.sh",
      "test/e2e/qa-lab/runtime/mcp-channels-docker-client.ts",
      "test/e2e/qa-lab/runtime/mcp-channels.fixture.ts",
      "test/e2e/qa-lab/runtime/mcp-client-temp-state.fixture.ts",
      "scripts/e2e/mcp-channels-seed.ts",
      "scripts/e2e/docker-openai-seed.ts",
      "scripts/e2e/mcp-code-mode-gateway-docker.sh",
      "scripts/e2e/mcp-code-mode-gateway-live-docker.sh",
      "scripts/e2e/mcp-code-mode-gateway-seed.ts",
      "scripts/e2e/agent-bundle-mcp-tools-docker.sh",
      "test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts",
      "scripts/mcp-code-mode-gateway-e2e.ts",
      "scripts/e2e/cron-cli-docker.sh",
      "scripts/e2e/cron-mcp-cleanup-docker.sh",
      "scripts/e2e/cron-mcp-cleanup-docker-client.ts",
      "scripts/e2e/cron-mcp-cleanup-seed.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(resolveChangedTestTargetPlan(targets)).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-observability.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/plugin-prerelease-test-plan.test.ts",
        "test/e2e/qa-lab/runtime/mcp-gateway-transport.e2e.test.ts",
        "test/scripts/cron-mcp-cleanup-docker-client.test.ts",
        "test/scripts/docker-e2e-seeds.test.ts",
        "test/scripts/mcp-code-mode-gateway-client.test.ts",
        "test/scripts/session-log-mentions.test.ts",
        "src/agents/agent-bundle-mcp-runtime.test.ts",
        "src/agents/agent-bundle-mcp-tools.materialize.test.ts",
        "src/gateway/server.cron.test.ts",
        "src/gateway/server-methods/agent.test.ts",
        "src/cron/isolated-agent/run.fast-mode.test.ts",
        "src/cron/active-jobs-manual-run.test.ts",
      ],
    });
  });

  it("routes OpenAI image auth Docker E2E script targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/openai-image-auth-docker.sh",
      "test/e2e/qa-lab/runtime/openai-image-auth-docker-client.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(resolveChangedTestTargetPlan(targets)).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/openai-image-auth-docker-client.test.ts",
        "extensions/openai/image-generation-provider.test.ts",
        "src/image-generation/openai-compatible-image-provider.test.ts",
      ],
    });
  });

  it("routes package-backed Docker shell targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/codex-media-path-docker.sh",
      "scripts/e2e/codex-npm-plugin-live-docker.sh",
      "scripts/e2e/codex-on-demand-docker.sh",
      "scripts/e2e/live-plugin-tool-docker.sh",
      "scripts/e2e/plugin-binding-command-escape-docker.sh",
      "scripts/e2e/qr-import-docker.sh",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(resolveChangedTestTargetPlan(targets)).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/codex-media-path-client.test.ts",
        "test/scripts/package-acceptance-workflow.test.ts",
        "test/scripts/live-plugin-tool-assertions.test.ts",
      ],
    });
  });

  it("routes OpenClaw Docker E2E script targets instead of skipping changed tests", () => {
    const targets = [
      "scripts/e2e/system-agent-first-run-docker.sh",
      "test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts",
      "scripts/e2e/system-agent-first-run-spec.json",
      "scripts/e2e/system-agent-rescue-docker.sh",
      "scripts/e2e/system-agent-rescue-docker-client.ts",
    ];

    expect(findUnmatchedExplicitTestTargets(targets)).toEqual([]);
    expect(resolveChangedTestTargetPlan(targets)).toEqual({
      mode: "targets",
      targets: [
        "test/scripts/docker-build-helper.test.ts",
        "test/scripts/docker-e2e-plan.test.ts",
        "test/scripts/docker-e2e-system-agent.test.ts",
        "src/cli/program/register.onboard.test.ts",
        "src/cli/run-main.test.ts",
        "src/cli/run-main.exit.test.ts",
        "src/commands/system-agent-with-inference.test.ts",
        "src/system-agent/assistant.configured.test.ts",
        "src/system-agent/assistant.test.ts",
        "src/system-agent/system-agent.test.ts",
        "src/system-agent/operations.test.ts",
        "src/system-agent/overview.test.ts",
        "src/system-agent/setup-inference.test.ts",
        "src/system-agent/audit.test.ts",
        "src/system-agent/rescue-policy.test.ts",
        "src/system-agent/rescue-message.test.ts",
      ],
    });
  });

  it("chunks the broad shell helper tooling shard after isolated targets", () => {
    const plans = buildVitestRunPlans(["test/scripts"], process.cwd());
    expect(plans.slice(0, 4)).toEqual([
      expect.objectContaining({
        config: "test/vitest/vitest.unit-fast.config.ts",
        includePatterns: expect.arrayContaining(["test/scripts/arg-utils.test.ts"]),
        watchMode: false,
      }),
      {
        config: "test/vitest/vitest.unit-fast-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/android-version.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling-docker.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/docker-build-helper.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/check-extension-package-tsc-boundary.test.ts",
          "test/scripts/control-ui-i18n.test.ts",
          "test/scripts/openclaw-e2e-instance.test.ts",
        ],
        watchMode: false,
      },
    ]);
    const e2ePlans = plans.filter((plan) => plan.config === "test/vitest/vitest.e2e.config.ts");
    const toolingPlans = plans
      .slice(4)
      .filter((plan) => plan.config === "test/vitest/vitest.tooling.config.ts");
    const toolingTargets = toolingPlans.flatMap((plan) => plan.includePatterns ?? []);

    expect(toolingPlans.length).toBeGreaterThan(1);
    expect(toolingPlans.every((plan) => (plan.includePatterns?.length ?? 0) <= 60)).toBe(true);
    expect(toolingTargets).toContain("test/scripts/run-opengrep.test.ts");
    expect(toolingTargets).not.toContain("test/scripts/docker-build-helper.test.ts");
    expect(toolingTargets).not.toContain("test/scripts/openclaw-e2e-instance.test.ts");
    expect(new Set(toolingTargets).size).toBe(toolingTargets.length);
    expect(e2ePlans).toEqual([
      {
        config: "test/vitest/vitest.e2e.config.ts",
        forwardedArgs: [
          "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
          "test/scripts/sqlite-sessions-transcripts-flip-proof.e2e.test.ts",
        ],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes the src scripts test root to the tooling shard", () => {
    expect(findUnmatchedExplicitTestTargets(["src/scripts"], process.cwd())).toEqual([]);
    expect(buildVitestRunPlans(["src/scripts"], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/scripts/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes exact source directory roots to their owning shards", () => {
    const cases = [
      ["src/acp", "test/vitest/vitest.acp.config.ts"],
      ["src/agents", "test/vitest/vitest.agents.config.ts"],
      ["src/auto-reply", "test/vitest/vitest.auto-reply.config.ts"],
      ["src/channels", "test/vitest/vitest.channels.config.ts"],
      ["src/cli", "test/vitest/vitest.cli.config.ts"],
      ["src/config", "test/vitest/vitest.runtime-config.config.ts"],
      ["src/cron", "test/vitest/vitest.cron.config.ts"],
      ["src/daemon", "test/vitest/vitest.daemon.config.ts"],
      ["src/gateway", "test/vitest/vitest.gateway.config.ts"],
      ["src/hooks", "test/vitest/vitest.hooks.config.ts"],
      ["src/infra", "test/vitest/vitest.infra.config.ts"],
      ["src/logging", "test/vitest/vitest.logging.config.ts"],
      ["src/media", "test/vitest/vitest.media.config.ts"],
      ["src/media-understanding", "test/vitest/vitest.media-understanding.config.ts"],
      ["src/plugin-sdk", "test/vitest/vitest.plugin-sdk.config.ts"],
      ["src/plugins", "test/vitest/vitest.plugins.config.ts"],
      ["src/process", "test/vitest/vitest.process.config.ts"],
      ["src/secrets", "test/vitest/vitest.secrets.config.ts"],
      ["src/shared", "test/vitest/vitest.shared-core.config.ts"],
      ["src/tasks", "test/vitest/vitest.tasks.config.ts"],
      ["src/tui", "test/vitest/vitest.tui.config.ts"],
      ["src/utils", "test/vitest/vitest.utils.config.ts"],
      ["src/wizard", "test/vitest/vitest.wizard.config.ts"],
      ["ui/src", "test/vitest/vitest.ui.config.ts"],
    ] as const;

    const plansByConfig = new Map(
      buildVitestRunPlans(
        cases.map(([target]) => target),
        process.cwd(),
      ).map((plan) => [plan.config, plan]),
    );
    for (const [target, config] of cases) {
      const plan = plansByConfig.get(config);
      expect(plan).toMatchObject({
        config,
        forwardedArgs: [],
        watchMode: false,
      });
      expect(plan?.includePatterns?.filter((pattern) => pattern.endsWith("/**/*.test.ts"))).toEqual(
        [`${target}/**/*.test.ts`],
      );
    }

    expect(buildVitestRunPlans(["src/plugin-sdk"], process.cwd())).toEqual([
      expect.objectContaining({
        config: "test/vitest/vitest.unit-fast.config.ts",
        includePatterns: expect.arrayContaining(["src/plugin-sdk/access-groups.test.ts"]),
      }),
      expect.objectContaining({
        config: "test/vitest/vitest.unit-fast-fake-timers.config.ts",
        includePatterns: ["src/plugin-sdk/memory-host-events.test.ts"],
      }),
      expect.objectContaining({
        config: "test/vitest/vitest.plugin-sdk-light.config.ts",
        includePatterns: expect.arrayContaining(["src/plugin-sdk/acp-runtime.test.ts"]),
      }),
      {
        config: "test/vitest/vitest.plugin-sdk.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/**/*.test.ts"],
        watchMode: false,
      },
    ]);
    expect(buildVitestRunPlans(["src/shared"], process.cwd()).map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.shared-core.config.ts",
    ]);
    expect(buildVitestRunPlans(["src/utils"], process.cwd()).map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.utils.config.ts",
    ]);
    expect(buildVitestRunPlans(["src/commands"], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("chunks broad shell helper globs after isolated targets", () => {
    const plans = buildVitestRunPlans(["test/scripts/*.test.ts"], process.cwd());
    expect(plans.slice(0, 4)).toEqual([
      expect.objectContaining({
        config: "test/vitest/vitest.unit-fast.config.ts",
        includePatterns: expect.arrayContaining(["test/scripts/arg-utils.test.ts"]),
        watchMode: false,
      }),
      {
        config: "test/vitest/vitest.unit-fast-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/android-version.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling-docker.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/docker-build-helper.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "test/scripts/check-extension-package-tsc-boundary.test.ts",
          "test/scripts/control-ui-i18n.test.ts",
          "test/scripts/openclaw-e2e-instance.test.ts",
        ],
        watchMode: false,
      },
    ]);
    const e2ePlans = plans.filter((plan) => plan.config === "test/vitest/vitest.e2e.config.ts");
    const toolingPlans = plans
      .slice(4)
      .filter((plan) => plan.config === "test/vitest/vitest.tooling.config.ts");
    const toolingTargets = toolingPlans.flatMap((plan) => plan.includePatterns ?? []);

    expect(toolingPlans.length).toBeGreaterThan(1);
    expect(toolingPlans.every((plan) => (plan.includePatterns?.length ?? 0) <= 60)).toBe(true);
    expect(toolingTargets).toContain("test/scripts/run-opengrep.test.ts");
    expect(toolingTargets).not.toContain("test/scripts/docker-build-helper.test.ts");
    expect(toolingTargets).not.toContain("test/scripts/openclaw-e2e-instance.test.ts");
    expect(new Set(toolingTargets).size).toBe(toolingTargets.length);
    expect(e2ePlans).toEqual([
      {
        config: "test/vitest/vitest.e2e.config.ts",
        forwardedArgs: [
          "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
          "test/scripts/sqlite-sessions-transcripts-flip-proof.e2e.test.ts",
        ],
        includePatterns: null,
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

  it("fans contract directory targets out to the owning contract lanes", () => {
    // Regression: the generic channels project excludes contracts/**, so the
    // directory target used to run zero tests and exit green.
    const plans = buildVitestRunPlans(["src/channels/plugins/contracts"]);

    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
    ]);
    expect(plans.every((plan) => plan.includePatterns === null)).toBe(true);
  });

  it("routes the plugin contracts directory to the plugin contracts lane", () => {
    const plans = buildVitestRunPlans(["src/plugins/contracts"]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.contracts-plugin.config.ts",
        forwardedArgs: [],
        includePatterns: null,
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
    let args: string[] | null = null;
    withTinyGitRepo(
      {
        "test/helpers/unmapped-helper.ts": "export const unmapped = true;\n",
      },
      (cwd) => {
        args = resolveChangedTargetArgs(["--changed", "origin/main"], cwd, () => [
          "test/helpers/unmapped-helper.ts",
        ]);
      },
    );

    expect(args).toStrictEqual([]);
  });

  it("routes imported shared test helpers through affected tests", () => {
    let targets: string[] = [];
    withTinyGitRepo(
      {
        "test/helpers/temp-dir.ts": "export const tempDir = 'x';\n",
        "test/helpers/temp-dir.test.ts":
          "import { tempDir } from './temp-dir.js';\nvoid tempDir;\n",
        "test/scripts/bench-cli-startup.test.ts":
          "import { tempDir } from '../helpers/temp-dir.js';\nvoid tempDir;\n",
        "src/foo.test.ts":
          "import { tempDir } from '../test/helpers/temp-dir.js';\nvoid tempDir;\n",
      },
      (cwd) => {
        targets = resolveChangedTestTargetPlan(["test/helpers/temp-dir.ts"], { cwd }).targets;
      },
    );

    expect(targets).toEqual([
      "test/helpers/temp-dir.test.ts",
      "src/foo.test.ts",
      "test/scripts/bench-cli-startup.test.ts",
    ]);
  });

  it("keeps the broad changed run available for shared test helpers", () => {
    let args: string[] | null = [];
    withTinyGitRepo(
      {
        "test/helpers/unmapped-helper.ts": "export const unmapped = true;\n",
      },
      (cwd) => {
        args = resolveChangedTargetArgs(
          ["--changed", "origin/main"],
          cwd,
          () => ["test/helpers/unmapped-helper.ts"],
          { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
        );
      },
    );

    expect(args).toBeNull();
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

  it("keeps unknown root surface skip reasons available to changed-mode callers", () => {
    expect(
      resolveChangedTestTargetPlanForArgs(["--changed", "origin/main"], process.cwd(), () => [
        "unknown/file.txt",
      ]),
    ).toEqual({
      mode: "targets",
      skippedBroadFallbackPaths: ["unknown/file.txt"],
      targets: [],
    });
  });

  it("explains changed paths that need explicit broad fallback before skipping", () => {
    expect(formatNoChangedTestTargetLines(["unknown-root-surface.txt"])).toEqual([
      "[test] no precise changed test targets; skipping Vitest.",
      "[test] 1 changed path require broad Vitest fallback:",
      "[test]   unknown-root-surface.txt",
      "[test] run `OPENCLAW_TEST_CHANGED_BROAD=1 pnpm test:changed` for broad coverage.",
    ]);
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

  it("can combine sibling and import-graph targets for CI", () => {
    withTinyGitRepo(
      {
        "src/consumer.test.ts": 'import "./value.js";\n',
        "src/value.test.ts": 'import "./value.js";\n',
        "src/value.ts": "export const value = 1;\n",
      },
      (cwd) => {
        expect(
          resolveChangedTestTargetPlan(["src/value.ts"], {
            combineSiblingWithImportGraph: true,
            cwd,
            forceFullImportGraph: true,
          }),
        ).toEqual({
          mode: "targets",
          targets: ["src/value.test.ts", "src/consumer.test.ts"],
        });
      },
    );
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
        includePatterns: ["ui/src/app/control-ui-chunking.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps explicit non-renderer ui test targets scoped", () => {
    expect(
      buildVitestRunPlans([
        "ui/src/i18n/test/translate.test.ts",
        "test/scripts/control-ui-i18n.test.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.tooling-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/control-ui-i18n.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/i18n/test/translate.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes control ui e2e tests to the ui e2e lane", () => {
    expect(buildVitestRunPlans(["ui/src/e2e/chat-flow.e2e.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.ui-e2e.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/e2e/chat-flow.e2e.test.ts"],
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

    expect(buildVitestRunPlans(["ui/src/e2e"])).toEqual([
      {
        config: "test/vitest/vitest.ui-e2e.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/e2e/**/*.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestArgs(["ui/src/e2e"])).toContain("--configLoader");
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
        "packages/memory-host-sdk/src/host/embedding-defaults.ts",
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

  it("uses collision-resistant include-file names for scoped Vitest specs", () => {
    const tempDir = path.join("tmp", "openclaw-vitest-specs");
    const [spec] = createVitestRunSpecs(["src/plugin-sdk/temp-path.test.ts"], {
      baseEnv: {},
      tempDir,
    });

    expect(path.dirname(spec?.includeFilePath ?? "")).toBe(tempDir);
    expect(path.basename(spec?.includeFilePath ?? "")).toMatch(
      /^openclaw-vitest-include-[0-9a-f-]{36}-0\.json$/u,
    );
    expect(spec?.includeFilePath).not.toMatch(new RegExp(`${process.pid}-\\d+-0\\.json$`, "u"));
  });

  it("expands routed glob targets to literal include-file paths", () => {
    withTinyGitRepo(
      {
        "src/gateway/core.test.ts": "",
        "src/gateway/server-methods/ping.test.ts": "",
        "src/gateway/server-startup.test.ts": "",
      },
      (cwd) => {
        const includeFile = path.join(cwd, "include.json");
        writeVitestIncludeFile(
          includeFile,
          [
            "src/gateway/**/*.test.ts",
            "src/gateway/server-*.test.ts",
            "src/gateway/@(core|server-startup).test.ts",
          ],
          { cwd },
        );

        expect(JSON.parse(fs.readFileSync(includeFile, "utf8"))).toEqual([
          "src/gateway/core.test.ts",
          "src/gateway/server-methods/ping.test.ts",
          "src/gateway/server-startup.test.ts",
        ]);
      },
    );
  });

  it("retains routed glob targets in watch-mode include files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-projects-watch-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      writeVitestIncludeFile(includeFile, ["src/gateway/**/*.test.ts"], {
        expandGlobs: false,
      });

      expect(JSON.parse(fs.readFileSync(includeFile, "utf8"))).toEqual([
        "src/gateway/**/*.test.ts",
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preflights targeted UI E2E specs with Playwright browser assets", () => {
    const [spec] = createVitestRunSpecs(["ui/src/pages/tasks/tasks.e2e.test.ts"], {
      baseEnv: {},
    });

    expect(spec?.config).toBe("test/vitest/vitest.ui-e2e.config.ts");
    expect(spec?.preflightPnpmArgs).toEqual([
      "exec",
      "node",
      "scripts/ensure-playwright-chromium.mjs",
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

  it("routes the full commands test root to both command shards", () => {
    expect(findUnmatchedExplicitTestTargets(["src/commands"])).toEqual([]);
    expect(buildVitestRunPlans(["src/commands"], process.cwd())).toEqual([
      {
        config: "test/vitest/vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: null,
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

  it("routes forced stateful unit-fast tests to the isolated lane", () => {
    const plans = buildVitestRunPlans(
      ["src/system-agent/assistant.configured.test.ts"],
      process.cwd(),
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/system-agent/assistant.configured.test.ts"],
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
      skippedBroadFallbackPaths: ["package.json"],
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
      skippedBroadFallbackPaths: ["src/gateway/server.impl.ts"],
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

  it("routes prompt snapshot generator helper edits to the owner test", () => {
    for (const target of [
      "scripts/generate-prompt-snapshots.ts",
      "scripts/prompt-snapshot-files.ts",
      "scripts/sync-codex-model-prompt-fixture.ts",
      "test/helpers/agents/happy-path-prompt-snapshots.ts",
      "test/fixtures/agents/prompt-snapshots/codex-model-catalog/gpt-5.5.pragmatic.source.json",
      "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/telegram-direct-codex-message-tool.md",
    ]) {
      expect(resolveChangedTestTargetPlan([target])).toEqual({
        mode: "targets",
        targets: ["test/scripts/prompt-snapshots.test.ts"],
      });
    }
  });

  it("routes runtime sidecar baseline edits to baseline owner tests", () => {
    for (const target of [
      "scripts/generate-runtime-sidecar-paths-baseline.ts",
      "src/plugins/runtime-sidecar-paths-baseline.ts",
    ]) {
      expect(resolveChangedTestTargetPlan([target])).toEqual({
        mode: "targets",
        targets: ["src/plugins/bundled-plugin-metadata.test.ts"],
      });
    }

    for (const target of [
      "scripts/lib/bundled-runtime-sidecar-paths.json",
      "src/plugins/runtime-sidecar-paths.ts",
    ]) {
      expect(resolveChangedTestTargetPlan([target])).toEqual({
        mode: "targets",
        targets: [
          "src/plugins/bundled-plugin-metadata.test.ts",
          "src/infra/update-global.test.ts",
          "src/infra/update-runner.test.ts",
          "test/openclaw-npm-postpublish-verify.test.ts",
        ],
      });
    }
  });

  it("routes appcast edits to appcast owner tests", () => {
    expect(resolveChangedTestTargetPlan(["appcast.xml"])).toEqual({
      mode: "targets",
      targets: ["test/appcast.test.ts", "test/scripts/make-appcast.test.ts"],
    });
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

  it("uses the global host worker budget for roomy local hosts", () => {
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
    ).toBe(6);
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

  it("rejects malformed parallel full-suite overrides", () => {
    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_PROJECTS_PARALLEL: "3x",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_TEST_PROJECTS_PARALLEL must be a positive integer; got: 3x");

    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_PROJECTS_PARALLEL: "0",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_TEST_PROJECTS_PARALLEL must be a positive integer; got: 0");
  });

  it("rejects malformed conservative worker budget values", () => {
    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_VITEST_MAX_WORKERS: "1e0",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_VITEST_MAX_WORKERS must be a positive integer; got: 1e0");

    expect(() =>
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_WORKERS: "1 worker",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toThrow("OPENCLAW_TEST_WORKERS must be a positive integer; got: 1 worker");
  });

  it("keeps serial untargeted local runs on leaf project configs", () => {
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const previousSerial = process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    const previousCi = process.env.CI;
    const previousActions = process.env.GITHUB_ACTIONS;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    delete process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    process.env.OPENCLAW_TEST_PROJECTS_SERIAL = "1";
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.gateway-server.config.ts");
      expect(configs).toContain("test/vitest/vitest.auto-reply-reply.config.ts");
      expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
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

  it("expands conservative local worker runs to leaf project configs", () => {
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
    process.env.OPENCLAW_VITEST_MAX_WORKERS = "1";
    delete process.env.OPENCLAW_TEST_WORKERS;
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.gateway-server.config.ts");
      expect(configs).toContain("test/vitest/vitest.auto-reply-reply.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
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
    const previousCi = process.env.CI;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    process.env.OPENCLAW_TEST_PROJECTS_SERIAL = "1";
    process.env.CI = "true";
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
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }
  });

  it("can expand full-suite shards to project configs for perf experiments", () => {
    const gatewayServerConfig = "test/vitest/vitest.gateway-server.config.ts";
    const agentsCoreConfig = "test/vitest/vitest.agents-core.config.ts";
    const toolingConfig = "test/vitest/vitest.tooling.config.ts";
    const unitFastConfig = "test/vitest/vitest.unit-fast.config.ts";
    const plans = leafShardPlans;
    const agentsCorePlans = plans.filter((plan) => plan.config === agentsCoreConfig);
    const toolingPlans = plans.filter((plan) => plan.config === toolingConfig);
    const unitFastPlans = plans.filter((plan) => plan.config === unitFastConfig);

    if (leafShardHasGitGatewayListing) {
      expect(leafShardGatewayTreeReads).toEqual([]);
    }
    expect(leafShardPlans.map((plan) => plan.config)).toEqual([
      ...unitFastPlans.map(() => unitFastConfig),
      "test/vitest/vitest.unit-fast-isolated.config.ts",
      "test/vitest/vitest.unit-fast-fake-timers.config.ts",
      "test/vitest/vitest.unit-src.config.ts",
      "test/vitest/vitest.unit-security.config.ts",
      "test/vitest/vitest.unit-support.config.ts",
      "test/vitest/vitest.boundary.config.ts",
      ...toolingPlans.map(() => toolingConfig),
      "test/vitest/vitest.tooling-docker.config.ts",
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
      "test/vitest/vitest.agents-core-isolated.config.ts",
      ...agentsCorePlans.map(() => agentsCoreConfig),
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
      "test/vitest/vitest.extension-codex-app-server-attempt.config.ts",
      "test/vitest/vitest.extension-codex-app-server-attempt-extra.config.ts",
      "test/vitest/vitest.extension-codex-app-server-attempt-light.config.ts",
      "test/vitest/vitest.extension-codex-app-server-attempt-support.config.ts",
      "test/vitest/vitest.extension-codex-app-server-runtime.config.ts",
      "test/vitest/vitest.extension-codex-app-server-support.config.ts",
      "test/vitest/vitest.extension-codex-app-server-tools.config.ts",
      "test/vitest/vitest.extension-codex-surface.config.ts",
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
    const agentsCoreTargets = agentsCorePlans.flatMap((plan) => plan.forwardedArgs);
    const agentsCoreChunkSizes = agentsCorePlans.map((plan) => plan.forwardedArgs.length);
    expect(agentsCorePlans).toHaveLength(6);
    expect(agentsCoreTargets.length).toBeGreaterThan(500);
    expect(new Set(agentsCoreTargets).size).toBe(agentsCoreTargets.length);
    expect(agentsCoreTargets).toContain("src/agents/agent-command.live-model-switch.test.ts");
    expect(agentsCoreTargets).not.toContain(
      "src/agents/embedded-agent-runner/run.incomplete-turn.test.ts",
    );
    expect(
      Math.max(...agentsCoreChunkSizes) - Math.min(...agentsCoreChunkSizes),
    ).toBeLessThanOrEqual(1);
    const unitFastTargets = unitFastPlans.flatMap((plan) => plan.forwardedArgs);
    expect(unitFastPlans.length).toBeGreaterThan(10);
    expect(unitFastPlans.every((plan) => plan.forwardedArgs.length <= 70)).toBe(true);
    expect(unitFastTargets.length).toBeGreaterThan(1_000);
    expect(new Set(unitFastTargets).size).toBe(unitFastTargets.length);
    expect(unitFastTargets).not.toContain("extensions/canvas/src/host/server.state-dir.test.ts");
    expect(unitFastTargets).not.toContain("src/utils.test.ts");
    const toolingTargets = toolingPlans.flatMap((plan) => plan.forwardedArgs);
    expect(toolingPlans.length).toBeGreaterThan(1);
    expect(toolingPlans.every((plan) => plan.forwardedArgs.length <= 2)).toBe(true);
    expect(new Set(toolingTargets).size).toBe(toolingTargets.length);
    expect(toolingTargets).toContain("test/scripts/test-group-report.test.ts");
    expect(toolingTargets).toContain("src/scripts/control-ui-i18n-report.test.ts");
    expect(toolingTargets.some((target) => target.endsWith(".live.test.ts"))).toBe(false);
    expect(toolingTargets).not.toContain("test/scripts/docker-build-helper.test.ts");
    expect(toolingTargets).not.toContain("test/scripts/openclaw-e2e-instance.test.ts");
    expect(
      plans.filter(
        (plan) =>
          plan.config !== gatewayServerConfig &&
          plan.config !== agentsCoreConfig &&
          plan.config !== toolingConfig &&
          plan.config !== unitFastConfig,
      ),
    ).toEqual(
      plans
        .filter(
          (plan) =>
            plan.config !== gatewayServerConfig &&
            plan.config !== agentsCoreConfig &&
            plan.config !== toolingConfig &&
            plan.config !== unitFastConfig,
        )
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

  it("rejects malformed full-suite expansion parallel overrides", () => {
    const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = "6x";
    try {
      expect(() => buildFullSuiteVitestRunPlans([], process.cwd())).toThrow(
        "OPENCLAW_TEST_PROJECTS_PARALLEL must be a positive integer; got: 6x",
      );
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

  it("extends the no-output watchdog for slow silent full-suite configs", () => {
    const specs = applyDefaultVitestNoOutputTimeout(
      [
        {
          config: "test/vitest/vitest.contracts-plugin.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.infra.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.gateway-core.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.gateway-server.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
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

    expect(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("2400000");
    expect(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("2400000");
    expect(specs[2]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("2400000");
    expect(specs[3]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("2400000");
    expect(specs[4]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe(
      DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
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
  });

  it("raises short shard no-output timeouts for the retry attempt", () => {
    const spec = { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000" } };
    expect(withRetryNoOutputTimeout(spec).env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("300000");
    const generous = { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "600000" } };
    expect(withRetryNoOutputTimeout(generous)).toBe(generous);
    const disabled = { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0" } };
    expect(withRetryNoOutputTimeout(disabled)).toBe(disabled);
    const unset = { env: {} };
    expect(withRetryNoOutputTimeout(unset)).toBe(unset);
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

describe("scripts/test-projects channel contract lane patterns", () => {
  // test-projects.test-support.mjs must stay loader-free plain JS, so it
  // duplicates the per-config channel-contract patterns instead of importing
  // vitest.contracts-shared.ts. Drift silently drops contract files from lane
  // routing (it happened once), so pin both enumerations to each other.
  it("stays in sync with the vitest.contracts-shared lane enumerations", () => {
    expect(Object.fromEntries(CHANNEL_CONTRACT_CONFIG_PATTERNS)).toEqual({
      "test/vitest/vitest.contracts-channel-surface.config.ts": channelSurfaceContractPatterns,
      "test/vitest/vitest.contracts-channel-config.config.ts": channelConfigContractPatterns,
      "test/vitest/vitest.contracts-channel-registry.config.ts": channelRegistryContractPatterns,
      "test/vitest/vitest.contracts-channel-session.config.ts": channelSessionContractPatterns,
    });
  });
});
