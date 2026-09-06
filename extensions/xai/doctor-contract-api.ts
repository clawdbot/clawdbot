// Xai doctor contract repairs plugin-owned model configuration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isLegacyXaiBuiltinModel } from "./model-definitions.js";
import { isXaiProviderId } from "./provider-id.js";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

type PluginModelMigration = {
  path: string[];
  retiredModels: ReadonlySet<string>;
  targetModel: string;
};

const RETIRED_REASONING_MODELS = new Set([
  "grok-4-1-fast",
  "grok-4-1-fast-reasoning",
  "grok-4-fast",
  "grok-4-fast-reasoning",
  "grok-4-0709",
]);
const RETIRED_NON_REASONING_MODELS = new Set([
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-3",
]);
const RETIRED_CODE_MODELS = new Set([
  "grok-code-fast-1",
  "grok-code-fast",
  "grok-code-fast-1-0825",
]);

const PLUGIN_MODEL_MIGRATIONS: PluginModelMigration[] = [
  {
    path: ["plugins", "entries", "xai", "config", "webSearch"],
    retiredModels: RETIRED_REASONING_MODELS,
    targetModel: "grok-4.3",
  },
  {
    path: ["plugins", "entries", "xai", "config", "codeExecution"],
    retiredModels: RETIRED_REASONING_MODELS,
    targetModel: "grok-4.3",
  },
  {
    path: ["plugins", "entries", "xai", "config", "xSearch"],
    retiredModels: RETIRED_NON_REASONING_MODELS,
    targetModel: "grok-4.3",
  },
  ...[
    ["plugins", "entries", "xai", "config", "webSearch"],
    ["plugins", "entries", "xai", "config", "codeExecution"],
    ["plugins", "entries", "xai", "config", "xSearch"],
  ].map((path) => ({ path, retiredModels: RETIRED_CODE_MODELS, targetModel: "grok-build-0.1" })),
];
const XAI_MEDIA_MODEL_LIST_PATHS = [["tools", "media", "models"]] as const;

function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    current = asObjectRecord(current)?.[segment];
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function isRetiredToolModel(value: unknown, retiredModels: ReadonlySet<string>): boolean {
  const model = asObjectRecord(value)?.model;
  return typeof model === "string" && retiredModels.has(model.trim().toLowerCase());
}

function hasLegacyBuiltinCatalogRows(value: unknown): boolean {
  return Array.isArray(value) && value.some((model) => isLegacyXaiBuiltinModel(model));
}

function asXaiProviderMediaEntry(value: unknown) {
  const entry = asObjectRecord(value);
  // An omitted type plus a command is a CLI entry at runtime. Its model is an arbitrary label.
  if (
    !entry ||
    (entry.type !== undefined && entry.type !== "provider") ||
    (entry.type === undefined && entry.command)
  ) {
    return undefined;
  }
  if (!isXaiProviderId(entry.provider)) {
    return undefined;
  }
  return entry;
}

function hasImageCapability(entry: { capabilities?: unknown }): boolean {
  return (
    Array.isArray(entry.capabilities) &&
    entry.capabilities.some(
      (capability) => typeof capability === "string" && capability.trim().toLowerCase() === "image",
    )
  );
}

function isRetiredXaiImageMediaEntry(value: unknown): boolean {
  const entry = asXaiProviderMediaEntry(value);
  // Media entries cannot preserve "reasoning disabled", so migrate only compatible redirects.
  // Shared xAI media entries without capabilities infer audio from provider
  // metadata, so rewriting them to grok-4.3 would mutate audio config.
  // Require an explicit capabilities tag that includes image.
  return (
    typeof entry?.model === "string" &&
    RETIRED_REASONING_MODELS.has(entry.model.trim().toLowerCase()) &&
    hasImageCapability(entry)
  );
}

function hasRetiredXaiImageMediaEntries(value: unknown): boolean {
  return Array.isArray(value) && value.some(isRetiredXaiImageMediaEntry);
}

function isLegacyXaiSttEntry(value: unknown): boolean {
  const entry = asXaiProviderMediaEntry(value);
  return typeof entry?.model === "string" && entry.model.trim().toLowerCase() === "grok-stt";
}

