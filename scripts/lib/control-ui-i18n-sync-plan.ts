export interface TranslationMap {
  [key: string]: string | TranslationMap;
}

export type LocaleEntry = {
  exportName: string;
  fileName: string;
  languageKey: string;
  locale: string;
};

export type GlossaryEntry = {
  source: string;
  target: string;
};

export type TranslationMemoryEntry = {
  cache_key: string;
  model: string;
  provider: string;
  segment_id: string;
  source_path: string;
  src_lang: string;
  text: string;
  text_hash: string;
  tgt_lang: string;
  translated: string;
  updated_at: string;
};

export type LocaleMeta = {
  fallbackKeys: string[];
  generatedAt: string;
  locale: string;
  model: string;
  provider: string;
  sourceHash: string;
  totalKeys: number;
  translatedKeys: number;
  workflow: number;
};

export type TranslationBatchItem = {
  cacheKey: string;
  key: string;
  text: string;
  textHash: string;
};

export function flattenTranslations(
  value: TranslationMap,
  prefix = "",
  out = new Map<string, string>(),
) {
  for (const [key, nested] of Object.entries(value)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof nested === "string") {
      out.set(fullKey, nested);
      continue;
    }
    flattenTranslations(nested, fullKey, out);
  }
  return out;
}

export function shouldReuseExistingTranslation(options: {
  allowTranslate: boolean;
  force: boolean;
  isFallback: boolean;
}): boolean {
  return !options.isFallback || (!options.allowTranslate && !options.force);
}

export function createControlUiLocaleSyncPlan(input: {
  allowTranslate: boolean;
  cacheKeyFor: (key: string, textHash: string) => string;
  entry: LocaleEntry;
  existingFlat: ReadonlyMap<string, string>;
  force: boolean;
  hashText: (text: string) => string;
  previousMeta: LocaleMeta | null;
  sourceFlat: ReadonlyMap<string, string>;
  sourceHash: string;
  translationMemory: ReadonlyMap<string, TranslationMemoryEntry>;
}) {
  const previousFallbackKeys = new Set(input.previousMeta?.fallbackKeys ?? []);
  const translationMemory = new Map(input.translationMemory);
  const translationMemoryByTextHash = new Map(
    [...translationMemory.values()]
      .filter(
        (entry) =>
          entry.tgt_lang === input.entry.locale && entry.text_hash && entry.translated.trim(),
      )
      .map((entry) => [entry.text_hash, entry]),
  );
  const nextFlat = new Map<string, string>();
  const pending: TranslationBatchItem[] = [];
  const fallbackKeys: string[] = [];

  for (const [key, text] of input.sourceFlat.entries()) {
    const textHash = input.hashText(text);
    const segmentCacheKey = input.cacheKeyFor(key, textHash);
    const cached = translationMemory.get(segmentCacheKey);
    const cachedByText = translationMemoryByTextHash.get(textHash);
    const existing = input.existingFlat.get(key);
    const shouldRefreshFallback = previousFallbackKeys.has(key);
    const shouldReuse = shouldReuseExistingTranslation({
      allowTranslate: input.allowTranslate,
      force: input.force,
      isFallback: shouldRefreshFallback,
    });

    if (cached && shouldReuse) {
      nextFlat.set(key, cached.translated);
      if (shouldRefreshFallback) {
        fallbackKeys.push(key);
      }
      continue;
    }

    if (cachedByText && (shouldRefreshFallback || existing === undefined)) {
      nextFlat.set(key, cachedByText.translated);
      translationMemory.set(segmentCacheKey, {
        ...cachedByText,
        cache_key: segmentCacheKey,
        segment_id: key,
        source_path: `ui/src/i18n/locales/${input.entry.fileName}`,
      });
      continue;
    }

    if (existing !== undefined && shouldReuse) {
      nextFlat.set(key, existing);
      if (shouldRefreshFallback) {
        fallbackKeys.push(key);
      }
      continue;
    }

    pending.push({ cacheKey: segmentCacheKey, key, text, textHash });
  }

  return {
    newFallbackCount: pending.filter((item) => !previousFallbackKeys.has(item.key)).length,
    pending,
    recordTranslations(
      batch: readonly TranslationBatchItem[],
      translated: ReadonlyMap<string, string>,
      metadata: {
        model: string;
        provider: string;
        sourceLocale: string;
        updatedAt: () => string;
      },
    ): void {
      for (const item of batch) {
        const value = translated.get(item.key);
        if (!value) {
          continue;
        }
        nextFlat.set(item.key, value);
        translationMemory.set(item.cacheKey, {
          cache_key: item.cacheKey,
          model: metadata.model,
          provider: metadata.provider,
          segment_id: item.key,
          source_path: `ui/src/i18n/locales/${input.entry.fileName}`,
          src_lang: metadata.sourceLocale,
          text: item.text,
          text_hash: item.textHash,
          tgt_lang: input.entry.locale,
          translated: value,
          updated_at: metadata.updatedAt(),
        });
      }
    },
    render(options: {
      defaultGlossary: readonly GlossaryEntry[];
      generatedAt: string;
      glossary: readonly GlossaryEntry[];
      model: string;
      provider: string;
      workflow: number;
    }) {
      for (const item of pending) {
        if (nextFlat.has(item.key)) {
          continue;
        }
        const existing = input.existingFlat.get(item.key);
        if (existing !== undefined && !input.force) {
          nextFlat.set(item.key, existing);
          if (previousFallbackKeys.has(item.key)) {
            fallbackKeys.push(item.key);
          }
          continue;
        }
        nextFlat.set(item.key, item.text);
        fallbackKeys.push(item.key);
      }

      const sortedFallbackKeys = [...new Set(fallbackKeys)].toSorted((left, right) =>
        left.localeCompare(right),
      );
      const translatedKeys = input.sourceFlat.size - sortedFallbackKeys.length;
      const previousMeta = input.previousMeta;
      const semanticMetaChanged =
        !previousMeta ||
        previousMeta.locale !== input.entry.locale ||
        previousMeta.sourceHash !== input.sourceHash ||
        previousMeta.provider !== options.provider ||
        previousMeta.model !== options.model ||
        previousMeta.totalKeys !== input.sourceFlat.size ||
        previousMeta.translatedKeys !== translatedKeys ||
        previousMeta.workflow !== options.workflow ||
        !compareStringArrays(previousMeta.fallbackKeys, sortedFallbackKeys);
      const nextMeta: LocaleMeta = {
        fallbackKeys: sortedFallbackKeys,
        generatedAt: semanticMetaChanged ? options.generatedAt : previousMeta.generatedAt,
        locale: input.entry.locale,
        model: options.model,
        provider: options.provider,
        sourceHash: input.sourceHash,
        totalKeys: input.sourceFlat.size,
        translatedKeys,
        workflow: options.workflow,
      };
      const nextMap: TranslationMap = {};
      for (const [key, value] of input.sourceFlat.entries()) {
        setNestedValue(nextMap, key, nextFlat.get(key) ?? value);
      }

      return {
        fallbackCount: sortedFallbackKeys.length,
        glossary: renderJson(
          options.glossary.length === 0 ? options.defaultGlossary : options.glossary,
        ),
        localeModule: renderLocaleModule(input.entry, nextMap),
        meta: renderJson(nextMeta),
        nextFlat,
        translationMemory: renderTranslationMemory(translationMemory),
      };
    },
  };
}

