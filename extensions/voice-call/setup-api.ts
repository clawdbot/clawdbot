// Voice Call API module exposes the plugin public contract.
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { migrateVoiceCallLegacyConfigInput } from "./src/config-migration.js";

// Setup-time entrypoint for voice-call config migrations.

/** Migrate voice-call plugin config inside the full OpenClaw config object. */
function migrateVoiceCallPluginConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const rawVoiceCallConfig = config.plugins?.entries?.["voice-call"]?.config;
  if (!isRecord(rawVoiceCallConfig)) {
    return null;
  }
  const migration = migrateVoiceCallLegacyConfigInput({
    value: rawVoiceCallConfig,
    configPathPrefix: "plugins.entries.voice-call.config",
  });
  if (migration.changes.length === 0) {
    return null;
  }
  const plugins = structuredClone(config.plugins ?? {});
  const entries = { ...plugins.entries };
  const existingVoiceCallEntry = isRecord(entries["voice-call"])
    ? (entries["voice-call"] as Record<string, unknown>)
    : {};
  entries["voice-call"] = {
    ...existingVoiceCallEntry,
    config: migration.config,
  };
  plugins.entries = entries;
  return {
    config: {
      ...config,
      plugins,
    },
    changes: migration.changes,
  };
}

/** Setup plugin entry that registers voice-call config migrations. */
export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call Setup",
  description: "Lightweight Voice Call setup hooks",
  register(api) {
    api.registerConfigMigration((config) => migrateVoiceCallPluginConfig(config));
  },
});
