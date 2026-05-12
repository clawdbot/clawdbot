import { describe, expect, it } from "vitest";
import {
  normalizeConfigPath,
  normalizeConfigPaths,
} from "../../test/helpers/vitest-config-paths.js";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "../../test/vitest/vitest.bundled-plugin-paths.ts";
import e2eConfig from "../../test/vitest/vitest.e2e.config.ts";

describe("e2e vitest config", () => {
  it("runs as a standalone config instead of inheriting unit projects", () => {
    expect(e2eConfig.test?.projects).toBeUndefined();
  });

  it("includes e2e test globs and runtime setup", () => {
    expect(e2eConfig.test?.include).toEqual([
      "test/**/*.e2e.test.ts",
      "src/**/*.e2e.test.ts",
      "packages/**/*.e2e.test.ts",
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
      BUNDLED_PLUGIN_E2E_TEST_GLOB,
    ]);
    expect(e2eConfig.test?.pool).toBe("threads");
    expect(e2eConfig.test?.isolate).toBe(false);
    expect(normalizeConfigPath(e2eConfig.test?.runner)).toBe("test/non-isolated-runner.ts");
    expect(normalizeConfigPaths(e2eConfig.test?.setupFiles)).toEqual([
      "test/setup.ts",
      "test/setup-openclaw-runtime.ts",
    ]);
  });
});
