import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeProviderId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasLegacyGoogleRealtimeProvider(value: unknown): boolean {
  const realtime = asRecord(value);
  if (!realtime || normalizeProviderId(realtime.provider) !== "google") {
    return false;
  }
  return !hasOwn(realtime, "voiceProvider") || !hasOwn(realtime, "transcriptionProvider");
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "google-meet", "config", "realtime"],
    message:
      'plugins.entries.google-meet.config.realtime.provider="google" is legacy for Gemini Live bidi mode; use realtime.voiceProvider="google" and realtime.transcriptionProvider="openai". Run "openclaw doctor --fix".',
    match: hasLegacyGoogleRealtimeProvider,
  },
];

export function migrateGoogleMeetLegacyRealtimeProvider(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const rawEntry = asRecord(config.plugins?.entries?.["google-meet"]);
  const rawPluginConfig = asRecord(rawEntry?.config);
  const rawRealtime = asRecord(rawPluginConfig?.realtime);
  if (!rawRealtime || !hasLegacyGoogleRealtimeProvider(rawRealtime)) {
    return null;
  }

  const nextConfig = structuredClone(config);
  const nextPlugins = asRecord(nextConfig.plugins) ?? {};
  nextConfig.plugins = nextPlugins;
  const nextEntries = asRecord(nextPlugins.entries) ?? {};
  nextPlugins.entries = nextEntries;
  const nextEntry = asRecord(nextEntries["google-meet"]) ?? {};
  nextEntries["google-meet"] = nextEntry;
  const nextPluginConfig = asRecord(nextEntry.config) ?? {};
  nextEntry.config = nextPluginConfig;
  const nextRealtime = asRecord(nextPluginConfig.realtime) ?? {};
  nextPluginConfig.realtime = nextRealtime;

  nextRealtime.provider = "openai";
  if (!hasOwn(nextRealtime, "transcriptionProvider")) {
    nextRealtime.transcriptionProvider = "openai";
  }
  if (!hasOwn(nextRealtime, "voiceProvider")) {
    nextRealtime.voiceProvider = "google";
  }

  return {
    config: nextConfig,
    changes: [
      'Moved Google Meet legacy realtime.provider="google" intent to realtime.voiceProvider="google" and realtime.transcriptionProvider="openai".',
    ],
  };
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return migrateGoogleMeetLegacyRealtimeProvider(cfg) ?? { config: cfg, changes: [] };
}
