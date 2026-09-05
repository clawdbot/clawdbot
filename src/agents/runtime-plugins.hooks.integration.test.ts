// Verifies direct agent registry scopes load enabled hook-only plugins so their
// typed hooks dispatch without a Gateway request registry (issue #138368).
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createHookRunner } from "../plugins/hooks.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withAgentPluginRegistry } from "./runtime-plugins.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

it("loads and dispatches hook-only plugins for ingress without a request registry", async () => {
  useNoBundledPlugins();
  const pluginId = "prompt-hook-probe";
  const configSchema = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
  const plugin = writePlugin({
    id: pluginId,
    configSchema,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("before_prompt_build", async () => ({ prependContext: "hook-injected" }));
  },
};\n`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema }),
    "utf8",
  );
  const config = {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
          config: {},
          hooks: { allowConversationAccess: true },
        },
      },
      load: { paths: [plugin.dir] },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();

  await withAgentPluginRegistry({
    config,
    workspaceDir,
    run: async () => {
      const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
      expect(scopedRegistry).toBeDefined();
      expect(scopedRegistry?.plugins.map((entry) => entry.id)).toContain(pluginId);
      // Dispatch through the loaded plugin instead of asserting mocked loader arguments.
      const runner = createHookRunner(scopedRegistry!);
      const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});
      expect(result?.prependContext).toBe("hook-injected");
    },
  });
});
