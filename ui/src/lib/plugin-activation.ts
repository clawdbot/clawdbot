// Control UI module implements plugin activation behavior.
import type { ConfigSnapshot } from "../api/types.ts";

type PluginActivationOptions = {
  enabledByDefault?: boolean;
};

export function isPluginEnabledInConfigSnapshot(
  configSnapshot: ConfigSnapshot | null | undefined,
  pluginId: string,
  options?: PluginActivationOptions,
): boolean {
  const enabledByDefault = options?.enabledByDefault ?? true;
  const config = configSnapshot?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return enabledByDefault;
  }

  const plugins =
    "plugins" in config && config.plugins && typeof config.plugins === "object"
      ? (config.plugins as Record<string, unknown>)
      : null;
  if (plugins?.enabled === false) {
    return false;
  }

  const deny =
    Array.isArray(plugins?.deny) && plugins.deny.every((entry) => typeof entry === "string")
      ? plugins.deny
      : [];
  if (deny.includes(pluginId)) {
    return false;
  }

  const entries =
    plugins && "entries" in plugins && plugins.entries && typeof plugins.entries === "object"
      ? (plugins.entries as Record<string, unknown>)
      : null;
  const entry = entries?.[pluginId];
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const enabled = (entry as { enabled?: unknown }).enabled;
    if (enabled === false) {
      return false;
    }
  }

  const slots =
    plugins && "slots" in plugins && plugins.slots && typeof plugins.slots === "object"
      ? (plugins.slots as Record<string, unknown>)
      : null;
  const isSelectedSlot =
    (typeof slots?.memory === "string" && slots.memory.trim() === pluginId) ||
    (typeof slots?.contextEngine === "string" && slots.contextEngine.trim() === pluginId);

  if (isSelectedSlot) {
    return true;
  }

  const allow =
    Array.isArray(plugins?.allow) && plugins.allow.every((entry) => typeof entry === "string")
      ? plugins.allow
      : [];
  if (allow.length > 0 && !allow.includes(pluginId)) {
    return false;
  }
  if (allow.includes(pluginId)) {
    return true;
  }

  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const enabled = (entry as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") {
      return enabled;
    }
  }

  return enabledByDefault;
}

/** Workboard ships disabled; an unloaded snapshot therefore reads as disabled. */
export function isWorkboardEnabledInConfigSnapshot(
  configSnapshot: ConfigSnapshot | null | undefined,
): boolean {
  return isPluginEnabledInConfigSnapshot(configSnapshot, "workboard", { enabledByDefault: false });
}
