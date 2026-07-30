// Legacy X search config migration from tools.web.x_search to the xAI plugin config.
import { isRecord } from "./legacy-config-record-shared.js";

type JsonRecord = Record<string, unknown>;

const XAI_PLUGIN_ID = "xai";
const X_SEARCH_LEGACY_PATH = "tools.web.x_search";
const XAI_WEB_SEARCH_PLUGIN_KEY_PATH = `plugins.entries.${XAI_PLUGIN_ID}.config.webSearch.apiKey`;
const RETIRED_X_SEARCH_MODELS = new Set([
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-3",
]);
const RETIRED_CODE_MODELS = new Set([
  "grok-code-fast-1",
  "grok-code-fast",
  "grok-code-fast-1-0825",
]);

function cloneRecord<T extends JsonRecord | undefined>(value: T): T {
  if (!value) {
    return value;
  }
  return { ...value } as T;
}

function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  const current = target[key];
  if (isRecord(current)) {
    return current;
  }
  const next: JsonRecord = {};
  target[key] = next;
  return next;
}

function resolveLegacyXSearchConfig(raw: unknown): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const tools = isRecord(raw.tools) ? raw.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  return isRecord(web?.x_search) ? web.x_search : undefined;
}

function resolveLegacyXSearchAuth(legacy: JsonRecord): unknown {
  return legacy.apiKey;
}

export function resolveLegacyXSearchModelTarget(modelValue: unknown): string | undefined {
  if (typeof modelValue !== "string") {
    return undefined;
  }
  const model = modelValue.trim().toLowerCase();
  if (RETIRED_X_SEARCH_MODELS.has(model)) {
    return "grok-4.3";
  }
  if (RETIRED_CODE_MODELS.has(model)) {
    return "grok-build-0.1";
  }
  return undefined;
}

/** Move legacy X search auth and repair retired legacy model defaults. */
export function migrateLegacyXSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }
  const legacy = resolveLegacyXSearchConfig(raw);
  const hasLegacyAuth = legacy ? Object.hasOwn(legacy, "apiKey") : false;
  const modelTarget = legacy ? resolveLegacyXSearchModelTarget(legacy.model) : undefined;
  if (!legacy || (!hasLegacyAuth && !modelTarget)) {
    return { config: raw, changes: [] };
  }

  const nextRoot = structuredClone(raw);
  const tools = ensureRecord(nextRoot, "tools");
  const web = ensureRecord(tools, "web");
  const nextLegacy = cloneRecord(legacy) ?? {};
  if (hasLegacyAuth) {
    delete nextLegacy.apiKey;
  }
  const changes: string[] = [];
  if (modelTarget) {
    nextLegacy.model = modelTarget;
    changes.push(
      `Updated ${X_SEARCH_LEGACY_PATH}.model from ${JSON.stringify(legacy.model)} to ${JSON.stringify(modelTarget)}.`,
    );
  }
  if (Object.keys(nextLegacy).length === 0) {
    delete web.x_search;
  } else {
    web.x_search = nextLegacy;
  }

  const auth = resolveLegacyXSearchAuth(legacy);

  let hadEnabled = true;
  if (hasLegacyAuth) {
    const plugins = ensureRecord(nextRoot, "plugins");
    const entries = ensureRecord(plugins, "entries");
    const entry = ensureRecord(entries, XAI_PLUGIN_ID);
    hadEnabled = entry.enabled !== undefined;
    if (!hadEnabled) {
      entry.enabled = true;
    }
    const config = ensureRecord(entry, "config");
    const existingWebSearch = isRecord(config.webSearch)
      ? cloneRecord(config.webSearch)
      : undefined;
    if (!existingWebSearch) {
      config.webSearch = { apiKey: auth };
      changes.push(`Moved ${X_SEARCH_LEGACY_PATH}.apiKey → ${XAI_WEB_SEARCH_PLUGIN_KEY_PATH}.`);
    } else if (!Object.hasOwn(existingWebSearch, "apiKey")) {
      existingWebSearch.apiKey = auth;
      config.webSearch = existingWebSearch;
      changes.push(
        `Merged ${X_SEARCH_LEGACY_PATH}.apiKey → ${XAI_WEB_SEARCH_PLUGIN_KEY_PATH} (filled missing plugin auth).`,
      );
    } else {
      changes.push(
        `Removed ${X_SEARCH_LEGACY_PATH}.apiKey (${XAI_WEB_SEARCH_PLUGIN_KEY_PATH} already set).`,
      );
    }
  }

  if (hasLegacyAuth && Object.keys(nextLegacy).length === 0 && !hadEnabled) {
    changes.push(`Removed empty ${X_SEARCH_LEGACY_PATH}.`);
  }

  return {
    config: nextRoot as T,
    changes,
  };
}
