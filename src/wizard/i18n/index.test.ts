// Wizard i18n tests cover locale lookup and fallback behavior through retained translators.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetupTranslator, t } from "./index.js";
import { en } from "./locales/en.js";
import { zh_CN } from "./locales/zh-CN.js";
import { zh_TW } from "./locales/zh-TW.js";
import type { WizardTranslationTree } from "./types.js";

function collectLeafKeys(tree: WizardTranslationTree, prefix = "", out: string[] = []): string[] {
  for (const [key, value] of Object.entries(tree)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.push(next);
    } else {
      collectLeafKeys(value, next, out);
    }
  }
  return out;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("wizard i18n", () => {
  it.each([
    ["zh_CN.UTF-8", "Gateway 端口"],
    ["zh-Hans", "Gateway 端口"],
    ["zh_TW.UTF-8", "Gateway 連接埠"],
    ["zh-HK", "Gateway 連接埠"],
    ["en_US.UTF-8", "Gateway port"],
    ["de_DE.UTF-8", "Gateway port"],
  ])("resolves the %s CLI locale through translated setup copy", (locale, expected) => {
    vi.stubEnv("OPENCLAW_LOCALE", locale);
    expect(t("wizard.gateway.port")).toBe(expected);
  });

  it("uses OPENCLAW_LOCALE before process locale variables", () => {
    vi.stubEnv("OPENCLAW_LOCALE", "en");
    vi.stubEnv("LC_ALL", "zh-CN");
    vi.stubEnv("LANG", "zh-TW");
    expect(t("wizard.gateway.port")).toBe("Gateway port");
  });

  it("ignores blank locale overrides when a process locale is available", () => {
    vi.stubEnv("OPENCLAW_LOCALE", "   ");
    vi.stubEnv("LC_ALL", "");
    vi.stubEnv("LC_MESSAGES", "zh-CN");
    vi.stubEnv("LANG", "en-US");
    expect(t("wizard.gateway.port")).toBe("Gateway 端口");
  });

  it("continues through a blank LC_MESSAGES value to LANG", () => {
    vi.stubEnv("OPENCLAW_LOCALE", "");
    vi.stubEnv("LC_ALL", " ");
    vi.stubEnv("LC_MESSAGES", "\t");
    vi.stubEnv("LANG", "zh-TW");
    expect(t("wizard.gateway.port")).toBe("Gateway 連接埠");
  });

  it("uses English when every locale variable is blank", () => {
    vi.stubEnv("OPENCLAW_LOCALE", " ");
    vi.stubEnv("LC_ALL", "");
    vi.stubEnv("LC_MESSAGES", "\t");
    vi.stubEnv("LANG", "  ");
    expect(t("wizard.gateway.port")).toBe("Gateway port");
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
    const english = collectLeafKeys(en).toSorted();
    for (const [locale, translations] of [
      ["zh-CN", zh_CN],
      ["zh-TW", zh_TW],
    ] as const) {
      expect(collectLeafKeys(translations).toSorted(), locale).toEqual(english);
    }
  });
});