export function compareStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function setNestedValue(root: TranslationMap, dottedKey: string, value: string): void {
  const parts = dottedKey.split(".");
  let cursor: TranslationMap = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const next = cursor[key];
    if (!next || typeof next === "string") {
      const replacement: TranslationMap = {};
      cursor[key] = replacement;
      cursor = replacement;
      continue;
    }
    cursor = next;
  }
  cursor[parts.at(-1)!] = value;
}

function renderTranslationValue(value: string | TranslationMap, indent = 0): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }

  const pad = "  ".repeat(indent);
  const innerPad = "  ".repeat(indent + 1);
  return `{\n${entries
    .map(([key, nested]) => {
      const renderedKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      return `${innerPad}${renderedKey}: ${renderTranslationValue(nested, indent + 1)},`;
    })
    .join("\n")}\n${pad}}`;
}

function renderLocaleModule(entry: LocaleEntry, value: TranslationMap): string {
  return `// Generated locale bundle for Control UI translations.
// Run \`pnpm ui:i18n:sync\` instead of editing this file directly.
import type { TranslationMap } from "../lib/types.ts";

export const ${entry.exportName}: TranslationMap = ${renderTranslationValue(value)};
`;
}

function renderTranslationMemory(entries: ReadonlyMap<string, TranslationMemoryEntry>): string {
  const ordered = [...entries.values()].toSorted((left, right) =>
    left.cache_key.localeCompare(right.cache_key),
  );
  return ordered.length === 0
    ? ""
    : `${ordered.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
