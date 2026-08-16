import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "./types.openclaw.js";

type JsonRecord = Record<string, unknown>;

const MODEL_CONTEXT_TOKENS_REPLACEMENT = "models.providers.<provider>.models[].contextTokens";

type ContextBudgetConfigMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: string[];
  warnings: string[];
};

function hasLegacyContextBudgetConfig(root: JsonRecord): boolean {
  const providers = isRecord(root.models) ? root.models.providers : undefined;
  if (
    isRecord(providers) &&
    Object.values(providers).some(
      (provider) =>
        isRecord(provider) &&
        (Object.hasOwn(provider, "contextTokens") || Object.hasOwn(provider, "contextWindow")),
    )
  ) {
    return true;
  }
  const agents = root.agents;
  if (!isRecord(agents)) {
    return false;
  }
  if (isRecord(agents.defaults) && Object.hasOwn(agents.defaults, "contextTokens")) {
    return true;
  }
  if (
    isRecord(agents.entries) &&
    Object.values(agents.entries).some(
      (entry) => isRecord(entry) && Object.hasOwn(entry, "contextTokens"),
    )
  ) {
    return true;
  }
  return (
    Array.isArray(agents.list) &&
    agents.list.some((entry) => isRecord(entry) && Object.hasOwn(entry, "contextTokens"))
  );
}

function removeAgentContextTokens(root: JsonRecord, changes: string[], warnings: string[]): void {
  const agents = root.agents;
  if (!isRecord(agents)) {
    return;
  }
  const defaults = agents.defaults;
  if (isRecord(defaults) && Object.hasOwn(defaults, "contextTokens")) {
    delete defaults.contextTokens;
    changes.push("Removed agents.defaults.contextTokens.");
    warnings.push(
      `agents.defaults.contextTokens cannot be represented per model; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
    );
  }
  const entries = agents.entries;
  if (isRecord(entries)) {
    for (const [agentId, entry] of Object.entries(entries)) {
      if (!isRecord(entry) || !Object.hasOwn(entry, "contextTokens")) {
        continue;
      }
      delete entry.contextTokens;
      const path = `agents.entries.${agentId}.contextTokens`;
      changes.push(`Removed ${path}.`);
      warnings.push(
        `${path} cannot be represented per model; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
      );
    }
  }
  if (!Array.isArray(agents.list)) {
    return;
  }
  for (const [index, entry] of agents.list.entries()) {
    if (!isRecord(entry) || !Object.hasOwn(entry, "contextTokens")) {
      continue;
    }
    delete entry.contextTokens;
    const path = `agents.list[${index}].contextTokens`;
    changes.push(`Removed ${path}.`);
    warnings.push(
      `${path} cannot be represented per model; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
    );
  }
}

function migrateProviderContextBudgets(
  root: JsonRecord,
  changes: string[],
  warnings: string[],
): void {
  const providers = isRecord(root.models) ? root.models.providers : undefined;
  if (!isRecord(providers)) {
    return;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) {
      continue;
    }
    for (const key of ["contextTokens", "contextWindow"] as const) {
      if (!Object.hasOwn(provider, key)) {
        continue;
      }
      const sourcePath = `models.providers.${providerId}.${key}`;
      if (Array.isArray(provider.models) && provider.models.length > 0) {
        for (const [index, model] of provider.models.entries()) {
          if (!isRecord(model) || model[key] !== undefined) {
            continue;
          }
          model[key] = provider[key];
          changes.push(`${sourcePath} → models.providers.${providerId}.models[${index}].${key}.`);
        }
        delete provider[key];
        changes.push(`Removed ${sourcePath} after baking it into explicit model entries.`);
        continue;
      }
      delete provider[key];
      changes.push(`Removed ${sourcePath}.`);
      warnings.push(
        `${sourcePath} had no explicit model entries to receive its value; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
      );
    }
  }
}

/** Removes retired context-budget keys before strict config validation. */
export function migrateLegacyContextBudgetConfig(
  raw: OpenClawConfig,
): ContextBudgetConfigMigration<OpenClawConfig>;
export function migrateLegacyContextBudgetConfig(raw: unknown): ContextBudgetConfigMigration;
export function migrateLegacyContextBudgetConfig(raw: unknown): ContextBudgetConfigMigration {
  if (!isRecord(raw) || !hasLegacyContextBudgetConfig(raw)) {
    return { config: raw, changed: false, changes: [], warnings: [] };
  }
  const next = structuredClone(raw);
  const changes: string[] = [];
  const warnings: string[] = [];
  migrateProviderContextBudgets(next, changes, warnings);
  removeAgentContextTokens(next, changes, warnings);
  return changes.length > 0
    ? { config: next, changed: true, changes, warnings }
    : { config: raw, changed: false, changes, warnings };
}
