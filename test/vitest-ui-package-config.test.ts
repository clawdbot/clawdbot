import { describe, expect, it } from "vitest";
import uiConfig from "../ui/vitest.config.ts";
import uiNodeConfig from "../ui/vitest.node.config.ts";

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected ui package vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

describe("ui package vitest config", () => {
  it("keeps the standalone ui package on thread workers without isolation", () => {
    const testConfig = requireTestConfig(uiConfig);

    expect(testConfig.pool).toBe("threads");
    expect(testConfig.isolate).toBe(false);
    expect(testConfig.projects).toHaveLength(3);

    for (const project of testConfig.projects) {
      const projectTestConfig = requireTestConfig(project);
      expect(projectTestConfig.pool).toBe("threads");
      expect(projectTestConfig.isolate).toBe(false);
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
