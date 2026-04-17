import { describe, expect, it } from "vitest";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import { createAgentsVitestConfig } from "./vitest/vitest.agents.config.ts";
import bundledConfig from "./vitest/vitest.bundled.config.ts";
import { createCommandsLightVitestConfig } from "./vitest/vitest.commands-light.config.ts";
import { createCommandsVitestConfig } from "./vitest/vitest.commands.config.ts";
import baseConfig, { rootVitestProjects } from "./vitest/vitest.config.ts";
import { createContractsVitestConfig } from "./vitest/vitest.contracts.config.ts";
import { createGatewayVitestConfig } from "./vitest/vitest.gateway.config.ts";
import { createPluginSdkLightVitestConfig } from "./vitest/vitest.plugin-sdk-light.config.ts";
import { sharedVitestConfig } from "./vitest/vitest.shared.config.ts";
import { createUiVitestConfig } from "./vitest/vitest.ui.config.ts";
import { createUnitFastVitestConfig } from "./vitest/vitest.unit-fast.config.ts";
import unitUiConfig from "./vitest/vitest.unit-ui.config.ts";
import { createUnitVitestConfig } from "./vitest/vitest.unit.config.ts";

describe("projects vitest config", () => {
  it("defines the native root project list for all non-live Vitest lanes", () => {
    expect(baseConfig.test?.projects).toEqual([...rootVitestProjects]);
  });

  it("disables vite env-file loading for vitest lanes", () => {
    expect(baseConfig.envFile).toBe(false);
    expect(sharedVitestConfig.envFile).toBe(false);
  });

  it("keeps root projects on their expected pool defaults", () => {
    expect(createGatewayVitestConfig().test.pool).toBe("threads");
    expect(createAgentsVitestConfig().test.pool).toBe("threads");
    expect(createCommandsLightVitestConfig().test.pool).toBe("threads");
    expect(createCommandsVitestConfig().test.pool).toBe("threads");
    expect(createPluginSdkLightVitestConfig().test.pool).toBe("threads");
    expect(createUnitFastVitestConfig().test.pool).toBe("threads");
    expect(createContractsVitestConfig().test.pool).toBe("forks");
  });

  it("keeps the contracts lane on the non-isolated fork runner by default", () => {
    const config = createContractsVitestConfig();
    expect(config.test.pool).toBe("forks");
    expect(config.test.isolate).toBe(false);
    expect(normalizeConfigPath(config.test.runner)).toBe("test/non-isolated-runner.ts");
  });

  it("keeps the root ui lane aligned with the isolated jsdom setup", () => {
    const config = createUiVitestConfig();
    expect(config.test.environment).toBe("jsdom");
    expect(config.test.isolate).toBe(true);
    expect(config.test.runner).toBeUndefined();
    const setupFiles = normalizeConfigPaths(config.test.setupFiles);
    expect(setupFiles).not.toContain("test/setup-openclaw-runtime.ts");
    expect(setupFiles).toContain("ui/src/test-helpers/lit-warnings.setup.ts");
    expect(config.test.deps?.optimizer?.web?.enabled).toBe(true);
  });

  it("keeps the unit-ui shard aligned with the isolated jsdom setup", () => {
    expect(unitUiConfig.test?.environment).toBe("jsdom");
    expect(unitUiConfig.test?.isolate).toBe(true);
    expect(unitUiConfig.test?.runner).toBeUndefined();
    const setupFiles = normalizeConfigPaths(unitUiConfig.test?.setupFiles);
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
    expect(bundledConfig.test?.pool).toBe("threads");
    expect(bundledConfig.test?.isolate).toBe(false);
    expect(normalizeConfigPath(bundledConfig.test?.runner)).toBe("test/non-isolated-runner.ts");
  });
});
