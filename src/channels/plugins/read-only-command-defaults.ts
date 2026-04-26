import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry.js";
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
  return nativeCommandsAutoEnabled !== undefined || nativeSkillsAutoEnabled !== undefined
    ? {
        ...(nativeCommandsAutoEnabled !== undefined ? { nativeCommandsAutoEnabled } : {}),
        ...(nativeSkillsAutoEnabled !== undefined ? { nativeSkillsAutoEnabled } : {}),
      }
    : undefined;
}

export function resolveReadOnlyChannelCommandDefaults(
  channelId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
  } = {},
): ChannelCommandDefaults | undefined {
  const normalizedChannelId = normalizeOptionalString(channelId) ?? "";
  if (!normalizedChannelId || !isSafeManifestChannelId(normalizedChannelId)) {
    return undefined;
  }
  const registry = loadPluginManifestRegistryForPluginRegistry({
    stateDir: options.stateDir,
    workspaceDir: options.workspaceDir,
    env: options.env ?? process.env,
    includeDisabled: true,
  });
  for (const record of registry.plugins) {
    if (!record.channels.includes(normalizedChannelId)) {
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
