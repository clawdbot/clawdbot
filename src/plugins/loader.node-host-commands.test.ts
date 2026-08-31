/** Verifies static plugin nodeHostCommands survive non-activating registry loads (node-host path). */
import { afterAll, afterEach, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

// The node host resolves its registry via loadPluginRegistryHandle (activate:false).
// Static nodeHostCommands (e.g. the browser plugin's browser.proxy) must register
// there too, or headless meeting/browser nodes silently lose their surface.
it("registers static nodeHostCommands without activation", () => {
  useNoBundledPlugins();
  const plugin = writePlugin({
    id: "node-surface",
    body: `module.exports = {
      id: "node-surface",
      nodeHostCommands: [{
        command: "nodesurface.proxy",
        cap: "node-surface",
        handle: async () => "ok",
      }],
      register() {},
    };`,
  });

  const registry = loadOpenClawPlugins({
    cache: false,
    activate: false,
    workspaceDir: plugin.dir,
    config: {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    },
    onlyPluginIds: [plugin.id],
  });

  expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
  expect(registry.nodeHostCommands.map((entry) => entry.command.command)).toContain(
    "nodesurface.proxy",
  );
});
