import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { buildPluginDiagnosticsReport } from "./status.js";

describe("plugin runtime inspection", () => {
  afterEach(() => {
    resetPluginLoaderTestStateForTest();
  });

  afterAll(() => {
    cleanupPluginLoaderFixturesForTest();
  });

  it("captures full registrations through the non-activating inspection mode", () => {
    const pluginDir = makePluginLoaderTempDir();
    const registrationModePath = path.join(pluginDir, "registration-mode.txt");
    const plugin = writePlugin({
      id: "runtime-inspection-route",
      dir: pluginDir,
      body: `module.exports = {
  id: "runtime-inspection-route",
  register(api) {
    require("node:fs").writeFileSync(
      ${JSON.stringify(registrationModePath)},
      api.registrationMode,
      "utf8",
    );
    if (api.registrationMode === "tool-discovery") {
      api.registerHttpRoute({
        path: "/runtime-inspection",
        auth: "plugin",
        handler() { return true; },
      });
    }
  },
};\n`,
    });
    const stateDir = makePluginLoaderTempDir();
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    };

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      useNoBundledPlugins();
      const params = { config, workspaceDir: plugin.dir, env: process.env };

      const diagnostics = buildPluginDiagnosticsReport(params);
      expect(diagnostics.plugins.find((entry) => entry.id === plugin.id)?.httpRoutes).toBe(0);
      expect(fs.readFileSync(registrationModePath, "utf8")).toBe("discovery");

      const runtimeInspectionParams = { ...params, runtimeInspection: true };
      const runtimeInspection = buildPluginDiagnosticsReport(runtimeInspectionParams);
      expect(runtimeInspection.plugins.find((entry) => entry.id === plugin.id)?.httpRoutes).toBe(1);
      expect(fs.readFileSync(registrationModePath, "utf8")).toBe("tool-discovery");
    });
  });
});
