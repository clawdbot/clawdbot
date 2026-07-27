// Normalizes command-related config for slash and shell command handling.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { NativeCommandsSetting } from "./types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function resolveAutoDefault(
  providerId: ChannelId | undefined,
  kind: "native" | "nativeSkills",
  options?: {
    env?: NodeJS.ProcessEnv;
    stateDir?: string;
    workspaceDir?: string;
    config?: OpenClawConfig;
    autoDefault?: boolean;
  },
): boolean {
  const id = normalizeChannelId(providerId) ?? normalizeOptionalLowercaseString(providerId);
  if (!id) {
    return false;
  }
  if (typeof options?.autoDefault === "boolean") {
    return options.autoDefault;
  }
  // Prefer live plugin metadata; fall back to read-only manifest defaults during cold config paths.
  const commandDefaults =
    getLoadedChannelPlugin(id)?.commands ??
    (options?.config
      ? resolveReadOnlyChannelCommandDefaults(id, {
          ...options,
          config: options.config,
        })
      : undefined);
  if (kind === "native") {
    return commandDefaults?.nativeCommandsAutoEnabled === true;
  }
  return commandDefaults?.nativeSkillsAutoEnabled === true;
}

/** Resolves native skill exposure for a provider, with provider config overriding global config. */
export function resolveNativeSkillsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  autoDefault?: boolean;
}): boolean {
  return resolveNativeCommandSetting({ ...params, kind: "nativeSkills" });
}

/** Resolves native command exposure for a provider, with provider config overriding global config. */
export function resolveNativeCommandsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  autoDefault?: boolean;
}): boolean {
  return resolveNativeCommandSetting({ ...params, kind: "native" });
}

function resolveNativeCommandSetting(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  kind?: "native" | "nativeSkills";
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  autoDefault?: boolean;
}): boolean {
  const { providerId, providerSetting, globalSetting, kind = "native", ...options } = params;
  const setting = providerSetting === undefined ? globalSetting : providerSetting;
  if (setting === true) {
    return true;
  }
  if (setting === false) {
    return false;
  }
  return resolveAutoDefault(providerId, kind, options);
}

/** Returns true only when native commands are explicitly disabled by provider or inherited global config. */
export function isNativeCommandsExplicitlyDisabled(params: {
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  const { providerSetting, globalSetting } = params;
  if (providerSetting === false) {
    return true;
  }
  if (providerSetting === undefined) {
    return globalSetting === false;
  }
  return false;
}
