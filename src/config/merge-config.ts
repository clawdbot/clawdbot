import type { MoltbotConfig } from "./config.js";
import type { WhatsAppConfig } from "./types.js";

export type MergeSectionOptions<T> = {
  unsetOnUndefined?: Array<keyof T>;
};

export function mergeConfigSection<T extends Record<string, unknown>>(
  base: T | undefined,
  patch: Partial<T>,
  options: MergeSectionOptions<T> = {},
): T {
  const next: Record<string, unknown> = { ...(base ?? undefined) };
  for (const [key, value] of Object.entries(patch) as [keyof T, T[keyof T]][]) {
    if (value === undefined) {
      if (options.unsetOnUndefined?.includes(key)) {
        delete next[key as string];
      }
      continue;
    }
    next[key as string] = value as unknown;
  }
  return next as T;
}

export function mergeWhatsAppConfig(
  cfg: MoltbotConfig,
  patch: Partial<WhatsAppConfig>,
  options?: MergeSectionOptions<WhatsAppConfig>,
): MoltbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: mergeConfigSection(cfg.channels?.whatsapp, patch, options),
    },
  };
}
