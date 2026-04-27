import { getLoadedChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { resolveReadOnlyChannelCommandDefaults } from "../channels/plugins/read-only-command-defaults.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { NativeCommandsSetting } from "./types.js";
import type { OpenClawConfig } from "./types.openclaw.js";
export { isCommandFlagEnabled, isRestartEnabled, type CommandFlagKey } from "./commands.flags.js";

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
