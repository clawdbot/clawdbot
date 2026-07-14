/**
 * Config presets — opinionated configuration bundles that set multiple
 * settings at once. Applied via config.patch to avoid submitting
 * unrelated fields (e.g. redacted SecretRefs) through the full-config path.
 *
 * User-facing strings (label, description, detail, impact) live in the
 * i18n locale under quickSettings.presets.<id>.* so the control-ui-i18n
 * check passes.
 */

import { t } from "../../i18n/index.ts";

export type ConfigPresetId = "personal" | "codeAgent" | "teamBot" | "minimal";

type ConfigPresetPatch = {
  agents: {
    defaults: {
      bootstrapMaxChars: number;
      bootstrapTotalMaxChars: number;
      contextInjection: "always" | "continuation-skip";
    };
  };
};

type ConfigPreset = {
  id: ConfigPresetId;
  icon: string;
  patch: ConfigPresetPatch;
};

export const CONFIG_PRESETS: ConfigPreset[] = [
  {
    id: "personal",
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

function getPresetById(id: ConfigPresetId): ConfigPreset | undefined {
  return CONFIG_PRESETS.find((p) => p.id === id);
}

/** Thin helper so Lit components can delegate applyPreset without housing
 *  the async orchestration logic inline.  Keeps config-page.ts under its
 *  LOC-ratchet ceiling. */
export async function executeApplyPreset(
  runtimeConfig: {
    applyPreset: (patch: Record<string, unknown>, note: string) => Promise<boolean>;
    state: { lastError: string | null };
  },
  presetId: ConfigPresetId,
): Promise<string | null> {
  const preset = getPresetById(presetId);
  if (!preset) {
    return null;
  }
  try {
    const ok = await runtimeConfig.applyPreset(
      preset.patch,
      `Applied ${t(`quickSettings.presets.${presetId}.label`)} profile`,
    );
    if (!ok) {
      return runtimeConfig.state.lastError ?? "Failed to apply profile";
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
