import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  isPluginRegistryRetired,
  pluginLoaderCacheState,
} from "../../plugins/registry-lifecycle.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createSyncSuiteTempRootTracker } from "../../plugins/test-helpers/fs-fixtures.js";
import { runModelsAuthLoginFlowCore } from "./auth.js";

const tempDirs = createSyncSuiteTempRootTracker("models-auth-registry");

afterEach(async () => {
  await clearActivePluginRegistry();
  pluginLoaderCacheState.clear();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

it("keeps the active plugin registry when provider sign-in is declined", async () => {
  const root = fs.realpathSync(tempDirs.makeTempDir());
  const pluginDir = path.join(root, "provider");
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "auth-registry-fixture",
      providers: ["fixture-provider"],
      configSchema: { type: "object" },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: "auth-registry-fixture",
      register(api) {
        api.registerProvider({
          id: "fixture-provider",
          label: "Fixture provider",
          auth: [{
            id: "synthetic", label: "Synthetic", kind: "custom",
            async run() { throw new Error("Auth must not start after sign-in is declined"); }
          }]
        });
      }
    };`,
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  const declined = new Error("Sign-in declined");
  const prompter = createWizardPrompter({
    note: vi.fn(async () => {
      throw declined;
    }),
  });

  await expect(
    runModelsAuthLoginFlowCore({
      provider: "fixture-provider",
      method: "synthetic",
      agent: "main",
      config: {
        agents: { entries: { main: { workspace: root } } },
        plugins: {
          allow: ["auth-registry-fixture"],
          load: { paths: [pluginDir] },
        },
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter,
    }),
  ).rejects.toBe(declined);
  expect(prompter.note).toHaveBeenCalledOnce();
  expect(getActivePluginRegistry() === registry).toBe(true);
  expect(isPluginRegistryRetired(registry)).toBe(false);
});
