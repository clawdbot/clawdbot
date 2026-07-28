// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveNavigatorLocale } from "./registry.ts";

describe("resolveNavigatorLocale", () => {
  it.each([
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-Hant-MO", "zh-TW"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["ZH-hAnT-tW", "zh-TW"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-Hans-SG", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-Hant-CN", "zh-TW"],
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
  ] as const)("maps %s to %s", (language, expected) => {
    expect(resolveNavigatorLocale(language)).toBe(expected);
  });
});
