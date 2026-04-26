import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

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

let registry: LocaleRegistry;

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
  beforeAll(async () => {
    registry = (await import("../../ui/src/i18n/lib/registry.ts")) as LocaleRegistry;
  });

  it("lists supported locales", () => {
    expect(registry.SUPPORTED_LOCALES).toEqual([
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
    expect(registry.DEFAULT_LOCALE).toBe("en");
  });

  it("resolves browser locale fallbacks", () => {
    expect(registry.resolveNavigatorLocale("de-DE")).toBe("de");
    expect(registry.resolveNavigatorLocale("es-ES")).toBe("es");
    expect(registry.resolveNavigatorLocale("es-MX")).toBe("es");
    expect(registry.resolveNavigatorLocale("pt-PT")).toBe("pt-BR");
    expect(registry.resolveNavigatorLocale("zh-HK")).toBe("zh-TW");
    expect(registry.resolveNavigatorLocale("en-US")).toBe("en");
    expect(registry.resolveNavigatorLocale("ja-JP")).toBe("ja-JP");
    expect(registry.resolveNavigatorLocale("ko-KR")).toBe("ko");
    expect(registry.resolveNavigatorLocale("fr-CA")).toBe("fr");
    expect(registry.resolveNavigatorLocale("tr-TR")).toBe("tr");
    expect(registry.resolveNavigatorLocale("uk-UA")).toBe("uk");
    expect(registry.resolveNavigatorLocale("id-ID")).toBe("id");
    expect(registry.resolveNavigatorLocale("pl-PL")).toBe("pl");
    expect(registry.resolveNavigatorLocale("th-TH")).toBe("th");
  });

  it("loads lazy locale translations from the registry", async () => {
    const [de, es, ptBR, zhCN, th, en] = await Promise.all([
      registry.loadLazyLocaleTranslation("de"),
      registry.loadLazyLocaleTranslation("es"),
      registry.loadLazyLocaleTranslation("pt-BR"),
      registry.loadLazyLocaleTranslation("zh-CN"),
      registry.loadLazyLocaleTranslation("th"),
      registry.loadLazyLocaleTranslation("en"),
    ]);

    expect(getNestedTranslation(de, "common", "health")).toBe("Status");
    expect(getNestedTranslation(es, "common", "health")).toBe("Estado");
    expect(getNestedTranslation(es, "languages", "de")).toBe("Deutsch (Alemán)");
    expect(getNestedTranslation(ptBR, "languages", "es")).toBe("Español (Espanhol)");
    expect(getNestedTranslation(zhCN, "common", "health")).toBe("\u5065\u5eb7\u72b6\u51b5");
    expect(getNestedTranslation(th, "languages", "en")).toBeTruthy();
    expect(en).toBeNull();
  });
});
