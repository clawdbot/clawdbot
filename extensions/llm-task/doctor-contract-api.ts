// LLM Task doctor contract migrates shipped plugin-local completion policy.
import { parseModelRef } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor";

const ENTRY_PATH = "plugins.entries.llm-task";

function preserveLiteralLegacyModelRefs(values: string[]): string[] {
  return values.filter((value) => {
    if (value !== value.trim() || value === "*") {
      return false;
    }
    const normalized = parseModelRef(value, "");
    if (!normalized) {
      return false;
    }
    return `${normalized.provider}/${normalized.model}` === value;
  });
}

export const legacyConfigRules = [
  {
    path: ["plugins", "entries", "llm-task", "config", "allowedModels"],
    message: `${ENTRY_PATH}.config.allowedModels moved to ${ENTRY_PATH}.llm.allowedCompletionModels. Run "openclaw doctor --fix".`,
  },
  {
    path: ["plugins", "entries", "llm-task"],
    message: `${ENTRY_PATH} needs host-owned LLM model/profile permissions to preserve shipped tool parameters. Run "openclaw doctor --fix".`,
    match: (value: unknown) => {
      const entry = asObjectRecord(value);
      const llm = asObjectRecord(entry?.llm);
      return llm?.allowModelOverride === undefined || llm.allowAuthProfileOverride === undefined;
    },
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const plugins = asObjectRecord(cfg.plugins);
  const entries = asObjectRecord(plugins?.entries);
  const entry = asObjectRecord(entries?.["llm-task"]);
  if (!entry) {
    return { config: cfg, changes: [] };
  }

  const pluginConfig = asObjectRecord(entry.config) ?? {};
  const hadLegacyAllowedModels = Object.hasOwn(pluginConfig, "allowedModels");
  const legacyAllowedModelsValue = pluginConfig.allowedModels;
  const legacyAllowedModels = Array.isArray(legacyAllowedModelsValue)
    ? legacyAllowedModelsValue.filter((value): value is string => typeof value === "string")
    : undefined;
  const migratedAllowedModels = !hadLegacyAllowedModels
    ? undefined
    : !Array.isArray(legacyAllowedModelsValue)
      ? []
      : legacyAllowedModelsValue.length === 0
        ? undefined
        : preserveLiteralLegacyModelRefs(legacyAllowedModels ?? []);
  const llm = asObjectRecord(entry.llm) ?? {};
  const nextLlm = {
    ...llm,
    ...(llm.allowModelOverride === undefined ? { allowModelOverride: true } : {}),
    ...(llm.allowAuthProfileOverride === undefined ? { allowAuthProfileOverride: true } : {}),
    ...(llm.allowedCompletionModels === undefined && migratedAllowedModels !== undefined
      ? { allowedCompletionModels: migratedAllowedModels }
      : {}),
  };
  const policyChanged =
    llm.allowModelOverride === undefined || llm.allowAuthProfileOverride === undefined;
  if (!hadLegacyAllowedModels && !policyChanged) {
    return { config: cfg, changes: [] };
  }

  const { allowedModels: _legacyAllowedModels, ...nextPluginConfig } = pluginConfig;
  const changes: string[] = [];
  if (hadLegacyAllowedModels) {
    changes.push(
      llm.allowedCompletionModels !== undefined
        ? `Removed ${ENTRY_PATH}.config.allowedModels; existing ${ENTRY_PATH}.llm.allowedCompletionModels remains authoritative.`
        : migratedAllowedModels !== undefined
          ? `Moved ${ENTRY_PATH}.config.allowedModels to ${ENTRY_PATH}.llm.allowedCompletionModels.`
          : `Removed empty ${ENTRY_PATH}.config.allowedModels; unrestricted model selection remains unchanged.`,
    );
  }
  if (policyChanged) {
    changes.push(
      `Enabled ${ENTRY_PATH}.llm model and auth-profile overrides to preserve shipped llm-task behavior.`,
    );
  }

  return {
    config: {
      ...cfg,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          "llm-task": {
            ...entry,
            llm: nextLlm,
            config: nextPluginConfig,
          },
        },
      } as OpenClawConfig["plugins"],
    },
    changes,
  };
}
