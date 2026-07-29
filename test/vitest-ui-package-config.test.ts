// Vitest UI package config tests validate UI package test project settings.
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
});
