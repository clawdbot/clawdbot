// Ci Node Test Plan tests cover ci node test plan script behavior.
import { existsSync, globSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNodeTestShardBundles,
  createNodeTestShards,
  createVitestCacheWarmGroups,
  resolvePolicyTestTargets,
} from "../../scripts/lib/ci-node-test-plan.mts";
import * as testTimings from "../../scripts/lib/ci-test-timings.mts";
import { expectNoNodeFsScans } from "../../src/test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, sortRepoPaths, toRepoPath } from "../../src/test-utils/repo-files.js";
import {
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "../vitest/vitest.agents-paths.mjs";
import { commandsLightTestFiles } from "../vitest/vitest.commands-light-paths.mjs";
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
const PLUGIN_NPM_INSTALL_SECURITY_SCAN_TEST =
  "src/plugins/npm-install-security-scan.release.test.ts";
const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
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
    expect(groups).toHaveLength(11);
    expect(groups.every((group) => group.configs.length === 1)).toBe(true);
    expect(new Set(groups.flatMap((group) => group.configs))).toHaveProperty("size", 10);
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
    expect(gatewayGroups.map((group) => group.configs[0]).toSorted()).toEqual([
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
      "core-tooling-2",
      "core-tooling-3",
      "core-tooling-4",
      "core-tooling-5",
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
    },
  );

  it.each([
    { profile: "blacksmith", addedSeconds: 61 },
    { profile: "hybrid", addedSeconds: 53 },
  ])(
    "retains $profile stripe policy while unpinned groups inherit measured base weights",
    ({ profile, addedSeconds }) => {
      const timings = vi.spyOn(testTimings, "readCompactGroupTimings").mockReturnValue({});
      const options = {
        includeReleaseOnlyPluginShards: false,
        compactMode: "push" as const,
        runnerBackend: profile,
      };
      const fallback = createNodeTestShardBundles(options);
      if (profile === "hybrid") {
        expect(
          fallback
            .filter((shard) => !shard.requiresDist)
            .every((shard) => (shard.predictedSeconds ?? Infinity) <= 150),
        ).toBe(true);
        const agentChatStripes = fallback
          .flatMap((shard) => shard.groups)
          .filter((group) =>
            group.shard_name.startsWith("agentic-control-plane-agent-chat-hosted-"),
          );
        expect(agentChatStripes.length).toBeGreaterThan(1);
        expect(
          agentChatStripes.every(
            (group) =>
              !group.includePatterns?.includes(
                "src/gateway/server.chat.gateway-server-chat.test.ts",
              ) || !group.includePatterns.includes("src/gateway/server.sessions.create.test.ts"),
          ),
        ).toBe(true);
      }
      const totalSeconds = (plan: typeof fallback) =>
        plan.reduce((sum, shard) => sum + (shard.predictedSeconds ?? 0), 0);
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
      expect(totalSeconds(updated) - totalSeconds(fallback)).toBe(addedSeconds);
      if (profile === "hybrid") {
        const tail = updated.find((shard) =>
          shard.groups.some((group) => group.shard_name === "agentic-gateway-core-3"),
        );
        expect(tail?.groups.map((group) => group.shard_name)).toEqual(["agentic-gateway-core-3"]);
        expect(tail?.predictedSeconds).toBe(140);
      }
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
    const pushExcludedShardNames = new Set([
      "core-runtime-tui-pty",
      "core-tooling-1",
      "core-tooling-2",
      "core-tooling-3",
      "core-tooling-4",
      "core-tooling-5",
      "core-tooling-6",
      "core-tooling-7",
      "core-tooling-isolated",
    ]);

    for (const profile of [
      {
        name: "Blacksmith",
        pullRequest: pullRequestCompact,
        push: compact,
      },
      {
        name: "GitHub-hosted",
        pullRequest: githubPullRequestCompact,
        push: githubCompact,
      },
      {
        name: "hybrid",
        pullRequest: hybridPullRequestCompact,
        push: hybridCompact,
      },
    ]) {
      expect(profile.push.length, `${profile.name} excludes PR-only work`).toBeLessThan(
        profile.pullRequest.length,
      );
      for (const plan of [profile.push, profile.pullRequest]) {
        expect(plan.every((shard) => shard.groups.length > 0 && shard.groups.length <= 10)).toBe(
          true,
        );
        expect(plan.every((shard) => Number.isFinite(shard.predictedSeconds))).toBe(true);
        const names = plan.flatMap((shard) => shard.groups.map((group) => group.shard_name));
        expect(new Set(names).size).toBe(names.length);
        if (profile.name !== "Blacksmith") {
          expect(plan.length, `${profile.name} registration budget`).toBeLessThanOrEqual(96);
        }
      }
    }
    expect(compact.every((shard) => Array.isArray(shard.groups))).toBe(true);
    expect(compact.every((shard) => shard.groups.length <= 10)).toBe(true);
    expect(compact.some((shard) => shard.requiresDist)).toBe(true);
    expect(
      compact.every((shard) =>
        shard.groups.every(
          (group) => group.requiresDist === shard.requiresDist && group.runner === shard.runner,
        ),
      ),
    ).toBe(true);
    const jobOf = (name: string) =>
      compact.findIndex((shard) => shard.groups.some((group) => group.shard_name === name));
    expect(jobOf("agentic-agents-core-runner-embedded")).toBeGreaterThanOrEqual(0);
    for (const prefix of [
      "agentic-gateway-core",
      "core-runtime-media-ui",
      "core-unit-src-security",
    ]) {
      const jobs = [1, 2, 3].map((stripe) => jobOf(`${prefix}-${stripe}`));
      expect(jobs.every((job) => job >= 0)).toBe(true);
      expect(new Set(jobs).size).toBe(jobs.length);
    }
    // Cheap stripes may legally co-locate in one bin; only existence matters.
    expect(jobOf("core-unit-fast-1")).toBeGreaterThanOrEqual(0);
    expect(jobOf("core-unit-fast-2")).toBeGreaterThanOrEqual(0);
    // Spawn/signal-timing suites never mix with regular groups, and every
    // compact bin runs serially: overlapping Vitest runs flake timing-
    // sensitive tests on both runner classes.
    const exclusiveGroupRe =
      /^core-tooling(?:-\d+(?:-hosted-\d+)?|-isolated)$|^core-runtime-tui-pty$/u;
    for (const shard of [
      ...pullRequestCompact,
      ...githubPullRequestCompact,
      ...hybridPullRequestCompact,
    ]) {
      const exclusiveCount = shard.groups.filter((group) =>
        exclusiveGroupRe.test(group.shard_name),
      ).length;
      if (exclusiveCount > 0) {
        expect(exclusiveCount).toBe(shard.groups.length);
      }
      expect(shard.planConcurrency).toBe(1);
    }
    expect(
      pullRequestCompact.filter((shard) =>
        shard.groups.some((group) => exclusiveGroupRe.test(group.shard_name)),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      compact.some((shard) =>
        shard.groups.some((group) => exclusiveGroupRe.test(group.shard_name)),
      ),
    ).toBe(false);
    const expectedEmbeddedAgentGroupNames = [
      "agentic-agents-embedded-base",
      "agentic-agents-embedded-incomplete-turn",
      "agentic-agents-embedded-overflow-compaction",
      "agentic-agents-embedded-run",
    ];
    const compactGroups = compact.flatMap((shard) => shard.groups);
    const pullRequestCompactGroups = pullRequestCompact.flatMap((shard) => shard.groups);
    const expectedGroupNames = base.flatMap((shard) =>
      shard.shardName === "agentic-agents-embedded"
        ? expectedEmbeddedAgentGroupNames
        : [shard.shardName],
    );
    expect(compactGroups.map((group) => group.shard_name).toSorted()).toEqual(
      expectedGroupNames.filter((name) => !pushExcludedShardNames.has(name)).toSorted(),
    );
    expect(pullRequestCompactGroups.map((group) => group.shard_name).toSorted()).toEqual(
      expectedGroupNames.toSorted(),
    );
    const hostedOwnerNames = (plan: typeof githubCompact) =>
      new Set(
        plan.flatMap((shard) =>
          shard.groups.map((group) => group.shard_name.replace(/-hosted-\d+$/u, "")),
        ),
      );
    expect(hostedOwnerNames(githubCompact)).toEqual(
      new Set(compactGroups.map((group) => group.shard_name)),
    );
    expect(hostedOwnerNames(githubPullRequestCompact)).toEqual(
      new Set(pullRequestCompactGroups.map((group) => group.shard_name)),
    );
    expect(hostedOwnerNames(hybridCompact)).toEqual(hostedOwnerNames(githubCompact));
    expect(hostedOwnerNames(hybridPullRequestCompact)).toEqual(
      hostedOwnerNames(githubPullRequestCompact),
    );
    for (const plan of [githubPullRequestCompact, hybridPullRequestCompact]) {
      for (const owner of base) {
        const groups = plan
          .flatMap((shard) => shard.groups)
          .filter((group) => group.shard_name.startsWith(`${owner.shardName}-hosted-`));
        if (groups.length === 0) {
          continue;
        }
        const actual = groups.flatMap((group) => group.includePatterns ?? []);
        expect(new Set(actual).size, owner.shardName).toBe(actual.length);
        if (owner.includePatterns) {
          expect(actual.toSorted(), owner.shardName).toEqual(owner.includePatterns.toSorted());
        } else if (owner.shardName === "agentic-agents-support") {
          const expected = globSync(agentVitestProjectOwners.support.include, {
            exclude: agentVitestProjectOwners.support.exclude,
          }).map(toRepoPath);
          expect(actual.toSorted()).toEqual(expected.toSorted());
        }
      }
    }
    for (const shardName of pushExcludedShardNames) {
      expect(compactGroups.some((group) => group.shard_name === shardName)).toBe(false);
      expect(pullRequestCompactGroups.some((group) => group.shard_name === shardName)).toBe(true);
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
        .toSorted((a, b) => a.localeCompare(b)),
    );
    expect(
      pullRequestCompactGroups
        .flatMap((group) => group.includePatterns ?? [])
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(
      base.flatMap((shard) => shard.includePatterns ?? []).toSorted((a, b) => a.localeCompare(b)),
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
        expect(
          compact
            .flatMap((shard) => shard.groups)
            .find((group) => group.shard_name === `${prefix}-${suffix}`)?.env,
        ).toEqual({ OPENCLAW_VITEST_MAX_WORKERS: "2" });
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
    expect(startupCoreJob?.runner).toBe(DEFAULT_NODE_TEST_RUNNER);
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
    const distJobs = compact.filter((shard) => shard.requiresDist);
    expect(largeJobs.length).toBeGreaterThan(0);
    expect(smallJobs.length).toBeGreaterThan(0);
    expect(distJobs).toHaveLength(1);
    const regularSmallJobs = smallJobs.filter((shard) =>
      shard.groups.every((group) => !exclusiveGroupRe.test(group.shard_name)),
    );
    const routed8VcpuCheckNames = [
      "checks-node-compact-small-2",
      "checks-node-compact-small-5",
      "checks-node-compact-small-8",
    ];
    expect(
      regularSmallJobs
        .filter((shard) => shard.runner === DEFAULT_NODE_TEST_RUNNER)
        .map((shard) => shard.checkName),
    ).toEqual(
      routed8VcpuCheckNames.filter((name) =>
        regularSmallJobs.some((shard) => shard.checkName === name),
      ),
    );
    expect(
      smallJobs
        .filter((shard) => !routed8VcpuCheckNames.includes(shard.checkName))
        .every((shard) => shard.runner === BUNDLED_NODE_TEST_RUNNER),
    ).toBe(true);
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
    expect(embeddedAgentGroups.flatMap((group) => group.configs).toSorted()).toEqual(
      embeddedAgentVitestProjectOwners.map((owner) => owner.config).toSorted(),
    );
    expect(
      embeddedAgentGroups.every(
        (group) => group.env?.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS === "660000",
      ),
    ).toBe(true);
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
    const toolingGroups = pullRequestCompact
      .flatMap((shard) => shard.groups)
      .filter((group) => /^core-tooling-\d+$/u.test(group.shard_name));
    const toolingFiles = toolingGroups.flatMap((group) => group.includePatterns ?? []);
    expect(toolingGroups).toHaveLength(7);
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
    const runtimeTargets = [
      "test/e2e/qa-lab/runtime/gateway-support-export-runtime.test.ts",
      "src/gateway/gateway-active-memory.test.ts",
      "src/gateway/gateway-concurrent-streams.test.ts",
    ];
    for (const shards of [
      createNodeTestShards(),
      createNodeTestShardBundles({ compact: true, compactMode: "pull-request" }),
    ]) {
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
  });

  it("splits tooling checks independently from built artifacts", () => {
    const toolingShards = createNodeTestShards().filter((shard) =>
      shard.shardName.startsWith("core-tooling"),
    );

    const stripes = toolingShards.filter((shard) => /^core-tooling-\d+$/u.test(shard.shardName));
    expect(stripes).toHaveLength(7);
    for (const stripe of stripes) {
      expect(stripe.configs).toEqual(["test/vitest/vitest.tooling.config.ts"]);
      expect(stripe.requiresDist).toBe(false);
      expect(stripe.includePatterns?.length ?? 0).toBeGreaterThan(0);
    }
    // Stripes partition the tooling files: no overlap, nothing dropped.
    const stripeFiles = stripes.flatMap((stripe) => stripe.includePatterns ?? []);
    expect(new Set(stripeFiles).size).toBe(stripeFiles.length);
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
    const expectedCommandFiles = listTestFiles("src/commands")
      .filter((file) => !commandsLightTestFiles.includes(file) && !file.endsWith(".e2e.test.ts"))
      .toSorted((a, b) => a.localeCompare(b));
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

  it("keeps plugin prerelease npm install coverage on the release-only agentic plugin shard", () => {
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
    expect(listMatchedTestFiles(createPluginsVitestConfig({}))).toContain(
      PLUGIN_NPM_INSTALL_SECURITY_SCAN_TEST,
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
