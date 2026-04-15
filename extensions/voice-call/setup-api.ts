import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/text-runtime";
import { migrateVoiceCallLegacyConfigInput } from "./config-api.js";

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

export default definePluginEntry({
  id: "voice-call",
  name: "Voice Call Setup",
  description: "Lightweight Voice Call setup hooks",
  register(api) {
    api.registerConfigMigration((config) => migrateVoiceCallPluginConfig(config));
  },
});
