import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerActivityEnglish } from "../../ui/src/i18n/locales/en-activity.ts";
import { registerDebugEnglish } from "../../ui/src/i18n/locales/en-debug.ts";
import { registerDevicesEnglish } from "../../ui/src/i18n/locales/en-devices.ts";
import { registerMeetingsEnglish } from "../../ui/src/i18n/locales/en-meetings.ts";
import { registerMemoryImportEnglish } from "../../ui/src/i18n/locales/en-memory-import.ts";
import { registerNewSessionSetupEnglish } from "../../ui/src/i18n/locales/en-new-session-setup.ts";
import { registerPluginConsentEnglish } from "../../ui/src/i18n/locales/en-plugin-consent.ts";
import { registerSessionPlacementEnglish } from "../../ui/src/i18n/locales/en-session-placement.ts";
import { registerSettingsEnglish } from "../../ui/src/i18n/locales/en-settings.ts";
import { registerSkillLibraryEnglish } from "../../ui/src/i18n/locales/en-skill-library.ts";
import { registerUpdateActionsEnglish } from "../../ui/src/i18n/locales/en-update-actions.ts";
import { en } from "../../ui/src/i18n/locales/en.ts";
import type { TranslationMap, TranslationMemoryEntry } from "./control-ui-i18n-sync-plan.ts";

// Host-only owner for generation, verification and Vite. Static imports let Vite
// track every English dependency (including en.ts's en-agents.ts import).
const localesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../ui/src/i18n/locales",
);
const sourceFiles = [
  "en.ts",
  "en-agents.ts",
  "en-activity.ts",
  "en-debug.ts",
  "en-devices.ts",
  "en-meetings.ts",
  "en-memory-import.ts",
  "en-session-placement.ts",
  "en-new-session-setup.ts",
  "en-plugin-consent.ts",
  "en-settings.ts",
  "en-skill-library.ts",
  "en-update-actions.ts",
];

export function loadControlUiSourceCatalog(): TranslationMap {
  // Read fragment data without registering it into the shared runtime catalog.
  // en.ts's empty anchors retain source order for extracted whole subtrees.
  return mergeControlUiTranslationMaps(
    registerSkillLibraryEnglish.catalog,
    // Preserve Debug key order while keeping only its title eager.
    { ...en, debug: registerDebugEnglish.catalog.debug },
    registerActivityEnglish.catalog,
    registerDevicesEnglish.catalog,
    registerMeetingsEnglish.catalog,
    registerMemoryImportEnglish.catalog,
    registerSessionPlacementEnglish.catalog,
    registerNewSessionSetupEnglish.catalog,
    registerPluginConsentEnglish.catalog,
    registerSettingsEnglish.catalog,
    registerUpdateActionsEnglish.catalog,
  );
}

export async function readControlUiSourceCatalog(): Promise<string> {
  const sources = await Promise.all(
    sourceFiles.map((fileName) => readFile(path.join(localesDir, fileName), "utf8")),
  );
  return sources.join("\n");
}

export function hashControlUiTranslationText(text: string): string {
  return createHash("sha256").update(text.trim().split(/\s+/).join(" ")).digest("hex");
}

export function mergeControlUiTranslationMaps(
  ...maps: ReadonlyArray<TranslationMap>
): TranslationMap {
  const merged: TranslationMap = {};
  const mergeInto = (target: TranslationMap, source: TranslationMap): void => {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string") {
        target[key] = value;
        continue;
      }
      const existing = target[key];
      const nested = typeof existing === "object" ? existing : {};
      target[key] = nested;
      mergeInto(nested, value);
    }
  };
  for (const map of maps) {
    mergeInto(merged, map);
  }
  return merged;
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
