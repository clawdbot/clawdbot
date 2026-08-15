// Vitest UI package config tests validate UI package test project settings.
import path from "node:path";
import { describe, expect, it } from "vitest";
import uiConfig from "../ui/vitest.config.ts";
import uiNodeConfig from "../ui/vitest.node.config.ts";

type ExpectedTestConfig = {
  isolate?: boolean;
  name?: string;
  pool?: string;
  projects?: unknown[];
  runner?: string;
};

function requireTestConfig(config: unknown): ExpectedTestConfig {
  if (!config || typeof config !== "object" || !("test" in config) || !config.test) {
    throw new Error("expected ui package vitest test config");
  }
  return config.test as ExpectedTestConfig;
}

function requireAlias(config: unknown, specifier: string): { find: string; replacement: string } {
  const aliases = (config as { resolve?: { alias?: unknown } }).resolve?.alias;
  if (!Array.isArray(aliases)) {
    throw new Error("expected ui package vitest aliases");
  }
  const alias = aliases.find((candidate): candidate is { find: string; replacement: string } =>
    Boolean(
      candidate &&
      typeof candidate === "object" &&
      "find" in candidate &&
      candidate.find === specifier &&
      "replacement" in candidate &&
      typeof candidate.replacement === "string",
    ),
  );
  if (!alias) {
    throw new Error(`missing ui package vitest alias ${specifier}`);
  }
  return alias;
}

describe("ui package vitest config", () => {
  it("keeps the standalone ui package on thread workers without broad isolation", () => {
    const testConfig = requireTestConfig(uiConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.projects).toHaveLength(4);

    for (const project of testConfig.projects ?? []) {
      const projectTestConfig = requireTestConfig(project);
      expect(projectTestConfig.pool).toBe("threads");
      expect(projectTestConfig.isolate).toBe(projectTestConfig.name === "unit-mock-registry");
      expect(projectTestConfig.runner).toBeUndefined();
    }
  });

  it("keeps the standalone ui node config on thread workers without isolation", () => {
    const testConfig = requireTestConfig(uiNodeConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.runner).toBeUndefined();
  });

  it("aliases the scope-upgrade workspace subpath for clean browser test checkouts", () => {
    expect(requireAlias(uiConfig, "@openclaw/gateway-client/scope-upgrade")).toEqual({
      find: "@openclaw/gateway-client/scope-upgrade",
      replacement: path.join(
        process.cwd(),
        "packages",
        "gateway-client",
        "src",
        "scope-upgrade.ts",
      ),
    });
  });
});
