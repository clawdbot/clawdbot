import { describe, expect, it } from "vitest";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import {
  createBoundaryVitestConfig,
  loadBoundaryIncludePatternsFromEnv,
} from "./vitest/vitest.boundary.config.ts";
import { boundaryTestFiles } from "./vitest/vitest.unit-paths.mjs";

function requireTestConfig(config: ReturnType<typeof createBoundaryVitestConfig>) {
  if (!config.test) {
    throw new Error("expected boundary vitest test config");
  }
  return config.test;
}

describe("loadBoundaryIncludePatternsFromEnv", () => {
  it("returns null when no include file is configured", () => {
    expect(loadBoundaryIncludePatternsFromEnv({})).toBeNull();
  });
});

describe("boundary vitest config", () => {
  it("keeps boundary suites on the non-isolated runner with shared test bootstrap", () => {
    const config = createBoundaryVitestConfig({});
    const testConfig = requireTestConfig(config);

    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
    expect(testConfig.include).toEqual(boundaryTestFiles);
    expect(normalizeConfigPaths(testConfig.setupFiles)).toEqual(["test/setup.ts"]);
  });

  it("narrows boundary includes to matching CLI file filters", () => {
    const config = createBoundaryVitestConfig({}, [
      "node",
      "vitest",
      "run",
      "src/infra/openclaw-root.test.ts",
    ]);
    const testConfig = requireTestConfig(config);

    expect(testConfig.include).toEqual(["src/infra/openclaw-root.test.ts"]);
    expect(testConfig.passWithNoTests).toBe(true);
  });
});
