/**
 * Config presets — opinionated configuration bundles that set multiple
 * settings at once. Applied via config.patch.
 */

export type ConfigPresetId = "personal" | "codeAgent" | "teamBot" | "minimal";

export type ConfigPreset = {
  id: ConfigPresetId;
  label: string;
  description: string;
  icon: string;
  patch: Record<string, unknown>;
};

export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    id: "personal",
    label: "Personal Assistant",
    description: "Balanced context and cost. Best for daily use.",
    icon: "✨",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 20_000,
          bootstrapTotalMaxChars: 150_000,
          contextInjection: "always",
        },
      },
    },
  },
  {
    id: "codeAgent",
    label: "Code Agent",
    description: "Higher context for coding tasks. More tokens per turn.",
    icon: "🛠️",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 50_000,
          bootstrapTotalMaxChars: 300_000,
          contextInjection: "always",
        },
      },
    },
  },
  {
    id: "teamBot",
    label: "Team Bot",
    description: "Multi-channel, group-aware. Leaner per-turn context.",
    icon: "👥",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 10_000,
          bootstrapTotalMaxChars: 80_000,
          contextInjection: "continuation-skip",
        },
      },
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Lowest cost per turn. Fast and lean.",
    icon: "⚡",
    patch: {
      agents: {
        defaults: {
          bootstrapMaxChars: 5_000,
          bootstrapTotalMaxChars: 30_000,
          contextInjection: "continuation-skip",
        },
      },
    },
  },
];

export function getPresetById(id: ConfigPresetId): ConfigPreset | undefined {
  return CONFIG_PRESETS.find((p) => p.id === id);
}

/**
 * Detect which preset (if any) matches the current config values.
 */
export function detectActivePreset(config: Record<string, unknown>): ConfigPresetId | null {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  if (!defaults) {
    return "personal"; // treat unset as default
  }
  const maxChars = defaults.bootstrapMaxChars;
  const totalMax = defaults.bootstrapTotalMaxChars;
  for (const preset of CONFIG_PRESETS) {
    const presetDefaults = (preset.patch.agents as Record<string, unknown>)?.defaults as
      | Record<string, unknown>
      | undefined;
    if (!presetDefaults) {
      continue;
    }
    if (
      maxChars === presetDefaults.bootstrapMaxChars &&
      totalMax === presetDefaults.bootstrapTotalMaxChars
    ) {
      return preset.id;
    }
  }
  return null;
}
