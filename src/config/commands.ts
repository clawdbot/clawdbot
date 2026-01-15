import type { ChannelId } from "../channels/plugins/types.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { NativeCommandsSetting } from "./types.js";

function resolveAutoDefault(providerId?: ChannelId): boolean {
  const id = normalizeChannelId(providerId);
  if (!id) return false;
  if (id === "discord" || id === "telegram") return true;
  if (id === "slack") return false;
  return false;
}

export function resolveNativeCommandsEnabled(params: {
  providerId: ChannelId;
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  const { providerId, providerSetting, globalSetting } = params;
  const setting = providerSetting === undefined ? globalSetting : providerSetting;
  if (setting === true) return true;
  if (setting === false) return false;
  // auto or undefined -> heuristic
  return resolveAutoDefault(providerId);
}

export function isNativeCommandsExplicitlyDisabled(params: {
  providerSetting?: NativeCommandsSetting;
  globalSetting?: NativeCommandsSetting;
}): boolean {
  const { providerSetting, globalSetting } = params;
  if (providerSetting === false) return true;
  if (providerSetting === undefined) return globalSetting === false;
  return false;
}
