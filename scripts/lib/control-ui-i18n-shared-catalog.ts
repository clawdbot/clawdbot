import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadControlUiTranslationMemory,
  materializeControlUiLocaleCatalog,
} from "./control-ui-i18n-catalog.ts";
import { CONTROL_UI_LOCALE_ENTRIES } from "./control-ui-i18n-config.ts";
import { flattenTranslations, type TranslationMap } from "./control-ui-i18n-sync-plan.ts";

export type ControlUiSharedCatalog = {
  source: ReadonlyMap<string, string>;
  translations: ReadonlyMap<string, ReadonlyMap<string, string>>;
  descriptions: ReadonlyMap<string, string>;
};

export type ControlUiSharedCatalogOptions = {
  rootDir?: string;
  locales?: readonly string[];
};

export type ControlUiSharedLocaleBundleOptions = {
  keys?: readonly string[];
  prefixes?: readonly string[];
  sources?: readonly string[];
};

export type ControlUiSharedLocaleBundle = Record<string, Record<string, string>>;

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function compareStableKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedTranslationMap(entries: Iterable<readonly [string, string]>): Map<string, string> {
  return new Map([...entries].toSorted(([left], [right]) => compareStableKeys(left, right)));
}

/** Expose the source-owned web catalog and verified translation memory without generating artifacts. */
export async function loadControlUiSharedCatalog(
  options: ControlUiSharedCatalogOptions = {},
): Promise<ControlUiSharedCatalog> {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const sourcePath = path.join(rootDir, "ui", "src", "i18n", "locales", "en.ts");
  const sourceModule = (await import(pathToFileURL(sourcePath).href)) as {
    en?: TranslationMap;
  };
  if (!sourceModule.en || typeof sourceModule.en !== "object" || Array.isArray(sourceModule.en)) {
    throw new Error(`${sourcePath} does not export an English localization catalog`);
  }

  const messages = flattenTranslations(sourceModule.en);
  const descriptions = new Map<string, string>();
  const desktopSourcePath = path.join(rootDir, "apps", "linux", "ui", "messages.json");
  if (existsSync(desktopSourcePath)) {
    const desktopMessages = JSON.parse(readFileSync(desktopSourcePath, "utf8")) as unknown;
    if (!desktopMessages || typeof desktopMessages !== "object" || Array.isArray(desktopMessages)) {
      throw new Error(`${desktopSourcePath} must contain semantic localization messages`);
    }
    for (const [semanticKey, message] of Object.entries(desktopMessages)) {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new Error(`${desktopSourcePath}:${semanticKey} must be a localization message`);
      }
      const { defaultMessage, description } = message as {
        defaultMessage?: unknown;
        description?: unknown;
      };
      if (typeof defaultMessage !== "string" || typeof description !== "string") {
        throw new Error(
          `${desktopSourcePath}:${semanticKey} requires a defaultMessage and translator description`,
        );
      }
      const existingSource = messages.get(semanticKey);
      if (existingSource !== undefined && existingSource !== defaultMessage) {
        throw new Error(
          `${desktopSourcePath}:${semanticKey} conflicts with the Control UI catalog`,
        );
      }
      messages.set(semanticKey, defaultMessage);
      descriptions.set(semanticKey, description);
    }
  }
  const source = sortedTranslationMap(messages);

  const requestedLocales = new Set(
    options.locales ?? CONTROL_UI_LOCALE_ENTRIES.map((entry) => entry.locale),
  );
  const translations = new Map<string, ReadonlyMap<string, string>>();
  for (const locale of [...requestedLocales].toSorted(compareStableKeys)) {
    if (locale === "en") {
      continue;
    }
    const memoryPath = path.join(rootDir, "ui", "src", "i18n", ".i18n", `${locale}.tm.jsonl`);
    if (!existsSync(memoryPath)) {
      continue;
    }
    const translated = materializeControlUiLocaleCatalog(
      source,
      loadControlUiTranslationMemory(memoryPath),
    );
    translations.set(locale, sortedTranslationMap(flattenTranslations(translated)));
  }

  return { source, translations, descriptions };
}

/** Share translations only when both surfaces explicitly own the same semantic key. */
export function resolveControlUiSharedTranslation(
  catalog: ControlUiSharedCatalog,
  locale: string,
  semanticKey: string,
): string | undefined {
  return catalog.translations.get(locale)?.get(semanticKey);
}

/** Build a small platform bundle; absent translations remain absent so runtime fallback stays honest. */
export function buildControlUiSharedLocaleBundle(
  catalog: ControlUiSharedCatalog,
  options: ControlUiSharedLocaleBundleOptions = {},
): ControlUiSharedLocaleBundle {
  const requestedKeys = new Set(options.keys ?? []);
  const requestedSources = new Set(options.sources ?? []);
  const requestedPrefixes = (options.prefixes ?? []).map((prefix) => prefix.replace(/\.+$/u, ""));
  const hasSelection =
    options.keys !== undefined || options.sources !== undefined || options.prefixes !== undefined;
  const selectedKeys = [...catalog.source.entries()]
    .filter(([semanticKey, source]) => {
      if (!hasSelection) {
        return true;
      }
      return (
        requestedKeys.has(semanticKey) ||
        requestedSources.has(source) ||
        requestedPrefixes.some(
          (prefix) => semanticKey === prefix || semanticKey.startsWith(`${prefix}.`),
        )
      );
    })
    .map(([semanticKey]) => semanticKey)
    .toSorted(compareStableKeys);

  const bundle: ControlUiSharedLocaleBundle = {
    en: Object.fromEntries(
      selectedKeys.map((semanticKey) => [semanticKey, catalog.source.get(semanticKey)!]),
    ),
  };
  for (const locale of [...catalog.translations.keys()].toSorted(compareStableKeys)) {
    bundle[locale] = Object.fromEntries(
      selectedKeys.flatMap((semanticKey) => {
        const translated = resolveControlUiSharedTranslation(catalog, locale, semanticKey);
        return translated === undefined ? [] : [[semanticKey, translated] as const];
      }),
    );
  }
  return bundle;
}
