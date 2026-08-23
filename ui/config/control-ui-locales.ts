import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
  mergeControlUiTranslationMaps,
} from "../../scripts/lib/control-ui-i18n-catalog.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import { flattenTranslations } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { registerActivityEnglish } from "../src/i18n/locales/en-activity.ts";
import { registerSessionPlacementEnglish } from "../src/i18n/locales/en-session-placement.ts";
import { en } from "../src/i18n/locales/en.ts";

const localeModulePrefix = "virtual:openclaw-control-ui-locale/";
const resolvedLocaleModulePrefix = `\0${localeModulePrefix}`;
// Vitest rewrites new URL(relative, import.meta.url) to browser self.location.
const i18nAssetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/i18n/.i18n",
);
const locales = new Set(CONTROL_UI_LOCALE_ENTRIES.map(({ locale }) => locale));
const sourceCatalog = mergeControlUiTranslationMaps(
  en,
  registerActivityEnglish.catalog,
  registerSessionPlacementEnglish.catalog,
);

export function controlUiLocaleModulesPlugin(): Plugin {
  return {
    name: "control-ui-locale-modules",
    enforce: "pre",
    resolveId(id) {
      if (id.startsWith(localeModulePrefix) && locales.has(id.slice(localeModulePrefix.length))) {
        return `\0${id}`;
      }
      return null;
    },
    load(id) {
      if (!id.startsWith(resolvedLocaleModulePrefix)) {
        return null;
      }
      const locale = id.slice(resolvedLocaleModulePrefix.length);
      if (!locales.has(locale)) {
        return null;
      }
      const memoryPath = path.join(i18nAssetsDir, `${locale}.tm.jsonl`);
      this.addWatchFile(memoryPath);
      const memory = loadControlUiTranslationMemory(memoryPath);
      if (memory.size === 0) {
        throw new Error(`Control UI ${locale} translation memory is missing or empty`);
      }
      const catalog = materializeControlUiLocaleCatalog(flattenTranslations(sourceCatalog), memory);
      return `export default ${JSON.stringify(catalog)};`;
    },
  };
}
