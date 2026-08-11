// Legacy web tool config migrations into plugin-owned provider config.
import { ensureRecord, mergeMissing } from "../../../config/legacy.shared.js";
import {
  cloneRecord,
  hasOwnKey,
  isRecord,
  type JsonRecord,
} from "./legacy-config-record-shared.js";

const DANGEROUS_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const LEGACY_WEB_SEARCH_OWNERS = new Map<string, string>([
  ["brave", "brave"],
  ["duckduckgo", "duckduckgo"],
  ["exa", "exa"],
  ["firecrawl", "firecrawl"],
  ["firecrawl-free", "firecrawl"],
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
const NON_MIGRATED_SEARCH_PROVIDERS = new Set([
  "firecrawl-free",
  "parallel",
  "parallel-free",
  "tavily",
]);
const RETIRED_GROK_SEARCH_MODELS = new Set([
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
const RETIRED_X_SEARCH_MODELS = new Set([
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-3",
]);

type PluginMove = {
  pluginId: string;
  configKey: "webSearch" | "webFetch";
  payload: JsonRecord;
  legacyPath: string;
  targetPath: string;
  mergeMode?: "missing" | "own-api-key";
  activatedMessage?: string;
};

type MigrationStep = { message: string } | { move: PluginMove };
type PreparedSlot = { retained: JsonRecord; deleteSource?: boolean; steps: MigrationStep[] };

function legacySearchProviderIds(): string[] {
  return [...LEGACY_WEB_SEARCH_OWNERS.keys()]
    .filter((providerId) => !NON_MIGRATED_SEARCH_PROVIDERS.has(providerId))
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveWebSlot(raw: unknown, slot: string): JsonRecord | undefined {
  if (!isRecord(raw) || !isRecord(raw.tools) || !isRecord(raw.tools.web)) {
    return undefined;
  }
  const value = raw.tools.web[slot];
  return isRecord(value) ? value : undefined;
}

function retainedSource(source: JsonRecord, removedRecordKeys: ReadonlySet<string>): JsonRecord {
  const retained: JsonRecord = {};
  for (const [key, value] of Object.entries(source)) {
    if (DANGEROUS_RECORD_KEYS.has(key) || (removedRecordKeys.has(key) && isRecord(value))) {
      continue;
    }
    retained[key] = value;
  }
  return retained;
}

function applyPluginMove(root: JsonRecord, move: PluginMove, changes: string[]): boolean {
  const entries = ensureRecord(ensureRecord(root, "plugins"), "entries");
  const entry = ensureRecord(entries, move.pluginId);
  const activated = entry.enabled === undefined;
  if (activated) {
    entry.enabled = true;
  }
  const config = ensureRecord(entry, "config");
  const existingValue = config[move.configKey];
  const existingWasRecord = isRecord(existingValue);
  const existing = cloneRecord(existingWasRecord ? existingValue : undefined);

  if (!existingWasRecord) {
    config[move.configKey] = cloneRecord(move.payload);
    changes.push(`Moved ${move.legacyPath} → ${move.targetPath}.`);
  } else if (move.mergeMode === "own-api-key") {
    if (!hasOwnKey(existing, "apiKey")) {
      existing.apiKey = move.payload.apiKey;
      config[move.configKey] = existing;
      changes.push(`Merged ${move.legacyPath} → ${move.targetPath} (filled missing plugin auth).`);
    } else {
      changes.push(`Removed ${move.legacyPath} (${move.targetPath} already set).`);
    }
  } else {
    const merged = cloneRecord(existing);
    mergeMissing(merged, move.payload);
    config[move.configKey] = merged;
    if (JSON.stringify(merged) !== JSON.stringify(existing) || activated) {
      changes.push(
        `Merged ${move.legacyPath} → ${move.targetPath} (filled missing fields from legacy; kept explicit plugin config values).`,
      );
    } else {
      changes.push(`Removed ${move.legacyPath} (${move.targetPath} already set).`);
    }
  }
  return activated;
}

function migrateLegacyWebSlot<T>(
  raw: T,
  slot: "search" | "fetch" | "x_search",
  prepare: (source: JsonRecord) => PreparedSlot | null,
): { config: T; changes: string[] } {
  const source = resolveWebSlot(raw, slot);
  const prepared = source ? prepare(source) : null;
  if (!isRecord(raw) || !prepared) {
    return { config: raw, changes: [] };
  }
  const nextRoot = structuredClone(raw) as T & JsonRecord;
  const web = ensureRecord(ensureRecord(nextRoot, "tools"), "web");
  if (prepared.deleteSource) {
    delete web[slot];
  } else {
    web[slot] = prepared.retained;
  }
  const changes: string[] = [];
  for (const step of prepared.steps) {
    if ("message" in step) {
      changes.push(step.message);
      continue;
    }
    const activated = applyPluginMove(nextRoot, step.move, changes);
    if (activated && step.move.activatedMessage) {
      changes.push(step.move.activatedMessage);
    }
  }
  return { config: nextRoot, changes };
}

function resolveGrokModelTarget(model: unknown, xSearch: boolean): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  const normalized = model.trim().toLowerCase();
  if ((xSearch ? RETIRED_X_SEARCH_MODELS : RETIRED_GROK_SEARCH_MODELS).has(normalized)) {
    return "grok-4.3";
  }
  return RETIRED_GROK_CODE_MODELS.has(normalized) ? "grok-build-0.1" : undefined;
}

function searchMove(
  providerId: string,
  payload: JsonRecord,
  paths?: { legacyPath: string; targetPath: string },
): PluginMove {
  const pluginId = LEGACY_WEB_SEARCH_OWNERS.get(providerId) ?? providerId;
  return {
    pluginId,
    configKey: "webSearch",
    payload,
    legacyPath: paths?.legacyPath ?? `tools.web.search.${providerId}`,
    targetPath: paths?.targetPath ?? `plugins.entries.${pluginId}.config.webSearch`,
  };
}

function prepareWebSearch(source: JsonRecord): PreparedSlot | null {
  const providerIds = legacySearchProviderIds();
  if (!hasOwnKey(source, "apiKey") && !providerIds.some((id) => isRecord(source[id]))) {
    return null;
  }
  const retained = retainedSource(source, new Set(["apiKey", ...providerIds]));
  delete retained.apiKey;
  const steps: MigrationStep[] = [];
  const braveRecord = isRecord(source.brave) ? cloneRecord(source.brave) : undefined;
  const bravePayload = cloneRecord(braveRecord);
  if (hasOwnKey(source, "apiKey")) {
    bravePayload.apiKey = source.apiKey;
  }
  if (Object.keys(bravePayload).length > 0) {
    const hasGlobalApiKey = hasOwnKey(source, "apiKey");
    steps.push({
      move: searchMove(
        "brave",
        bravePayload,
        hasGlobalApiKey
          ? {
              legacyPath: "tools.web.search.apiKey",
              targetPath: braveRecord
                ? "plugins.entries.brave.config.webSearch"
                : "plugins.entries.brave.config.webSearch.apiKey",
            }
          : undefined,
      ),
    });
  }
  for (const providerId of providerIds) {
    if (providerId === "brave" || !isRecord(source[providerId])) {
      continue;
    }
    const payload = cloneRecord(source[providerId]);
    if (Object.keys(payload).length === 0) {
      continue;
    }
    if (providerId === "grok") {
      const modelTarget = resolveGrokModelTarget(payload.model, false);
      if (modelTarget) {
        steps.push({
          message: `Updated tools.web.search.grok.model from ${JSON.stringify(payload.model)} to ${JSON.stringify(modelTarget)}.`,
        });
        payload.model = modelTarget;
      }
    }
    steps.push({ move: searchMove(providerId, payload) });
  }
  return { retained, steps };
}

function prepareWebFetch(source: JsonRecord): PreparedSlot | null {
  if (!isRecord(source.firecrawl)) {
    return null;
  }
  const payload = cloneRecord(source.firecrawl);
  delete payload.enabled;
  const retained = retainedSource(source, new Set(["firecrawl"]));
  return {
    retained,
    steps:
      Object.keys(payload).length > 0
        ? [
            {
              move: {
                pluginId: "firecrawl",
                configKey: "webFetch",
                payload,
                legacyPath: "tools.web.fetch.firecrawl",
                targetPath: "plugins.entries.firecrawl.config.webFetch",
              },
            },
          ]
        : [{ message: "Removed empty tools.web.fetch.firecrawl." }],
  };
}

/** Resolve a supported replacement for a retired legacy X search model. */
export function resolveLegacyXSearchModelTarget(model: unknown): string | undefined {
  return resolveGrokModelTarget(model, true);
}

function prepareXSearch(source: JsonRecord): PreparedSlot | null {
  const hasAuth = hasOwnKey(source, "apiKey");
  const modelTarget = resolveLegacyXSearchModelTarget(source.model);
  if (!hasAuth && !modelTarget) {
    return null;
  }
  const retained = cloneRecord(source);
  const steps: MigrationStep[] = [];
  if (hasAuth) {
    delete retained.apiKey;
  }
  if (modelTarget) {
    steps.push({
      message: `Updated tools.web.x_search.model from ${JSON.stringify(source.model)} to ${JSON.stringify(modelTarget)}.`,
    });
    retained.model = modelTarget;
  }
  if (hasAuth) {
    steps.push({
      move: {
        pluginId: "xai",
        configKey: "webSearch",
        payload: { apiKey: source.apiKey },
        legacyPath: "tools.web.x_search.apiKey",
        targetPath: "plugins.entries.xai.config.webSearch.apiKey",
        mergeMode: "own-api-key",
        ...(Object.keys(retained).length === 0
          ? { activatedMessage: "Removed empty tools.web.x_search." }
          : {}),
      },
    });
  }
  return { retained, deleteSource: Object.keys(retained).length === 0, steps };
}

/** List legacy tools.web.search provider config paths present in raw config. */
export function listLegacyWebSearchConfigPaths(raw: unknown): string[] {
  const source = resolveWebSlot(raw, "search");
  if (!source) {
    return [];
  }
  const paths = hasOwnKey(source, "apiKey") ? ["tools.web.search.apiKey"] : [];
  for (const providerId of legacySearchProviderIds()) {
    if (isRecord(source[providerId])) {
      paths.push(
        ...Object.keys(source[providerId]).map((key) => `tools.web.search.${providerId}.${key}`),
      );
    }
  }
  return paths;
}

/** Move legacy web-search provider config into provider plugin entries. */
export function migrateLegacyWebSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  return migrateLegacyWebSlot(raw, "search", prepareWebSearch);
}

/** Move legacy Firecrawl web-fetch config into plugin-owned config. */
export function migrateLegacyWebFetchConfig<T>(raw: T): { config: T; changes: string[] } {
  return migrateLegacyWebSlot(raw, "fetch", prepareWebFetch);
}

/** Move legacy X search auth and repair retired legacy model defaults. */
export function migrateLegacyXSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  return migrateLegacyWebSlot(raw, "x_search", prepareXSearch);
}
