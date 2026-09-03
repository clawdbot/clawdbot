// Ci Node Test Plan tests cover ci node test plan script behavior.
import { existsSync, globSync, readdirSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChangedExtensionFallbackShards,
  createChangedNodeTestShards,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
  createVitestCacheWarmGroups,
  isExclusiveCompactShardName,
  resolvePolicyTestTargets,
} from "../../scripts/lib/ci-node-test-plan.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { createCompactSplitTimingGeneration } from "../../scripts/lib/vitest-shard-metadata.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, sortRepoPaths, toRepoPath } from "../../src/test-utils/repo-files.js";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../vitest/vitest.agents-paths.mjs";
import { createCliProcessVitestConfig } from "../vitest/vitest.cli-process.config.ts";
import { createCommandsVitestConfig } from "../vitest/vitest.commands.config.ts";
import { createGatewayClientVitestConfig } from "../vitest/vitest.gateway-client.config.ts";
import { createGatewayCoreVitestConfig } from "../vitest/vitest.gateway-core.config.ts";
import { isGatewayServerTestFile } from "../vitest/vitest.gateway-server-paths.mjs";
import { createGatewayServerVitestConfig } from "../vitest/vitest.gateway-server.config.ts";
import { createMediaUnderstandingVitestConfig } from "../vitest/vitest.media-understanding.config.ts";
import { createMediaVitestConfig } from "../vitest/vitest.media.config.ts";
import { createPluginsVitestConfig } from "../vitest/vitest.plugins.config.ts";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";
import { createToolingVitestConfig } from "../vitest/vitest.tooling.config.ts";
import { createTuiVitestConfig } from "../vitest/vitest.tui.config.ts";
import { createUiIsolatedVitestConfig } from "../vitest/vitest.ui-isolated.config.ts";
import { createUiVitestConfig } from "../vitest/vitest.ui.config.ts";
import { getUnitFastTestFilesForIncludePatterns } from "../vitest/vitest.unit-fast-paths.mjs";
import { createUnitVitestConfigWithOptions } from "../vitest/vitest.unit.config.ts";
import { createWizardVitestConfig } from "../vitest/vitest.wizard.config.ts";

type VitestTestConfig = {
  dir?: string;
  exclude?: string[];
  include?: string[];
};

type VitestConfig = {
  test?: VitestTestConfig;
};

const PLUGIN_PRERELEASE_NPM_SPEC_TEST = "src/plugins/install.npm-spec.test.ts";
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";
const STORE_ALIAS_CHANGED_PATHS = [
  "docs/gateway/secrets.md",
  "src/agents/auth-profiles/read-only-availability.test.ts",
  "src/agents/auth-profiles/read-only-availability.ts",
  "src/agents/model-auth-availability.test.ts",
  "src/plugins/manifest-tool-availability.test.ts",
  "src/plugins/manifest-tool-availability.ts",
  "src/plugins/tools.optional.test.ts",
];
function listTestFiles(rootDir: string): string[] {
  const gitFiles = listGitTrackedFiles({ pathspecs: rootDir });
  expect(gitFiles).not.toBeNull();
  if (gitFiles) {
    return gitFiles.filter((line) => line.endsWith(".test.ts"));
  }

  if (!existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(toRepoPath(path));
      }
    }
  };

  visit(rootDir);
  return sortRepoPaths(files);
}

function listMatchedTestFiles(config: VitestConfig): string[] {
  const testConfig = config.test ?? {};
  const cwd = testConfig.dir ? resolve(testConfig.dir) : process.cwd();
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    isAbsolute(pattern) ? toRepoPath(relative(cwd, pattern)) : toRepoPath(pattern),
  );
  return globSync(testConfig.include ?? [], {
    cwd,
    exclude,
  })
    .map((file) => toRepoPath(relative(process.cwd(), resolve(cwd, file))))
    .toSorted((a, b) => a.localeCompare(b));
}

function listAllToolingTestFiles(): string[] {
  const originalArgv = process.argv;
  try {
    process.argv = originalArgv.slice(0, 2);
    return listMatchedTestFiles(
      createToolingVitestConfig({
        ...process.env,
        OPENCLAW_VITEST_INCLUDE_FILE: undefined,
      }),
    );
  } finally {
    process.argv = originalArgv;
  }
}

