import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type TranslationTree = {
  readonly [key: string]: string | TranslationTree | undefined;
};

type LocaleRegistry = {
  DEFAULT_LOCALE: string;
  SUPPORTED_LOCALES: readonly string[];
  loadLazyLocaleTranslation(locale: string): Promise<TranslationTree | null>;
  resolveNavigatorLocale(locale: string): string;
};

const registryModuleUrl = new URL("../../ui/src/i18n/lib/registry.ts", import.meta.url);
const describeWhenUiI18nPresent = fs.existsSync(fileURLToPath(registryModuleUrl))
  ? describe
  : describe.skip;

const registry =
  describeWhenUiI18nPresent === describe
    ? ((await import("../../ui/src/i18n/lib/registry.ts")) as LocaleRegistry)
    : undefined;

function getRegistry(): LocaleRegistry {
  if (registry === undefined) {
    throw new Error("expected UI i18n registry to be present");
  }
  return registry;
}

function getNestedTranslation(map: TranslationTree | null, ...path: string[]): string | undefined {
  let value: string | TranslationTree | undefined = map ?? undefined;
  for (const key of path) {
    if (value === undefined || typeof value === "string") {
      return undefined;
    }
    value = value[key];
  }
  return typeof value === "string" ? value : undefined;
}

describeWhenUiI18nPresent("ui i18n locale registry", () => {
  it("lists supported locales", () => {
    const localeRegistry = getRegistry();

    expect(localeRegistry.SUPPORTED_LOCALES).toEqual([
      "en",
      "zh-CN",
      "zh-TW",
      "pt-BR",
      "de",
      "es",
      "ja-JP",
      "ko",
      "fr",
      "ar",
      "it",
      "tr",
      "uk",
      "id",
      "pl",
      "th",
      "vi",
      "nl",
      "fa",
    ]);
    expect(localeRegistry.DEFAULT_LOCALE).toBe("en");
  });

  it("resolves browser locale fallbacks", () => {
    const localeRegistry = getRegistry();

    expect(localeRegistry.resolveNavigatorLocale("de-DE")).toBe("de");
    expect(localeRegistry.resolveNavigatorLocale("es-ES")).toBe("es");
    expect(localeRegistry.resolveNavigatorLocale("es-MX")).toBe("es");
    expect(localeRegistry.resolveNavigatorLocale("pt-PT")).toBe("pt-BR");
    expect(localeRegistry.resolveNavigatorLocale("zh-HK")).toBe("zh-TW");
    expect(localeRegistry.resolveNavigatorLocale("en-US")).toBe("en");
    expect(localeRegistry.resolveNavigatorLocale("ja-JP")).toBe("ja-JP");
    expect(localeRegistry.resolveNavigatorLocale("ko-KR")).toBe("ko");
    expect(localeRegistry.resolveNavigatorLocale("fr-CA")).toBe("fr");
    expect(localeRegistry.resolveNavigatorLocale("ar-EG")).toBe("ar");
    expect(localeRegistry.resolveNavigatorLocale("it-IT")).toBe("it");
    expect(localeRegistry.resolveNavigatorLocale("tr-TR")).toBe("tr");
    expect(localeRegistry.resolveNavigatorLocale("uk-UA")).toBe("uk");
    expect(localeRegistry.resolveNavigatorLocale("id-ID")).toBe("id");
    expect(localeRegistry.resolveNavigatorLocale("pl-PL")).toBe("pl");
    expect(localeRegistry.resolveNavigatorLocale("th-TH")).toBe("th");
    expect(localeRegistry.resolveNavigatorLocale("vi-VN")).toBe("vi");
    expect(localeRegistry.resolveNavigatorLocale("nl-NL")).toBe("nl");
    expect(localeRegistry.resolveNavigatorLocale("fa-IR")).toBe("fa");
  });

  it("loads lazy locale translations from the registry", async () => {
    const localeRegistry = getRegistry();
    const [de, es, ptBR, zhCN, th, en] = await Promise.all([
      localeRegistry.loadLazyLocaleTranslation("de"),
      localeRegistry.loadLazyLocaleTranslation("es"),
      localeRegistry.loadLazyLocaleTranslation("pt-BR"),
      localeRegistry.loadLazyLocaleTranslation("zh-CN"),
      localeRegistry.loadLazyLocaleTranslation("th"),
      localeRegistry.loadLazyLocaleTranslation("en"),
    ]);

    expect(getNestedTranslation(de, "common", "health")).toBe("Status");
    expect(getNestedTranslation(es, "common", "health")).toBe("Estado");
    expect(getNestedTranslation(es, "languages", "de")).toBe("Deutsch (Alemán)");
    expect(getNestedTranslation(ptBR, "languages", "es")).toBe("Español (Espanhol)");
    expect(getNestedTranslation(zhCN, "common", "health")).toBe("\u5065\u5eb7\u72b6\u51b5");
    expect(getNestedTranslation(th, "languages", "en")).toBe("อังกฤษ");
    expect(en).toBeNull();
  });
});
