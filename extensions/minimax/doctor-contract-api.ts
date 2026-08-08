// MiniMax doctor contract repairs stale Anthropic-compatible model metadata.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor";

// These aliases remain supported provider identities, so Doctor must repair
// their persisted catalogs before the runtime decides to send native images.
const MINIMAX_ANTHROPIC_PROVIDER_IDS = [
  "minimax",
  "minimax-cn",
  "minimax-portal",
  "minimax-portal-cn",
] as const;
const MINIMAX_M3_MODEL_ID = "MiniMax-M3";

type MinimaxProviderId = (typeof MINIMAX_ANTHROPIC_PROVIDER_IDS)[number];

function hasStaleM3ImageInput(value: unknown): boolean {
  const model = asObjectRecord(value);
  const input = model?.input;
  return (
    model?.id === MINIMAX_M3_MODEL_ID &&
    Array.isArray(input) &&
    input.includes("text") &&
    input.includes("image")
  );
}

function hasStaleM3ImageCatalog(value: unknown): boolean {
  const provider = asObjectRecord(value);
  if (provider?.api !== undefined && provider.api !== "anthropic-messages") {
    return false;
  }
  return Array.isArray(provider?.models) && provider.models.some(hasStaleM3ImageInput);
}

function migrateProviderModels(
  providerId: MinimaxProviderId,
  cfg: OpenClawConfig,
): { config: OpenClawConfig; changes: string[] } | null {
  const provider = cfg.models?.providers?.[providerId];
  if (
    !provider ||
    (provider.api !== undefined && provider.api !== "anthropic-messages") ||
    !Array.isArray(provider.models)
  ) {
    return null;
  }

  const models = provider.models.map((model) =>
    hasStaleM3ImageInput(model)
      ? { ...model, input: model.input?.filter((input) => input !== "image") }
      : model,
  );
  if (models.every((model, index) => model === provider.models?.[index])) {
    return null;
  }

  return {
    config: {
      ...cfg,
      models: {
        ...cfg.models,
        providers: {
          ...cfg.models?.providers,
          [providerId]: { ...provider, models },
        },
      },
    },
    changes: [
      `Removed the unsupported image input from models.providers.${providerId}.models ${MINIMAX_M3_MODEL_ID}.`,
    ],
  };
}

export const legacyConfigRules = MINIMAX_ANTHROPIC_PROVIDER_IDS.map((providerId) => ({
  path: ["models", "providers", providerId],
  message: `models.providers.${providerId}.models lists ${MINIMAX_M3_MODEL_ID} as image-capable on the Anthropic-compatible route. Run "openclaw doctor --fix".`,
  match: hasStaleM3ImageCatalog,
}));

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = cfg;
  const changes: string[] = [];
  for (const providerId of MINIMAX_ANTHROPIC_PROVIDER_IDS) {
    const migration = migrateProviderModels(providerId, next);
    if (migration) {
      next = migration.config;
      changes.push(...migration.changes);
    }
  }
  return { config: next, changes };
}
