// Verifies hook dispatch follows configured policy and explicit agent registry scopes.
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
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  loadAgentRuntimePluginRegistryHandle,
  withAgentPluginRegistry,
} from "./runtime-plugins.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  "configured",
  "globally disabled",
  "disabled plugin",
  "not allowlisted",
  "denied plugin",
  "empty base",
  "empty request",
])("dispatches configured hooks while preserving %s scope", async (scope) => {
  useNoBundledPlugins();
  const pluginId = "prompt-hook-probe";
  const plugin = writePlugin({
    id: pluginId,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.on("before_prompt_build", async () => ({ prependContext: "hook-injected" }));
  },
};\n`,
  });
  const config = {
    plugins: {
      enabled: scope !== "globally disabled",
      ...(scope === "not allowlisted" ? { allow: ["other-plugin"] } : {}),
      ...(scope === "denied plugin" ? { deny: [pluginId] } : {}),
      entries: {
        [pluginId]: {
          enabled: scope !== "disabled plugin",
          hooks: { allowConversationAccess: true },
        },
      },
      load: { paths: [plugin.file] },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  const run = async (registry: PluginRegistry) => {
    const result = await createHookRunner(registry).runBeforePromptBuild(
      { prompt: "test", messages: [] },
      {},
    );
    expect(result?.prependContext).toBe(scope === "configured" ? "hook-injected" : undefined);
  };
  if (scope === "empty base") {
    await run(loadAgentRuntimePluginRegistryHandle({ config, workspaceDir, basePluginIds: [] }));
  } else if (scope === "empty request") {
    await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
      withAgentPluginRegistry({ config, workspaceDir, run }),
    );
  } else {
    await withAgentPluginRegistry({ config, workspaceDir, run });
  }
});
