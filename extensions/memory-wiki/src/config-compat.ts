import type { OpenClawConfig } from "../api.js";

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

function hasLegacyBridgeArtifactToggle(value: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(asRecord(value) ?? {}, "readMemoryCore");
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "memory-wiki", "config", "bridge"],
    message:
      'plugins.entries.memory-wiki.config.bridge.readMemoryCore is legacy; use plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts. Run "openclaw doctor --fix".',
    match: hasLegacyBridgeArtifactToggle,
  },
];

export function migrateMemoryWikiLegacyConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const rawEntry = asRecord(config.plugins?.entries?.["memory-wiki"]);
  const rawPluginConfig = asRecord(rawEntry?.config);
  const rawBridge = asRecord(rawPluginConfig?.bridge);
  if (!rawBridge || !hasLegacyBridgeArtifactToggle(rawBridge)) {
    return null;
  }

  const nextConfig = structuredClone(config);
  const nextPlugins = asRecord(nextConfig.plugins) ?? {};
  nextConfig.plugins = nextPlugins;
  const nextEntries = asRecord(nextPlugins.entries) ?? {};
  nextPlugins.entries = nextEntries;
  const nextEntry = asRecord(nextEntries["memory-wiki"]) ?? {};
  nextEntries["memory-wiki"] = nextEntry;
  const nextPluginConfig = asRecord(nextEntry.config) ?? {};
  nextEntry.config = nextPluginConfig;
  const nextBridge = asRecord(nextPluginConfig.bridge) ?? {};
  nextPluginConfig.bridge = nextBridge;

  const legacyValue = nextBridge.readMemoryCore;
  const hasCanonical = Object.prototype.hasOwnProperty.call(nextBridge, "readMemoryArtifacts");
  if (!hasCanonical) {
    nextBridge.readMemoryArtifacts = legacyValue;
  }
  delete nextBridge.readMemoryCore;

  return {
    config: nextConfig,
    changes: hasCanonical
      ? [
          "Removed legacy plugins.entries.memory-wiki.config.bridge.readMemoryCore; kept explicit plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts.",
        ]
      : [
          "Moved plugins.entries.memory-wiki.config.bridge.readMemoryCore → plugins.entries.memory-wiki.config.bridge.readMemoryArtifacts.",
        ],
  };
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return migrateMemoryWikiLegacyConfig(cfg) ?? { config: cfg, changes: [] };
}
