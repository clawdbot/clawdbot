import { buildBaseHints } from "../../src/config/schema.hints.js";
import { configHintTranslationKey } from "../../ui/src/i18n/lib/config-hint-translation.ts";
import type { TranslationMap } from "../../ui/src/i18n/lib/types.ts";
import {
  loadControlUiSourceCatalog as loadStaticControlUiSourceCatalog,
  mergeControlUiTranslationMaps,
  readControlUiSourceCatalog as readStaticControlUiSourceCatalog,
} from "./control-ui-i18n-catalog.ts";

function loadControlUiConfigHintCatalog(): TranslationMap {
  const catalog: TranslationMap = {};
  const setValue = (key: string, value: string): void => {
    const parts = key.split(".");
    let current = catalog;
    for (const part of parts.slice(0, -1)) {
      const existing = current[part];
      const nested = existing && typeof existing === "object" ? existing : {};
      current[part] = nested;
      current = nested;
    }
    const leaf = parts.at(-1);
    if (leaf) {
      current[leaf] = value;
    }
  };
  for (const [hintPath, hint] of Object.entries(buildBaseHints()).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const field of ["label", "help"] as const) {
      const value = hint[field];
      if (value) {
        setValue(configHintTranslationKey(hintPath, field, value), value);
      }
    }
  }
  return catalog;
}

export function loadControlUiSourceCatalog(): TranslationMap {
  return mergeControlUiTranslationMaps(
    loadStaticControlUiSourceCatalog(),
    loadControlUiConfigHintCatalog(),
  );
}

export async function readControlUiSourceCatalog(): Promise<string> {
  const staticSource = await readStaticControlUiSourceCatalog();
  return `${staticSource}\n${JSON.stringify(loadControlUiConfigHintCatalog())}`;
}
