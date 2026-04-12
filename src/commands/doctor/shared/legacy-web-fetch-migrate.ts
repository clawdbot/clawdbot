import { mergeMissing } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  cloneRecord,
  ensureRecord,
  hasOwnKey,
  isRecord,
  type JsonRecord,
} from "./legacy-config-record-shared.js";
const DANGEROUS_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function resolveLegacyFetchConfig(raw: unknown): JsonRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const tools = isRecord(raw.tools) ? raw.tools : undefined;
  const web = isRecord(tools?.web) ? tools.web : undefined;
  return isRecord(web?.fetch) ? web.fetch : undefined;
}

function copyLegacyFirecrawlFetchConfig(fetch: JsonRecord): JsonRecord | undefined {
  const current = fetch.firecrawl;
  if (!isRecord(current)) {
    return undefined;
  }
  const next = cloneRecord(current);
  delete next.enabled;
  return next;
}

function hasMappedLegacyWebFetchConfig(raw: unknown): boolean {
  const fetch = resolveLegacyFetchConfig(raw);
  if (!fetch) {
    return false;
  }
  return isRecord(fetch.firecrawl);
}

function migratePluginWebFetchConfig(params: {
  root: JsonRecord;
  payload: JsonRecord;
  changes: string[];
}) {
  const plugins = ensureRecord(params.root, "plugins");
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, "firecrawl");
  const config = ensureRecord(entry, "config");
  const hadEnabled = entry.enabled !== undefined;
  const existing = isRecord(config.webFetch) ? cloneRecord(config.webFetch) : undefined;

  if (!hadEnabled) {
    entry.enabled = true;
  }

  if (!existing) {
    config.webFetch = cloneRecord(params.payload);
    params.changes.push(
      "Moved tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch.",
    );
    return;
  }

  const merged = cloneRecord(existing);
  mergeMissing(merged, params.payload);
  const changed = JSON.stringify(merged) !== JSON.stringify(existing) || !hadEnabled;
  config.webFetch = merged;
  if (changed) {
    params.changes.push(
      "Merged tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch (filled missing fields from legacy; kept explicit plugin config values).",
    );
    return;
  }

  params.changes.push(
    "Removed tools.web.fetch.firecrawl (plugins.entries.firecrawl.config.webFetch already set).",
  );
}

export function listLegacyWebFetchConfigPaths(raw: unknown): string[] {
  const fetch = resolveLegacyFetchConfig(raw);
  const firecrawl = fetch ? copyLegacyFirecrawlFetchConfig(fetch) : undefined;
  if (!firecrawl) {
    return [];
  }
  return Object.keys(firecrawl).map((key) => `tools.web.fetch.firecrawl.${key}`);
}

export function normalizeLegacyWebFetchConfig<T>(raw: T): T {
  if (!isRecord(raw)) {
    return raw;
  }

  const fetch = resolveLegacyFetchConfig(raw);
  if (!fetch) {
    return raw;
  }

  return normalizeLegacyWebFetchConfigRecord(raw).config;
}

export function migrateLegacyWebFetchConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw) || !hasMappedLegacyWebFetchConfig(raw)) {
    return { config: raw, changes: [] };
  }
  return normalizeLegacyWebFetchConfigRecord(raw);
}

function normalizeLegacyWebFetchConfigRecord<T extends JsonRecord>(
  raw: T,
): {
  config: T;
  changes: string[];
} {
  const nextRoot = structuredClone(raw);
  const tools = ensureRecord(nextRoot, "tools");
  const web = ensureRecord(tools, "web");
  const fetch = resolveLegacyFetchConfig(nextRoot);
  if (!fetch) {
    return { config: raw, changes: [] };
  }

  const nextFetch: JsonRecord = {};
  for (const [key, value] of Object.entries(fetch)) {
    if (key === "firecrawl" && isRecord(value)) {
      continue;
    }
    if (DANGEROUS_RECORD_KEYS.has(key)) {
      continue;
    }
    nextFetch[key] = value;
  }
  web.fetch = nextFetch;

  const firecrawl = copyLegacyFirecrawlFetchConfig(fetch);
  const changes: string[] = [];
  if (firecrawl && Object.keys(firecrawl).length > 0) {
    migratePluginWebFetchConfig({
      root: nextRoot,
      payload: firecrawl,
      changes,
    });
  } else if (hasOwnKey(fetch, "firecrawl")) {
    changes.push("Removed empty tools.web.fetch.firecrawl.");
  }

  return { config: nextRoot, changes };
}

export function resolvePluginWebFetchConfig(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const pluginConfig = config?.plugins?.entries?.[pluginId]?.config;
  if (!isRecord(pluginConfig)) {
    return undefined;
  }
  return isRecord(pluginConfig.webFetch) ? pluginConfig.webFetch : undefined;
}
