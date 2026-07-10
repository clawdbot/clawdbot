// Legacy web-search config migration from tools.web.search to plugin-owned configs.
import { mergeMissing } from "../../../config/legacy.shared.js";
import {
  cloneRecord,
  ensureRecord,
  hasOwnKey,
  isRecord,
  type JsonRecord,
} from "./legacy-config-record-shared.js";

const DANGEROUS_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const BUNDLED_LEGACY_WEB_SEARCH_OWNERS = new Map<string, string>([
  ["brave", "brave"],
  ["duckduckgo", "duckduckgo"],
  ["exa", "exa"],
  ["firecrawl", "firecrawl"],
  ["gemini", "google"],
  ["grok", "xai"],
  ["kimi", "moonshot"],
  ["minimax", "minimax"],
  ["ollama", "ollama"],
  ["parallel", "parallel"],
  ["parallel-free", "parallel"],
  ["perplexity", "perplexity"],
  ["searxng", "searxng"],
  ["tavily", "tavily"],
]);

// Tavily and Parallel (paid + free) only ever used the plugin-owned config path,
// so there is no legacy `tools.web.search.<id>.*` shape to migrate for them.
const NON_MIGRATED_LEGACY_WEB_SEARCH_PROVIDER_IDS = new Set([
  "parallel",
  "parallel-free",
  "tavily",
]);
const LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID = "brave";
const RETIRED_GROK_WEB_SEARCH_MODELS = new Set([
  "grok-4-1-fast",
  "grok-4-1-fast-reasoning",
  "grok-4-fast",
  "grok-4-fast-reasoning",
  "grok-4-0709",
]);
const RETIRED_GROK_CODE_MODELS = new Set([
  "grok-code-fast-1",
  "grok-code-fast",
  "grok-code-fast-1-0825",
]);

export function resolveLegacyGrokWebSearchModelTarget(model: unknown): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  const normalized = model.trim().toLowerCase();
  if (RETIRED_GROK_WEB_SEARCH_MODELS.has(normalized)) {
    return "grok-4.3";
  }
  if (RETIRED_GROK_CODE_MODELS.has(normalized)) {
    return "grok-build-0.1";
  }
  return undefined;
}

function getBundledLegacyWebSearchOwners(): ReadonlyMap<string, string> {
  return BUNDLED_LEGACY_WEB_SEARCH_OWNERS;
}

function getLegacyWebSearchProviderIds(
  owners: ReadonlyMap<string, string> = getBundledLegacyWebSearchOwners(),
): string[] {
  return [...owners.keys()]
    .filter((providerId) => !NON_MIGRATED_LEGACY_WEB_SEARCH_PROVIDER_IDS.has(providerId))
    .toSorted((left, right) => left.localeCompare(right));
}

function getLegacyWebSearchProviderIdSet(owners: ReadonlyMap<string, string>): Set<string> {
  return new Set(getLegacyWebSearchProviderIds(owners));
}

function resolveLegacySearchConfig(raw: unknown): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const tools = isRecord(raw.tools) ? raw.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  return isRecord(web?.search) ? web.search : undefined;
}

function copyLegacyProviderConfig(search: JsonRecord, providerKey: string): JsonRecord | undefined {
  const current = search[providerKey];
  return isRecord(current) ? cloneRecord(current) : undefined;
}

function hasMappedLegacyWebSearchConfig(
  raw: unknown,
  owners: ReadonlyMap<string, string>,
): boolean {
  const search = resolveLegacySearchConfig(raw);
  if (!search) {
    return false;
  }
  if (hasOwnKey(search, "apiKey")) {
    return true;
  }
  return getLegacyWebSearchProviderIds(owners).some((providerId) => isRecord(search[providerId]));
}

function resolveLegacyGlobalWebSearchMigration(
  search: JsonRecord,
  owners: ReadonlyMap<string, string>,
): {
  pluginId: string;
  payload: JsonRecord;
  legacyPath: string;
  targetPath: string;
} | null {
  const legacyProviderConfig = copyLegacyProviderConfig(
    search,
    LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID,
  );
  const payload = legacyProviderConfig ?? {};
  const hasLegacyApiKey = hasOwnKey(search, "apiKey");
  if (hasLegacyApiKey) {
    payload.apiKey = search.apiKey;
  }
  if (Object.keys(payload).length === 0) {
    return null;
  }
  const pluginId =
    owners.get(LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID) ?? LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID;
  return {
    pluginId,
    payload,
    legacyPath: hasLegacyApiKey
      ? "tools.web.search.apiKey"
      : `tools.web.search.${LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID}`,
    targetPath:
      hasLegacyApiKey && !legacyProviderConfig
        ? `plugins.entries.${pluginId}.config.webSearch.apiKey`
        : `plugins.entries.${pluginId}.config.webSearch`,
  };
}

