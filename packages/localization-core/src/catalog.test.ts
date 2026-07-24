import { describe, expect, it } from "vitest";
import {
  createCatalogSnapshot,
  interpolateMessage,
  renderLocalizedMessage,
  validateCatalog,
  type LocalizationCatalog,
} from "./catalog.js";
import { createLocalizationContext } from "./context.js";

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
    const snapshot = createCatalogSnapshot({
      catalogRevision: "test",
      catalogs: {
        en: english,
        ru: {
          "core.files.count":
            "{count, plural, one {{count} файл} few {{count} файла} many {{count} файлов} other {{count} файла}}",
        },
        pl: {
          "core.files.count":
            "{count, plural, one {{count} plik} few {{count} pliki} many {{count} plików} other {{count} pliku}}",
        },
        ar: {
          "core.files.count":
            "{count, plural, one {{count} ملف} two {{count} ملفان} other {{count} ملفات}}",
        },
      },
    });
    const context = createLocalizationContext({
      locale,
      source: "explicit-user",
      audience: "user",
    });
    expect(
      renderLocalizedMessage(snapshot, context, {
        key: "core.files.count",
        params: { count },
        fallback: "Files: {count}",
      }),
    ).toBe(expected);
  });

  it("renders select messages through ICU MessageFormat", () => {
    const snapshot = createCatalogSnapshot({ catalogRevision: "test", catalogs: { en: english } });
    const context = createLocalizationContext({
      locale: "en",
      source: "english-default",
      audience: "user",
    });
    expect(
      renderLocalizedMessage(snapshot, context, {
        key: "core.state.label",
        params: { state: "ready", name: "Patrick" },
        fallback: "State for {name}",
      }),
    ).toBe("Ready for Patrick");
  });

  it("uses a whole-message fallback for unknown keys", () => {
    const snapshot = createCatalogSnapshot({ catalogRevision: "test", catalogs: { en: english } });
    const context = createLocalizationContext({
      locale: "de",
      source: "platform",
      audience: "operator",
    });
    expect(
      renderLocalizedMessage(snapshot, context, {
        key: "core.unknown",
        fallback: "Reviewed English fallback",
      }),
    ).toBe("Reviewed English fallback");
  });

  it("interpolates whole-message fallbacks", () => {
    const snapshot = createCatalogSnapshot({ catalogRevision: "test", catalogs: {} });
    const context = createLocalizationContext({
      locale: "de",
      source: "platform",
      audience: "operator",
    });
    expect(
      renderLocalizedMessage(snapshot, context, {
        key: "core.unknown",
        params: { target: "gateway" },
        fallback: "Approve {target}?",
      }),
    ).toBe("Approve gateway?");
  });

  it.each([false, true])("renders boolean params as text (%s)", (enabled) => {
    const snapshot = createCatalogSnapshot({
      catalogRevision: "test",
      catalogs: { en: { "core.setting.enabled": "Enabled: {enabled}" } },
    });
    const context = createLocalizationContext({
      locale: "en",
      source: "english-default",
      audience: "operator",
    });
    expect(
      renderLocalizedMessage(snapshot, context, {
        key: "core.setting.enabled",
        params: { enabled },
        fallback: "Setting enabled: {enabled}",
      }),
    ).toBe(`Enabled: ${enabled}`);
    expect(interpolateMessage("Enabled: {enabled}", { enabled })).toBe(`Enabled: ${enabled}`);
  });

  it("uses the matched catalog locale for plural fallback", () => {
    const snapshot = createCatalogSnapshot({ catalogRevision: "test", catalogs: { en: english } });
    const context = createLocalizationContext({
      locale: "ru",
      source: "platform",
      audience: "operator",
    });
    expect(
      renderLocalizedMessage(snapshot, context, {
        key: "core.files.count",
        params: { count: 21 },
        fallback: "21 files",
      }),
    ).toBe("21 files");
  });

  it("freezes snapshots and captures catalog replacement by reference", () => {
    const first = createCatalogSnapshot({
      catalogRevision: "first",
      catalogs: { en: { "core.label": "First" } },
    });
    const second = createCatalogSnapshot({
      catalogRevision: "second",
      catalogs: { en: { "core.label": "Second" } },
    });
    const context = createLocalizationContext({
      locale: "en",
      source: "english-default",
      audience: "user",
    });
    const message = { key: "core.label", fallback: "Fallback" };
    expect(renderLocalizedMessage(first, context, message)).toBe("First");
    expect(renderLocalizedMessage(second, context, message)).toBe("Second");
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
});
