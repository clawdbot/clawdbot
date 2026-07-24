import { describe, expect, it } from "vitest";
import { resolveLocalizationContext, resolveProcessLocalizationContext } from "./context.js";

describe("localization context", () => {
  it("uses an explicit recipient locale before request and platform inputs", () => {
    const result = resolveLocalizationContext({
      audience: "user",
      explicitRecipient: "zh-Hant",
      request: "zh-CN",
      platform: ["de-DE"],
    });
    expect(result.context.locale).toBe("zh-TW");
    expect(result.context.source).toBe("explicit-recipient");
  });

  it("uses strict stored preferences before inferred platform locales", () => {
    const result = resolveLocalizationContext({
      audience: "user",
      surfacePreference: "fa",
      platform: ["de-DE"],
    });
    expect(result.context).toEqual({
      locale: "fa",
      fallbackLocales: ["en"],
      source: "surface-preference",
      audience: "user",
    });
    expect(Object.isFrozen(result.context)).toBe(true);
  });

  it("ignores a stale stored preference and records a bounded finding", () => {
    const result = resolveLocalizationContext({
      audience: "user",
      surfacePreference: "xx-invalid",
      platform: ["de-DE"],
    });
    expect(result.context.locale).toBe("de");
    expect(result.findings).toEqual([
      {
        source: "surface-preference",
        value: "xx-invalid",
        reason: "invalid",
      },
    ]);
  });

  it("falls directly to English for an invalid explicit process override", () => {
    const result = resolveProcessLocalizationContext(
      {
        OPENCLAW_LOCALE: "xx-invalid",
        LC_ALL: "zh-CN",
      },
      { audience: "operator", supportedLocales: ["en", "zh-CN", "zh-TW"] },
    );
    expect(result.context.locale).toBe("en");
    expect(result.context.source).toBe("english-default");
  });

  it("honors POSIX locale precedence when the highest-priority value is unsupported", () => {
    const result = resolveProcessLocalizationContext(
      {
        LC_ALL: "de",
        LC_MESSAGES: "zh-Hant",
      },
      { audience: "operator", supportedLocales: ["en", "zh-CN", "zh-TW"] },
    );
    expect(result.context.locale).toBe("en");
    expect(result.findings).toEqual([
      { source: "platform", value: "de", reason: "unsupported-by-surface" },
    ]);
  });

  it("keeps the POSIX C locale in English instead of falling through to LANG", () => {
    const result = resolveProcessLocalizationContext(
      {
        LC_ALL: "C",
        LANG: "zh_CN.UTF-8",
      },
      { audience: "operator", supportedLocales: ["en", "zh-CN", "zh-TW"] },
    );
    expect(result.context.locale).toBe("en");
    expect(result.context.source).toBe("platform");
    expect(result.findings).toEqual([]);
  });

  it("uses runtime platform locales when Windows has no POSIX locale variables", () => {
    const result = resolveProcessLocalizationContext(
      {},
      {
        audience: "operator",
        supportedLocales: ["en", "zh-CN", "zh-TW"],
        platform: ["zh-Hant-HK"],
      },
    );
    expect(result.context.locale).toBe("zh-TW");
    expect(result.context.source).toBe("platform");
  });
});
