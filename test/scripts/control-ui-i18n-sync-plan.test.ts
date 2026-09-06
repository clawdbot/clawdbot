import { describe, expect, it } from "vitest";
import {
  hashControlUiTranslationText,
  materializeControlUiLocaleCatalog,
  mergeControlUiTranslationMaps,
} from "../../scripts/lib/control-ui-i18n-catalog.ts";
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
    sourceHash: "old-source",
    totalKeys: 0,
    translatedKeys: 0,
    workflow: 1,
    ...overrides,
  };
}

describe("createControlUiLocaleSyncPlan", () => {
  it("retranslates cached and existing strings on a full refresh", () => {
    const cached = memoryEntry({ segment_id: "cached" });
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: true,
      cacheKeyFor,
      entry,
      existingFlat: new Map([
        ["cached", "Partage"],
        ["existing", "Existant"],
      ]),
      force: true,
      hashText,
      previousMeta: localeMeta(),
      sourceFlat: new Map([
        ["cached", "Shared"],
        ["alias", "Shared"],
        ["existing", "Existing"],
      ]),
      sourceHash: "source",
      translationMemory: new Map([[cached.cache_key, cached]]),
    });
    expect(plan.pending.map((item) => item.key)).toEqual(["cached", "alias", "existing"]);
  });

  it("fills lazy anchors in source order without mutating source or losing siblings", () => {
    const startup = {
      updates: { before: "Before", page: {}, after: "After" },
      settings: {},
      common: { ok: "OK" },
    };
    const fragment = {
      settings: { title: "Settings" },
      updates: { page: { title: "Updates" } },
    };
    const merged = mergeControlUiTranslationMaps(startup, fragment);

    expect([...flattenTranslations(merged)]).toEqual([
      ["updates.before", "Before"],
      ["updates.page.title", "Updates"],
      ["updates.after", "After"],
      ["settings.title", "Settings"],
      ["common.ok", "OK"],
    ]);
    expect(startup.settings).toEqual({});
    expect(startup.updates.page).toEqual({});
    expect(merged.updates).not.toBe(startup.updates);
    expect(merged.settings).not.toBe(fragment.settings);
  });

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
    const sharedCache = Object.assign(memoryEntry(), {
      model: "private-model-fixture",
      provider: "private-provider-fixture",
    });
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
      workflow: 1,
    });

    expect(artifacts.meta).toBe(
      `${JSON.stringify(
        {
          fallbackKeys: ["group.cached", "group.pending"],
          generatedAt: "2026-02-02T00:00:00.000Z",
          locale: "fr",
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
    const reusedCache = {
      ...memoryEntry(),
      cache_key: cacheKeyFor("group.reused", hashText("Shared")),
      segment_id: "group.reused",
    };
    expect(artifacts.translationMemory).toBe(
      `${[reusedCache, exactCache]
        .toSorted((left, right) => left.cache_key.localeCompare(right.cache_key))
        .map((value) => JSON.stringify(value))
        .join("\n")}\n`,
    );
    expect(artifacts.translationMemory + artifacts.meta).not.toContain("private-");
  });

  it("reuses grouped segment aliases only while their source text still matches", () => {
    const sourceFlat = flattenTranslations({ group: { alias: "Shared" } });
    const grouped = memoryEntry({ segment_ids: ["group.alias"] });
    const createPlan = (source: ReadonlyMap<string, string>) =>
      createControlUiLocaleSyncPlan({
        allowTranslate: false,
        cacheKeyFor,
        entry,
        existingFlat: new Map(),
        force: false,
        hashText,
        previousMeta: localeMeta(),
        sourceFlat: source,
        sourceHash: "source",
        translationMemory: new Map([[grouped.cache_key, grouped]]),
      });

    expect(createPlan(sourceFlat).pending).toEqual([]);
    expect(createPlan(new Map([["group.alias", "Changed"]])).pending).toHaveLength(1);
  });

  it("materializes grouped aliases in source order and discards stale or retired segments", () => {
    const grouped = memoryEntry({
      segment_id: "group.first",
      segment_ids: ["group.second", "removed"],
      text_hash: hashControlUiTranslationText("Shared"),
      translated: "Partagé",
    });
    const source = flattenTranslations({ group: { first: "Shared", second: "Shared" } });

    expect(
      materializeControlUiLocaleCatalog(source, new Map([[grouped.cache_key, grouped]])),
    ).toEqual({
      group: { first: "Partagé", second: "Partagé" },
    });
    expect(
      materializeControlUiLocaleCatalog(
        new Map([["group.first", "Changed"]]),
        new Map([[grouped.cache_key, grouped]]),
      ),
    ).toEqual({});
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
      sourceLocale: "en",
      updatedAt: () => "2026-02-02T00:00:00.000Z",
    });

    const artifacts = plan.render({
      defaultGlossary: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      glossary: [],
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
          segment_id: "title",
          text: "New English",
          text_hash: hashText("New English"),
          translated: "Nouveau",
          updated_at: "2026-02-02T00:00:00.000Z",
        }),
      )}\n`,
    );
  });

  it("refreshes recorded fallback copy when forced without a provider", () => {
    const plan = createControlUiLocaleSyncPlan({
      allowTranslate: false,
      cacheKeyFor,
      entry,
      existingFlat: new Map([["title", "Old English"]]),
      force: true,
      hashText,
      previousMeta: localeMeta({ fallbackKeys: ["title"] }),
      sourceFlat: new Map([["title", "New English"]]),
      sourceHash: "next-source",
      translationMemory: new Map(),
    });

    expect(plan.newFallbackCount).toBe(0);
    const artifacts = plan.render({
      defaultGlossary: [],
      generatedAt: "2026-03-03T00:00:00.000Z",
      glossary: [],
      workflow: 1,
    });
    expect(artifacts.nextFlat.get("title")).toBe("New English");
    expect(JSON.parse(artifacts.meta).fallbackKeys).toEqual(["title"]);
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
      workflow: 1,
    });

    expect(JSON.parse(artifacts.meta)).toMatchObject({
      generatedAt: previousMeta.generatedAt,
    });
  });
});
