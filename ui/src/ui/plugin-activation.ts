import type { ConfigSnapshot } from "./types.ts";

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
    return true;
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

  const allow =
    Array.isArray(plugins?.allow) && plugins.allow.every((entry) => typeof entry === "string")
      ? plugins.allow
      : [];
  if (allow.length > 0 && !allow.includes(pluginId)) {
    return false;
  }

  const entries =
    plugins && "entries" in plugins && plugins.entries && typeof plugins.entries === "object"
      ? (plugins.entries as Record<string, unknown>)
      : null;
  const entry = entries?.[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return enabledByDefault;
  }

  const enabled = (entry as { enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : enabledByDefault;
}