function hasLegacyXaiSttEntries(value: unknown): boolean {
  return Array.isArray(value) && value.some(isLegacyXaiSttEntry);
}

export const legacyConfigRules: LegacyConfigRule[] = [
  ...PLUGIN_MODEL_MIGRATIONS.map((migration) => ({
    path: migration.path,
    message: `${migration.path.join(".")}.model uses a retired xAI model; run "openclaw doctor --fix" to use ${migration.targetModel}.`,
    match: (value: unknown) => isRetiredToolModel(value, migration.retiredModels),
  })),
  ...XAI_MEDIA_MODEL_LIST_PATHS.map((path) => ({
    path: [...path],
    message: `${path.join(".")} contains an xAI image entry with a retired model; run "openclaw doctor --fix" to migrate it to grok-4.3.`,
    match: hasRetiredXaiImageMediaEntries,
  })),
  ...XAI_MEDIA_MODEL_LIST_PATHS.map((path) => ({
    path: [...path],
    message: `${path.join(".")} contains the obsolete xAI grok-stt model selector; run "openclaw doctor --fix" to remove it.`,
    match: hasLegacyXaiSttEntries,
  })),
  {
    path: ["models", "providers", "xai", "models"],
    message:
      'models.providers.xai.models contains stale generated xAI catalog rows; run "openclaw doctor --fix" to remove them.',
    match: hasLegacyBuiltinCatalogRows,
  },
];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = cfg;
  const changes: string[] = [];

  for (const migration of PLUGIN_MODEL_MIGRATIONS) {
    const current = readPath(next, migration.path);
    if (!isRetiredToolModel(current, migration.retiredModels)) {
      continue;
    }
    if (next === cfg) {
      next = structuredClone(cfg);
    }
    const target = asObjectRecord(readPath(next, migration.path));
    if (!target) {
      continue;
    }
    const previous = target.model;
    target.model = migration.targetModel;
    changes.push(
      `Updated ${migration.path.join(".")}.model from ${JSON.stringify(previous)} to ${JSON.stringify(migration.targetModel)}.`,
    );
  }

  for (const path of XAI_MEDIA_MODEL_LIST_PATHS) {
    const currentEntries = readPath(next, path);
    const hasRetiredImages = hasRetiredXaiImageMediaEntries(currentEntries);
    const hasLegacyStt = hasLegacyXaiSttEntries(currentEntries);
    if (!hasRetiredImages && !hasLegacyStt) {
      continue;
    }
    if (next === cfg) {
      next = structuredClone(cfg);
    }
    const entries = readPath(next, path);
    if (!Array.isArray(entries)) {
      continue;
    }
    let migrated = 0;
    let removed = 0;
    for (const entry of entries) {
      const rec = asObjectRecord(entry);
      if (isRetiredXaiImageMediaEntry(entry) && rec) {
        rec.model = "grok-4.3";
        migrated += 1;
        continue;
      }
      if (isLegacyXaiSttEntry(entry) && rec) {
        delete rec.model;
        removed += 1;
      }
    }
    if (migrated > 0) {
      changes.push(
        `Migrated ${migrated} retired xAI image model${migrated === 1 ? "" : "s"} in ${path.join(".")} to grok-4.3.`,
      );
    }
    if (removed > 0) {
      changes.push(
        `Removed the obsolete xAI grok-stt model selector from ${removed} ${path.join(".")} entr${removed === 1 ? "y" : "ies"}.`,
      );
    }
  }

  const modelsPath = ["models", "providers", "xai", "models"];
  const configuredModels = readPath(next, modelsPath);
  if (hasLegacyBuiltinCatalogRows(configuredModels)) {
    if (next === cfg) {
      next = structuredClone(cfg);
    }
    const provider = asObjectRecord(readPath(next, ["models", "providers", "xai"]));
    const models = provider?.models;
    if (provider && Array.isArray(models)) {
      const retained = models.filter((model) => !isLegacyXaiBuiltinModel(model));
      const removed = models.length - retained.length;
      provider.models = retained;
      changes.push(`Removed ${removed} stale generated xAI model catalog row(s).`);
    }
  }

  return { config: next, changes };
}
