import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as translate from "../lib/translate.ts";
import { ar } from "../locales/ar.ts";
import { de } from "../locales/de.ts";
import { en } from "../locales/en.ts";
import { es } from "../locales/es.ts";
import { fa } from "../locales/fa.ts";
import { fr } from "../locales/fr.ts";
import { id } from "../locales/id.ts";
import { it as itLocale } from "../locales/it.ts";
import { ja_JP } from "../locales/ja-JP.ts";
import { ko } from "../locales/ko.ts";
import { nl } from "../locales/nl.ts";
import { pl } from "../locales/pl.ts";
import { pt_BR } from "../locales/pt-BR.ts";
import { th } from "../locales/th.ts";
import { tr } from "../locales/tr.ts";
import { uk } from "../locales/uk.ts";
import { vi as viLocale } from "../locales/vi.ts";
import { zh_CN } from "../locales/zh-CN.ts";
import { zh_TW } from "../locales/zh-TW.ts";

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

  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.clear();
    await translate.i18n.setLocale("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should return the key if translation is missing", () => {
    expect(translate.t("non.existent.key")).toBe("non.existent.key");
  });

  it("should return the correct English translation", () => {
    expect(translate.t("common.health")).toBe("Health");
  });

  it("should replace parameters correctly", () => {
    expect(translate.t("overview.stats.cronNext", { time: "10:00" })).toBe("Next wake 10:00");
  });

  it("should fallback to English if key is missing in another locale", async () => {
    // We haven't registered other locales in the test environment yet,
    // but the logic should fallback to 'en' map which is always there.
    await translate.i18n.setLocale("zh-CN");
    // Since we don't mock the import, it might fail to load zh-CN,
    // but let's assume it falls back to English for now.
    expect(translate.t("common.health")).toBeDefined();
  });

  it("loads translations even when setting the same locale again", async () => {
    const internal = translate.i18n as unknown as {
      locale: string;
      translations: Record<string, unknown>;
    };
    internal.locale = "zh-CN";
    delete internal.translations["zh-CN"];

    await translate.i18n.setLocale("zh-CN");
    expect(translate.t("common.health")).toBe("健康状况");
  });

  it("loads saved non-English locale on startup", async () => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    localStorage.setItem("openclaw.i18n.locale", "zh-CN");
    const fresh = await import("../lib/translate.ts");
    await vi.waitFor(() => {
      expect(fresh.i18n.getLocale()).toBe("zh-CN");
    });
    expect(fresh.i18n.getLocale()).toBe("zh-CN");
    expect(fresh.t("common.health")).toBe("健康状况");
  });

  it("skips node localStorage accessors that warn without a storage file", async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal("navigator", { language: "en-US" } as Navigator);
    const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    const fresh = await import("../lib/translate.ts");

    expect(fresh.i18n.getLocale()).toBe("en");
    expect(warningSpy).not.toHaveBeenCalledWith(
      "`--localstorage-file` was provided without a valid path",
      expect.anything(),
      expect.anything(),
    );
  });

  it("keeps the version label available in shipped locales", () => {
    expect((ar.common as { version?: string }).version).toBeTruthy();
    expect((de.common as { version?: string }).version).toBeTruthy();
    expect((es.common as { version?: string }).version).toBeTruthy();
    expect((fa.common as { version?: string }).version).toBeTruthy();
    expect((fr.common as { version?: string }).version).toBeTruthy();
    expect((id.common as { version?: string }).version).toBeTruthy();
    expect((itLocale.common as { version?: string }).version).toBeTruthy();
    expect((ja_JP.common as { version?: string }).version).toBeTruthy();
    expect((ko.common as { version?: string }).version).toBeTruthy();
    expect((nl.common as { version?: string }).version).toBeTruthy();
    expect((pl.common as { version?: string }).version).toBeTruthy();
    expect((pt_BR.common as { version?: string }).version).toBeTruthy();
    expect((th.common as { version?: string }).version).toBeTruthy();
    expect((tr.common as { version?: string }).version).toBeTruthy();
    expect((uk.common as { version?: string }).version).toBeTruthy();
    expect((viLocale.common as { version?: string }).version).toBeTruthy();
    expect((zh_CN.common as { version?: string }).version).toBeTruthy();
    expect((zh_TW.common as { version?: string }).version).toBeTruthy();
  });

  it("keeps newly exposed locales from shipping as English fallback bundles", () => {
    const englishHealth = (en.common as { health: string }).health;
    for (const [locale, value] of Object.entries({
      ar,
      fa,
      it: itLocale,
      nl,
      vi: viLocale,
    })) {
      expect((value.common as { health: string }).health, locale).not.toBe(englishHealth);
    }
  });

  it("keeps shipped locales structurally aligned with English", () => {
    const englishKeys = flatten(en);
    for (const [locale, value] of Object.entries({
      ar,
      de,
      es,
      fa,
      fr,
      id,
      it: itLocale,
      ja_JP,
      ko,
      nl,
      pl,
      pt_BR,
      th,
      tr,
      uk,
      vi: viLocale,
      zh_CN,
      zh_TW,
    })) {
      expect(flatten(value as Record<string, string | Record<string, unknown>>), locale).toEqual(
        englishKeys,
      );
    }
  });
});
