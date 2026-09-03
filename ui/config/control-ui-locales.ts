import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import type { Plugin } from "vite";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
} from "../../scripts/lib/control-ui-i18n-catalog.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "../../scripts/lib/control-ui-i18n-config.ts";
import { flattenTranslations } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";
import type { TranslationMap } from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const localeModulePrefix = "virtual:openclaw-control-ui-locale/";
const resolvedLocaleModulePrefix = `\0${localeModulePrefix}`;
// Vitest rewrites new URL(relative, import.meta.url) to browser self.location.
const i18nAssetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/i18n/.i18n",
);
const locales = new Set(CONTROL_UI_LOCALE_ENTRIES.map(({ locale }) => locale));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceCatalogUrl = pathToFileURL(
  path.join(repoRoot, "scripts/lib/control-ui-i18n-source-catalog.ts"),
).href;
let sourceCatalogLoadId = 0;

async function loadCurrentSourceCatalog(): Promise<{
  catalog: TranslationMap;
  watchFiles: Set<string>;
}> {
  const watchFiles = new Set<string>();
  const loader = register({
    namespace: `openclaw-control-ui-source-catalog-${sourceCatalogLoadId++}`,
    onImport(url) {
      if (url.startsWith("file:")) {
        watchFiles.add(fileURLToPath(url));
      }
    },
    tsconfig: path.join(repoRoot, "tsconfig.json"),
  });
  try {
    const module = (await loader.import(
      sourceCatalogUrl,
      import.meta.url,
    )) as typeof import("../../scripts/lib/control-ui-i18n-source-catalog.ts");
    return { catalog: module.loadControlUiSourceCatalog(), watchFiles };
  } finally {
    await loader.unregister();
  }
}

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
    async load(id) {
      if (!id.startsWith(resolvedLocaleModulePrefix)) {
        return null;
      }
      const locale = id.slice(resolvedLocaleModulePrefix.length);
      if (!locales.has(locale)) {
        return null;
      }
      const memoryPath = path.join(i18nAssetsDir, `${locale}.tm.jsonl`);
      const { catalog: sourceCatalog, watchFiles } = await loadCurrentSourceCatalog();
      for (const watchFile of watchFiles) {
        this.addWatchFile(watchFile);
      }
      // Source PRs omit generated memory until the post-merge refresh runs.
      // Existing empty or malformed memory stays fatal below so drift cannot hide.
      if (!existsSync(memoryPath)) {
        return `export default ${JSON.stringify(sourceCatalog)};`;
      }
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
