import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Restores retired cron migration inputs that canonical config migration intentionally strips. */
export function withLegacyConfig(
  config: OpenClawConfig,
  legacyConfig: OpenClawConfig | undefined,
): OpenClawConfig {
  const legacyCron = legacyConfig?.cron as Record<string, unknown> | undefined;
  if (
    !legacyCron ||
    (!Object.hasOwn(legacyCron, "store") && !Object.hasOwn(legacyCron, "webhook"))
  ) {
    return config;
  }
  return {
    ...config,
    cron: {
      ...config.cron,
      ...(Object.hasOwn(legacyCron, "store") ? { store: legacyCron.store } : {}),
      ...(Object.hasOwn(legacyCron, "webhook") ? { webhook: legacyCron.webhook } : {}),
    },
  } as OpenClawConfig;
}

/** Isolates the trusted partition selector from a partially valid legacy config. */
export function retainStoreConfig(config: OpenClawConfig | undefined): OpenClawConfig | undefined {
  const cron = config?.cron as { store?: unknown; webhook?: unknown } | undefined;
  if (typeof cron?.store !== "string" || !cron.store.trim()) {
    return undefined;
  }
  return {
    cron: {
      store: cron.store,
      ...(Object.hasOwn(cron, "webhook") ? { webhook: cron.webhook } : {}),
    },
  } as OpenClawConfig;
}
