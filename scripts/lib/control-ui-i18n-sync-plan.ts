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
  // Aliases share their primary segment's source hash and translated text.
  segment_ids?: string[];
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

export function resolveLocaleMetaProvenance(options: {
  didTranslate: boolean;
  model: string;
  previousMeta: LocaleMeta | null;
  provider: string;
}): { model: string; provider: string } {
  if (options.didTranslate) {
    return { model: options.model, provider: options.provider };
  }
  return {
    model: options.previousMeta?.model ?? options.model,
    provider: options.previousMeta?.provider ?? options.provider,
  };
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
  const translationMemoryBySegment = new Map(
    [...translationMemory.values()].flatMap((entry) =>
      [entry.segment_id, ...(entry.segment_ids ?? [])].map((key) => [key, entry] as const),
    ),
  );
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
    const exactSegment = translationMemoryBySegment.get(key);
    const cached =
      translationMemory.get(segmentCacheKey) ??
      (exactSegment?.text_hash === textHash ? exactSegment : undefined);
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
      const { segment_ids: _aliases, ...cachedTranslation } = cachedByText;
      translationMemory.set(segmentCacheKey, {
        ...cachedTranslation,
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
      return {
        fallbackCount: sortedFallbackKeys.length,
        glossary: renderJson(
          options.glossary.length === 0 ? options.defaultGlossary : options.glossary,
        ),
        meta: renderJson(nextMeta),
        nextFlat,
        translationMemory: renderTranslationMemory(
          translationMemory,
          input.sourceFlat,
          nextFlat,
          input.hashText,
        ),
      };
    },
  };
}

export function compareStringArrays(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderTranslationMemory(
  entries: ReadonlyMap<string, TranslationMemoryEntry>,
  sourceFlat: ReadonlyMap<string, string>,
  translatedFlat: ReadonlyMap<string, string>,
  hashText: (text: string) => string,
): string {
  const bySegment = new Map(
    [...entries.values()].flatMap((entry) =>
      [entry.segment_id, ...(entry.segment_ids ?? [])].map((key) => [key, entry] as const),
    ),
  );
  const byTranslation = new Map(
    [...entries.values()].map((entry) => [
      JSON.stringify([entry.text_hash, entry.translated]),
      entry,
    ]),
  );
  const canonical = new Map<string, TranslationMemoryEntry>();

  for (const [key, text] of sourceFlat) {
    const translated = translatedFlat.get(key);
    if (translated === undefined) {
      continue;
    }
    const textHash = hashText(text);
    const groupKey = JSON.stringify([textHash, translated]);
    const existing = canonical.get(groupKey);
    if (existing) {
      (existing.segment_ids ??= []).push(key);
      continue;
    }
    const direct = bySegment.get(key);
    const source =
      direct?.text_hash === textHash && direct.translated === translated
        ? direct
        : byTranslation.get(groupKey);
    if (!source) {
      continue;
    }
    const { segment_ids: _aliases, ...record } = source;
    canonical.set(groupKey, { ...record, segment_id: key, text, text_hash: textHash });
  }

  const ordered = [...canonical.values()].toSorted((left, right) =>
    left.cache_key.localeCompare(right.cache_key),
  );
  return ordered.length === 0
    ? ""
    : `${ordered.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
