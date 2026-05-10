import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasRetiredDynamicToolsProfile(value: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(asRecord(value) ?? {}, "codexDynamicToolsProfile");
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "codex", "config"],
    message:
      'plugins.entries.codex.config.codexDynamicToolsProfile is retired; Codex app-server always keeps Codex-native workspace tools native. Run "openclaw doctor --fix".',
    match: hasRetiredDynamicToolsProfile,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const rawEntry = asRecord(cfg.plugins?.entries?.codex);
  const rawPluginConfig = asRecord(rawEntry?.config);
  if (!rawPluginConfig || !hasRetiredDynamicToolsProfile(rawPluginConfig)) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg) as OpenClawConfig & {
    plugins?: Record<string, unknown>;
  };
  const nextPlugins = asRecord(nextConfig.plugins);
  const nextEntries = asRecord(nextPlugins?.entries);
  const nextEntry = asRecord(nextEntries?.codex);
  const nextPluginConfig = asRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }

  delete nextPluginConfig.codexDynamicToolsProfile;
  return {
    config: nextConfig,
    changes: [
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    ],
  };
}

export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "codex",
    label: "Codex",
    providerIds: ["codex", "codex-cli", "openai-codex"],
    runtimeIds: ["codex", "codex-cli"],
    cliSessionKeys: ["codex-cli"],
    authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
  },
];
