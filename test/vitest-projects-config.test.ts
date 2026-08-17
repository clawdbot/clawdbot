// Vitest project config tests validate aggregate Vitest project wiring.
import { afterEach, describe, expect, it } from "vitest";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import { auditFullSuiteTestFileOwnership } from "./vitest-projects-config.test-support.js";
import { createAgentsCoreVitestConfig } from "./vitest/vitest.agents-core.config.ts";
import { createAgentsEmbeddedIncompleteTurnVitestConfig } from "./vitest/vitest.agents-embedded-agent-incomplete-turn.config.ts";
import { createAgentsEmbeddedOverflowCompactionVitestConfig } from "./vitest/vitest.agents-embedded-agent-overflow-compaction.config.ts";
import { createAgentsEmbeddedRunVitestConfig } from "./vitest/vitest.agents-embedded-agent-run.config.ts";
import { createAgentsEmbeddedVitestConfig } from "./vitest/vitest.agents-embedded-agent.config.ts";
import {
  agentVitestProjectConfigs,
  agentVitestProjectOwners,
  embeddedAgentVitestProjectOwners,
} from "./vitest/vitest.agents-paths.mjs";
import { createAgentsSupportVitestConfig } from "./vitest/vitest.agents-support.config.ts";
import { createAgentsToolsVitestConfig } from "./vitest/vitest.agents-tools.config.ts";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import bundledConfig from "./vitest/vitest.bundled.config.ts";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createCommandsVitestConfig } from "./vitest/vitest.commands.config.ts";
import baseConfig from "./vitest/vitest.config.ts";
import contractChannelConfigConfig from "./vitest/vitest.contracts-channel-config.config.ts";
import contractChannelRegistryConfig from "./vitest/vitest.contracts-channel-registry.config.ts";
import contractChannelSessionConfig from "./vitest/vitest.contracts-channel-session.config.ts";
import contractChannelSurfaceConfig from "./vitest/vitest.contracts-channel-surface.config.ts";
import contractPluginConfig from "./vitest/vitest.contracts-plugin.config.ts";
import {
  createContractsVitestConfig,
  pluginContractPatterns,
} from "./vitest/vitest.contracts-shared.ts";
import { createGatewayVitestConfig } from "./vitest/vitest.gateway.config.ts";
import { createPluginSdkLightVitestConfig } from "./vitest/vitest.plugin-sdk-light.config.ts";
import {
  resolveSharedVitestWorkerConfig,
  sharedVitestConfig,
} from "./vitest/vitest.shared.config.ts";
import { fullSuiteVitestShards } from "./vitest/vitest.test-shards.mjs";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";
import { createUnitFastFakeTimersVitestConfig } from "./vitest/vitest.unit-fast-fake-timers.config.ts";
import unitFastRootConfig from "./vitest/vitest.unit-fast-root.config.ts";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";

const patternFiles = createPatternFileHelper("openclaw-vitest-projects-config-");

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

const rootVitestProjects = requireTestConfig(baseConfig).projects as string[];

function requireWebOptimizer(testConfig: unknown) {
  const webOptimizer = (testConfig as { deps?: { optimizer?: { web?: { enabled?: boolean } } } })
    .deps?.optimizer?.web;
  if (!webOptimizer) {
    throw new Error("expected vitest web optimizer config");
  }
  return webOptimizer;
}

afterEach(() => {
  patternFiles.cleanup();
});

