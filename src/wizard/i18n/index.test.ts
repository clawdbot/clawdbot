import { describe, expect, it } from "vitest";
import {
  WIZARD_SUPPORTED_LOCALES,
  createSetupTranslator,
  listWizardI18nKeys,
  resolveWizardLocale,
  resolveWizardLocaleFromEnv,
  t,
} from "./index.js";

describe("wizard i18n", () => {
  it("resolves supported CLI locales from explicit and system locale values", () => {
    expect(resolveWizardLocale("zh_CN.UTF-8")).toBe("zh-CN");
    expect(resolveWizardLocale("zh-Hans")).toBe("zh-CN");
    expect(resolveWizardLocale("zh_TW.UTF-8")).toBe("zh-TW");
    expect(resolveWizardLocale("zh-HK")).toBe("zh-TW");
    expect(resolveWizardLocale("en_US.UTF-8")).toBe("en");
    expect(resolveWizardLocale("de_DE.UTF-8")).toBe("en");
  });

  it("uses OPENCLAW_LOCALE before process locale variables", () => {
    expect(
      resolveWizardLocaleFromEnv({
        OPENCLAW_LOCALE: "zh-TW",
        LC_ALL: "zh-CN",
        LANG: "en-US",
      }),
    ).toBe("zh-TW");
  });

  it("falls back to English and interpolates params", () => {
    expect(t("wizard.gateway.port", undefined, { locale: "zh-CN" })).toBe("Gateway 端口");
    expect(t("wizard.gateway.missing", undefined, { locale: "zh-CN" })).toBe(
      "wizard.gateway.missing",
    );
    expect(
      t(
        "wizard.customProvider.endpointIdRenamed",
        { from: "custom", to: "custom-2" },
        { locale: "en" },
      ),
    ).toBe('Endpoint ID "custom" already exists for a different base URL. Using "custom-2".');
  });

  it("creates scoped setup translators without exporting a generic SDK t helper", () => {
    const telegramT = createSetupTranslator({
      keyPrefix: "wizard.telegram",
      locale: "zh-CN",
    });
    expect(telegramT("botToken")).toBe("Telegram bot token");
    expect(telegramT("wizard.gateway.port")).toBe("Gateway 端口");
  });

  it("keeps shipped locale keys aligned with English", () => {
    const english = listWizardI18nKeys("en");
    for (const locale of WIZARD_SUPPORTED_LOCALES) {
      expect(listWizardI18nKeys(locale), locale).toEqual(english);
    }
  });
});
