import { isRecord } from "./legacy-config-record-shared.js";

type JsonRecord = Record<string, unknown>;

const XAI_PLUGIN_ID = "xai";
const X_SEARCH_LEGACY_PATH = "tools.web.x_search";
const XAI_WEB_SEARCH_PLUGIN_KEY_PATH = `plugins.entries.${XAI_PLUGIN_ID}.config.webSearch.apiKey`;

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

export function listLegacyXSearchConfigPaths(raw: unknown): string[] {
  const legacy = resolveLegacyXSearchConfig(raw);
  if (!legacy || !Object.hasOwn(legacy, "apiKey")) {
    return [];
  }
  return [`${X_SEARCH_LEGACY_PATH}.apiKey`];
}

export function migrateLegacyXSearchConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }
  const legacy = resolveLegacyXSearchConfig(raw);
  if (!legacy || !Object.hasOwn(legacy, "apiKey")) {
    return { config: raw, changes: [] };
  }

  const nextRoot = structuredClone(raw);
  const tools = ensureRecord(nextRoot, "tools");
  const web = ensureRecord(tools, "web");
  const nextLegacy = cloneRecord(legacy) ?? {};
  delete nextLegacy.apiKey;
  if (Object.keys(nextLegacy).length === 0) {
    delete web.x_search;
  } else {
    web.x_search = nextLegacy;
  }

  const plugins = ensureRecord(nextRoot, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, XAI_PLUGIN_ID);
  const hadEnabled = entry.enabled !== undefined;
  if (!hadEnabled) {
    entry.enabled = true;
  }
  const config = ensureRecord(entry, "config");
  const auth = resolveLegacyXSearchAuth(legacy);
  const changes: string[] = [];

  if (auth !== undefined) {
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

  if (auth !== undefined && Object.keys(nextLegacy).length === 0 && !hadEnabled) {
    changes.push(`Removed empty ${X_SEARCH_LEGACY_PATH}.`);
  }

  return {
    config: nextRoot as T,
    changes,
  };
}