describe("projects vitest config", () => {
  it("keeps root and full-suite agent projects aligned with canonical owners", () => {
    const agenticShard = fullSuiteVitestShards.find((shard) => shard.name === "agentic");
    const agentConfigs = new Set(agentVitestProjectConfigs);

    expect(rootVitestProjects.filter((config) => agentConfigs.has(config))).toEqual(
      agentVitestProjectConfigs,
    );
    expect(agenticShard?.projects.filter((config) => agentConfigs.has(config))).toEqual(
      agentVitestProjectConfigs,
    );
    expect(agentConfigs.size).toBe(agentVitestProjectConfigs.length);
  });

  it("covers each normal full-suite test file exactly once after configs cached filtered includes", async () => {
    const contractTestConfigs = [
      contractChannelSurfaceConfig,
      contractChannelConfigConfig,
      contractChannelRegistryConfig,
      contractChannelSessionConfig,
      contractPluginConfig,
    ].map(requireTestConfig);
    const previousIncludes = contractTestConfigs.map((config) => config.include);

    try {
      // A CLI path outside the contract patterns caches these defaults with empty includes.
      for (const config of contractTestConfigs) {
        config.include = [];
      }

      const { missing, duplicated } = await auditFullSuiteTestFileOwnership();

      expect(missing).toStrictEqual([]);
      expect(duplicated).toStrictEqual([]);
    } finally {
      contractTestConfigs.forEach((config, index) => {
        const previousInclude = previousIncludes[index];
        if (previousInclude === undefined) {
          delete config.include;
        } else {
          config.include = previousInclude;
        }
      });
    }
  });

  it("keeps all embedded harnesses under their canonical embedded owner", () => {
    expect(embeddedAgentVitestProjectOwners).toEqual([
      agentVitestProjectOwners.embedded,
      agentVitestProjectOwners.embeddedIncompleteTurn,
      agentVitestProjectOwners.embeddedOverflowCompaction,
      agentVitestProjectOwners.embeddedRun,
    ]);
  });

  it("keeps root watch projects aligned with dedicated extension shard lanes", () => {
    const extensionShard = fullSuiteVitestShards.find(
      (shard) => shard.config === "test/vitest/vitest.full-extensions.config.ts",
    );

    expect(extensionShard?.projects).toEqual(
      expect.arrayContaining([
        "test/vitest/vitest.extension-browser.config.ts",
        "test/vitest/vitest.extension-qa.config.ts",
        "test/vitest/vitest.extension-media.config.ts",
        "test/vitest/vitest.extension-misc.config.ts",
      ]),
    );
    expect(rootVitestProjects).toEqual(
      expect.arrayContaining([
        "test/vitest/vitest.extension-browser.config.ts",
        "test/vitest/vitest.extension-qa.config.ts",
        "test/vitest/vitest.extension-media.config.ts",
        "test/vitest/vitest.extension-misc.config.ts",
      ]),
    );
  });

  it("keeps root watch projects aligned with dedicated tooling shard lanes", () => {
    const toolingShard = fullSuiteVitestShards.find(
      (shard) => shard.config === "test/vitest/vitest.full-core-tooling.config.ts",
    );
    const toolingProjects = [
      "test/vitest/vitest.tooling.config.ts",
      "test/vitest/vitest.tooling-docker.config.ts",
      "test/vitest/vitest.tooling-isolated.config.ts",
    ];

    expect(toolingShard?.projects).toEqual(toolingProjects);
    const rootToolingProjects = rootVitestProjects.filter((project) =>
      toolingProjects.includes(project),
    );
    expect(new Set(rootToolingProjects)).toEqual(new Set(toolingProjects));
    expect(rootToolingProjects).toHaveLength(toolingProjects.length);
  });

  it("disables vite env-file loading for vitest lanes", () => {
    expect(baseConfig.envDir).toBe(false);
    expect(sharedVitestConfig.envDir).toBe(false);
  });

  it("uses absolute force-rerun triggers for discovered vitest lane files", () => {
    expect(sharedVitestConfig.test.forceRerunTriggers.map(normalizeConfigPath)).toContain(
      normalizeConfigPath(`${process.cwd()}/test/vitest/vitest.config.ts`),
    );
  });

  it("keeps root projects on their expected pool defaults", () => {
    expect(requireTestConfig(createGatewayVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createAgentsVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createAgentsCoreVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createAgentsEmbeddedVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createAgentsEmbeddedIncompleteTurnVitestConfig()).pool).toBe(
      "threads",
    );
    expect(requireTestConfig(createAgentsEmbeddedOverflowCompactionVitestConfig()).pool).toBe(
      "threads",
    );
    expect(requireTestConfig(createAgentsEmbeddedRunVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createAgentsSupportVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createAgentsToolsVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createCommandsLightVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createCommandsVitestConfig()).pool).toBe("forks");
    expect(requireTestConfig(createPluginSdkLightVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createUnitFastVitestConfig()).pool).toBe("threads");
    expect(requireTestConfig(createContractsVitestConfig(pluginContractPatterns)).pool).toBe(
      "threads",
    );
  });

  it("keeps the embedded-agent cold-hook budget explicit", () => {
    expect(requireTestConfig(createAgentsEmbeddedVitestConfig()).hookTimeout).toBe(600_000);
  });

  it("honors explicit worker caps in CI vitest lanes", () => {
    expect(
      resolveSharedVitestWorkerConfig({
        env: { CI: "true", OPENCLAW_VITEST_MAX_WORKERS: "1" },
        isCI: true,
        isWindows: false,
        localScheduling: {
          fileParallelism: false,
          maxWorkers: 1,
          throttledBySystem: false,
        },
      }),
    ).toEqual({
      fileParallelism: false,
      maxWorkers: 1,
    });
    expect(
      resolveSharedVitestWorkerConfig({
        env: { CI: "true" },
        isCI: true,
        isWindows: false,
        localScheduling: {
          fileParallelism: false,
          maxWorkers: 1,
          throttledBySystem: false,
        },
      }),
    ).toEqual({
      fileParallelism: true,
      maxWorkers: 3,
    });
  });

  it("keeps contract shards on the non-isolated runner by default", () => {
    const config = createContractsVitestConfig(pluginContractPatterns);
    const testConfig = requireTestConfig(config);
    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
  });

  it("gives contract project configs unique names", () => {
    expect([
      requireTestConfig(contractChannelSurfaceConfig).name,
      requireTestConfig(contractChannelConfigConfig).name,
      requireTestConfig(contractChannelRegistryConfig).name,
      requireTestConfig(contractChannelSessionConfig).name,
      requireTestConfig(contractPluginConfig).name,
    ]).toEqual([
      "contracts-channel-surface",
      "contracts-channel-config",
      "contracts-channel-registry",
      "contracts-channel-session",
      "contracts-plugin",
    ]);
  });

  it("narrows the contracts lane to targeted contract files", () => {
    const config = createContractsVitestConfig(pluginContractPatterns, {}, [
      "node",
      "vitest",
      "run",
      "src/plugins/contracts/bundled-web-search.google.contract.test.ts",
    ]);

    expect(requireTestConfig(config).include).toEqual([
      "src/plugins/contracts/bundled-web-search.google.contract.test.ts",
    ]);
  });

  it("intersects contract include-file shards with the config family", () => {
    const includeFile = patternFiles.writePatternFile("include.json", [
      "src/channels/plugins/contracts/surfaces-only.registry-backed-shard-b.contract.test.ts",
      "src/channels/plugins/contracts/surfaces-only.registry-backed-shard-d.contract.test.ts",
      "src/channels/plugins/contracts/directory.registry-backed-shard-a.contract.test.ts",
    ]);

    const config = createContractsVitestConfig(
      ["src/channels/plugins/contracts/*-shard-a.contract.test.ts"],
      {
        OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
      },
    );

    expect(requireTestConfig(config).include).toEqual([
      "src/channels/plugins/contracts/directory.registry-backed-shard-a.contract.test.ts",
    ]);
  });

  it("keeps the root ui lane on the shared non-isolated runner", () => {
    const config = createUiVitestConfig();
    const testConfig = requireTestConfig(config);
    expect(testConfig.environment).toBe("jsdom");
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    const setupFiles = normalizeConfigPaths(testConfig.setupFiles);
    expect(setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(setupFiles).toContain("ui/src/test-helpers/lit-warnings.setup.ts");
    expect(requireWebOptimizer(testConfig).enabled).toBe(true);
  });

  it("keeps root-matrix unit-fast files on the cross-file cleanup runner", () => {
    const testConfig = requireTestConfig(unitFastRootConfig);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(rootVitestProjects).toContain("test/vitest/vitest.unit-fast-root.config.ts");
    expect(rootVitestProjects).not.toContain("test/vitest/vitest.unit-fast.config.ts");
  });

  it("keeps fake-timer unit-fast files serial with the non-isolated runner", () => {
    const config = createUnitFastFakeTimersVitestConfig();
    const testConfig = requireTestConfig(config);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(testConfig.fileParallelism).toBe(false);
    expect(testConfig.maxWorkers).toBe(1);
    expect(testConfig.sequence).toMatchObject({ groupOrder: 1 });
  });

  it("keeps the bundled lane on thread workers with the non-isolated runner", () => {
    const testConfig = requireTestConfig(bundledConfig);
    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
  });
});
