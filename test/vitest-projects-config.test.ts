import { afterEach, describe, expect, it } from "vitest";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import { createAgentsCoreVitestConfig } from "./vitest/vitest.agents-core.config.ts";
import { createAgentsPiEmbeddedVitestConfig } from "./vitest/vitest.agents-pi-embedded.config.ts";
import { createAgentsSupportVitestConfig } from "./vitest/vitest.agents-support.config.ts";
import { createAgentsToolsVitestConfig } from "./vitest/vitest.agents-tools.config.ts";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import bundledConfig from "./vitest/vitest.bundled.config.ts";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createCommandsVitestConfig } from "./vitest/vitest.commands.config.ts";
import baseConfig, { rootVitestProjects } from "./vitest/vitest.config.ts";
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
import { createUiVitestConfig, unitUiIncludePatterns } from "./vitest/vitest.ui.config.ts";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";
import unitUiConfig from "./vitest/vitest.unit-ui.config.ts";
import { createUnitVitestConfig } from "./vitest/vitest.unit.config.ts";

const patternFiles = createPatternFileHelper("openclaw-vitest-projects-config-");

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

function requireWebOptimizer(testConfig: {
  deps?: { optimizer?: { web?: { enabled?: boolean } } };
}) {
  const webOptimizer = testConfig.deps?.optimizer?.web;
  if (!webOptimizer) {
    throw new Error("expected vitest web optimizer config");
  }
  return webOptimizer;
}

afterEach(() => {
  patternFiles.cleanup();
});

describe("projects vitest config", () => {
  it("defines the native root project list for all non-live Vitest lanes", () => {
    expect(requireTestConfig(baseConfig).projects).toEqual([...rootVitestProjects]);
  });

  it("disables vite env-file loading for vitest lanes", () => {
    expect(baseConfig.envFile).toBe(false);
    expect(sharedVitestConfig.envFile).toBe(false);
  });

  it("keeps root projects on their expected pool defaults", () => {
    expect(createGatewayVitestConfig().test.pool).toBe("threads");
    expect(createAgentsVitestConfig().test.pool).toBe("threads");
    expect(createAgentsCoreVitestConfig().test.pool).toBe("threads");
    expect(createAgentsPiEmbeddedVitestConfig().test.pool).toBe("threads");
    expect(createAgentsSupportVitestConfig().test.pool).toBe("threads");
    expect(createAgentsToolsVitestConfig().test.pool).toBe("threads");
    expect(createCommandsLightVitestConfig().test.pool).toBe("threads");
    expect(createCommandsVitestConfig().test.pool).toBe("threads");
    expect(createPluginSdkLightVitestConfig().test.pool).toBe("threads");
    expect(createUnitFastVitestConfig().test.pool).toBe("threads");
    expect(createContractsVitestConfig(pluginContractPatterns).test.pool).toBe("threads");
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
    expect(config.test.pool).toBe("threads");
    expect(config.test.isolate).toBe(false);
    expect(normalizeConfigPath(config.test.runner)).toBe("test/non-isolated-runner.ts");
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

    expect(config.test.include).toEqual([
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

    expect(config.test.include).toEqual([
      "src/channels/plugins/contracts/directory.registry-backed-shard-a.contract.test.ts",
    ]);
  });

  it("keeps the root ui lane aligned with the shared jsdom setup", () => {
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

  it("keeps the unit-ui shard aligned with the shared jsdom setup", () => {
    const testConfig = requireTestConfig(unitUiConfig);
    expect(testConfig.environment).toBe("jsdom");
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(unitUiIncludePatterns).toContain("ui/src/ui/views/dreaming.test.ts");
    const setupFiles = normalizeConfigPaths(testConfig.setupFiles);
    expect(setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(setupFiles).toContain("ui/src/test-helpers/lit-warnings.setup.ts");
  });

  it("keeps the unit lane on the non-isolated runner by default", () => {
    const config = createUnitVitestConfig();
    expect(config.test.isolate).toBe(false);
    expect(normalizeConfigPath(config.test.runner)).toBe("test/non-isolated-runner.ts");
  });

  it("keeps the unit-fast lane on shared workers without the reset-heavy runner", () => {
    const config = createUnitFastVitestConfig();
    expect(config.test.isolate).toBe(false);
    expect(config.test.runner).toBeUndefined();
  });

  it("keeps the bundled lane on thread workers with the non-isolated runner", () => {
    const testConfig = requireTestConfig(bundledConfig);
    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
  });
});
