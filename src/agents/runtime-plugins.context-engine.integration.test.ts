// Verifies prepared agent turns retain their selected runtime context-engine owner.
import { afterAll, afterEach, expect, it } from "vitest";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

it("keeps the configured context engine active in a prepared agent registry", async () => {
  useNoBundledPlugins();
  const engineId = "prepared-context-engine";
  const plugin = writePlugin({
    id: engineId,
    body: `module.exports = {
      id: ${JSON.stringify(engineId)},
      register(api) {
        api.registerContextEngine(${JSON.stringify(engineId)}, () => ({
          info: { id: ${JSON.stringify(engineId)}, name: "Prepared Context Engine" },
          async ingest() { return { ingested: false }; },
          async assemble({ messages }) {
            return { messages, estimatedTokens: 0, systemPromptAddition: "prepared-engine" };
          },
          async compact() { return { ok: true, compacted: false }; },
        }));
      },
    };\n`,
  });
  const config = {
    plugins: {
      load: { paths: [plugin.file] },
      slots: { contextEngine: engineId },
    },
  };

  const activeRegistry = loadAndActivateRootPluginRegistry({
    cache: false,
    config,
    workspaceDir: makePluginLoaderTempDir(),
    onlyPluginIds: [engineId],
  });
  const preparedRegistry = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [],
    config,
    workspaceDir: plugin.dir,
  });

  expect(preparedRegistry).not.toBe(activeRegistry);
  await withPluginRuntimeRegistryScope(preparedRegistry, async () => {
    const lease = await createContextEngineLogicalTurnLease({ config, workspaceDir: plugin.dir });
    expect(lease.degraded).toBe(false);
    expect(lease.effectiveEngineId).toBe(engineId);
    expect(lease.effectiveEnginePluginId).toBe(engineId);
    await expect(
      lease.begin().engine.assemble({ messages: [], sessionId: "prepared-session" }),
    ).resolves.toMatchObject({ systemPromptAddition: "prepared-engine" });
    await lease.dispose();
  });
});
