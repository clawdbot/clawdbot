// @vitest-environment node
// Control UI tests cover translate behavior.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as translate from "../lib/translate.ts";
import { ar } from "../locales/ar.ts";
import { de } from "../locales/de.ts";
import { registerLoginEnglish } from "../locales/en-login.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fa } from "../locales/fa.ts";
import { fr } from "../locales/fr.ts";
import { hi } from "../locales/hi.ts";
import { id } from "../locales/id.ts";
import { it as itLocale } from "../locales/it.ts";
import { ja_JP } from "../locales/ja-JP.ts";
import { ko } from "../locales/ko.ts";
import { nl } from "../locales/nl.ts";
import { pl } from "../locales/pl.ts";
import { pt_BR } from "../locales/pt-BR.ts";
import { ru } from "../locales/ru.ts";
import { th } from "../locales/th.ts";
import { tr } from "../locales/tr.ts";
import { uk } from "../locales/uk.ts";
import { vi as viLocale } from "../locales/vi.ts";
import { zh_CN } from "../locales/zh-CN.ts";
import { zh_TW } from "../locales/zh-TW.ts";

const shippedLocales = {
  ar,
  de,
  es,
  fa,
  fr,
  hi,
  id,
  it: itLocale,
  ja_JP,
  ko,
  nl,
  pl,
  pt_BR,
  ru,
  th,
  tr,
  uk,
  vi: viLocale,
  zh_CN,
  zh_TW,
} as const;
let translateImportCase = 0;

async function importFreshTranslate() {
  return importFreshModule<typeof import("../lib/translate.ts")>(
    import.meta.url,
    `../lib/translate.ts?case=${++translateImportCase}`,
  );
}

function stubDocumentLocaleMetadata() {
  const documentElement = { lang: "", dir: "" };
  vi.stubGlobal("document", { documentElement } as unknown as Document);
  return documentElement;
}

