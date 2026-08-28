import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import copilotPlugin from "../../extensions/copilot/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import { prepareWorkspacePluginRegistries } from "./prepared-model-runtime.inbound-registry.js";

const REGISTER_COPILOT = Symbol.for("openclaw.test.registerCopilot");
type RegistrationGlobal = typeof globalThis & {
  [REGISTER_COPILOT]?: typeof copilotPlugin.register;
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as RegistrationGlobal)[REGISTER_COPILOT];
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
  const bundledRoot = fs.realpathSync(makePluginLoaderTempDir());
  // Let Vitest import the public entrypoint once; the real loader still owns its
  // manifest, mode, API, and registry without a second SDK source-transform graph.
  const plugin = writePlugin({
    id: "copilot",
    filename: "index.cjs",
    dir: path.join(bundledRoot, "copilot"),
    body: `module.exports = {
      id: "copilot",
      register(api) { globalThis[Symbol.for("openclaw.test.registerCopilot")](api); },
    };`,
  });
  fs.copyFileSync(
    new URL("../../extensions/copilot/openclaw.plugin.json", import.meta.url),
    path.join(plugin.dir, "openclaw.plugin.json"),
  );
  (globalThis as RegistrationGlobal)[REGISTER_COPILOT] = copilotPlugin.register;
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
  expect(getActivePluginRegistry()).toBe(root);
  expect(root.agentHarnesses).toEqual([]);
  expect(
    runtimePluginRegistry?.plugins,
    JSON.stringify(runtimePluginRegistry?.diagnostics),
  ).toEqual([expect.objectContaining({ id: "copilot", status: "loaded" })]);
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
