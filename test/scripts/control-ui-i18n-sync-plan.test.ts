import { describe, expect, it } from "vitest";
import {
  createControlUiLocaleSyncPlan,
  flattenTranslations,
  type LocaleEntry,
  type LocaleMeta,
  type TranslationMemoryEntry,
} from "../../scripts/lib/control-ui-i18n-sync-plan.ts";

const entry: LocaleEntry = {
  exportName: "fr",
  fileName: "fr.ts",
  languageKey: "fr",
  locale: "fr",
};

const hashText = (text: string) => `hash:${text}`;
const cacheKeyFor = (key: string, textHash: string) => `cache:${key}:${textHash}`;

function memoryEntry(overrides: Partial<TranslationMemoryEntry> = {}): TranslationMemoryEntry {
  return {
    cache_key: "legacy-cache",
    model: "legacy-model",
    provider: "legacy-provider",
    segment_id: "legacy.segment",
    source_path: "ui/src/i18n/locales/fr.ts",
    src_lang: "en",
    text: "Shared",
    text_hash: hashText("Shared"),
    tgt_lang: "fr",
    translated: "Partage",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function localeMeta(overrides: Partial<LocaleMeta> = {}): LocaleMeta {
  return {
    fallbackKeys: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
    locale: "fr",
    model: "legacy-model",
    provider: "legacy-provider",
    sourceHash: "old-source",
    totalKeys: 0,
    translatedKeys: 0,
    workflow: 1,
    ...overrides,
  };
}

describe("createControlUiLocaleSyncPlan", () => {
  it("plans reuse and renders deterministic locale artifacts", () => {
    const sourceFlat = flattenTranslations({
      group: {
        cached: "Cached source",
        existing: "Existing source",
        pending: "Pending source",
        reused: "Shared",
      },
    });
    const exactCacheKey = cacheKeyFor("group.cached", hashText("Cached source"));
    const exactCache = memoryEntry({
      cache_key: exactCacheKey,
      segment_id: "group.cached",
      text: "Cached source",
      text_hash: hashText("Cached source"),
      translated: "En cache",
    });
    const sharedCache = memoryEntry();
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: false,
      cacheKeyFor,
      entry,
      existingFlat: new Map([
        ["group.cached", "Ancien cache"],
        ["group.existing", "Existant"],
      ]),
      force: false,
      hashText,
      previousMeta: localeMeta({ fallbackKeys: ["group.cached"] }),
      sourceFlat,
      sourceHash: "next-source",
      translationMemory: new Map([
        [sharedCache.cache_key, sharedCache],
        [exactCache.cache_key, exactCache],
      ]),
    });

    expect(plan.pending.map((item) => item.key)).toEqual(["group.pending"]);
    expect(plan.newFallbackCount).toBe(1);

    const artifacts = plan.render({
      defaultGlossary: [{ source: "OpenClaw", target: "OpenClaw" }],
      generatedAt: "2026-02-02T00:00:00.000Z",
      glossary: [],
      model: "legacy-model",
      provider: "legacy-provider",
      workflow: 1,
    });

    expect(artifacts.localeModule).toBe(
      [
        "// Generated locale bundle for Control UI translations.",
        "// Run `pnpm ui:i18n:sync` instead of editing this file directly.",
        'import type { TranslationMap } from "../lib/types.ts";',
        "",
        "export const fr: TranslationMap = {",
        "  group: {",
        '    cached: "En cache",',
        '    existing: "Existant",',
        '    pending: "Pending source",',
        '    reused: "Partage",',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    expect(artifacts.meta).toBe(
      `${JSON.stringify(
        {
          fallbackKeys: ["group.cached", "group.pending"],
          generatedAt: "2026-02-02T00:00:00.000Z",
          locale: "fr",
          model: "legacy-model",
          provider: "legacy-provider",
          sourceHash: "next-source",
          totalKeys: 4,
          translatedKeys: 2,
          workflow: 1,
        },
        null,
        2,
      )}\n`,
    );
    expect(artifacts.glossary).toBe(
      `${JSON.stringify([{ source: "OpenClaw", target: "OpenClaw" }], null, 2)}\n`,
    );
    const clonedCache = {
      ...sharedCache,
      cache_key: cacheKeyFor("group.reused", hashText("Shared")),
      segment_id: "group.reused",
    };
    expect(artifacts.translationMemory).toBe(
      `${[clonedCache, exactCache, sharedCache]
        .toSorted((left, right) => left.cache_key.localeCompare(right.cache_key))
        .map((value) => JSON.stringify(value))
        .join("\n")}\n`,
    );
  });

  it("refreshes recorded fallbacks and records translated replacements", () => {
    const sourceFlat = flattenTranslations({ title: "New English" });
    const previousMeta = localeMeta({
      fallbackKeys: ["title"],
      sourceHash: "previous-source",
      totalKeys: 1,
      translatedKeys: 0,
    });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: true,
      cacheKeyFor,
      entry,
      existingFlat: new Map([["title", "Old English"]]),
      force: true,
      hashText,
      previousMeta,
      sourceFlat,
      sourceHash: "next-source",
      translationMemory: new Map(),
    });

    expect(plan.newFallbackCount).toBe(0);
    plan.recordTranslations(plan.pending, new Map([["title", "Nouveau"]]), {
      model: "next-model",
      provider: "next-provider",
      sourceLocale: "en",
      updatedAt: () => "2026-02-02T00:00:00.000Z",
    });

    const artifacts = plan.render({
      defaultGlossary: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      glossary: [],
      model: "next-model",
      provider: "next-provider",
      workflow: 1,
    });

    expect(artifacts.fallbackCount).toBe(0);
    expect(artifacts.nextFlat.get("title")).toBe("Nouveau");
    expect(JSON.parse(artifacts.meta)).toMatchObject({
      fallbackKeys: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      translatedKeys: 1,
    });
    expect(artifacts.translationMemory).toBe(
      `${JSON.stringify(
        memoryEntry({
          cache_key: cacheKeyFor("title", hashText("New English")),
          model: "next-model",
          provider: "next-provider",
          segment_id: "title",
          text: "New English",
          text_hash: hashText("New English"),
          translated: "Nouveau",
          updated_at: "2026-02-02T00:00:00.000Z",
        }),
      )}\n`,
    );
  });

  it("preserves generatedAt when semantic metadata is unchanged", () => {
    const sourceFlat = flattenTranslations({ title: "Titre" });
    const previousMeta = localeMeta({
      sourceHash: "same-source",
      totalKeys: 1,
      translatedKeys: 1,
    });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: false,
      cacheKeyFor,
      entry,
      existingFlat: new Map([["title", "Titre"]]),
      force: false,
      hashText,
      previousMeta,
      sourceFlat,
      sourceHash: "same-source",
      translationMemory: new Map(),
    });

    const artifacts = plan.render({
      defaultGlossary: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      glossary: [],
      model: "legacy-model",
      provider: "legacy-provider",
      workflow: 1,
    });

    expect(JSON.parse(artifacts.meta)).toMatchObject({
      generatedAt: previousMeta.generatedAt,
    });
  });
});