describe("i18n", () => {
  function flatten(value: Record<string, string | Record<string, unknown>>, prefix = ""): string[] {
    return Object.entries(value).flatMap(([key, nested]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof nested === "string") {
        return [fullKey];
      }
      return flatten(nested as Record<string, string | Record<string, unknown>>, fullKey);
    });
  }

  function readTranslationString(value: unknown, path: string): string {
    let cursor = value;
    for (const part of path.split(".")) {
      cursor =
        cursor && typeof cursor === "object"
          ? (cursor as Record<string, unknown>)[part]
          : undefined;
    }
    return typeof cursor === "string" ? cursor : "";
  }

  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
    await translate.i18n.setLocale("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("should return the key if translation is missing", () => {
    expect(translate.t("non.existent.key")).toBe("non.existent.key");
  });

  it("should return the correct English translation", () => {
    expect(translate.t("common.health")).toBe("Health");
  });

  it("should replace parameters correctly", () => {
    expect(translate.t("connection.help.copyCommandAria", { command: "openclaw dashboard" })).toBe(
      "Copy command: openclaw dashboard",
    );
  });

  it("renders a provided empty-string param as empty, not the raw placeholder", () => {
    expect(translate.t("connection.help.copyCommandAria", { command: "" })).toBe("Copy command: ");
  });

  it("keeps the visible placeholder when the param is missing", () => {
    expect(translate.t("connection.help.copyCommandAria", {})).toBe("Copy command: {command}");
  });

  it("should fallback to English if key is missing in another locale", async () => {
    translate.i18n.registerTranslation("zh-CN", { common: {} } as never);
    await translate.i18n.setLocale("zh-CN");
    expect(translate.t("common.health")).toBe("Health");
  });

  it("loads translations even when setting the same locale again", async () => {
    const internal = translate.i18n as unknown as {
      locale: string;
      translations: Record<string, unknown>;
    };
    internal.locale = "zh-CN";
    delete internal.translations["zh-CN"];

    await translate.i18n.setLocale("zh-CN");
    expect(translate.t("common.health")).toBe(readTranslationString(zh_CN, "common.health"));
  });

  it("loads saved non-English locale on startup", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "zh-CN");
    const fresh = await importFreshTranslate();
    await vi.waitFor(() => {
      expect(fresh.i18n.getLocale()).toBe("zh-CN");
    });
    expect(fresh.i18n.getLocale()).toBe("zh-CN");
    expect(fresh.t("common.health")).toBe(readTranslationString(zh_CN, "common.health"));
  });

  it("syncs canonical document locale metadata on startup", async () => {
    const documentElement = stubDocumentLocaleMetadata();
    vi.stubGlobal("navigator", { language: "fa-IR" } as Navigator);
    localStorage.removeItem("openclaw.i18n.locale");

    const fresh = await importFreshTranslate();

    await vi.waitFor(() => expect(fresh.i18n.getLocale()).toBe("fa"));
    expect(documentElement).toEqual({ lang: "fa", dir: "rtl" });
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
  });

  it("clears an explicit locale when returning to the system language", async () => {
    vi.stubGlobal("navigator", { language: "de-DE" } as Navigator);
    await translate.i18n.setLocale("fr");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBe("fr");

    await translate.i18n.useSystemLocale();

    expect(translate.i18n.getLocale()).toBe("de");
    expect(localStorage.getItem("openclaw.i18n.locale")).toBeNull();
  });

  it("syncs document locale metadata when the locale changes", async () => {
    const documentElement = stubDocumentLocaleMetadata();

    await translate.i18n.setLocale("ar");
    expect(documentElement).toEqual({ lang: "ar", dir: "rtl" });

    await translate.i18n.setLocale("de");
    expect(documentElement).toEqual({ lang: "de", dir: "ltr" });
  });

  it.each([
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-Hant-MO", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["ZH-hAnT-hK", "zh-TW"],
    ["zh-Hans-HK", "zh-CN"],
    ["ZH-hAnS-hK", "zh-CN"],
  ] as const)(
    "loads the %s browser language as the registered %s locale on startup",
    async (browserLanguage, expectedLocale) => {
      vi.stubGlobal("navigator", { language: browserLanguage } as Navigator);
      localStorage.removeItem("openclaw.i18n.locale");

      const fresh = await importFreshTranslate();

      await vi.waitFor(() => expect(fresh.i18n.getLocale()).toBe(expectedLocale));
      expect(fresh.t("common.health")).toBe(
        readTranslationString(expectedLocale === "zh-TW" ? zh_TW : zh_CN, "common.health"),
      );
    },
  );

  it("skips node localStorage accessors that warn without a storage file", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    const fresh = await importFreshTranslate();

    expect(fresh.i18n.getLocale()).toBe("en");
    const warningMessages = warningSpy.mock.calls.map((call) => String(call[0]));
    expect(warningMessages).not.toContain(
      "`--localstorage-file` was provided without a valid path",
    );
  });

  it("keeps the version label available in shipped locales", () => {
    for (const [locale, value] of Object.entries(shippedLocales)) {
      const version = (value.common as { version?: unknown }).version;
      expect(version, locale).toBeTypeOf("string");
      if (typeof version !== "string") {
        throw new Error(`expected ${locale} common.version to be a string`);
      }
      expect(version.trim(), locale).not.toBe("");
    }
  });

  it("keeps newly exposed locales from shipping as English fallback bundles", () => {
    const englishHealth = (en.common as { health: string }).health;
    for (const [locale, value] of Object.entries({
      ar,
      hi,
      fa,
      it: itLocale,
      nl,
      vi: viLocale,
    })) {
      expect((value.common as { health: string }).health, locale).not.toBe(englishHealth);
    }
  });

  it("keeps login failure guidance localized in shipped locale bundles", () => {
    const checkedKeys = flatten(registerLoginEnglish.catalog.login.failure, "login.failure");
    expect(checkedKeys.length).toBeGreaterThan(0);
    for (const [locale, value] of Object.entries({
      ar,
      de,
      es,
      fa,
      fr,
      hi,
      id,
      it: itLocale,
      ja_JP,
      ko,
      nl,
      pl,
      pt_BR,
      ru,
      th,
      tr,
      uk,
      vi: viLocale,
      zh_CN,
      zh_TW,
    })) {
      for (const key of checkedKeys) {
        expect(readTranslationString(value, key), `${locale}:${key}`).not.toBe(
          readTranslationString(registerLoginEnglish.catalog, key),
        );
      }
    }
  });

  it("keeps mobile pairing copy localized in shipped locale bundles", () => {
    const checkedKeys = flatten(en).filter(
      (key) => key.startsWith("devices.pairing.") && key !== "devices.pairing.title",
    );

    for (const [locale, value] of Object.entries(shippedLocales)) {
      for (const key of checkedKeys) {
        expect(readTranslationString(value, key), `${locale}:${key}`).not.toBe(
          readTranslationString(en, key),
        );
      }
    }
  });

  it("keeps the chat composer attachment action localized in shipped locale bundles", () => {
    const key = "chat.composer.addAttachment";

    for (const [locale, value] of Object.entries(shippedLocales)) {
      expect(readTranslationString(value, key), `${locale}:${key}`).not.toBe(
        readTranslationString(en, key),
      );
    }
  });
});
