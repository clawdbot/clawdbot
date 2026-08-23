import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.openclaw.js";

type JsonRecord = Record<string, unknown>;

const MODEL_CONTEXT_TOKENS_REPLACEMENT = "models.providers.<provider>.models[].contextTokens";

type ContextBudgetConfigMigration<T = unknown> = {
  config: T;
  changed: boolean;
  changes: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
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

function removeAgentContextTokens(
  root: JsonRecord,
  changes: ConfigValidationIssue[],
  warnings: ConfigValidationIssue[],
): void {
  const agents = root.agents;
  if (!isRecord(agents)) {
    return;
  }
  const removeContextTokens = (record: unknown, path: string): void => {
    if (!isRecord(record) || !Object.hasOwn(record, "contextTokens")) {
      return;
    }
    delete record.contextTokens;
    changes.push({ path, message: `Removed ${path}.` });
    warnings.push({
      path,
      message: `${path} cannot be represented per model; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
    });
  };
  removeContextTokens(agents.defaults, "agents.defaults.contextTokens");
  const entries = agents.entries;
  if (isRecord(entries)) {
    for (const [agentId, entry] of Object.entries(entries)) {
      removeContextTokens(entry, `agents.entries.${agentId}.contextTokens`);
    }
  }
  if (Array.isArray(agents.list)) {
    for (const [index, entry] of agents.list.entries()) {
      removeContextTokens(entry, `agents.list[${index}].contextTokens`);
    }
  }
}

function migrateProviderContextBudgets(
  root: JsonRecord,
  changes: ConfigValidationIssue[],
  warnings: ConfigValidationIssue[],
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
          changes.push({
            path: sourcePath,
            message: `${sourcePath} → models.providers.${providerId}.models[${index}].${key}.`,
          });
        }
        delete provider[key];
        changes.push({
          path: sourcePath,
          message: `Removed ${sourcePath} after baking it into explicit model entries.`,
        });
        continue;
      }
      delete provider[key];
      changes.push({ path: sourcePath, message: `Removed ${sourcePath}.` });
      warnings.push({
        path: sourcePath,
        message: `${sourcePath} had no explicit model entries to receive its value; use ${MODEL_CONTEXT_TOKENS_REPLACEMENT} instead.`,
      });
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
  const changes: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [];
  migrateProviderContextBudgets(next, changes, warnings);
  removeAgentContextTokens(next, changes, warnings);
  return changes.length > 0
    ? { config: next, changed: true, changes, warnings }
    : { config: raw, changed: false, changes, warnings };
}
