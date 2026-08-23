import { describe, expect, it } from "vitest";
import {
  LOCALIZATION_CATALOG_LIMITS,
  createCatalogSnapshot,
  createCatalogStore,
  interpolateMessage,
  isolateLocalizationLiteral,
  renderLocalizedMessage,
  validateCatalog,
  type CatalogSnapshotInput,
  type LocalizationCatalog,
} from "./catalog.js";
import { createLocalizationContext } from "./context.js";

function createTestSnapshot(params: Omit<CatalogSnapshotInput, "namespace">) {
  const result = createCatalogSnapshot({ namespace: "core", ...params });
  if (!result.ok) {
    throw new Error("Test catalog was invalid.");
  }
  return result.value;
}

function renderTestMessage(...params: Parameters<typeof renderLocalizedMessage>): string {
  return renderLocalizedMessage(...params).value;
}

describe("localization catalogs", () => {
  const english: LocalizationCatalog = {
    "core.files.count": "{count, plural, one {{count} file} other {{count} files}}",
    "core.state.label": "{state, select, ready {Ready for {name}} other {Waiting for {name}}}",
  };

  it.each([
    ["en", 2, "2 files"],
    ["ru", 2, "2 файла"],
    ["pl", 2, "2 pliki"],
    ["ar", 2, "2 ملفان"],
  ] as const)("renders plural categories for %s", (locale, count, expected) => {
    const snapshot = createTestSnapshot({
      catalogRevision: "test",
      catalogs: {
        en: english,
        ru: {
          "core.files.count":
            "{count, plural, one {{count} файл} few {{count} файла} many {{count} файлов} other {{count} файла}}",
          "core.state.label": english["core.state.label"]!,
        },
        pl: {
          "core.files.count":
            "{count, plural, one {{count} plik} few {{count} pliki} many {{count} plików} other {{count} pliku}}",
          "core.state.label": english["core.state.label"]!,
        },
        ar: {
          "core.files.count":
            "{count, plural, one {{count} ملف} two {{count} ملفان} other {{count} ملفات}}",
          "core.state.label": english["core.state.label"]!,
        },
      },
    });
    const context = createLocalizationContext({
      locale,
      source: "explicit-user",
      audience: "user",
    });
    expect(
      renderTestMessage(snapshot, context, {
        key: "core.files.count",
        params: { count },
        fallback: "Files: {count}",
      }),
    ).toBe(expected);
  });

  it("renders select messages through ICU MessageFormat", () => {
    const snapshot = createTestSnapshot({ catalogRevision: "test", catalogs: { en: english } });
    const context = createLocalizationContext({
      locale: "en",
      source: "english-default",
      audience: "user",
    });
    expect(
      renderTestMessage(snapshot, context, {
        key: "core.state.label",
        params: { state: "ready", name: "Patrick" },
        fallback: "State {state} for {name}",
      }),
    ).toBe("Ready for Patrick");
  });

  it("uses a whole-message fallback for unknown keys", () => {
    const snapshot = createTestSnapshot({ catalogRevision: "test", catalogs: { en: english } });
    const context = createLocalizationContext({
      locale: "de",
      source: "platform",
      audience: "operator",
    });
    expect(
      renderTestMessage(snapshot, context, {
        key: "core.unknown",
        fallback: "Reviewed English fallback",
      }),
    ).toBe("Reviewed English fallback");
  });

  it("interpolates whole-message fallbacks", () => {
    const snapshot = createTestSnapshot({
      catalogRevision: "test",
      catalogs: { en: { "core.known": "Known" } },
    });
    const context = createLocalizationContext({
      locale: "de",
      source: "platform",
      audience: "operator",
    });
    expect(
      renderTestMessage(snapshot, context, {
        key: "core.unknown",
        params: { target: "gateway" },
        fallback: "Approve {target}?",
      }),
    ).toBe("Approve gateway?");
  });

  it.each([false, true])("renders boolean params as text (%s)", (enabled) => {
    const snapshot = createTestSnapshot({
      catalogRevision: "test",
      catalogs: { en: { "core.setting.enabled": "Enabled: {enabled}" } },
    });
    const context = createLocalizationContext({
      locale: "en",
      source: "english-default",
      audience: "operator",
    });
    expect(
      renderTestMessage(snapshot, context, {
        key: "core.setting.enabled",
        params: { enabled },
        fallback: "Setting enabled: {enabled}",
      }),
    ).toBe(`Enabled: ${enabled}`);
    expect(interpolateMessage("Enabled: {enabled}", { enabled })).toBe(`Enabled: ${enabled}`);
  });

  it("uses the matched catalog locale for plural fallback", () => {
    const snapshot = createTestSnapshot({ catalogRevision: "test", catalogs: { en: english } });
    const context = createLocalizationContext({
      locale: "ru",
      source: "platform",
      audience: "operator",
    });
    expect(
      renderTestMessage(snapshot, context, {
        key: "core.files.count",
        params: { count: 21 },
        fallback: "21 files",
      }),
    ).toBe("21 files");
  });

  it("freezes snapshots and captures catalog replacement by reference", () => {
    const first = createTestSnapshot({
      catalogRevision: "first",
      catalogs: { en: { "core.label": "First" } },
    });
    const second = createTestSnapshot({
      catalogRevision: "second",
      catalogs: { en: { "core.label": "Second" } },
    });
    const context = createLocalizationContext({
      locale: "en",
      source: "english-default",
      audience: "user",
    });
    const message = { key: "core.label", fallback: "Fallback" };
    expect(renderTestMessage(first, context, message)).toBe("First");
    expect(renderTestMessage(second, context, message)).toBe("Second");
    expect(Object.isFrozen(first.catalogs.en)).toBe(true);
  });

  it("rejects placeholder drift and translator-authored bidi controls", () => {
    expect(
      validateCatalog({
        namespace: "core",
        source: { "core.path": "Open {path}" },
        candidate: { "core.path": "Öffnen {file}\u202e" },
      }).map((issue) => issue.code),
    ).toEqual(["placeholder-mismatch", "forbidden-bidi-control"]);
  });

  it("rejects forbidden bidi controls in the English source catalog", () => {
    expect(
      validateCatalog({
        namespace: "core",
        source: { "core.path": "Open {path}\u202e" },
        candidate: { "core.path": "Öffnen {path}" },
      }).map((issue) => issue.code),
    ).toContain("forbidden-bidi-control");
  });

  it("does not interpolate invalid runtime parameter values", () => {
    expect(
      interpolateMessage("Open {path} after {delay}", {
        path: { unsafe: true } as unknown as string,
        delay: Number.NaN,
      }),
    ).toBe("Open {path} after {delay}");
  });

  it("rejects missing selector fallback cases", () => {
    expect(
      validateCatalog({
        namespace: "core",
        source: english,
        candidate: {
          "core.files.count": "{count, plural, one {{count} Datei}}",
          "core.state.label": english["core.state.label"]!,
        },
      }).map((issue) => issue.code),
    ).toContain("invalid-selector");
  });

  it("rejects a selector branch that omits a required placeholder", () => {
    expect(
      validateCatalog({
        namespace: "core",
        source: {
          "core.files.count":
            "{count, plural, one {{count} file for {name}} other {{count} files for {name}}}",
        },
        candidate: {
          "core.files.count":
            "{count, plural, one {{count} Datei für {name}} other {{count} Dateien}}",
        },
      }).map((issue) => issue.code),
    ).toContain("placeholder-mismatch");
  });

  it("rejects select catalogs that omit a source case", () => {
    expect(
      validateCatalog({
        namespace: "core",
        source: {
          "core.state.label":
            "{state, select, ready {Ready for {name}} other {Waiting for {name}}}",
        },
        candidate: {
          "core.state.label": "{state, select, other {Warten auf {name}}}",
        },
      }).map((issue) => issue.code),
    ).toContain("invalid-selector");
  });

  it("rejects ICU features outside the bounded v1 profile", () => {
    expect(
      validateCatalog({
        namespace: "core",
        source: { "core.amount": "Amount: {amount, number}" },
        candidate: { "core.amount": "Betrag: {amount, number}" },
      }).map((issue) => issue.code),
    ).toContain("invalid-selector");
  });

  it("rejects oversized messages before ICU parsing", () => {
    const result = createCatalogSnapshot({
      namespace: "core",
      catalogRevision: "oversized-message",
      catalogs: {
        en: {
          "core.message": "x".repeat(LOCALIZATION_CATALOG_LIMITS.messageLength + 1),
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-catalog",
        catalogRevision: "oversized-message",
        issues: [
          {
            code: "message-too-large",
            key: "core.message",
            detail: `Message must be a string no longer than ${LOCALIZATION_CATALOG_LIMITS.messageLength} characters.`,
          },
        ],
      },
    });
  });

  it("rejects oversized keys before ICU parsing", () => {
    const key = `core.${"x".repeat(LOCALIZATION_CATALOG_LIMITS.keyLength)}`;
    const result = createCatalogSnapshot({
      namespace: "core",
      catalogRevision: "oversized-key",
      catalogs: { en: { [key]: "Value" } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues).toContainEqual({
        code: "invalid-key",
        key,
        detail: `Key exceeds ${LOCALIZATION_CATALOG_LIMITS.keyLength} characters.`,
      });
    }
  });

  it("rejects excessive catalog entries before ICU parsing", () => {
    const catalog = Object.fromEntries(
      Array.from({ length: LOCALIZATION_CATALOG_LIMITS.entries + 1 }, (_, index) => [
        `core.message-${index}`,
        "Value",
      ]),
    );
    const result = createCatalogSnapshot({
      namespace: "core",
      catalogRevision: "oversized-catalog",
      catalogs: { en: catalog },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid-catalog",
        catalogRevision: "oversized-catalog",
        issues: [
          {
            code: "catalog-too-large",
            key: "core.*",
            detail: `Snapshot exceeds ${LOCALIZATION_CATALOG_LIMITS.entries} catalog entries.`,
          },
        ],
      },
    });
  });

  it("rejects candidate-only catalog keys", () => {
    expect(
      validateCatalog({
        namespace: "core",
        source: { "core.known": "Known" },
        candidate: {
          "core.known": "Bekannt",
          "core.extra": "Extra",
        },
      }),
    ).toContainEqual({
      code: "unknown-key",
      key: "core.extra",
      detail: "Candidate catalog contains a key that is absent from the source catalog.",
    });
  });

  it("rejects invalid snapshots and preserves the previous active revision", () => {
    const store = createCatalogStore({
      namespace: "core",
      catalogRevision: "first",
      catalogs: { en: { "core.label": "First" } },
    });
    expect(store.ok).toBe(true);
    if (!store.ok) {
      return;
    }

    const rejected = store.value.activate({
      catalogRevision: "broken",
      catalogs: { en: { "core.label": "Open {path}" }, de: { "core.label": "Öffnen {file}" } },
    });
    expect(rejected.ok).toBe(false);
    expect(store.value.snapshot.catalogRevision).toBe("first");
    expect(
      renderTestMessage(
        store.value.snapshot,
        createLocalizationContext({
          locale: "en",
          source: "english-default",
          audience: "operator",
        }),
        { key: "core.label", fallback: "Fallback" },
      ),
    ).toBe("First");
  });

  it("returns bounded findings for missing catalogs and invalid parameters", () => {
    const snapshot = createTestSnapshot({
      catalogRevision: "test",
      catalogs: { en: { "core.path": "Open {path}" } },
    });
    const context = createLocalizationContext({
      locale: "ar",
      source: "explicit-user",
      audience: "operator",
    });
    const missingCatalog = renderLocalizedMessage(snapshot, context, {
      key: "core.path",
      params: { path: "/tmp/openclaw" },
      fallback: "Open {path}",
    });
    expect(missingCatalog.value).toBe("Open /tmp/openclaw");
    expect(missingCatalog.findings.map((finding) => finding.code)).toEqual(["missing-catalog"]);

    const invalidParams = renderLocalizedMessage(snapshot, context, {
      key: "core.path",
      params: { other: "value" },
      fallback: "Open {path}",
    });
    expect(invalidParams.value).toBe("Open {path}");
    expect(invalidParams.findings.map((finding) => finding.code)).toEqual(["invalid-parameter"]);
  });

  it("isolates RTL literals with renderer-owned controls", () => {
    expect(isolateLocalizationLiteral("openclaw gateway status")).toEqual({
      ok: true,
      value: "\u2068openclaw gateway status\u2069",
    });
    expect(isolateLocalizationLiteral("unsafe\u202evalue")).toEqual({
      ok: false,
      error: { code: "forbidden-bidi-control" },
    });
  });
});
