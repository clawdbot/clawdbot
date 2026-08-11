import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_LOCALES,
  LOCALE_REGISTRY,
  LOCALE_REGISTRY_REVISION,
  getLocaleDirection,
  matchExactOpenClawLocale,
  matchInferredOpenClawLocale,
  normalizeLocaleToken,
} from "./locale-registry.js";

describe("localization locale registry", () => {
  it("registers the existing 22-locale product union", () => {
    expect(SUPPORTED_LOCALES).toHaveLength(22);
    expect(SUPPORTED_LOCALES).toContain("sv");
  });

  it("binds the registry revision to its canonical content", () => {
    expect(LOCALE_REGISTRY_REVISION).toBe(
      `sha256:${createHash("sha256").update(JSON.stringify(LOCALE_REGISTRY)).digest("hex")}`,
    );
  });

  it.each([
    ["zh_CN.UTF-8", "zh-CN"],
    ["zh", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh_TW.UTF-8", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-SG", "zh-CN"],
    ["en_US.UTF-8", "en"],
  ] as const)("matches explicit locale %s as %s", (value, expected) => {
    expect(matchExactOpenClawLocale(value)).toBe(expected);
  });

  it.each(["zh-Hant-HK", "zh-Hans-SG"])(
    "rejects unregistered explicit wildcard locale %s",
    (value) => {
      expect(matchExactOpenClawLocale(value)).toBeNull();
    },
  );

  it.each([
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["fr-CA", "fr"],
    ["ja", "ja-JP"],
  ] as const)("infers platform locale %s as %s", (value, expected) => {
    expect(matchInferredOpenClawLocale(value)).toBe(expected);
  });

  it("preserves the explicit cross-region Portuguese compatibility rule", () => {
    expect(matchInferredOpenClawLocale("pt-PT")).toBe("pt-BR");
  });

  it("removes platform suffixes and Unicode extensions", () => {
    expect(normalizeLocaleToken("fa_IR.UTF-8@calendar")).toBe("fa-IR");
    expect(normalizeLocaleToken("de-DE-u-co-phonebk")).toBe("de-DE");
  });

  it("reports Arabic and Persian as right-to-left", () => {
    expect(getLocaleDirection("ar")).toBe("rtl");
    expect(getLocaleDirection("fa")).toBe("rtl");
    expect(() => getLocaleDirection("he" as never)).toThrow("Unknown OpenClaw locale");
  });
});
