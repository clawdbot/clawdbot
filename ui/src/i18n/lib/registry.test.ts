// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveNavigatorLocale } from "./registry.ts";

describe("resolveNavigatorLocale", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-Hans-SG", "zh-CN"],
    ["zh-Hans-HK", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-Hant-MO", "zh-TW"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["ZH-hAnT-hK", "zh-TW"],
    ["ZH-hAnS-hK", "zh-CN"],
    ["en-US", "en"],
    ["pt-PT", "pt-BR"],
    ["PT-br", "pt-BR"],
    ["de-DE", "de"],
    ["DE-at", "de"],
    ["es-MX", "es"],
    ["ja-JP", "ja-JP"],
    ["ko-KR", "ko"],
    ["fr-CA", "fr"],
    ["hi-IN", "hi"],
    ["ar-EG", "ar"],
    ["it-IT", "it"],
    ["tr-TR", "tr"],
    ["uk-UA", "uk"],
    ["id-ID", "id"],
    ["pl-PL", "pl"],
    ["th-TH", "th"],
    ["vi-VN", "vi"],
    ["nl-NL", "nl"],
    ["fa-IR", "fa"],
    ["ru-RU", "ru"],
    ["sv-SE", "en"],
    ["", "en"],
  ] as const)("maps browser language %s to %s", (browserLanguage, expectedLocale) => {
    expect(resolveNavigatorLocale(browserLanguage)).toBe(expectedLocale);
  });
});
