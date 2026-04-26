/**
 * Config presets — opinionated configuration bundles that set multiple
 * settings at once. Applied via config.patch.
 */

export type ConfigPresetId = "personal" | "codeAgent" | "teamBot" | "minimal";

export type ConfigPresetPatch = {
  agents: {
    defaults: {
      bootstrapMaxChars: number;
      bootstrapTotalMaxChars: number;
      contextInjection: "always" | "continuation-skip";
    };
  };
};

export type ConfigPreset = {
  id: ConfigPresetId;
  label: string;
  description: string;
  detail: string;
  impact: string;
  icon: string;
  patch: ConfigPresetPatch;
};

export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    id: "personal",
    label: "Personal Assistant",
    description: "Balanced default for daily use.",
    detail: "Good fit for chat, docs, and light edits without a large coding budget.",
    impact: "Injects bootstrap context every turn with a moderate prompt budget.",
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
    description: "Highest context budget for repo work.",
    detail: "Best for multi-file changes, long bootstrap docs, and code-heavy sessions.",
    impact: "Uses the largest prompt budget and reinjects context every turn.",
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
    description: "Lean follow-ups for shared bots.",
    detail:
      "Best for multi-channel workflows where continuity matters more than large bootstrap payloads.",
    impact: "Keeps follow-up turns smaller by skipping safe continuation reinjection.",
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
    description: "Smallest context budget and lowest cost.",
    detail: "Best for quick utility turns, automations, and cost-sensitive workflows.",
    impact: "Uses the smallest bootstrap budget and the leanest follow-up behavior.",
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
    return null;
  }
  const maxChars = defaults.bootstrapMaxChars;
  const totalMax = defaults.bootstrapTotalMaxChars;
  const contextInjection = defaults.contextInjection;
  for (const preset of CONFIG_PRESETS) {
    const presetDefaults = (preset.patch.agents as Record<string, unknown>)?.defaults as
      | Record<string, unknown>
      | undefined;
    if (!presetDefaults) {
      continue;
    }
    if (
      maxChars === presetDefaults.bootstrapMaxChars &&
      totalMax === presetDefaults.bootstrapTotalMaxChars &&
      contextInjection === presetDefaults.contextInjection
    ) {
      return preset.id;
    }
  }
  return null;
}
