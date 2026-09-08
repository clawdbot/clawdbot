import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  mkdirSafe,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";

export function createVoiceProviderFixture(policy: OpenClawConfig["plugins"] = {}) {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const workspace = path.join(root, "workspace");
  mkdirSafe(workspace);
  for (const [id, order] of [
    ["active-voice", 20],
    ["configured-voice", 10],
  ] as const) {
    const plugin = writePlugin({
      id,
      dir: path.join(root, "extensions", id),
      filename: "index.cjs",
      body: `module.exports = { id: "${id}", register(api) {
        api.registerRealtimeVoiceProvider({
          id: "${id}", aliases: ["${id}-alias"], label: "${id}", autoSelectOrder: ${order},
          resolveConfig: ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
          isConfigured: ({ providerConfig }) => providerConfig.ready === true ||
            process.env.VOICE_DISCOVERY_TEST_CONFIGURED_PROVIDER === "${id}",
          createBridge: () => { throw new Error("provider discovery must not start media"); },
        });
      } };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
        contracts: { realtimeVoiceProviders: [id] },
      }),
    );
    fs.writeFileSync(
      path.join(plugin.dir, "package.json"),
      JSON.stringify({ openclaw: { extensions: ["./index.cjs"] } }),
    );
  }
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace } },
    plugins: {
      allow: ["active-voice", "configured-voice"],
      ...policy,
      entries: {
        "active-voice": { enabled: true },
        "configured-voice": { enabled: true },
        ...policy?.entries,
      },
    },
  };
  return {
    cfg,
    env: {
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
  };
}
