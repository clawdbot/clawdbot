// Covers the standalone Vitest E2E config shape.
import { describe, expect, it } from "vitest";
import {
  normalizeConfigPath,
  normalizeConfigPaths,
} from "../../test/helpers/vitest-config-paths.js";
import { BUNDLED_PLUGIN_E2E_TEST_GLOB } from "../../test/vitest/vitest.bundled-plugin-paths.ts";
import e2eConfig, { createE2EVitestConfig } from "../../test/vitest/vitest.e2e.config.ts";
import { createTuiPtyVitestConfig } from "../../test/vitest/vitest.tui-pty.config.ts";

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

  it("keeps every terminal integration test exclusively in the serial PTY lane", () => {
    const tuiPtyConfig = createTuiPtyVitestConfig({});
    const tuiPtyTests = [
      "src/tui/tui-auth-child-pty.e2e.test.ts",
      "src/tui/tui-pty-harness.e2e.test.ts",
      "src/tui/tui-session-identity-pty.e2e.test.ts",
      "src/tui/tui-reset-transition-pty.e2e.test.ts",
      "src/tui/tui-task-suggestions-pty.e2e.test.ts",
      "src/tui/tui-pty-local.e2e.test.ts",
    ];

    expect(e2eConfig.test?.exclude).toEqual(expect.arrayContaining(tuiPtyTests));
    expect(tuiPtyConfig.test?.include).toEqual(
      tuiPtyTests
        .filter((target) => !target.endsWith("tui-pty-local.e2e.test.ts"))
        .map((target) => target.replace(/^src\//u, "")),
    );
    expect(tuiPtyConfig.test?.fileParallelism).toBe(false);
    expect(tuiPtyConfig.test?.maxWorkers).toBe(1);
  });

  it("serializes default e2e runs while preserving explicit worker overrides", () => {
    expect(createE2EVitestConfig({}).test?.maxWorkers).toBe(1);
    expect(createE2EVitestConfig({ OPENCLAW_E2E_WORKERS: "4" }).test?.maxWorkers).toBe(4);
    expect(createE2EVitestConfig({ OPENCLAW_E2E_WORKERS: "99" }).test?.maxWorkers).toBe(16);
    expect(createE2EVitestConfig({ OPENCLAW_E2E_WORKERS: "0" }).test?.maxWorkers).toBe(1);
    expect(createE2EVitestConfig({ OPENCLAW_E2E_WORKERS: "invalid" }).test?.maxWorkers).toBe(1);
  });
});
