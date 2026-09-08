import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "./config-state.js";

/** Configuration consumed during registration, independent of activation and load scope. */
export function resolvePluginRegistrationConfigKey(params: {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
}): string {
  const runtimeEntries = normalizePluginsConfig(params.config?.plugins).entries;
  const sourceEntries = normalizePluginsConfig(params.activationSourceConfig?.plugins).entries;
  const pluginIds = new Set([...Object.keys(runtimeEntries), ...Object.keys(sourceEntries)]);
  const inputs = [...pluginIds].toSorted().flatMap((pluginId) => {
    const { enabled: _enabled, ...runtime } = runtimeEntries[pluginId] ?? {};
    const sourceConfig = sourceEntries[pluginId]?.config;
    const registration = { ...runtime, sourceConfig };
    // Auto-enable may add an otherwise empty entry; it does not change callback inputs.
    return Object.values(registration).some((value) => value !== undefined)
      ? [[pluginId, registration]]
      : [];
  });
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}
