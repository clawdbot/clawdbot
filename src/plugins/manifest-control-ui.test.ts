import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifest } from "./manifest.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function fixture(controlUi: unknown) {
  const plugin = writePlugin({
    id: "native-ui",
    body: 'module.exports = { id: "native-ui", register() {} };',
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", additionalProperties: false },
      controlUi,
    }),
  );
  return plugin;
}

describe("native Control UI manifest", () => {
  it("carries normalized built entrypoints through discovery into runtime ownership", () => {
    useNoBundledPlugins();
    const plugin = fixture({
      entry: "./dist/control-ui/index.js",
      styles: ["./dist/control-ui/theme.css", "dist/control-ui/theme.css"],
    });
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: { plugins: { load: { paths: [plugin.file] }, allow: [plugin.id] } },
      onlyPluginIds: [plugin.id],
    });
    expect(registry.plugins.find((record) => record.id === plugin.id)).toMatchObject({
      status: "loaded",
      controlUi: { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/theme.css"] },
    });
  });

  it.each([
    { entry: "src/index.ts" },
    { entry: "dist/index.js" },
    { entry: "../dist/control-ui/index.js" },
    { entry: "/dist/control-ui/index.js" },
    { entry: "dist/control-ui/../server.js" },
    { entry: "dist\\control-ui\\index.js" },
    { entry: "dist/control-ui/index.js", styles: ["dist/server.css"] },
    { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/.secret.css"] },
    { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/code.js"] },
    { entry: "dist/control-ui/index.js", root: "/private" },
  ])("rejects unsafe or source declarations %j", (controlUi) => {
    expect(loadPluginManifest(fixture(controlUi).dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("controlUi"),
    });
  });
});
