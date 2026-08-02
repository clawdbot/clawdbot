import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { TranslationMap, TranslationMemoryEntry } from "./control-ui-i18n-sync-plan.ts";

export function hashControlUiTranslationText(text: string): string {
  return createHash("sha256").update(text.trim().split(/\s+/).join(" ")).digest("hex");
}

export function loadControlUiTranslationMemory(
  filePath: string,
): Map<string, TranslationMemoryEntry> {
  const entries = new Map<string, TranslationMemoryEntry>();
  if (!existsSync(filePath)) {
    return entries;
  }
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const entry = JSON.parse(line) as TranslationMemoryEntry;
    if (entry.cache_key && entry.translated.trim()) {
      entries.set(entry.cache_key, entry);
    }
  }
  return entries;
}

function setControlUiCatalogValue(catalog: TranslationMap, key: string, value: string): void {
  const parts = key.split(".");
  let current = catalog;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing === "string") {
      current[part] = {};
    }
    current = current[part] as TranslationMap;
  }
  current[parts[parts.length - 1]!] = value;
}

export function materializeControlUiLocaleCatalog(
  sourceFlat: ReadonlyMap<string, string>,
  memory: ReadonlyMap<string, TranslationMemoryEntry>,
): TranslationMap {
  const translations = new Map<string, string>();

  for (const entry of memory.values()) {
    for (const key of [entry.segment_id, ...(entry.segment_ids ?? [])]) {
      const source = sourceFlat.get(key);
      if (source === undefined || entry.text_hash !== hashControlUiTranslationText(source)) {
        continue;
      }
      translations.set(key, entry.translated);
    }
  }

  const catalog: TranslationMap = {};
  for (const key of sourceFlat.keys()) {
    const translated = translations.get(key);
    if (translated !== undefined) {
      setControlUiCatalogValue(catalog, key, translated);
    }
  }
  return catalog;
}
