import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  loadLazyLocaleTranslation,
  resolveNavigatorLocale,
} from "../../ui/src/i18n/lib/registry.ts";
import type { TranslationMap } from "../../ui/src/i18n/lib/types.ts";

function getNestedTranslation(map: TranslationMap | null, ...path: string[]): string | undefined {
  let value: string | TranslationMap | undefined = map ?? undefined;
  for (const key of path) {
    if (value === undefined || typeof value === "string") {
      return undefined;
    }
    value = value[key];
  }
  return typeof value === "string" ? value : undefined;
}

describe("ui i18n locale registry", () => {
  it("lists supported locales", () => {
    expect(SUPPORTED_LOCALES).toEqual([
      "en",
      "zh-CN",
      "zh-TW",
      "pt-BR",
      "de",
      "es",
      "ja-JP",
      "ko",
      "fr",
      "tr",
      "uk",
      "id",
      "pl",
      "th",
    ]);
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("resolves browser locale fallbacks", () => {
    expect(resolveNavigatorLocale("de-DE")).toBe("de");
    expect(resolveNavigatorLocale("es-ES")).toBe("es");
    expect(resolveNavigatorLocale("es-MX")).toBe("es");
    expect(resolveNavigatorLocale("pt-PT")).toBe("pt-BR");
    expect(resolveNavigatorLocale("zh-HK")).toBe("zh-TW");
    expect(resolveNavigatorLocale("en-US")).toBe("en");
    expect(resolveNavigatorLocale("ja-JP")).toBe("ja-JP");
    expect(resolveNavigatorLocale("ko-KR")).toBe("ko");
    expect(resolveNavigatorLocale("fr-CA")).toBe("fr");
    expect(resolveNavigatorLocale("tr-TR")).toBe("tr");
    expect(resolveNavigatorLocale("uk-UA")).toBe("uk");
    expect(resolveNavigatorLocale("id-ID")).toBe("id");
    expect(resolveNavigatorLocale("pl-PL")).toBe("pl");
    expect(resolveNavigatorLocale("th-TH")).toBe("th");
  });

  it("loads lazy locale translations from the registry", async () => {
    const de = await loadLazyLocaleTranslation("de");
    const es = await loadLazyLocaleTranslation("es");
    const ptBR = await loadLazyLocaleTranslation("pt-BR");
    const zhCN = await loadLazyLocaleTranslation("zh-CN");
    const th = await loadLazyLocaleTranslation("th");

    expect(getNestedTranslation(de, "common", "health")).toBe("Status");
    expect(getNestedTranslation(es, "common", "health")).toBe("Estado");
    expect(getNestedTranslation(es, "languages", "de")).toBe("Deutsch (Alemán)");
    expect(getNestedTranslation(ptBR, "languages", "es")).toBe("Español (Espanhol)");
    expect(getNestedTranslation(zhCN, "common", "health")).toBe("\u5065\u5eb7\u72b6\u51b5");
    expect(getNestedTranslation(th, "languages", "en")).toBeTruthy();
    expect(await loadLazyLocaleTranslation("en")).toBeNull();
  });
});
