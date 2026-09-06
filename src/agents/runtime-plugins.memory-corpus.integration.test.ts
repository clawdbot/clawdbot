// Verifies direct agent registry scopes retain root-owned memory corpus sidecars.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import {
  buildMemoryPromptSection,
  listMemoryCorpusSupplements,
  prepareMemoryPromptSection,
} from "../plugins/memory-state.js";
import { withAgentPluginRegistry } from "./runtime-plugins.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

it("keeps root-owned memory sidecars in a direct agent registry", async () => {
  useNoBundledPlugins();
  const pluginId = "memory-corpus-sidecar";
  const configSchema = {
    type: "object",
    additionalProperties: false,
    properties: { source: { type: "string" } },
  };
  const plugin = writePlugin({
    id: pluginId,
    configSchema,
    body: `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerMemoryPromptSupplement(() => ["runtime wiki guidance"]);
    api.registerMemoryPromptPreparation(async () => ["runtime wiki digest"]);
    api.registerMemoryCorpusSupplement({
      search: async () => [],
      get: async () => null,
    });
  },
};\n`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId, configSchema, contracts: { tools: ["corpus_probe"] } }),
    "utf8",
  );
  const config = {
    plugins: {
      entries: { [pluginId]: { config: { source: "runtime" } } },
      load: { paths: [plugin.dir] },
    },
  } satisfies OpenClawConfig;
  const workspaceDir = makePluginLoaderTempDir();
  const rootConfig = applyPluginAutoEnable({ config, env: process.env }).config;
  expect(rootConfig.plugins?.entries?.[pluginId]?.enabled).toBe(true);
  const root = loadAndActivateRootPluginRegistry({
    cache: false,
    config: rootConfig,
    onlyPluginIds: [pluginId],
    workspaceDir,
  });

  expect(root.memoryCorpusSupplements.map((entry) => entry.pluginId)).toEqual([pluginId]);
  const rootSupplement = root.memoryCorpusSupplements[0]?.supplement;
  await withAgentPluginRegistry({
    config,
    workspaceDir,
    run: async () => {
      expect(listMemoryCorpusSupplements().map((entry) => entry.pluginId)).toEqual([pluginId]);
      const promptParams = { availableTools: new Set(["memory_search"]) };
      const prepared = await prepareMemoryPromptSection(promptParams);
      expect(buildMemoryPromptSection(promptParams, prepared)).toEqual([
        "runtime wiki guidance",
        "runtime wiki digest",
      ]);
    },
  });
  await withAgentPluginRegistry({
    config,
    workspaceDir: makePluginLoaderTempDir(),
    run: async () => {
      // A direct scope for a different workspace loads the configured plugin fresh instead
      // of adopting the root's sidecar instance; adoption only applies on workspace match.
      const supplements = listMemoryCorpusSupplements();
      expect(supplements.map((entry) => entry.pluginId)).toEqual([pluginId]);
      expect(supplements[0]?.supplement).not.toBe(rootSupplement);
    },
  });
  await withAgentPluginRegistry({
    config: { plugins: { enabled: false } },
    workspaceDir,
    run: async () => {
      expect(listMemoryCorpusSupplements()).toEqual([]);
    },
  });
});