describe("scripts/lib/ci-node-test-plan.mts", () => {
  it("binds split timing identity to exact complete-file membership", () => {
    const common = {
      configs: ["test/vitest/vitest.gateway-server.config.ts"],
      env: { OPENCLAW_GATEWAY_TEST_WORKERS: "2" },
      parentShardName: "agentic-control-plane-agent-chat",
    };
    const original = createCompactSplitTimingGeneration({
      ...common,
      stripes: [["src/gateway/a.test.ts"], ["src/gateway/b.test.ts"]],
    });
    expect(
      createCompactSplitTimingGeneration({
        ...common,
        stripes: [["src/gateway/a.test.ts"], ["src/gateway/b.test.ts"]],
      }),
    ).toEqual(original);
    expect(
      createCompactSplitTimingGeneration({
        ...common,
        stripes: [["src/gateway/a.test.ts"], ["src/gateway/c.test.ts"]],
      }),
    ).not.toEqual(original);
    expect(
      createCompactSplitTimingGeneration({
        ...common,
        stripes: [["src/gateway/b.test.ts"], ["src/gateway/a.test.ts"]],
      }),
    ).not.toEqual(original);
  });

  it("retains a complete measured generation and ignores complementary partial generations", () => {
    const originalTimings = testTimings.readCompactGroupTimings;
    let overlays: Record<"blacksmith" | "github", Readonly<Record<string, number>>> = {
      blacksmith: { "agentic-agents-support": 165 },
      github: { "agentic-agents-support": 253 },
    };
    vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => {
      const unrelated = Object.fromEntries(
        Object.entries(originalTimings(profile)).filter(
          ([key]) => !key.startsWith("agentic-agents-support"),
        ),
      );
      return { ...unrelated, ...overlays[profile] };
    });
    const options = {
      compactMode: "pull-request" as const,
      includeReleaseOnlyPluginShards: false,
      runnerBackend: "hybrid",
    };
    const initialPlan = createNodeTestShardBundles(options);
    const supportGroups = (plan: typeof initialPlan) =>
      plan
        .flatMap((job) => job.groups)
        .filter((group) => /^agentic-agents-support-hosted-\d+$/u.test(group.shard_name))
        .toSorted((left, right) => left.shard_name.localeCompare(right.shard_name));
    const initial = supportGroups(initialPlan);
    expect(initial).toHaveLength(2);
    overlays.blacksmith = {
      ...overlays.blacksmith,
      ...Object.fromEntries(initial.map((group, index) => [group.timing_key!, 247 + index])),
    };

    const expanded = supportGroups(createNodeTestShardBundles(options));
    expect(expanded).toHaveLength(4);
    const stripes = expanded.map((group) => group.includePatterns!);
    const changedStripesA = stripes.map((patterns) => patterns.slice());
    const first = changedStripesA[0]!.shift()!;
    const second = changedStripesA[1]!.shift()!;
    changedStripesA[0]!.push(second);
    changedStripesA[1]!.push(first);
    const partialA = createCompactSplitTimingGeneration({
      configs: expanded[0]!.configs,
      env: expanded[0]!.env,
      parentShardName: "agentic-agents-support",
      stripes: changedStripesA,
    });
    const changedStripesB = stripes.map((patterns) => patterns.slice());
    const third = changedStripesB[2]!.shift()!;
    const fourth = changedStripesB[3]!.shift()!;
    changedStripesB[2]!.push(fourth);
    changedStripesB[3]!.push(third);
    const partialB = createCompactSplitTimingGeneration({
      configs: expanded[0]!.configs,
      env: expanded[0]!.env,
      parentShardName: "agentic-agents-support",
      stripes: changedStripesB,
    });
    overlays = {
      github: { "agentic-agents-support": 100 },
      blacksmith: {
        "agentic-agents-support": 100,
        [partialA.timingKeys[0]!]: 1_000,
        [partialA.timingKeys[1]!]: 1_000,
        [partialB.timingKeys[2]!]: 1_000,
        [partialB.timingKeys[3]!]: 1_000,
      },
    };
    const incomplete = createNodeTestShardBundles(options).flatMap((job) => job.groups);
    expect(
      incomplete.filter((group) => group.shard_name === "agentic-agents-support"),
    ).toHaveLength(1);
    expect(
      incomplete.filter((group) => /^agentic-agents-support-hosted-\d+$/u.test(group.shard_name)),
    ).toHaveLength(0);

    overlays.blacksmith = {
      ...overlays.blacksmith,
      ...Object.fromEntries(expanded.map((group) => [group.timing_key!, 124])),
    };

    const stable = supportGroups(createNodeTestShardBundles(options));
    expect(stable).toHaveLength(4);
    expect(stable.map((group) => group.timing_key)).toEqual(
      expanded.map((group) => group.timing_key),
    );
  });

  it("keeps Chromium files in the UI CI owner and Node-driven Playwright files in Node stripes", () => {
    const shards = createNodeTestShards();
    const uiStripes = shards.filter((shard) =>
      shard.shardName.startsWith("core-runtime-media-ui-"),
    );
    const files = uiStripes.flatMap((shard) => shard.includePatterns ?? []);
    expect(files).toContain("ui/src/components/form-controls.browser.test.ts");
    expect(files).not.toContain("ui/src/components/markdown-mermaid.runtime.browser.test.ts");
    expect(shards.flatMap((shard) => shard.configs)).not.toContain(
      "test/vitest/vitest.ui-browser.config.ts",
    );
  });
  it.each(["github", "hybrid"])("keeps oversized sparse groups nonempty on %s", (runnerBackend) => {
    const native = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const targets = [1, 2].map((count) =>
      native.find(
        (shard) =>
          shard.includePatterns?.length === count && !shard.shardName.startsWith("core-tooling"),
      )!,
    );
    expect(targets.every(Boolean)).toBe(true);
    const original = testTimings.readCompactGroupTimings;
    vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => ({
      ...original(profile),
      ...Object.fromEntries(targets.map((target) => [target.shardName, 1_000])),
    }));
    const plan = createNodeTestShardBundles({
      compactMode: "push",
      runnerBackend,
      includeReleaseOnlyPluginShards: false,
    });
    for (const target of targets) {
      const groups = plan
        .flatMap((job) => job.groups)
        .filter(
          (group) =>
            group.shard_name === target.shardName ||
            group.shard_name.startsWith(`${target.shardName}-hosted-`),
        );
      expect(groups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
      expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
        target.includePatterns!.toSorted(),
      );
      expect(groups).toHaveLength(target.includePatterns!.length);
    }
  });

  it.each([
    { runnerBackend: "github", slowerProfile: "github" },
    { runnerBackend: "hybrid", slowerProfile: "github" },
    { runnerBackend: "hybrid", slowerProfile: "blacksmith" },
  ])(
    "bounds $runnerBackend child groups by the slower $slowerProfile path",
    ({ runnerBackend, slowerProfile }) => {
      const consumer = "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts";
      const target = createNodeTestShards().find((shard) =>
        shard.includePatterns?.includes(consumer),
      )!;
      const originalShards = fullSuiteVitestShards.slice();
      // Exercise this owner's split without consuming unrelated suite families' job budget.
      const fixtureShards = originalShards
        .map((shard) => ({
          ...shard,
          projects: shard.projects.filter((config) => target.configs.includes(config)),
        }))
        .filter((shard) => shard.projects.length > 0);
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
      try {
        vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => ({
          [target.shardName]: profile === slowerProfile ? 400 : 100,
        }));
        const plan = createNodeTestShardBundles({
          compactMode: "pull-request",
          runnerBackend,
          includeReleaseOnlyPluginShards: false,
        });
        const groups = plan
          .flatMap((job) => job.groups)
          .filter((group) => group.shard_name.startsWith(`${target.shardName}-hosted-`));
        // Runtime preparation stays in its own child; the remaining test
        // cost needs three stripes on both runner profiles.
        expect(groups).toHaveLength(4);
        if (runnerBackend === "github") {
          expect(
            plan
              .filter((job) => job.predictedSeconds! > 150)
              .every(
                (job) => job.groups.length === 1 && job.groups[0]!.includePatterns?.length === 1,
              ),
          ).toBe(true);
        }
        expect(
          groups
            .filter((group) => group.pretestBuildMode !== undefined)
            .map(({ pretestBuildMode, includePatterns }) => ({
              pretestBuildMode,
              includePatterns,
            })),
        ).toEqual([{ pretestBuildMode: "runtime", includePatterns: [consumer] }]);
        for (const job of plan) {
          if (
            job.groups.some(
              (group) => groups.includes(group) && group.pretestBuildMode === undefined,
            )
          ) {
            expect(job.predictedSeconds, `${runnerBackend}/${slowerProfile}`).toBeLessThanOrEqual(
              150,
            );
          }
        }
        expect(groups.flatMap((group) => group.includePatterns ?? []).toSorted()).toEqual(
          target.includePatterns!.toSorted(),
        );
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }
    },
  );
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inventories source-scanning Control UI policy tests", () => {
    expect(resolvePolicyTestTargets(["ui/src/pages/chat/view.ts"])).toEqual([
      "ui/src/components/web-awesome-migration.node.test.ts",
      "ui/src/styles/base-theme-tokens.node.test.ts",
      "ui/src/styles/cursor-policy.node.test.ts",
    ]);
    expect(resolvePolicyTestTargets(["docs/web/control-ui.md"])).toEqual([]);
  });

  it("projects cache-warm groups from the owned node test plan", () => {
    const groups = createVitestCacheWarmGroups();
    expect(groups).toHaveLength(12);
    expect(groups.every((group) => group.configs.length === 1)).toBe(true);
    expect(new Set(groups.flatMap((group) => group.configs))).toHaveProperty("size", 11);
    expect(new Set(groups.map((group) => group.shard_name))).toHaveProperty("size", groups.length);

    const coreStripeGroups = groups.filter(
      (group) => group.configs[0] === "test/vitest/vitest.unit-fast.config.ts",
    );
    expect(coreStripeGroups).toHaveLength(2);
    expect(coreStripeGroups.every((group) => (group.includePatterns?.length ?? 0) > 0)).toBe(true);
    const coreStripePatterns = coreStripeGroups.flatMap((group) => group.includePatterns ?? []);
    expect(new Set(coreStripePatterns).size).toBe(coreStripePatterns.length);

    const isolatedGroups = groups.filter(
      (group) =>
        group.shard_name.startsWith("cache-warm:core-unit-fast-isolated:") ||
        group.shard_name.startsWith("cache-warm:core-unit-fast-fake-timers:"),
    );
    expect(isolatedGroups).toHaveLength(2);
    expect(isolatedGroups.every((group) => group.includePatterns === undefined)).toBe(true);
    expect(isolatedGroups.every((group) => group.env === undefined)).toBe(true);

    const embeddedGroups = groups.filter((group) =>
      group.shard_name.startsWith("cache-warm:agentic-agents-embedded:"),
    );
    expect(embeddedGroups).toHaveLength(4);
    expect(
      embeddedGroups.every((group) => group.env?.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS === "660000"),
    ).toBe(true);

    const gatewayGroups = groups.filter((group) =>
      group.shard_name.startsWith("cache-warm:agentic-gateway-methods:"),
    );
    expect(
      gatewayGroups.flatMap((group) => group.configs).toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([
      "test/vitest/vitest.gateway-methods-isolated.config.ts",
      "test/vitest/vitest.gateway-methods.config.ts",
    ]);
    expect(gatewayGroups.every((group) => group.includePatterns === undefined)).toBe(true);
    expect(gatewayGroups.every((group) => group.env === undefined)).toBe(true);

    const autoReplyGroups = groups.filter((group) =>
      group.shard_name.startsWith("cache-warm:auto-reply-reply-commands-3:"),
    );
    expect(autoReplyGroups).toHaveLength(1);
    expect(autoReplyGroups[0]?.includePatterns).toHaveLength(18);
    expect(autoReplyGroups[0]?.env).toBeUndefined();

    expect(groups.find((group) => group.shard_name === "cache-warm:ui-package")).toEqual({
      configs: ["ui/vitest.config.ts"],
      env: { OPENCLAW_VITEST_MAX_WORKERS: "1" },
      includePatterns: [
        "ui/src/components/app-sidebar.test.ts",
        "ui/src/pages/chat/chat-view.test.ts",
        "ui/src/pages/chat/chat-pane-lifecycle.test.ts",
        "ui/src/pages/usage/metrics.node.test.ts",
      ],
      shard_name: "cache-warm:ui-package",
    });
  });

  it("creates split shards without walking test roots", () => {
    const payload = expectNoNodeFsScans<{
      includePatterns: number;
      shards: number;
    }>(`
      const { createNodeTestShards } = await import("./scripts/lib/ci-node-test-plan.mts");
      const shards = createNodeTestShards();
      return {
        includePatterns: shards.reduce(
          (total, shard) => total + (shard.includePatterns?.length ?? 0),
          0,
        ),
        shards: shards.length,
      };
    `);
    expect(payload.shards).toBeGreaterThan(0);
    expect(payload.includePatterns).toBeGreaterThan(0);
  });

  it("bundles split shards deterministically without changing coverage", () => {
    const base = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const bundled = createNodeTestShardBundles({ includeReleaseOnlyPluginShards: false });
    const basePatterns = base
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const bundledPatterns = bundled
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(bundled.length).toBeLessThan(base.length);
    expect(bundledPatterns).toEqual(basePatterns);
    expect(
      bundled
        .filter((shard) => shard.shardName.startsWith("bundle-"))
        .every((shard) => (shard.includePatterns?.length ?? 0) <= 64),
    ).toBe(true);
    expect(bundled.every((shard) => shard.runner?.startsWith("blacksmith-"))).toBe(true);
    expect(bundled).toEqual(createNodeTestShardBundles({ includeReleaseOnlyPluginShards: false }));
    expect(bundled.slice(0, 7).map((shard) => shard.shardName)).toEqual([
      "core-unit-fast-1",
      "core-unit-fast-2",
      "core-tooling-1",
      "core-tooling-10",
      "core-tooling-11",
      "core-tooling-12",
      "core-tooling-13",
    ]);
    expect(bundled.find((shard) => shard.shardName === "core-unit-fast-1")?.runner).toBe(
      DEFAULT_NODE_TEST_RUNNER,
    );
    expect(bundled.find((shard) => shard.shardName === "core-unit-fast-2")?.runner).toBe(
      DEFAULT_NODE_TEST_RUNNER,
    );
    expect(
      bundled.find((shard) => shard.shardName === "agentic-control-plane-startup-health-runtime")
        ?.env,
    ).toEqual({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000" });
    expect(
      bundled.find((shard) => shard.shardName === "agentic-control-plane-startup-core")?.runner,
    ).toBe(DEFAULT_NODE_TEST_RUNNER);
    expect(bundled.find((shard) => shard.shardName === "bundle-infra-small-1")?.runner).toBe(
      "blacksmith-4vcpu-ubuntu-2404",
    );
    expect(
      new Set(
        bundled
          .filter((shard) => shard.shardName.startsWith("bundle-"))
          .flatMap((shard) => shard.configs),
      ),
    ).toEqual(new Set(["test/vitest/vitest.infra.config.ts"]));
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-commands-"))).toBe(false);
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-cron-"))).toBe(false);
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-agents-core-"))).toBe(false);
    expect(bundled.some((shard) => shard.shardName.startsWith("bundle-gateway-server-"))).toBe(
      false,
    );
  });

  it.each([
    { profile: "blacksmith", legacy: 116, measured: 310, defaultSeconds: 25 },
    { profile: "github", legacy: 186, measured: 370, defaultSeconds: 40 },
    { profile: "hybrid", legacy: 101, measured: 270, defaultSeconds: 22 },
  ])(
    "prefers $profile measurements while retaining unmeasured hints and defaults",
    ({ profile, legacy, measured, defaultSeconds }) => {
      const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
      const options = {
        includeReleaseOnlyPluginShards: false,
        compactMode: "pull-request" as const,
        runnerBackend: profile,
      };
      const fallback = createNodeTestShardBundles(options);
      const tuiJob = (plan: typeof fallback) =>
        plan.find((shard) =>
          shard.groups.some((group) => group.shard_name === "core-runtime-tui-pty"),
        );
      expect(tuiJob(fallback)?.predictedSeconds).toBe(legacy);
      timings.mockImplementation((runner) => ({
        "core-runtime-tui-pty": runner === "blacksmith" ? 310 : 370,
        "removed-test-group": 999,
      }));
      const updated = createNodeTestShardBundles(options);
      expect(tuiJob(updated)?.groups.map((group) => group.shard_name)).toEqual([
        "core-runtime-tui-pty",
      ]);
      expect(tuiJob(updated)?.predictedSeconds).toBe(measured);
      expect(
        updated.find((shard) =>
          shard.groups.some((group) => group.shard_name === "core-support-boundary"),
        )?.predictedSeconds,
      ).toBe(defaultSeconds);
      const groupNames = (plan: typeof fallback) =>
        plan.flatMap((shard) => shard.groups.map((group) => group.shard_name)).toSorted();
      expect(groupNames(updated)).toEqual(groupNames(fallback));

      // Two complete, compatible configs share setup without changing either
      // process envelope. Only Blacksmith requests capacity for overlapping plans.
      const fixtureConfigs = new Set([
        "test/vitest/vitest.hooks.config.ts",
        "test/vitest/vitest.secrets.config.ts",
      ]);
      const originalShards = fullSuiteVitestShards.slice();
      try {
        const fixtureShards = originalShards
          .map((shard) => ({
            ...shard,
            projects: shard.projects.filter((config) => fixtureConfigs.has(config)),
          }))
          .filter((shard) => shard.projects.length > 0);
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
        const base = createNodeTestShards(options);
        expect(base).toHaveLength(2);
        timings.mockReturnValue(Object.fromEntries(base.map((shard) => [shard.shardName, 70])));
        const packed = createNodeTestShardBundles(options);
        expect(packed).toHaveLength(1);
        expect(packed[0]?.groups).toEqual(
          base.map(({ checkName: _checkName, shardName, ...group }) => ({
            ...group,
            shard_name: shardName,
          })),
        );
        expect(packed[0]?.planConcurrency).toBe(profile === "blacksmith" ? 2 : 1);
        expect(packed[0]?.runner).toBe(
          profile === "blacksmith" ? EXTRA_LARGE_NODE_TEST_RUNNER : base[0]?.runner,
        );
        expect(packed[0]?.predictedSeconds).toBe(profile === "hybrid" ? 122 : 140);
      } finally {
        fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
      }
    },
  );

  it("keeps hybrid fallback bounds and unmeasured stripes when other measurements change", () => {
    const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
    const options = {
      includeReleaseOnlyPluginShards: false,
      compactMode: "push" as const,
      runnerBackend: "hybrid",
    };
    const fallback = createNodeTestShardBundles(options);
    expect(
      fallback
        .filter((shard) => !shard.requiresDist)
        .every((shard) => (shard.predictedSeconds ?? Infinity) <= 210),
    ).toBe(true);
    // Runtime consumers retain their build floor without unrelated Doctor work.
    // The complete CLI catalog still leaves its slow gateway files alone.
    expect(
      fallback
        .filter((shard) => !shard.requiresDist)
        .filter((shard) =>
          shard.groups.some((group) => isExclusiveCompactShardName(group.shard_name)),
        )
        .filter((shard) => !((shard.predictedSeconds ?? Infinity) <= 150))
        .map((shard) => ({
          groups: shard.groups.map((group) => group.shard_name),
          pretestBuildMode: shard.pretestBuildMode,
          predictedSeconds: shard.predictedSeconds,
        }))
        .toSorted((a, b) => a.groups.join(",").localeCompare(b.groups.join(","))),
    ).toEqual([
      {
        groups: ["agentic-cli-process-hosted-1"],
        pretestBuildMode: undefined,
        predictedSeconds: 200,
      },
      {
        groups: ["agentic-cli-process-hosted-2"],
        pretestBuildMode: undefined,
        predictedSeconds: 200,
      },
    ]);
    const agentChatStripes = fallback
      .flatMap((shard) => shard.groups)
      .filter((group) => group.shard_name.startsWith("agentic-control-plane-agent-chat-hosted-"));
    expect(agentChatStripes.length).toBeGreaterThan(1);
    expect(
      agentChatStripes.every(
        (group) =>
          !group.includePatterns?.includes("src/gateway/server.chat.gateway-server-chat.test.ts") ||
          !group.includePatterns.includes("src/gateway/server.sessions.create.test.ts"),
      ),
    ).toBe(true);
    timings.mockImplementation(
      (runner): Readonly<Record<string, number>> =>
        runner === "blacksmith"
          ? {
              "agentic-agents-core-models": 123,
              "core-unit-fast-1": 100,
              "core-runtime-hooks": 80,
            }
          : {},
    );
    const updated = createNodeTestShardBundles(options);
    const tail = updated.find((shard) =>
      shard.groups.some((group) => group.shard_name === "agentic-gateway-core-3"),
    );
    expect(tail?.predictedSeconds).toBeGreaterThanOrEqual(140);
    expect(tail?.predictedSeconds).toBeLessThanOrEqual(210);
  });

  it.each([
    { profile: "github", timingProfile: "github", addedSeconds: 40 },
    { profile: "hybrid", timingProfile: "blacksmith", addedSeconds: 35 },
  ] as const)(
    "retains parent floors and uses higher $profile child timings without changing test partitions",
    ({ profile, timingProfile, addedSeconds }) => {
      const shardName = "agentic-agents-support-hosted-2";
      let directTimings: Readonly<Record<string, number>> = {};
      vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation(
        (runner): Readonly<Record<string, number>> => ({
          "agentic-agents-support": runner === "blacksmith" ? 165 : 253,
          ...(runner === timingProfile ? directTimings : {}),
        }),
      );
      const options = {
        includeReleaseOnlyPluginShards: false,
        compactMode: "push" as const,
        runnerBackend: profile,
      };
      const unmeasured = createNodeTestShardBundles(options);
      const initialGroup = unmeasured
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === shardName);
      expect(initialGroup?.timing_key).toMatch(
        /^agentic-agents-support#selector-.+#generation-.+#part-2-of-2#include-.+$/u,
      );
      const timingKey = initialGroup!.timing_key!;
      directTimings = { [timingKey]: 1 };
      const belowFloor = createNodeTestShardBundles(options);
      // Both larger samples exceed the parent share, so their delta measures
      // direct timing precedence independently of the retained floor.
      directTimings = { [timingKey]: 200 };
      const baseline = createNodeTestShardBundles(options);
      directTimings = { [timingKey]: 240 };
      const updated = createNodeTestShardBundles(options);
      const totalSeconds = (plan: typeof baseline) =>
        plan.reduce((sum, shard) => sum + (shard.predictedSeconds ?? 0), 0);
      const testPartition = (plan: typeof baseline) =>
        plan
          .flatMap((shard) => shard.groups)
          .map((group) => ({
            name: group.shard_name,
            configs: group.configs,
            includePatterns: group.includePatterns,
            runner: group.runner,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name));

      expect(totalSeconds(belowFloor)).toBe(totalSeconds(unmeasured));
      expect(totalSeconds(updated) - totalSeconds(baseline)).toBe(addedSeconds);
      expect(testPartition(baseline)).toEqual(testPartition(unmeasured));
      expect(testPartition(updated)).toEqual(testPartition(baseline));
      expect(
        updated.flatMap((shard) => shard.groups).find((group) => group.shard_name === shardName)
          ?.timing_key,
      ).toBe(timingKey);
      expect(updated.every((shard) => shard.planConcurrency === 1)).toBe(true);
    },
  );

  it("preserves coverage and execution policies with committed compact measurements", () => {
    const base = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const compact = createNodeTestShardBundles({
      includeReleaseOnlyPluginShards: false,
      compactMode: "push",
    });
    const pullRequestCompact = createNodeTestShardBundles({
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request",
    });
    const githubCompact = createNodeTestShardBundles({
      includeReleaseOnlyPluginShards: false,
      compactMode: "push",
      runnerBackend: "github",
    });
    const githubPullRequestCompact = createNodeTestShardBundles({
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request",
      runnerBackend: "github",
    });
    const hybridCompact = createNodeTestShardBundles({
      includeReleaseOnlyPluginShards: false,
      compactMode: "push",
      runnerBackend: "hybrid",
    });
    const hybridPullRequestCompact = createNodeTestShardBundles({
      includeReleaseOnlyPluginShards: false,
      compactMode: "pull-request",
      runnerBackend: "hybrid",
    });
    const expectedToolingOwnerNames = Array.from(
      { length: 16 },
      (_, index) => `core-tooling-${index + 1}`,
    );
    const pushExcludedShardNames = new Set([
      "core-runtime-tui-pty",
      ...expectedToolingOwnerNames,
      "core-tooling-isolated",
    ]);
    const gatewayFiles = [
      "src/cli/gateway-backed-exit.process.test.ts",
      "src/cli/gateway-backed-exit-health.process.test.ts",
    ];

    for (const profile of [
      {
        name: "Blacksmith",
        pullRequest: pullRequestCompact,
        push: compact,
        largeOwners: [
          "agentic-cli",
          "agentic-control-plane-http-plugin-ws",
          "agentic-commands-doctor-platform",
          "agentic-commands-doctor-sessions-cron",
          "agentic-commands-doctor-sessions-cron-memory",
          "agentic-commands-doctor-sessions-cron-sqlite",
          "agentic-control-plane-auth-node",
          "core-runtime-infra-storage-state",
          "agentic-control-plane-runtime-ui-tools",
          "core-runtime-infra-heartbeat-runner",
          "core-runtime-infra-system-runtime",
          "auto-reply-reply-agent-runner",
          "agentic-commands-status-tools",
          "agentic-commands-doctor",
          "agentic-agents-core-isolated",
        ],
        largeFiles: ["src/cli/update-dry-run-state.process.test.ts"],
      },
      {
        name: "GitHub-hosted",
        pullRequest: githubPullRequestCompact,
        push: githubCompact,
        largeOwners: [
          "core-runtime-cron-service",
          "agentic-agents-tools",
          "core-runtime-infra-storage-state",
        ],
        largeFiles: [],
      },
      {
        name: "hybrid",
        pullRequest: hybridPullRequestCompact,
        push: hybridCompact,
        largeOwners: [
          "agentic-commands-doctor-config-state",
          "core-runtime-cron-service",
          "agentic-control-plane-runtime-shared-token",
          "agentic-commands-doctor-platform",
        ],
        largeFiles: gatewayFiles,
      },
    ]) {
      expect(profile.push.length, `${profile.name} excludes PR-only work`).toBeLessThan(
        profile.pullRequest.length,
      );
      for (const plan of [profile.push, profile.pullRequest]) {
        // Capacity belongs to the workload even when timing changes reorder rows.
        const groups = plan.flatMap((shard) => shard.groups);
        for (const owner of profile.largeOwners) {
          const selected = groups.filter(
            (group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner,
          );
          expect(selected.length, `${profile.name}: ${owner}`).toBeGreaterThan(0);
          expect(
            selected.every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER),
            `${profile.name}: ${owner}`,
          ).toBe(true);
        }
        for (const largeFile of profile.largeFiles) {
          const selected = groups.filter((group) => group.includePatterns?.includes(largeFile));
          expect(selected, largeFile).toHaveLength(1);
          expect(selected[0]?.runner, largeFile).toBe(DEFAULT_NODE_TEST_RUNNER);
        }
        const supportGroups = groups.filter((group) =>
          group.configs.includes(agentVitestProjectOwners.support.config),
        );
        expect(supportGroups.length, profile.name).toBeGreaterThan(0);
        if (profile.name === "Blacksmith") {
          for (const owner of [
            "agentic-control-plane-agent-chat",
            "agentic-gateway-core-3",
            "core-runtime-infra-storage-state",
          ]) {
            expect(
              groups.filter((group) => group.shard_name.startsWith(`${owner}-hosted-`)).length,
              owner,
            ).toBeGreaterThan(1);
          }
          expect(supportGroups).toEqual([
            {
              shard_name: "agentic-agents-support",
              configs: [agentVitestProjectOwners.support.config],
              requiresDist: false,
              runner: EXTRA_LARGE_NODE_TEST_RUNNER,
            },
          ]);
          expect(plan.find((shard) => shard.groups.includes(supportGroups[0]!))).toMatchObject({
            checkName: "checks-node-compact-large32-1",
            shardName: "compact-large32-1",
            groups: supportGroups,
            runner: EXTRA_LARGE_NODE_TEST_RUNNER,
            planConcurrency: 1,
            timeoutMinutes: 120,
          });
        } else {
          expect(supportGroups.every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER)).toBe(
            true,
          );
          expect(plan.some((shard) => shard.runner === EXTRA_LARGE_NODE_TEST_RUNNER)).toBe(false);
          expect(plan.every((shard) => shard.planConcurrency === 1)).toBe(true);
        }
        const cliProcessJobs = plan.filter((shard) =>
          shard.groups.some((group) =>
            group.configs.includes("test/vitest/vitest.cli-process.config.ts"),
          ),
        );
        expect(cliProcessJobs, profile.name).toHaveLength(7);
        const gatewayJobs = new Set(
          gatewayFiles.map((file) => {
            const gatewayJob = cliProcessJobs.find((shard) =>
              shard.groups.some((group) => group.includePatterns?.includes(file)),
            );
            expect(gatewayJob?.groups, `${profile.name}: ${file}`).toEqual([
              expect.objectContaining({ includePatterns: [file] }),
            ]);
            return gatewayJob;
          }),
        );
        const runtimeCliJobs = cliProcessJobs.filter((shard) => shard.pretestBuildMode);
        expect(runtimeCliJobs).toHaveLength(2);
        expect(runtimeCliJobs).toEqual(
          expect.arrayContaining(
            [
              "src/cli/acp-cli-exit.process.test.ts",
              "src/cli/update-dry-run-state.process.test.ts",
            ].map((file) =>
              expect.objectContaining({
                pretestBuildMode: "runtime",
                groups: expect.arrayContaining([
                  expect.objectContaining({
                    pretestBuildMode: "runtime",
                    includePatterns: expect.arrayContaining([file]),
                  }),
                ]),
              }),
            ),
          ),
        );
        for (const shard of cliProcessJobs) {
          // The gateway files retain 200s budgets. Hosted runtime preparation
          // alone costs 160s; other groups retain the 150s admission budget.
          const budget =
            gatewayJobs.has(shard) ||
            (profile.name === "GitHub-hosted" && shard.pretestBuildMode === "runtime")
              ? 200
              : 150;
          expect(shard.predictedSeconds, profile.name).toBeLessThanOrEqual(budget);
        }
        expect(plan.every((shard) => shard.groups.length > 0 && shard.groups.length <= 10)).toBe(
          true,
        );
        expect(plan.every((shard) => Number.isFinite(shard.predictedSeconds))).toBe(true);
        const names = plan.flatMap((shard) => shard.groups.map((group) => group.shard_name));
        expect(new Set(names).size).toBe(names.length);
        expect(new Set(plan.map((shard) => shard.checkName)).size).toBe(plan.length);
        expect(new Set(plan.map((shard) => shard.shardName)).size).toBe(plan.length);
        expect(plan.length, `${profile.name} row budget`).toBeLessThanOrEqual(80);
      }
    }
    expect(compact.every((shard) => Array.isArray(shard.groups))).toBe(true);
    expect(compact.every((shard) => shard.groups.length <= 10)).toBe(true);
    expect(compact.some((shard) => shard.requiresDist)).toBe(true);
    expect(
      compact.every((shard) =>
        shard.groups.every(
          (group) =>
            group.requiresDist === shard.requiresDist && group.runner === shard.groups[0]?.runner,
        ),
      ),
    ).toBe(true);
    const jobOf = (name: string) =>
      compact.findIndex((shard) => shard.groups.some((group) => group.shard_name === name));
    expect(jobOf("agentic-agents-core-runner-embedded")).toBeGreaterThanOrEqual(0);
    for (const prefix of [
      "agentic-agents-embedded-base",
      "agentic-gateway-core",
      "core-runtime-media-ui",
      "core-unit-src-security",
    ]) {
      const jobs = [1, 2, 3].flatMap((stripe) => {
        const owner = `${prefix}-${stripe}`;
        const placements = compact.flatMap((shard, index) =>
          shard.groups
            .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === owner)
            .map(() => index),
        );
        expect(placements.length, owner).toBeGreaterThan(0);
        return placements;
      });
      expect(new Set(jobs).size).toBe(jobs.length);
    }
    // Cheap stripes may legally co-locate in one bin; only existence matters.
    expect(jobOf("core-unit-fast-1")).toBeGreaterThanOrEqual(0);
    expect(jobOf("core-unit-fast-2")).toBeGreaterThanOrEqual(0);
    // Timing-sensitive and runtime-building jobs stay serial. Ordinary Blacksmith
    // bins may overlap only with the larger capacity request; logical groups stay intact.
    for (const shard of [
      ...pullRequestCompact,
      ...githubPullRequestCompact,
      ...hybridPullRequestCompact,
    ]) {
      const exclusiveCount = shard.groups.filter((group) =>
        isExclusiveCompactShardName(group.shard_name),
      ).length;
      if (exclusiveCount > 0) {
        expect(exclusiveCount).toBe(shard.groups.length);
        expect(shard.planConcurrency).toBe(1);
      }
      if (shard.planConcurrency === 2) {
        expect(pullRequestCompact).toContain(shard);
        expect(shard.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
        expect(shard.groups.length).toBeGreaterThan(1);
        expect(shard.pretestBuildMode).toBeUndefined();
        expect(shard.requiresDist).toBe(false);
      } else {
        expect(shard.planConcurrency).toBe(1);
        const blacksmithTooling =
          pullRequestCompact.includes(shard) &&
          shard.groups.some((group) =>
            group.configs.includes("test/vitest/vitest.tooling.config.ts"),
          );
        expect(shard.runner).toBe(
          blacksmithTooling ? EXTRA_LARGE_NODE_TEST_RUNNER : shard.groups[0]?.runner,
        );
      }
    }
    expect(
      pullRequestCompact.filter((shard) =>
        shard.groups.some((group) => isExclusiveCompactShardName(group.shard_name)),
      ).length,
    ).toBeGreaterThan(0);
    const hybridJobFor = (name: string) =>
      hybridPullRequestCompact.find((shard) =>
        shard.groups.some((group) => group.shard_name === name),
      );
    const hybridCliJob = hybridJobFor("agentic-cli");
    const hybridToolingIsolatedJob = hybridJobFor("core-tooling-isolated");
    expect(hybridCliJob).toBeDefined();
    expect(hybridToolingIsolatedJob).toBeDefined();
    expect(hybridToolingIsolatedJob?.checkName).not.toBe(hybridCliJob?.checkName);
    const expectedEmbeddedAgentGroupNames = [
      "agentic-agents-embedded-base-1",
      "agentic-agents-embedded-base-2",
      "agentic-agents-embedded-base-3",
      "agentic-agents-embedded-incomplete-turn",
      "agentic-agents-embedded-overflow-compaction",
      "agentic-agents-embedded-run",
    ];
    // Scoped configs drop unit-fast files and the shared live/e2e suffixes, so
    // a striped owner covers only the files its config runs; the rest are inert.
    const ownerScopedTestFiles = (owner: { dir: string; include: string[]; exclude: string[] }) => {
      const unitFastFiles = new Set(
        getUnitFastTestFilesForIncludePatterns(owner.include, { dir: owner.dir }),
      );
      return globSync(owner.include)
        .map(toRepoPath)
        .filter(
          (file) =>
            !unitFastFiles.has(file) &&
            !file.endsWith(".live.test.ts") &&
            !file.endsWith(".e2e.test.ts") &&
            !owner.exclude.some((pattern) => matchesGlob(file, pattern)),
        );
    };
    // The embedded composite expands into per-config groups and stripes its
    // serial base config; whole-config runtime consumers may also be striped.
    const embeddedBaseOwnerFiles = ownerScopedTestFiles(agentVitestProjectOwners.embedded);
    const compactGroups = compact.flatMap((shard) => shard.groups);
    const pullRequestCompactGroups = pullRequestCompact.flatMap((shard) => shard.groups);
    const expectedGroupNames = base.flatMap((shard) =>
      shard.shardName === "agentic-agents-embedded"
        ? expectedEmbeddedAgentGroupNames
        : [shard.shardName],
    );
    const compactOwnerNames = (plan: typeof githubCompact) =>
      new Set(
        plan.flatMap((shard) =>
          shard.groups.map((group) => group.shard_name.replace(/-hosted-\d+$/u, "")),
        ),
      );
    expect(compactOwnerNames(compact)).toEqual(
      new Set(expectedGroupNames.filter((name) => !pushExcludedShardNames.has(name))),
    );
    expect(compactOwnerNames(pullRequestCompact)).toEqual(new Set(expectedGroupNames));
    expect(compactOwnerNames(githubCompact)).toEqual(compactOwnerNames(compact));
    expect(compactOwnerNames(githubPullRequestCompact)).toEqual(
      compactOwnerNames(pullRequestCompact),
    );
    expect(compactOwnerNames(hybridCompact)).toEqual(compactOwnerNames(githubCompact));
    expect(compactOwnerNames(hybridPullRequestCompact)).toEqual(
      compactOwnerNames(githubPullRequestCompact),
    );
    for (const plan of [
      compact,
      pullRequestCompact,
      githubCompact,
      githubPullRequestCompact,
      hybridCompact,
      hybridPullRequestCompact,
    ]) {
      for (const owner of base) {
        const groups = plan
          .flatMap((shard) => shard.groups)
          .filter((group) => group.shard_name.startsWith(`${owner.shardName}-hosted-`));
        if (groups.length === 0) {
          continue;
        }
        const jobs = groups.map((group) => plan.findIndex((shard) => shard.groups.includes(group)));
        expect(new Set(jobs).size, `${owner.shardName}: split children stay separate`).toBe(
          groups.length,
        );
        const actual = groups.flatMap((group) => group.includePatterns ?? []);
        expect(new Set(actual).size, owner.shardName).toBe(actual.length);
        if (owner.includePatterns) {
          expect(actual.toSorted(), owner.shardName).toEqual(owner.includePatterns.toSorted());
        } else if (owner.shardName === "agentic-agents-support") {
          const expected = ownerScopedTestFiles(agentVitestProjectOwners.support);
          expect(actual.toSorted()).toEqual(expected.toSorted());
        } else if (owner.shardName === "agentic-cli-process") {
          expect(actual.toSorted()).toEqual(
            listMatchedTestFiles(createCliProcessVitestConfig({})).toSorted(),
          );
        }
      }
    }
    // Pushes omit only the explicit low-signal families; PR fallback retains
    // their include-pattern coverage when special setup prevents targeting.
    expect(
      compactGroups
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      base
        .filter((shard) => !pushExcludedShardNames.has(shard.shardName))
        .flatMap((shard) => shard.includePatterns ?? [])
        .concat(embeddedBaseOwnerFiles, listMatchedTestFiles(createCliProcessVitestConfig({})))
        .toSorted((a, b) => a.localeCompare(b)),
    );
    expect(
      pullRequestCompactGroups
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      base
        .flatMap((shard) => shard.includePatterns ?? [])
        .concat(embeddedBaseOwnerFiles, listMatchedTestFiles(createCliProcessVitestConfig({})))
        .toSorted((a, b) => a.localeCompare(b)),
    );
    expect(compact.every((shard) => shard.groups.every((group) => group.configs.length > 0))).toBe(
      true,
    );
    expect(
      pullRequestCompact
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === "core-runtime-tui-pty")?.env,
    ).toEqual({
      OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
      OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1",
      // Timing-sensitive groups pin the worker budget while the job-level
      // default scales with the runner class.
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    expect(
      compact.flatMap((shard) => shard.groups).find((group) => group.shard_name === "agentic-cli")
        ?.env,
    ).toEqual({
      OPENCLAW_VITEST_MAX_WORKERS: "2",
    });
    for (const prefix of ["agentic-gateway-core", "core-runtime-media-ui"]) {
      for (const suffix of ["1", "2", "3"]) {
        const groups = compact
          .flatMap((shard) => shard.groups)
          .filter(
            (group) => group.shard_name.replace(/-hosted-\d+$/u, "") === `${prefix}-${suffix}`,
          );
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
          expect(group.env).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: "2" });
        }
      }
    }
    expect(
      compact
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === "core-runtime-media-ui-support")?.env,
    ).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: "2" });
    const startupCoreJob = compact.find((shard) =>
      shard.groups.some((group) => group.shard_name === "agentic-control-plane-startup-core"),
    );
    expect(startupCoreJob?.runner).toBe(
      startupCoreJob?.planConcurrency === 2
        ? EXTRA_LARGE_NODE_TEST_RUNNER
        : DEFAULT_NODE_TEST_RUNNER,
    );
    expect(
      startupCoreJob?.groups.find(
        (group) => group.shard_name === "agentic-control-plane-startup-core",
      )?.runner,
    ).toBe(DEFAULT_NODE_TEST_RUNNER);
    expect(
      compact
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === "agentic-control-plane-startup-health-runtime")?.env,
    ).toEqual({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000" });
    const largeJobs = compact.filter(
      (shard) => !shard.requiresDist && shard.checkName.startsWith("checks-node-compact-large-"),
    );
    const smallJobs = compact.filter(
      (shard) => !shard.requiresDist && shard.checkName.startsWith("checks-node-compact-small-"),
    );
    const extraLargeJobs = compact.filter(
      (shard) => !shard.requiresDist && shard.checkName.startsWith("checks-node-compact-large32-"),
    );
    const distJobs = compact.filter((shard) => shard.requiresDist);
    expect(largeJobs.length).toBeGreaterThan(0);
    expect(smallJobs.length).toBeGreaterThan(0);
    expect(extraLargeJobs).toHaveLength(1);
    expect(distJobs).toHaveLength(1);
    expect(largeJobs.length + smallJobs.length + extraLargeJobs.length + distJobs.length).toBe(
      compact.length,
    );
    expect(
      largeJobs.every((shard) =>
        shard.groups.every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER),
      ),
    ).toBe(true);
    expect(
      smallJobs.every((shard) =>
        shard.groups.every((group) => group.runner === BUNDLED_NODE_TEST_RUNNER),
      ),
    ).toBe(true);
    expect(extraLargeJobs[0]?.runner).toBe(EXTRA_LARGE_NODE_TEST_RUNNER);
    for (const shard of [
      ...compact,
      ...pullRequestCompact,
      ...githubCompact,
      ...githubPullRequestCompact,
      ...hybridCompact,
      ...hybridPullRequestCompact,
    ]) {
      for (const group of shard.groups) {
        if (
          !group.configs.some((config) => /vitest\.cli(?:-process)?\.config\.ts$/u.test(config))
        ) {
          continue;
        }
        expect(isExclusiveCompactShardName(group.shard_name)).toBe(true);
        expect(group.env?.OPENCLAW_VITEST_MAX_WORKERS).toBe("2");
        if ((shard.predictedSeconds ?? 0) > 150) {
          expect(shard.groups).toHaveLength(1);
        }
      }
    }
    expect(compact).toEqual(
      createNodeTestShardBundles({
        includeReleaseOnlyPluginShards: false,
        compactMode: "push",
      }),
    );
    const embeddedAgentGroups = compact
      .flatMap((shard) => shard.groups)
      .filter((group) => group.shard_name.startsWith("agentic-agents-embedded-"));
    expect(embeddedAgentGroups.map((group) => group.shard_name).toSorted()).toEqual(
      expectedEmbeddedAgentGroupNames,
    );
    expect(
      compact.some((shard) =>
        shard.groups.some((group) => group.shard_name === "agentic-agents-embedded"),
      ),
    ).toBe(false);
    // The base config repeats once per stripe; its files stay partitioned below.
    expect(new Set(embeddedAgentGroups.flatMap((group) => group.configs))).toEqual(
      new Set(embeddedAgentVitestProjectOwners.map((owner) => owner.config)),
    );
    expect(
      embeddedAgentGroups.every(
        (group) => group.env?.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS === "660000",
      ),
    ).toBe(true);
    // The base config runs serially with a shared module graph, so its stripes
    // must partition the owner's files: a repeat re-runs a suite, a miss drops it.
    const embeddedBaseGroups = embeddedAgentGroups.filter((group) =>
      /^agentic-agents-embedded-base-\d+$/u.test(group.shard_name),
    );
    const embeddedBaseFiles = embeddedBaseGroups.flatMap((group) => group.includePatterns ?? []);
    expect(embeddedBaseGroups).toHaveLength(3);
    expect(
      embeddedBaseGroups.every(
        (group) => group.configs[0] === agentVitestProjectOwners.embedded.config,
      ),
    ).toBe(true);
    expect(new Set(embeddedBaseFiles).size).toBe(embeddedBaseFiles.length);
    expect(embeddedBaseFiles.toSorted((a, b) => a.localeCompare(b))).toEqual(
      embeddedBaseOwnerFiles.toSorted((a, b) => a.localeCompare(b)),
    );
    expect(
      compact
        .filter((shard) => shard.groups.some((group) => !group.includePatterns))
        .every((shard) => shard.timeoutMinutes === 120),
    ).toBe(true);
    // Whole-config groups now pack into the same runtime-balanced bins as
    // include-pattern groups; the separate "-whole-" job class is gone.
    expect(compact.some((shard) => shard.checkName.includes("-whole-"))).toBe(false);
    expect(
      compact.some((shard) => shard.groups.some((group) => group.shard_name === "core-tooling")),
    ).toBe(false);
    expect(
      pullRequestCompact
        .flatMap((shard) => shard.groups)
        .find((group) => group.shard_name === "core-tooling-isolated"),
    ).toEqual(
      expect.objectContaining({
        configs: [
          "test/vitest/vitest.tooling-docker.config.ts",
          "test/vitest/vitest.tooling-isolated.config.ts",
        ],
      }),
    );
    // The docker helper config rides with the isolated shard on both plans;
    // no standalone core-tooling-docker group remains.
    expect(
      pullRequestCompact
        .flatMap((shard) => shard.groups)
        .some((group) => group.shard_name === "core-tooling-docker"),
    ).toBe(false);
    const toolingGroups = pullRequestCompactGroups.filter((group) =>
      /^core-tooling-\d+(?:-hosted-\d+)?$/u.test(group.shard_name),
    );
    const toolingFiles = toolingGroups.flatMap((group) => group.includePatterns ?? []);
    expect(
      new Set(
        [...compactOwnerNames(pullRequestCompact)].filter((name) =>
          /^core-tooling-\d+$/u.test(name),
        ),
      ),
    ).toEqual(new Set(expectedToolingOwnerNames));
    expect(
      toolingGroups.every((group) => group.configs[0] === "test/vitest/vitest.tooling.config.ts"),
    ).toBe(true);
    expect(new Set(toolingFiles).size).toBe(toolingFiles.length);
    expect(toolingFiles.toSorted((a, b) => a.localeCompare(b))).toEqual(listAllToolingTestFiles());
  });

  it("splits the slow core unit shards while keeping paired source/security coverage", () => {
    const coreUnitShards = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("core-unit-"))
      .map((shard) => ({
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        shardName: shard.shardName,
      }));

    expect(coreUnitShards).toEqual([
      {
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-1",
      },
      {
        configs: ["test/vitest/vitest.unit-fast.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-2",
      },
      {
        configs: ["test/vitest/vitest.unit-fast-isolated.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-isolated",
      },
      {
        configs: ["test/vitest/vitest.unit-fast-fake-timers.config.ts"],
        requiresDist: false,
        shardName: "core-unit-fast-fake-timers",
      },
      {
        configs: ["test/vitest/vitest.unit-src.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-1",
      },
      {
        configs: ["test/vitest/vitest.unit-src.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-2",
      },
      {
        configs: ["test/vitest/vitest.unit-src.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-3",
      },
      {
        configs: ["test/vitest/vitest.unit-security.config.ts"],
        requiresDist: false,
        shardName: "core-unit-src-security-support",
      },
      {
        configs: ["test/vitest/vitest.unit-support.config.ts"],
        requiresDist: false,
        shardName: "core-unit-support",
      },
    ]);
  });

  it("keeps Doctor session SQLite owners complete and isolated", () => {
    const ownerNames = [
      "agentic-commands-doctor-sessions-cron",
      "agentic-commands-doctor-sessions-cron-memory",
      "agentic-commands-doctor-sessions-cron-sqlite",
    ];
    const base = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const commandShards = base.filter((shard) =>
      shard.configs.includes("test/vitest/vitest.commands.config.ts"),
    );
    const owners = new Map(
      commandShards
        .filter((shard) => ownerNames.includes(shard.shardName))
        .map((shard) => [shard.shardName, shard.includePatterns]),
    );
    expect(owners.get("agentic-commands-doctor-sessions-cron-memory")).toEqual([
      "src/commands/doctor-session-sqlite.memory.test.ts",
    ]);
    expect(owners.get("agentic-commands-doctor-sessions-cron-sqlite")).toEqual([
      "src/commands/doctor-session-sqlite.test.ts",
    ]);
    expect(owners.get("agentic-commands-doctor-sessions-cron")).toEqual([
      "src/commands/doctor-heartbeat-cadence-migration.test.ts",
      "src/commands/doctor-heartbeat-scratch-migration.test.ts",
      "src/commands/doctor-heartbeat-session-target.test.ts",
      "src/commands/doctor-heartbeat-task-migration.test.ts",
      "src/commands/doctor-session-canonical-keys.memory.test.ts",
      "src/commands/doctor-session-canonical-keys.retention.test.ts",
      "src/commands/doctor-session-delivery-state.test.ts",
      "src/commands/doctor-session-exec-policy.test.ts",
      "src/commands/doctor-session-incognito-key-repair.test.ts",
      "src/commands/doctor-session-snapshots.test.ts",
      "src/commands/doctor-session-sqlite-github-issue.test.ts",
      "src/commands/doctor-session-sqlite-readers.test.ts",
      "src/commands/doctor-session-sqlite.shared-store.test.ts",
      "src/commands/doctor-session-state-providers.test.ts",
      "src/commands/doctor-session-transcript-headers.test.ts",
      "src/commands/doctor-session-transcript-labels.test.ts",
      "src/commands/doctor-session-transcripts.incident.test.ts",
      "src/commands/doctor-session-transcripts.test.ts",
    ]);
    const commandFiles = commandShards.flatMap((shard) => shard.includePatterns ?? []).toSorted();
    expect(commandFiles).toEqual(listMatchedTestFiles(createCommandsVitestConfig({})));
    expect(new Set(commandFiles).size).toBe(commandFiles.length);

    for (const compactMode of ["push", "pull-request"] as const) {
      const plan = createNodeTestShardBundles({
        compactMode,
        includeReleaseOnlyPluginShards: false,
        runnerBackend: "blacksmith",
      });
      const jobs = ownerNames.map((name) =>
        plan.findIndex((shard) => shard.groups.some((group) => group.shard_name === name)),
      );
      expect(jobs.every((job) => job >= 0)).toBe(true);
      expect(new Set(jobs).size).toBe(jobs.length);
      expect(
        plan
          .flatMap((shard) => shard.groups)
          .filter((group) => ownerNames.includes(group.shard_name))
          .every((group) => group.runner === DEFAULT_NODE_TEST_RUNNER),
      ).toBe(true);
    }

    const families = [ownerNames, [1, 2, 3].map((part) => `agentic-gateway-core-${part}`)];
    const fixtureConfigs = new Set(
      base
        .filter((shard) => families.some((family) => family.includes(shard.shardName)))
        .flatMap((shard) => shard.configs),
    );
    const originalShards = fullSuiteVitestShards.slice();
    const fixtureShards = originalShards
      .map((shard) => ({
        ...shard,
        projects: shard.projects.filter((config) => fixtureConfigs.has(config)),
      }))
      .filter((shard) => shard.projects.length > 0);
    fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...fixtureShards);
    try {
      // Affordable descendants must also stay apart from their unsplit ancestors'
      // siblings: an immediate-selector-only rule loses the Doctor/giant boundary.
      const fixtureTimings = Object.fromEntries(
        base
          .filter((shard) => shard.configs.some((config) => fixtureConfigs.has(config)))
          .map((shard) => [shard.shardName, 1]),
      );
      vi.spyOn(testTimings, "readCompactGroupTimings").mockImplementation((profile) => ({
        ...fixtureTimings,
        ...Object.fromEntries(
          families.flatMap((family) =>
            family.map((name, index) => [
              name,
              index === 0 ? (profile === "github" ? 400 : 100) : 10,
            ]),
          ),
        ),
      }));
      const nestedPlan = createNodeTestShardBundles({
        compactMode: "pull-request",
        includeReleaseOnlyPluginShards: false,
        runnerBackend: "hybrid",
      });
      for (const family of families) {
        const placements = nestedPlan.flatMap((job, jobIndex) =>
          job.groups
            .filter((group) => family.includes(group.shard_name.replace(/-hosted-\d+$/u, "")))
            .map((group) => ({ group, jobIndex })),
        );
        expect(
          placements.filter(({ group }) => group.shard_name.startsWith(`${family[0]}-hosted-`)),
        ).toHaveLength(3);
        expect(new Set(placements.map(({ jobIndex }) => jobIndex)).size, family[0]).toBe(
          placements.length,
        );
        for (const name of family) {
          const actual = placements
            .filter(({ group }) => group.shard_name.replace(/-hosted-\d+$/u, "") === name)
            .flatMap(({ group }) => group.includePatterns ?? []);
          expect(actual.toSorted(), name).toEqual(
            base.find((shard) => shard.shardName === name)?.includePatterns?.toSorted(),
          );
        }
      }
    } finally {
      fullSuiteVitestShards.splice(0, fullSuiteVitestShards.length, ...originalShards);
    }
  });

  it("partitions each giant compact group across three deterministic stripes", () => {
    const env = { ...process.env, OPENCLAW_VITEST_INCLUDE_FILE: undefined };
    const cases = [
      {
        stripeConfigs: [createUiVitestConfig(env)],
        supportConfigs: [
          createMediaVitestConfig(env),
          createMediaUnderstandingVitestConfig(env),
          createTuiVitestConfig(env),
          createUiIsolatedVitestConfig(env),
          createWizardVitestConfig(env),
        ],
        prefix: "core-runtime-media-ui",
      },
      {
        stripeConfigs: [createGatewayCoreVitestConfig(env), createGatewayClientVitestConfig(env)],
        supportConfigs: [],
        prefix: "agentic-gateway-core",
      },
      {
        stripeConfigs: [
          createUnitVitestConfigWithOptions(env, {
            name: "unit-src",
            includePatterns: ["src/**/*.test.ts"],
            extraExcludePatterns: ["src/acp/**", "src/security/**"],
          }),
        ],
        supportConfigs: [
          createUnitVitestConfigWithOptions(env, {
            name: "unit-security",
            includePatterns: ["src/security/**/*.test.ts"],
            passWithNoTests: true,
          }),
        ],
        prefix: "core-unit-src-security",
      },
    ];

    const shards = createNodeTestShards();
    for (const { prefix, stripeConfigs, supportConfigs } of cases) {
      const stripes = shards.filter(
        (shard) => /^.+-\d+$/u.test(shard.shardName) && shard.shardName.startsWith(`${prefix}-`),
      );
      // Files needing a pretest build are pulled into a sibling `-runtime`
      // shard so only one job builds; coverage must still be complete across
      // the stripes plus that shard.
      const coverageShards = shards.filter((shard) => shard.shardName.startsWith(`${prefix}-`));
      const actual = coverageShards
        .flatMap((shard) => shard.includePatterns ?? [])
        .toSorted((a, b) => a.localeCompare(b));
      const expected = stripeConfigs
        .flatMap((config) => listMatchedTestFiles(config))
        .toSorted((a, b) => a.localeCompare(b));

      expect(stripes.map((stripe) => stripe.shardName)).toEqual([
        `${prefix}-1`,
        `${prefix}-2`,
        `${prefix}-3`,
      ]);
      expect(stripes.every((stripe) => (stripe.includePatterns?.length ?? 0) > 0)).toBe(true);
      expect(new Set(actual).size).toBe(actual.length);
      expect(actual).toEqual(expected);

      const support = shards.find((shard) => shard.shardName === `${prefix}-support`);
      if (supportConfigs.length === 0) {
        expect(support).toBeUndefined();
      } else {
        expect(support?.includePatterns).toBeUndefined();
        expect(support?.configs).toHaveLength(supportConfigs.length);
      }
    }
  });

  it("names the node shard checks as core test lanes", () => {
    const shards = createNodeTestShards();

    expect(shards).not.toHaveLength(0);
    expect(shards.map((shard) => shard.checkName)).toEqual(
      shards.map((shard) =>
        shard.shardName.startsWith("core-unit-")
          ? `checks-node-core-${shard.shardName.slice("core-unit-".length)}`
          : `checks-node-${shard.shardName}`,
      ),
    );
  });

  it("keeps extension, bundled, contracts, and channels configs out of the core node lane", () => {
    const configs = createNodeTestShards().flatMap((shard) => shard.configs);

    expect(configs).not.toContain("test/vitest/vitest.channels.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.contracts.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.bundled.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
    expect(configs).not.toContain("test/vitest/vitest.extension-telegram.config.ts");
  });

  it("keeps compact agentic config ownership aligned with the full agentic project set", () => {
    const fullAgenticShard = fullSuiteVitestShards.find((shard) => shard.name === "agentic");
    const intentionallyExcludedConfigs = new Set(["test/vitest/vitest.channels.config.ts"]);
    const expectedConfigs = (fullAgenticShard?.projects ?? [])
      .filter((config) => !intentionallyExcludedConfigs.has(config))
      .toSorted((left, right) => left.localeCompare(right));
    const actualConfigs = [
      ...new Set(
        createNodeTestShards()
          .filter((shard) => shard.shardName.startsWith("agentic-"))
          .flatMap((shard) => shard.configs),
      ),
    ].toSorted((left, right) => left.localeCompare(right));

    expect(fullAgenticShard).toBeDefined();
    expect(actualConfigs).toEqual(expectedConfigs);
  });

  it("marks only dist-dependent shards for built artifact restore", () => {
    const requiresDistShardNames = createNodeTestShards()
      .filter((shard) => shard.requiresDist)
      .map((shard) => shard.shardName);

    expect(requiresDistShardNames).toEqual(["core-support-boundary", "core-runtime-tui-pty"]);
  });

  it("preserves runtime preparation and core-only ownership in full and compact plans", () => {
    const qaConfig = "test/vitest/vitest.extension-qa.config.ts";
    const doctorRuntimeTargets = [
      "src/commands/doctor-config-preflight.process.test.ts",
      "src/commands/doctor-config-preflight.v17-atomicity.process.test.ts",
    ];
    const runtimeTargets = [
      "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
      ...doctorRuntimeTargets,
      "src/gateway/gateway-active-memory.test.ts",
      "src/gateway/gateway-concurrent-streams.test.ts",
      "src/gateway/gateway-cron-process-identity.windows.test.ts",
    ];
    const full = createNodeTestShards();
    const compact = createNodeTestShardBundles({ compact: true, compactMode: "pull-request" });
    for (const shards of [full, compact]) {
      expect(
        shards.flatMap((shard) =>
          "configs" in shard ? shard.configs : shard.groups.flatMap((group) => group.configs),
        ),
      ).not.toContain(qaConfig);
      for (const runtimeTarget of runtimeTargets) {
        const owner = shards.find((shard) =>
          ("configs" in shard ? [shard] : shard.groups).some((group) =>
            group.includePatterns?.includes(runtimeTarget),
          ),
        );
        expect(owner?.pretestBuildMode, runtimeTarget).toBe("runtime");
        if (owner && "groups" in owner) {
          expect(
            owner.groups?.find((group) => group.includePatterns?.includes(runtimeTarget))
              ?.pretestBuildMode,
            runtimeTarget,
          ).toBe("runtime");
        }
      }
    }

    const doctorName = "agentic-commands-doctor-config-state";
    const doctor = full.find((shard) => shard.shardName === doctorName)!;
    const placements = compact.flatMap((job, jobIndex) =>
      job.groups
        .filter((group) => group.shard_name.replace(/-hosted-\d+$/u, "") === doctorName)
        .map((group) => ({ group, job, jobIndex })),
    );
    const runtimeParts = placements.filter(({ group }) => group.pretestBuildMode === "runtime");
    expect(runtimeParts).toHaveLength(1);
    expect(runtimeParts[0]?.job.planConcurrency).toBe(1);
    expect(runtimeParts[0]?.group.includePatterns).toEqual(doctorRuntimeTargets);
    expect(placements.some(({ group }) => group.pretestBuildMode === undefined)).toBe(true);
    expect(placements.flatMap(({ group }) => group.includePatterns ?? []).toSorted()).toEqual(
      doctor.includePatterns?.toSorted(),
    );
    expect(new Set(placements.map(({ jobIndex }) => jobIndex)).size).toBe(placements.length);
    for (const { group } of placements) {
      expect(group.configs).toEqual(doctor.configs);
      expect(group.env).toEqual(doctor.env);
      expect(group.requiresDist).toBe(doctor.requiresDist);
      expect(group.runner).toBe(BUNDLED_NODE_TEST_RUNNER);
    }
  });

  it("splits tooling checks independently from built artifacts", () => {
    const compilerFixture = "test/scripts/write-unified-entry-dts.test.ts";
    const toolingShards = createNodeTestShards().filter((shard) =>
      shard.shardName.startsWith("core-tooling"),
    );
    const compilerParent = toolingShards.find((shard) =>
      shard.includePatterns?.includes(compilerFixture),
    )!;
    for (const runnerBackend of ["blacksmith", "hybrid", "github"]) {
      const jobs = createNodeTestShardBundles({ compactMode: "pull-request", runnerBackend });
      const owner = jobs.find((job) =>
        job.groups.some((group) => group.includePatterns?.includes(compilerFixture)),
      );
      // This fixture runs the real full-build guard, which needs more than the
      // available heap observed inside a small runner's retained tooling graph.
      expect(owner?.runner, runnerBackend).toBe(
        runnerBackend === "blacksmith" ? EXTRA_LARGE_NODE_TEST_RUNNER : DEFAULT_NODE_TEST_RUNNER,
      );
      expect(
        jobs
          .flatMap((job) => job.groups)
          .filter((group) => group.includePatterns?.includes(compilerFixture)),
      ).toHaveLength(1);
      if (runnerBackend !== "blacksmith") {
        const siblings = jobs
          .flatMap((job) => job.groups)
          .filter(
            (group) =>
              group.shard_name.startsWith(`${compilerParent.shardName}-hosted-`) &&
              !group.includePatterns?.includes(compilerFixture),
          );
        expect(siblings.length).toBeGreaterThan(0);
        expect(siblings.every((group) => group.runner === BUNDLED_NODE_TEST_RUNNER)).toBe(true);
      }
    }

    const stripes = toolingShards.filter((shard) => /^core-tooling-\d+$/u.test(shard.shardName));
    expect(stripes).toHaveLength(16);
    for (const stripe of stripes) {
      expect(stripe.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
      expect(stripe.requiresDist).toBe(false);
      expect(stripe.includePatterns?.length ?? 0).toBeGreaterThan(0);
    }
    // Stripes partition the tooling files: no overlap, nothing dropped.
    const stripeFiles = stripes.flatMap((stripe) => stripe.includePatterns ?? []);
    expect(new Set(stripeFiles).size).toBe(stripeFiles.length);
    const processProofFiles = [
      "test/scripts/ci-git-owner.test.ts",
      "test/scripts/managed-child-process.test.ts",
      "test/scripts/vitest-worker-artifacts.test.ts",
      "test/scripts/vitest-worker-artifacts.transforms.test.ts",
      "test/scripts/openclaw-performance-git-lifecycle.test.ts",
      "test/scripts/ci-linux-git.test.ts",
      "test/scripts/pr-merge-outcome.test.ts",
    ];
    const processProofStripes = processProofFiles.map(
      (file) => stripes.find((stripe) => stripe.includePatterns?.includes(file))?.shardName,
    );
    expect(processProofStripes).not.toContain(undefined);
    expect(new Set(processProofStripes).size).toBe(processProofFiles.length);
    expect(
      stripes.find((stripe) =>
        stripe.includePatterns?.includes(
          "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
        ),
      )?.pretestBuildMode,
    ).toBe("runtime");
    expect(
      toolingShards.find((shard) => shard.shardName === "core-tooling-isolated"),
    ).toMatchObject({
      configs: [
        "test/vitest/vitest.tooling-docker.config.ts",
        "test/vitest/vitest.tooling-isolated.config.ts",
      ],
      requiresDist: false,
    });
  });

  it("assigns Blacksmith runners to every core node shard", () => {
    const shards = createNodeTestShards();

    expect(shards).not.toHaveLength(0);
    expect(shards.every((shard) => shard.runner?.startsWith("blacksmith-"))).toBe(true);
  });

  it("splits core runtime configs into smaller source-only shards", () => {
    const runtimeShards = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("core-runtime-"))
      .map((shard) => ({
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        runner: shard.runner,
        shardName: shard.shardName,
      }));

    expect(runtimeShards).toEqual([
      {
        configs: ["test/vitest/vitest.hooks.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-hooks",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-approval-exec",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-channel-plugin",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-cli-ui",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-device",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-diagnostics-state",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-core-utils",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-env-auth",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-events-runtime",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-file-safety",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-files-commands",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-lock-argv",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-processes",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-gateway-watch",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-heartbeat-core",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-heartbeat-runner",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-dedupe-disk",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-os",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-misc-values",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-net-install",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-network-node",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-network-platform",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-outbound-actions",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-outbound-core",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-provider-push",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-repo-tooling",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-storage-state",
      },
      {
        configs: ["test/vitest/vitest.infra.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-system-runtime",
      },
      {
        configs: ["test/vitest/vitest.secrets.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-secrets",
      },
      {
        configs: ["test/vitest/vitest.logging.config.ts", "test/vitest/vitest.process.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-infra-process",
      },
      {
        configs: ["test/vitest/vitest.runtime-config.config.ts"],
        requiresDist: false,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-config",
      },
      {
        configs: ["test/vitest/vitest.tui-pty.config.ts"],
        requiresDist: true,
        runner: "blacksmith-4vcpu-ubuntu-2404",
        shardName: "core-runtime-tui-pty",
      },
      {
        configs: ["test/vitest/vitest.ui.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-1",
      },
      {
        configs: ["test/vitest/vitest.ui.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-2",
      },
      {
        configs: ["test/vitest/vitest.ui.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-3",
      },
      {
        configs: [
          "test/vitest/vitest.media.config.ts",
          "test/vitest/vitest.media-understanding.config.ts",
          "test/vitest/vitest.tui.config.ts",
          "test/vitest/vitest.ui-isolated.config.ts",
          "test/vitest/vitest.wizard.config.ts",
        ],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-media-ui-support",
      },
      {
        configs: [
          "test/vitest/vitest.acp.config.ts",
          "test/vitest/vitest.shared-core.config.ts",
          "test/vitest/vitest.tasks.config.ts",
          "test/vitest/vitest.utils.config.ts",
        ],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-shared",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-core",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-isolated-agent",
      },
      {
        configs: ["test/vitest/vitest.cron.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "core-runtime-cron-service",
      },
    ]);
  });

  it("keeps the full TUI PTY suite in its dedicated built-CLI shard", () => {
    const tuiPtyShard = createNodeTestShards().find(
      (shard) => shard.shardName === "core-runtime-tui-pty",
    );

    expect(tuiPtyShard).toMatchObject({
      checkName: "checks-node-core-runtime-tui-pty",
      configs: ["test/vitest/vitest.tui-pty.config.ts"],
      env: {
        OPENCLAW_TUI_PTY_INCLUDE_LOCAL: "1",
        OPENCLAW_TUI_PTY_USE_BUILT_CLI: "1",
      },
      requiresDist: true,
    });
    expect(tuiPtyShard?.includePatterns).toBeUndefined();
  });

  it("covers every infra test exactly once across core runtime infra shards", () => {
    const infraShards = createNodeTestShards().filter((shard) =>
      shard.shardName.startsWith("core-runtime-infra-"),
    );
    const actual = infraShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(infraShards.map((shard) => shard.shardName)).toEqual([
      "core-runtime-infra-approval-exec",
      "core-runtime-infra-channel-plugin",
      "core-runtime-infra-cli-ui",
      "core-runtime-infra-device",
      "core-runtime-infra-diagnostics-state",
      "core-runtime-infra-core-utils",
      "core-runtime-infra-env-auth",
      "core-runtime-infra-events-runtime",
      "core-runtime-infra-file-safety",
      "core-runtime-infra-files-commands",
      "core-runtime-infra-gateway-lock-argv",
      "core-runtime-infra-gateway-processes",
      "core-runtime-infra-gateway-watch",
      "core-runtime-infra-heartbeat-core",
      "core-runtime-infra-heartbeat-runner",
      "core-runtime-infra-misc",
      "core-runtime-infra-misc-dedupe-disk",
      "core-runtime-infra-misc-os",
      "core-runtime-infra-misc-values",
      "core-runtime-infra-net-install",
      "core-runtime-infra-network-node",
      "core-runtime-infra-network-platform",
      "core-runtime-infra-outbound-actions",
      "core-runtime-infra-outbound-core",
      "core-runtime-infra-provider-push",
      "core-runtime-infra-repo-tooling",
      "core-runtime-infra-storage-state",
      "core-runtime-infra-system-runtime",
      "core-runtime-infra-process",
    ]);
    expect(actual).toEqual(listTestFiles("src/infra"));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("covers every cron test exactly once across core runtime cron shards", () => {
    const cronShards = createNodeTestShards().filter((shard) =>
      shard.shardName.startsWith("core-runtime-cron-"),
    );
    const actual = cronShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(cronShards.map((shard) => shard.shardName)).toEqual([
      "core-runtime-cron-core",
      "core-runtime-cron-isolated-agent",
      "core-runtime-cron-service",
    ]);
    expect(actual).toEqual(listTestFiles("src/cron"));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("splits the agentic lane into control-plane, command, agent, gateway, SDK, and plugin shards", () => {
    const shards = createNodeTestShards();
    const controlPlaneShards = shards.filter((shard) =>
      shard.shardName.startsWith("agentic-control-plane-"),
    );
    const cliShard = shards.find((shard) => shard.shardName === "agentic-cli");
    const cliProcessShard = shards.find((shard) => shard.shardName === "agentic-cli-process");
    const commandSupportShard = shards.find(
      (shard) => shard.shardName === "agentic-command-support",
    );
    const commandShards = shards.filter((shard) => shard.shardName.startsWith("agentic-commands-"));
    const agentShards = shards.filter((shard) => shard.shardName.startsWith("agentic-agents-"));
    const gatewayCoreShards = shards.filter((shard) =>
      shard.shardName.startsWith("agentic-gateway-core-"),
    );
    const gatewayMethodsShard = shards.find(
      (shard) => shard.shardName === "agentic-gateway-methods",
    );
    const pluginSdkShard = shards.find((shard) => shard.shardName === "agentic-plugin-sdk");
    const pluginsShard = shards.find((shard) => shard.shardName === "agentic-plugins");

    expect(controlPlaneShards.map((shard) => shard.shardName)).toEqual([
      "agentic-control-plane-agent-chat",
      "agentic-control-plane-auth-node",
      "agentic-control-plane-http-models",
      "agentic-control-plane-http-plugin-ws",
      "agentic-control-plane-runtime",
      "agentic-control-plane-runtime-config",
      "agentic-control-plane-runtime-cron",
      "agentic-control-plane-runtime-network",
      "agentic-control-plane-runtime-server",
      "agentic-control-plane-runtime-shared-token",
      "agentic-control-plane-runtime-state",
      "agentic-control-plane-runtime-ui-tools",
      "agentic-control-plane-startup-config",
      "agentic-control-plane-startup-core",
      "agentic-control-plane-startup-health-runtime",
      "agentic-control-plane-startup-restart-close",
    ]);
    expect(controlPlaneShards).toEqual(
      controlPlaneShards.map((shard) => ({
        checkName: `checks-node-${shard.shardName}`,
        configs: ["test/vitest/vitest.gateway-server.config.ts"],
        ...(shard.shardName === "agentic-control-plane-startup-health-runtime"
          ? { env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "60000" } }
          : {}),
        includePatterns: shard.includePatterns,
        requiresDist: false,
        runner:
          shard.shardName === "agentic-control-plane-startup-core"
            ? DEFAULT_NODE_TEST_RUNNER
            : "blacksmith-4vcpu-ubuntu-2404",
        shardName: shard.shardName,
      })),
    );
    const controlPlaneShardFiles = controlPlaneShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expectedControlPlaneFiles = listMatchedTestFiles(
      createGatewayServerVitestConfig({
        ...process.env,
        OPENCLAW_VITEST_INCLUDE_FILE: undefined,
      }),
    );
    expect(
      listTestFiles("src/gateway")
        .filter(isGatewayServerTestFile)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(expectedControlPlaneFiles);
    expect(controlPlaneShardFiles).toEqual(expectedControlPlaneFiles);
    expect(new Set(controlPlaneShardFiles).size).toBe(controlPlaneShardFiles.length);
    expect(cliShard).toEqual({
      checkName: "checks-node-agentic-cli",
      shardName: "agentic-cli",
      configs: ["test/vitest/vitest.cli.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(cliProcessShard).toEqual({
      checkName: "checks-node-agentic-cli-process",
      shardName: "agentic-cli-process",
      configs: ["test/vitest/vitest.cli-process.config.ts"],
      pretestBuildMode: "runtime",
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(commandSupportShard).toEqual({
      checkName: "checks-node-agentic-command-support",
      shardName: "agentic-command-support",
      configs: [
        "test/vitest/vitest.commands-light.config.ts",
        "test/vitest/vitest.daemon.config.ts",
      ],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(commandShards.map((shard) => shard.shardName)).toEqual([
      "agentic-commands-agent-channel",
      "agentic-commands-doctor",
      "agentic-commands-doctor-auth",
      "agentic-commands-doctor-config-state",
      "agentic-commands-doctor-device",
      "agentic-commands-doctor-gateway",
      "agentic-commands-doctor-platform",
      "agentic-commands-doctor-plugins-tools",
      "agentic-commands-doctor-sessions-cron",
      "agentic-commands-doctor-sessions-cron-memory",
      "agentic-commands-doctor-sessions-cron-sqlite",
      "agentic-commands-doctor-shared",
      "agentic-commands-doctor-whatsapp",
      "agentic-commands-doctor-workspace",
      "agentic-commands-models",
      "agentic-commands-onboard-config",
      "agentic-commands-status-tools",
    ]);
    expect(commandShards).toEqual(
      commandShards.map((shard) => ({
        checkName: `checks-node-${shard.shardName}`,
        configs: ["test/vitest/vitest.commands.config.ts"],
        includePatterns: shard.includePatterns,
        ...(shard.shardName === "agentic-commands-doctor-config-state"
          ? { pretestBuildMode: "runtime" }
          : {}),
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: shard.shardName,
      })),
    );
    expect(
      commandShards.find((shard) => shard.shardName === "agentic-commands-doctor-auth")
        ?.includePatterns,
    ).toContain("src/commands/oauth-tls-preflight.doctor.test.ts");
    const commandShardFiles = commandShards
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expectedCommandFiles = listMatchedTestFiles(createCommandsVitestConfig({}));
    expect(commandShardFiles).toEqual(expectedCommandFiles);
    expect(new Set(commandShardFiles).size).toBe(commandShardFiles.length);
    expect(agentShards).toEqual([
      {
        checkName: "checks-node-agentic-agents-core-auth",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[0]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-auth",
      },
      {
        checkName: "checks-node-agentic-agents-core-models",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[1]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-models",
      },
      {
        checkName: "checks-node-agentic-agents-core-tools",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[2]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-tools",
      },
      {
        checkName: "checks-node-agentic-agents-core-subagents",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[3]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-subagents",
      },
      // cli-runner stripes: agents-core runs files serially, so the
      // import-heavy suite splits across jobs to parallelize at bin level.
      {
        checkName: "checks-node-agentic-agents-core-runner-cli-1",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[4]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-cli-1",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-cli-2",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[5]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-cli-2",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-cli-3",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[6]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-cli-3",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-commands",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[7]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-commands",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-embedded",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[8]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-embedded",
      },
      {
        checkName: "checks-node-agentic-agents-core-runner-sessions",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[9]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runner-sessions",
      },
      {
        checkName: "checks-node-agentic-agents-core-runtime",
        configs: ["test/vitest/vitest.agents-core.config.ts"],
        includePatterns: agentShards[10]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-runtime",
      },
      {
        checkName: "checks-node-agentic-agents-core-isolated",
        configs: ["test/vitest/vitest.agents-core-isolated.config.ts"],
        includePatterns: agentShards[11]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-core-isolated",
      },
      {
        checkName: "checks-node-agentic-agents-embedded",
        configs: [
          "test/vitest/vitest.agents-embedded-agent.config.ts",
          "test/vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts",
          "test/vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts",
          "test/vitest/vitest.agents-embedded-agent-run.config.ts",
        ],
        env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "660000" },
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-embedded",
      },
      {
        checkName: "checks-node-agentic-agents-support",
        configs: ["test/vitest/vitest.agents-support.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-support",
      },
      {
        checkName: "checks-node-agentic-agents-tools",
        configs: ["test/vitest/vitest.agents-tools.config.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
        shardName: "agentic-agents-tools",
      },
    ]);
    expect(pluginSdkShard).toEqual({
      checkName: "checks-node-agentic-plugin-sdk",
      shardName: "agentic-plugin-sdk",
      configs: [
        "test/vitest/vitest.plugin-sdk-light.config.ts",
        "test/vitest/vitest.plugin-sdk.config.ts",
      ],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    const gatewayCoreConfigs = [
      "test/vitest/vitest.gateway-core.config.ts",
      "test/vitest/vitest.gateway-client.config.ts",
    ];
    expect(gatewayCoreShards.slice(0, 3)).toEqual(
      [1, 2, 3].map((stripe) => ({
        checkName: `checks-node-agentic-gateway-core-${stripe}`,
        shardName: `agentic-gateway-core-${stripe}`,
        configs: gatewayCoreConfigs,
        includePatterns: gatewayCoreShards[stripe - 1]?.includePatterns,
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
      })),
    );
    // The pretest runtime build is charged per job, so the files that need it
    // stay in one shard; the ordinary stripes must never carry a build mode.
    expect(gatewayCoreShards.filter((shard) => shard.pretestBuildMode != null)).toEqual([
      {
        checkName: "checks-node-agentic-gateway-core-runtime",
        shardName: "agentic-gateway-core-runtime",
        configs: gatewayCoreConfigs,
        includePatterns: [
          "src/gateway/gateway-active-memory.test.ts",
          "src/gateway/gateway-concurrent-streams.test.ts",
          "src/gateway/gateway-cron-process-identity.windows.test.ts",
        ],
        pretestBuildMode: "runtime",
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
      },
    ]);
    expect(gatewayMethodsShard).toEqual({
      checkName: "checks-node-agentic-gateway-methods",
      shardName: "agentic-gateway-methods",
      configs: [
        "test/vitest/vitest.gateway-methods.config.ts",
        "test/vitest/vitest.gateway-methods-isolated.config.ts",
      ],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      shardName: "agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
    });
  });

  it("keeps plugin prerelease npm install behavior on the release-only agentic plugin shard", () => {
    const pluginsShard = createNodeTestShards().find(
      (shard) => shard.shardName === "agentic-plugins",
    );

    expect(pluginsShard).toEqual({
      checkName: "checks-node-agentic-plugins",
      configs: ["test/vitest/vitest.plugins.config.ts"],
      requiresDist: false,
      runner: DEFAULT_NODE_TEST_RUNNER,
      shardName: "agentic-plugins",
    });
    expect(listMatchedTestFiles(createPluginsVitestConfig({}))).toContain(
      PLUGIN_PRERELEASE_NPM_SPEC_TEST,
    );
  });

  it("covers flat agents-core and explicitly nested isolated tests exactly once", () => {
    const actual = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("agentic-agents-core-"))
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));
    const expected = [
      ...listTestFiles("src/agents").filter(
        (file) => !relative("src/agents", file).replaceAll("\\", "/").includes("/"),
      ),
      ...agentVitestProjectOwners.coreIsolated.include.filter((file) =>
        relative("src/agents", file).replaceAll("\\", "/").includes("/"),
      ),
    ].toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps embedded-agent tests in four bounded config surfaces", () => {
    const shard = createNodeTestShards().find(
      (candidate) => candidate.shardName === "agentic-agents-embedded",
    );
    const incompleteTurnFiles = new Set(agentVitestProjectOwners.embeddedIncompleteTurn.include);
    const overflowCompactionFiles = new Set(
      agentVitestProjectOwners.embeddedOverflowCompaction.include,
    );
    const actual = [
      ...globSync(agentVitestProjectOwners.embedded.include)
        .map(toRepoPath)
        .filter((file) => !incompleteTurnFiles.has(file) && !overflowCompactionFiles.has(file)),
      ...agentVitestProjectOwners.embeddedIncompleteTurn.include,
      ...agentVitestProjectOwners.embeddedOverflowCompaction.include,
      ...globSync(agentVitestProjectOwners.embeddedRun.include).map(toRepoPath),
    ].toSorted((left, right) => left.localeCompare(right));
    const expected = listTestFiles("src/agents/embedded-agent-runner").toSorted((left, right) =>
      left.localeCompare(right),
    );

    expect(shard?.configs).toEqual(embeddedAgentVitestProjectOwners.map((owner) => owner.config));
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps expensive plugin shards release-only when normal CI asks for the cheaper plan", () => {
    const shards = createNodeTestShards({ includeReleaseOnlyPluginShards: false });
    const shardNames = shards.map((shard) => shard.shardName);

    expect(shardNames).not.toContain("agentic-plugins");
    expect(shardNames).toContain("agentic-gateway-core-1");
    expect(shardNames).toContain("agentic-gateway-core-2");
    expect(shardNames).toContain("agentic-gateway-core-3");
    expect(shardNames).toContain("agentic-gateway-methods");
    expect(shardNames).toContain("agentic-plugin-sdk");
  });

  it("retains the changed host plugin test when the store-alias diff forces fallback", () => {
    expect(createChangedNodeTestShards(STORE_ALIAS_CHANGED_PATHS)).toBeNull();
    const options = {
      changedPaths: STORE_ALIAS_CHANGED_PATHS,
      includeReleaseOnlyPluginShards: false,
    };
    const shards = [
      ...createNodeTestShards(options),
      ...createChangedExtensionFallbackShards(STORE_ALIAS_CHANGED_PATHS),
    ];
    expect(shards.filter((shard) => shard.shardName === "agentic-plugins")).toEqual([
      {
        checkName: "checks-node-agentic-plugins",
        shardName: "agentic-plugins",
        configs: ["test/vitest/vitest.plugins.config.ts"],
        includePatterns: ["src/plugins/tools.optional.test.ts"],
        requiresDist: false,
        runner: DEFAULT_NODE_TEST_RUNNER,
      },
    ]);
  });

  it("retains only exact changed plugin-owner tests in deterministic order", () => {
    const options = {
      includeReleaseOnlyPluginShards: false,
      changedPaths: [
        ...STORE_ALIAS_CHANGED_PATHS.toReversed(),
        "./src/plugins/tools.optional.test.ts",
        PLUGIN_PRERELEASE_NPM_SPEC_TEST,
        "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
        "src/plugins/loader.test.ts",
        "src/plugins/install.npm-spec.e2e.test.ts",
      ],
    };
    const shards = createNodeTestShards(options);
    expect(shards.find((shard) => shard.shardName === "agentic-plugins")?.includePatterns).toEqual([
      PLUGIN_PRERELEASE_NPM_SPEC_TEST,
      "src/plugins/tools.optional.test.ts",
    ]);
    expect(shards.filter((shard) => shard.shardName !== "agentic-plugins")).toEqual(
      createNodeTestShards({ includeReleaseOnlyPluginShards: false }),
    );
    expect(createNodeTestShards({ ...options, includeReleaseOnlyPluginShards: true })).toEqual(
      createNodeTestShards(),
    );
  });

  it("does not widen plugin coverage for deleted tests, sources, docs, or directories", () => {
    const deletedTest = "src/plugins/deleted-ci-routing.test.ts";
    expect(existsSync(deletedTest)).toBe(false);
    const options = {
      includeReleaseOnlyPluginShards: false,
      changedPaths: [deletedTest, "src/plugins/tools.ts", "src/plugins", "docs/ci.md"],
    };
    expect(createNodeTestShards(options)).toEqual(
      createNodeTestShards({ includeReleaseOnlyPluginShards: false }),
    );
  });

  it.each(["blacksmith", "github", "hybrid"])(
    "retains changed plugin tests once in %s compact fallback without changing group policies",
    (runnerBackend) => {
      const options = {
        compactMode: "pull-request" as const,
        includeReleaseOnlyPluginShards: false,
        runnerBackend,
      };
      const before = createNodeTestShardBundles(options);
      const after = createNodeTestShardBundles({
        ...options,
        changedPaths: STORE_ALIAS_CHANGED_PATHS,
      });
      const groups = after.flatMap((shard) => shard.groups);
      expect(groups.filter((group) => group.shard_name === "agentic-plugins")).toEqual([
        {
          shard_name: "agentic-plugins",
          configs: ["test/vitest/vitest.plugins.config.ts"],
          includePatterns: ["src/plugins/tools.optional.test.ts"],
          requiresDist: false,
          runner: expect.stringMatching(/^blacksmith-(?:4|8)vcpu-ubuntu-2404$/u),
        },
      ]);
      const policies = (plan: typeof before) =>
        plan
          .flatMap((shard) => shard.groups)
          .filter((group) => group.shard_name !== "agentic-plugins")
          .map(({ runner: _runner, ...group }) => group)
          .toSorted((a, b) => a.shard_name.localeCompare(b.shard_name));
      expect(policies(after)).toEqual(policies(before));
      expect(
        after.every(
          (shard) =>
            shard.groups.length <= 10 &&
            (shard.planConcurrency === 1 ||
              (runnerBackend === "blacksmith" &&
                shard.planConcurrency === 2 &&
                shard.runner === EXTRA_LARGE_NODE_TEST_RUNNER)),
        ),
      ).toBe(true);
      expect(after.length).toBeLessThanOrEqual(80);
    },
  );

  it("splits auto-reply into balanced core/top-level and reply subtree shards", () => {
    const shards = createNodeTestShards();
    const autoReplyShards = shards
      .filter((shard) => shard.shardName.startsWith("auto-reply"))
      .map((shard) => ({
        checkName: shard.checkName,
        configs: shard.configs,
        requiresDist: shard.requiresDist,
        shardName: shard.shardName,
      }));

    expect(autoReplyShards).toEqual([
      {
        checkName: "checks-node-auto-reply-core-top-level",
        configs: [
          "test/vitest/vitest.auto-reply-core.config.ts",
          "test/vitest/vitest.auto-reply-top-level.config.ts",
        ],
        requiresDist: false,
        shardName: "auto-reply-core-top-level",
      },
      {
        checkName: "checks-node-auto-reply-reply-agent-runner",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-agent-runner",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands-1",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands-1",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands-2",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands-2",
      },
      {
        checkName: "checks-node-auto-reply-reply-commands-3",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-commands-3",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch-core",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch-core",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch-delivery",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch-delivery",
      },
      {
        checkName: "checks-node-auto-reply-reply-dispatch-lifecycle",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-dispatch-lifecycle",
      },
      {
        checkName: "checks-node-auto-reply-reply-session",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-session",
      },
      {
        checkName: "checks-node-auto-reply-reply-state-routing",
        configs: ["test/vitest/vitest.auto-reply-reply.config.ts"],
        requiresDist: false,
        shardName: "auto-reply-reply-state-routing",
      },
    ]);
  });

  it("covers every auto-reply reply test exactly once across split shards", () => {
    const actual = createNodeTestShards()
      .filter((shard) => shard.shardName.startsWith("auto-reply-reply-"))
      .flatMap((shard) => shard.includePatterns ?? [])
      .toSorted((a, b) => a.localeCompare(b));

    expect(actual).toEqual(listTestFiles("src/auto-reply/reply"));
    expect(new Set(actual).size).toBe(actual.length);
  });

  it("keeps each dispatch entrypoint in its own dedicated shard", () => {
    const dispatchEntrypoints = new Map([
      ["auto-reply-reply-dispatch-core", "src/auto-reply/reply/dispatch-from-config.test.ts"],
      [
        "auto-reply-reply-dispatch-delivery",
        "src/auto-reply/reply/dispatch-from-config.delivery.test.ts",
      ],
      [
        "auto-reply-reply-dispatch-lifecycle",
        "src/auto-reply/reply/dispatch-from-config.lifecycle.test.ts",
      ],
    ]);
    const shards = createNodeTestShards();

    for (const [shardName, entrypoint] of dispatchEntrypoints) {
      expect(shards.find((shard) => shard.shardName === shardName)?.includePatterns).toEqual([
        entrypoint,
      ]);
    }
  });
});
