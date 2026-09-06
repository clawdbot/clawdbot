import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurface } from "../plugin-sdk/test-helpers/public-surface-loader.js";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import * as pluginModuleRuntime from "../plugins/loader-module-runtime.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import { prepareWorkspacePluginRegistries } from "./prepared-model-runtime.inbound-registry.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it("prepares an agent-local Copilot BYOK harness without replacing the active root registry", async () => {
  const openStore = vi
    .spyOn(pluginState, "createPluginStateSyncKeyedStore")
    .mockImplementation(() => {
      throw new Error("prepared harness discovery must not activate state stores");
    });
  const workspaceDir = fs.realpathSync(makePluginLoaderTempDir());
  // This composition uses the checkout's source fixture, not installed plugin resolution.
  const bundledRoot = path.resolve(import.meta.dirname, "../../extensions");
  const entrypoint = path.join(bundledRoot, "copilot", "index.ts");
  const copilotModule = await loadBundledPluginPublicSurface({
    pluginId: "copilot",
    artifactBasename: "index.ts",
  });
  // Reuse Vitest's source graph at the module-loading seam. The real loader
  // still discovers and validates the entrypoint and owns registration.
  const loadModule = vi.fn((source: string) => {
    expect(source).toBe(entrypoint);
    return copilotModule;
  });
  vi.spyOn(pluginModuleRuntime, "createPluginModuleLoader").mockReturnValue(loadModule);
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: fs.realpathSync(makePluginLoaderTempDir()),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
  };
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: {
        worker: {
          model: "custom-proxy/test-model",
          models: { "custom-proxy/test-model": { agentRuntime: { id: "copilot" } } },
        },
      },
    },
    models: {
      providers: {
        "custom-proxy": {
          api: "openai-responses",
          baseUrl: "https://api.example.com/v1",
          models: [
            {
              id: "test-model",
              name: "Test model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    plugins: { allow: ["copilot"], slots: { memory: "none" } },
  };
  const root = loadAndActivateRootPluginRegistry({
    config,
    env,
    workspaceDir,
    onlyPluginIds: [],
    cache: false,
  });
  const metadata = loadPluginMetadataSnapshot({
    config,
    env,
    workspaceDir,
    pluginIds: ["copilot"],
    allowCurrent: false,
    preferPersisted: false,
  });
  const selection = { agentId: "worker", provider: "custom-proxy", modelId: "test-model" };
  const { runtimePluginRegistry } = prepareWorkspacePluginRegistries(
    {
      config,
      env,
      agentDir: workspaceDir,
      workspaceDir,
      loadRuntimePlugins: true,
      runtimePluginSelections: [selection],
    },
    metadata,
  );

  expect(runtimePluginRegistry).not.toBe(root);
  expect(loadModule).toHaveBeenCalled();
  expect(getActivePluginRegistry()).toBe(root);
  expect(root.agentHarnesses).toEqual([]);
  expect(
    runtimePluginRegistry?.plugins,
    JSON.stringify(runtimePluginRegistry?.diagnostics),
  ).toEqual([expect.objectContaining({ id: "copilot", status: "loaded", source: entrypoint })]);
  await expect(
    ensureSelectedAgentHarnessPlugin({
      ...selection,
      config,
      workspaceDir,
      pluginRegistry: runtimePluginRegistry,
    }),
  ).resolves.toBeUndefined();
  const harness = runtimePluginRegistry?.agentHarnesses.find(
    (entry) => entry.harness.id === "copilot",
  )?.harness;
  expect(
    harness?.supports({
      ...selection,
      requestedRuntime: "copilot",
      providerOwnerStatus: "unowned",
      providerOwnerPluginIds: [],
      modelProvider: config.models!.providers!["custom-proxy"],
    }),
  ).toEqual({ supported: true, priority: 100 });
  await harness?.dispose?.();
  expect(openStore).not.toHaveBeenCalled();
});
