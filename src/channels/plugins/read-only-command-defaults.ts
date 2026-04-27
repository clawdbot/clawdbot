import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { isInstalledPluginEnabled } from "../../plugins/installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "../../plugins/manifest-registry-installed.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { loadPluginRegistrySnapshot } from "../../plugins/plugin-registry.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { ChannelPlugin } from "./types.plugin.js";

const SAFE_MANIFEST_CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export type ChannelCommandDefaults = Pick<
  NonNullable<ChannelPlugin["commands"]>,
  "nativeCommandsAutoEnabled" | "nativeSkillsAutoEnabled"
>;

type ManifestChannelConfigRecord = NonNullable<PluginManifestRecord["channelConfigs"]>[string];

export function isSafeManifestChannelId(channelId: string): boolean {
  return SAFE_MANIFEST_CHANNEL_ID_PATTERN.test(channelId) && !isBlockedObjectKey(channelId);
}

export function readOwnRecordValue(record: Record<string, unknown>, key: string): unknown {
  if (isBlockedObjectKey(key) || !Object.prototype.hasOwnProperty.call(record, key)) {
    return undefined;
  }
  return record[key];
}

export function normalizeChannelCommandDefaults(
  value: ChannelCommandDefaults | undefined,
): ChannelCommandDefaults | undefined {
  if (!value) {
    return undefined;
  }
  const nativeCommandsAutoEnabled =
    typeof value.nativeCommandsAutoEnabled === "boolean"
      ? value.nativeCommandsAutoEnabled
      : undefined;
  const nativeSkillsAutoEnabled =
    typeof value.nativeSkillsAutoEnabled === "boolean" ? value.nativeSkillsAutoEnabled : undefined;
  if (nativeCommandsAutoEnabled === undefined && nativeSkillsAutoEnabled === undefined) {
    return undefined;
  }
  const defaults: ChannelCommandDefaults = {};
  if (nativeCommandsAutoEnabled !== undefined) {
    defaults.nativeCommandsAutoEnabled = nativeCommandsAutoEnabled;
  }
  if (nativeSkillsAutoEnabled !== undefined) {
    defaults.nativeSkillsAutoEnabled = nativeSkillsAutoEnabled;
  }
  return defaults;
}

export function resolveReadOnlyChannelCommandDefaults(
  channelId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
    config: OpenClawConfig;
  },
): ChannelCommandDefaults | undefined {
  const normalizedChannelId = normalizeOptionalString(channelId) ?? "";
  if (!normalizedChannelId || !isSafeManifestChannelId(normalizedChannelId)) {
    return undefined;
  }
  const index = loadPluginRegistrySnapshot({
    config: options.config,
    stateDir: options.stateDir,
    workspaceDir: options.workspaceDir,
    env: options.env ?? process.env,
  });
  const registry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: options.config,
    workspaceDir: options.workspaceDir,
    env: options.env ?? process.env,
    includeDisabled: true,
  });
  for (const record of registry.plugins) {
    if (!record.channels.includes(normalizedChannelId)) {
      continue;
    }
    if (
      record.id !== normalizedChannelId &&
      record.channelCatalogMeta?.id !== normalizedChannelId
    ) {
      continue;
    }
    if (!isInstalledPluginEnabled(index, record.id, options.config)) {
      continue;
    }
    const channelConfigValue = record.channelConfigs
      ? readOwnRecordValue(record.channelConfigs as Record<string, unknown>, normalizedChannelId)
      : undefined;
    const channelConfig =
      channelConfigValue &&
      typeof channelConfigValue === "object" &&
      !Array.isArray(channelConfigValue)
        ? (channelConfigValue as ManifestChannelConfigRecord)
        : undefined;
    const commands = normalizeChannelCommandDefaults(
      channelConfig?.commands ?? record.channelCatalogMeta?.commands,
    );
    if (commands) {
      return commands;
    }
  }
  return undefined;
}
