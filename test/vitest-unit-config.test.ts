import { afterEach, describe, expect, it } from "vitest";
import { createPatternFileHelper } from "./helpers/pattern-file.js";
import { normalizeConfigPath, normalizeConfigPaths } from "./helpers/vitest-config-paths.js";
import {
  createUnitVitestConfig,
  createUnitVitestConfigWithOptions,
  loadExtraExcludePatternsFromEnv,
  loadIncludePatternsFromEnv,
  resolveDefaultUnitCoverageIncludePatterns,
} from "./vitest/vitest.unit.config.ts";

const patternFiles = createPatternFileHelper("openclaw-vitest-unit-config-");

function requireTestConfig<T extends { test?: unknown }>(config: T): NonNullable<T["test"]> {
  if (!config.test) {
    throw new Error("expected unit vitest test config");
  }
  return config.test as NonNullable<T["test"]>;
}

afterEach(() => {
  patternFiles.cleanup();
});

describe("loadIncludePatternsFromEnv", () => {
  it("returns null when no include file is configured", () => {
    expect(loadIncludePatternsFromEnv({})).toBeNull();
  });

  it("loads include patterns from a JSON file", () => {
    const filePath = patternFiles.writePatternFile("include.json", [
      "src/infra/update-runner.test.ts",
      42,
      "",
      "ui/src/ui/views/chat.test.ts",
    ]);

    expect(
      loadIncludePatternsFromEnv({
        OPENCLAW_VITEST_INCLUDE_FILE: filePath,
      }),
    ).toEqual(["src/infra/update-runner.test.ts", "ui/src/ui/views/chat.test.ts"]);
  });
});

describe("loadExtraExcludePatternsFromEnv", () => {
  it("returns an empty list when no extra exclude file is configured", () => {
    expect(loadExtraExcludePatternsFromEnv({})).toStrictEqual([]);
  });

  it("loads extra exclude patterns from a JSON file", () => {
    const filePath = patternFiles.writePatternFile("extra-exclude.json", [
      "src/infra/update-runner.test.ts",
      42,
      "",
      "ui/src/ui/views/chat.test.ts",
    ]);

    expect(
      loadExtraExcludePatternsFromEnv({
        OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE: filePath,
      }),
    ).toEqual(["src/infra/update-runner.test.ts", "ui/src/ui/views/chat.test.ts"]);
  });

  it("throws when the configured file is not a JSON array", () => {
    const filePath = patternFiles.writePatternFile("extra-exclude.json", {
      exclude: ["src/infra/update-runner.test.ts"],
    });

    expect(() =>
      loadExtraExcludePatternsFromEnv({
        OPENCLAW_VITEST_EXTRA_EXCLUDE_FILE: filePath,
      }),
    ).toThrow(/JSON array/u);
  });
});

describe("unit vitest config", () => {
  it("defaults unit tests to the non-isolated runner", () => {
    const unitConfig = createUnitVitestConfig({});
    const testConfig = requireTestConfig(unitConfig);
    expect(testConfig.isolate).toBe(false);
    expect(normalizeConfigPath(testConfig.runner)).toBe("test/non-isolated-runner.ts");
  });

  it("keeps acp and ui tests out of the generic unit lane", () => {
    const unitConfig = createUnitVitestConfig({});
    const testConfig = requireTestConfig(unitConfig);
    expect(testConfig.exclude).toContain("extensions/**");
    expect(testConfig.exclude).toContain("test/**");
    for (const pattern of [
      "ui/src/ui/app-chat.test.ts",
      "ui/src/ui/chat/**/*.test.ts",
      "ui/src/ui/views/chat.test.ts",
    ]) {
      expect(testConfig.include).not.toContain(pattern);
    }
  });

  it("narrows the active include list to CLI file filters when present", () => {
    const unitConfig = createUnitVitestConfigWithOptions(
      {},
      {
        argv: ["node", "vitest", "run", "src/config/channel-configured.test.ts"],
      },
    );
    const testConfig = requireTestConfig(unitConfig);
    expect(testConfig.include).toEqual(["src/config/channel-configured.test.ts"]);
    expect(testConfig.passWithNoTests).toBe(true);
  });

  it("adds the OpenClaw runtime setup hooks on top of the base setup", () => {
    const unitConfig = createUnitVitestConfig({});
    const testConfig = requireTestConfig(unitConfig);
    expect(normalizeConfigPaths(testConfig.setupFiles)).toEqual([
      "test/setup.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });

  it("appends extra exclude patterns instead of replacing the base unit excludes", () => {
    const unitConfig = createUnitVitestConfigWithOptions(
      {},
      {
        extraExcludePatterns: ["src/security/**"],
      },
    );
    const testConfig = requireTestConfig(unitConfig);
    expect(testConfig.exclude).toContain("src/commands/**");
    expect(testConfig.exclude).toContain("src/config/**");
    expect(testConfig.exclude).toContain("src/security/**");
  });

  it("scopes default coverage to source files owned by the unit lane", () => {
    const unitConfig = createUnitVitestConfig({});
    const testConfig = requireTestConfig(unitConfig);
    const coverageInclude = testConfig.coverage?.include;
    expect(coverageInclude).toContain("src/commitments/runtime.ts");
    expect(coverageInclude).toContain("src/media-generation/runtime-shared.ts");
    expect(coverageInclude).toContain("src/web-search/runtime.ts");
    expect(coverageInclude).not.toContain("src/markdown/render.ts");
    expect(coverageInclude).not.toContain("src/security/audit-workspace-skills.ts");
  });

  it("derives default coverage includes from non-fast unit tests with sibling source files", () => {
    const coverageInclude = resolveDefaultUnitCoverageIncludePatterns();
    expect(coverageInclude).toContain("packages/memory-host-sdk/src/host/embeddings.ts");
    expect(coverageInclude).toContain("src/commitments/store.ts");
    expect(coverageInclude).toContain("src/tools/planner.ts");
  });

  it("leaves coverage include filters unset for explicit unit include lists", () => {
    const unitConfig = createUnitVitestConfigWithOptions(
      {},
      {
        includePatterns: ["src/commitments/runtime.test.ts"],
      },
    );
    const testConfig = requireTestConfig(unitConfig);

    expect(testConfig.coverage?.include).toBeUndefined();
  });

  it("keeps bundled unit include files out of the resolved exclude list", () => {
    const unitConfig = createUnitVitestConfigWithOptions(
      {},
      {
        includePatterns: [
          "src/infra/matrix-plugin-helper.test.ts",
          "src/plugin-sdk/facade-runtime.test.ts",
          "src/plugins/loader.test.ts",
        ],
      },
    );
    const testConfig = requireTestConfig(unitConfig);

    expect(testConfig.include).toEqual([
      "src/infra/matrix-plugin-helper.test.ts",
      "src/plugin-sdk/facade-runtime.test.ts",
      "src/plugins/loader.test.ts",
    ]);
    expect(testConfig.exclude).not.toContain("src/infra/**");
    expect(testConfig.exclude).not.toContain("src/plugin-sdk/**");
    expect(testConfig.exclude).not.toContain("src/plugins/**");
    expect(testConfig.exclude).not.toContain("src/infra/matrix-plugin-helper.test.ts");
    expect(testConfig.exclude).not.toContain("src/plugin-sdk/facade-runtime.test.ts");
    expect(testConfig.exclude).not.toContain("src/plugins/loader.test.ts");
  });
});
