import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeChannelId } from "../channels/registry.js";
import type { NativeCommandsSetting } from "./types.js";
export { isCommandFlagEnabled, isRestartEnabled, type CommandFlagKey } from "./commands.flags.js";

function resolveAutoDefault(
  providerId: ChannelId | undefined,
  kind: "native" | "nativeSkills",
): boolean {
  const id = normalizeChannelId(providerId);
  if (!id) {
    return false;
  }
  const plugin = getChannelPlugin(id);
  if (!plugin) {
    return false;
  }
  if (kind === "native") {
    return plugin.commands?.nativeCommandsAutoEnabled === true;
  }
  return plugin.commands?.nativeSkillsAutoEnabled === true;
}

export function resolveNativeSkillsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  return resolveNativeCommandSetting({ ...params, kind: "nativeSkills" });
}

export function resolveNativeCommandsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  return resolveNativeCommandSetting({ ...params, kind: "native" });
}

function resolveNativeCommandSetting(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
  kind?: "native" | "nativeSkills";
}): boolean {
  const { providerId, providerSetting, globalSetting, kind = "native" } = params;
  const setting = providerSetting === undefined ? globalSetting : providerSetting;
  if (setting === true) {
    return true;
  }
  if (setting === false) {
    return false;
  }
  return resolveAutoDefault(providerId, kind);
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