function migratePluginWebSearchConfig(params: {
  root: JsonRecord;
  legacyPath: string;
  targetPath: string;
  pluginId: string;
  payload: JsonRecord;
  changes: string[];
}) {
  const plugins = ensureRecord(params.root, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, params.pluginId);
  const config = ensureRecord(entry, "config");
  const hadEnabled = entry.enabled !== undefined;
  const existing = isRecord(config.webSearch) ? cloneRecord(config.webSearch) : undefined;

  if (!hadEnabled) {
    entry.enabled = true;
  }

  if (!existing) {
    config.webSearch = cloneRecord(params.payload);
    params.changes.push(`Moved ${params.legacyPath} → ${params.targetPath}.`);
    return;
  }

  const merged = cloneRecord(existing);
  mergeMissing(merged, params.payload);
  const changed = JSON.stringify(merged) !== JSON.stringify(existing) || !hadEnabled;
  config.webSearch = merged;
  if (changed) {
    params.changes.push(
      `Merged ${params.legacyPath} → ${params.targetPath} (filled missing fields from legacy; kept explicit plugin config values).`,
    );
    return;
  }

  params.changes.push(`Removed ${params.legacyPath} (${params.targetPath} already set).`);
}

/** List legacy tools.web.search provider config paths present in raw config. */
export function listLegacyWebSearchConfigPaths(raw: unknown): string[] {
  const owners = getBundledLegacyWebSearchOwners();
  const search = resolveLegacySearchConfig(raw);
  if (!search) {
    return [];
  }
  const paths: string[] = [];

  if ("apiKey" in search) {
    paths.push("tools.web.search.apiKey");
  }
  for (const providerId of getLegacyWebSearchProviderIds(owners)) {
    const scoped = search[providerId];
    if (isRecord(scoped)) {
      for (const key of Object.keys(scoped)) {
        paths.push(`tools.web.search.${providerId}.${key}`);
      }
    }
  }
  return paths;
}

/** Move legacy web-search provider config into provider plugin entries. */
export function migrateLegacyWebSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }

  const owners = getBundledLegacyWebSearchOwners();
  if (!hasMappedLegacyWebSearchConfig(raw, owners)) {
    return { config: raw, changes: [] };
  }

  return normalizeLegacyWebSearchConfigRecord(structuredClone(raw) as T & JsonRecord, owners);
}

function normalizeLegacyWebSearchConfigRecord<T extends JsonRecord>(
  raw: T,
  owners: ReadonlyMap<string, string>,
): {
  config: T;
  changes: string[];
} {
  const nextRoot = cloneRecord(raw);
  const tools = ensureRecord(nextRoot, "tools");
  const web = ensureRecord(tools, "web");
  const search = resolveLegacySearchConfig(nextRoot);
  if (!search) {
    return { config: raw, changes: [] };
  }
  const nextSearch: JsonRecord = {};
  const changes: string[] = [];

  for (const [key, value] of Object.entries(search)) {
    if (key === "apiKey") {
      continue;
    }
    if (getLegacyWebSearchProviderIdSet(owners).has(key) && isRecord(value)) {
      continue;
    }
    if (DANGEROUS_RECORD_KEYS.has(key)) {
      continue;
    }
    nextSearch[key] = value;
  }
  web.search = nextSearch;

  const globalSearchMigration = resolveLegacyGlobalWebSearchMigration(search, owners);
  if (globalSearchMigration) {
    migratePluginWebSearchConfig({
      root: nextRoot,
      legacyPath: globalSearchMigration.legacyPath,
      targetPath: globalSearchMigration.targetPath,
      pluginId: globalSearchMigration.pluginId,
      payload: globalSearchMigration.payload,
      changes,
    });
  }

  for (const providerId of getLegacyWebSearchProviderIds(owners)) {
    if (providerId === LEGACY_GLOBAL_WEB_SEARCH_PROVIDER_ID) {
      continue;
    }
    const scoped = copyLegacyProviderConfig(search, providerId);
    if (!scoped || Object.keys(scoped).length === 0) {
      continue;
    }
    const pluginId = owners.get(providerId);
    if (!pluginId) {
      continue;
    }
    if (providerId === "grok") {
      const targetModel = resolveLegacyGrokWebSearchModelTarget(scoped.model);
      if (targetModel) {
        const previousModel = scoped.model;
        scoped.model = targetModel;
        changes.push(
          `Updated tools.web.search.grok.model from ${JSON.stringify(previousModel)} to ${JSON.stringify(targetModel)}.`,
        );
      }
    }
    migratePluginWebSearchConfig({
      root: nextRoot,
      legacyPath: `tools.web.search.${providerId}`,
      targetPath: `plugins.entries.${pluginId}.config.webSearch`,
      pluginId,
      payload: scoped,
      changes,
    });
  }

  return { config: nextRoot, changes };
}
