import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isModelThinkingFormat } from "../../../config/types.models.js";

function hasInvalidThinkingFormat(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord) {
    return false;
  }

  for (const provider of Object.values(providersRecord)) {
    const models = getRecord(provider)?.models;
    if (!Array.isArray(models)) {
      continue;
    }

    for (const model of models) {
      const compat = getRecord(getRecord(model)?.compat);
      const thinkingFormat = compat?.thinkingFormat;
      if (typeof thinkingFormat === "string" && !isModelThinkingFormat(thinkingFormat)) {
        return true;
      }
    }
  }

  return false;
}

const INVALID_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].compat.thinkingFormat has an unrecognized value; run "openclaw doctor --fix" to remove it and restore the runtime default.',
  match: (value) => hasInvalidThinkingFormat(value),
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat.thinkingFormat-invalid",
    describe: "Remove unrecognized compat.thinkingFormat values from provider model entries",
    legacyRules: [INVALID_THINKING_FORMAT_RULE],
    apply: (raw, changes) => {
      const providers = getRecord(getRecord(raw.models)?.providers);
      if (!providers) {
        return;
      }

      for (const [providerId, provider] of Object.entries(providers)) {
        const models = getRecord(provider)?.models;
        if (!Array.isArray(models)) {
          continue;
        }

        for (const [index, model] of models.entries()) {
          const compat = getRecord(getRecord(model)?.compat);
          if (!compat) {
            continue;
          }
          const thinkingFormat = compat.thinkingFormat;
          if (typeof thinkingFormat !== "string" || isModelThinkingFormat(thinkingFormat)) {
            continue;
          }

          delete compat.thinkingFormat;
          changes.push(
            `Removed models.providers.${providerId}.models.${index}.compat.thinkingFormat (unrecognized value ${JSON.stringify(thinkingFormat)}; runtime default applies).`,
          );
        }
      }
    },
  }),
];
