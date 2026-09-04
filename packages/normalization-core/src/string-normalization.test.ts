// Normalization Core tests cover string normalization behavior.
import { describe, expect, it } from "vitest";
import {
  containsAsciiControlCharacter,
  filterStringEntries,
  normalizeAtHashSlug,
  normalizeCsvOrLooseStringList,
  normalizeHyphenSlug,
  normalizeOptionalTrimmedStringList,
  normalizeSortedUniqueStringEntries,
  normalizeSortedUniqueTrimmedStringList,
  normalizeStringEntries,
  normalizeStringEntriesLower,
  normalizeTrimmedStringList,
  normalizeUniqueSingleOrTrimmedStringList,
  normalizeUniqueStringEntries,
  normalizeUniqueStringEntriesLower,
  normalizeUniqueTrimmedStringList,
  sortUniqueStrings,
  uniqueStrings,
} from "./string-normalization.js";

describe("normalization-core/string-normalization", () => {
  it.each([
    { label: "empty", value: "", expected: false },
    { label: "printable Unicode", value: "fix/a&b λ", expected: false },
    { label: "C1", value: String.fromCharCode(0x80, 0x9f), expected: false },
    { label: "NUL", value: `branch${String.fromCharCode(0)}name`, expected: true },
    { label: "unit separator", value: `branch${String.fromCharCode(0x1f)}`, expected: true },
    { label: "DEL", value: `branch${String.fromCharCode(0x7f)}name`, expected: true },
    { label: "line feed", value: "main\n", expected: true },
  ])("detects only ASCII controls: $label", ({ value, expected }) => {
    expect(containsAsciiControlCharacter(value)).toBe(expected);
  });

  it.each([
    { value: undefined, expected: [] },
    { value: "value", expected: [] },
    { value: { 0: "value" }, expected: [] },
    {
      value: ["", "  ", 1, "first", null, "first", Object("boxed"), "last\n"],
      expected: ["", "  ", "first", "first", "last\n"],
    },
  ])("filters runtime strings from $value", ({ value, expected }) => {
    expect(filterStringEntries(value)).toEqual(expected);
  });

  it("normalizes mixed allow-list entries", () => {
    expect(normalizeStringEntries([" a ", 42, "", "  ", "z"])).toEqual(["a", "42", "z"]);
    expect(normalizeStringEntries([" ok ", null, { toString: () => " obj " }])).toEqual([
      "ok",
      "null",
      "obj",
    ]);
    expect(normalizeStringEntries(undefined)).toStrictEqual([]);
  });

  it("normalizes mixed allow-list entries to lowercase", () => {
    expect(normalizeStringEntriesLower([" A ", "MiXeD", 7])).toEqual(["a", "mixed", "7"]);
  });

  it.each([
    { label: "empty", values: [], expected: [] },
    { label: "duplicates", values: ["b", "a", "b"], expected: ["a", "b"] },
    {
      label: "case and numeric text",
      values: ["a", "Z", "10", "2", "A", ""],
      expected: ["", "10", "2", "A", "Z", "a"],
    },
    {
      label: "UTF-16 without normalization",
      values: ["\ue000", "\ud83d\ude00", "\ud800", "\udc00", "é", "e\u0301", "é"],
      expected: ["e\u0301", "é", "\ud800", "\ud83d\ude00", "\udc00", "\ue000"],
    },
  ])("sorts fresh unique strings from iterables: $label", ({ values, expected }) => {
    const input = Object.freeze(values);
    const result = sortUniqueStrings(input);
    expect(result).toEqual(expected);
    expect(result).not.toBe(input);
    expect(sortUniqueStrings(new Set(input))).toEqual(expected);
    expect(sortUniqueStrings(input.values())).toEqual(expected);
  });

  it("deduplicates string values while preserving first-seen order", () => {
    expect(uniqueStrings(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("normalizes unique string entries", () => {
    expect(normalizeUniqueStringEntries([" b ", "a", "b", "", 4, "a"])).toEqual(["b", "a", "4"]);
  });

  it("normalizes unique lowercase string entries", () => {
    expect(normalizeUniqueStringEntriesLower([" A ", "a", "MiXeD", "", 7])).toEqual([
      "a",
      "mixed",
      "7",
    ]);
  });

  it("normalizes sorted unique string entries", () => {
    expect(normalizeSortedUniqueStringEntries([" b ", "a", "b", "", 4])).toEqual(["4", "a", "b"]);
  });

  it("normalizes unique trimmed string lists", () => {
    expect(normalizeUniqueTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual(["b", "a"]);
    expect(normalizeUniqueTrimmedStringList("b")).toEqual([]);
  });

  it("normalizes array-backed trimmed string lists", () => {
    const values = [" first ", "", 42, " second ", null];
    expect(normalizeTrimmedStringList(values)).toEqual(["first", "second"]);
    expect(normalizeTrimmedStringList("first")).toEqual([]);
    expect(normalizeOptionalTrimmedStringList(values)).toEqual(["first", "second"]);
    expect(normalizeOptionalTrimmedStringList(["", 42])).toBeUndefined();
  });

  it.each([
    { value: " first, second, , first ", expected: ["first", "second", "first"] },
    { value: [" first ", 42, "", "  ", 7], expected: ["first", "42", "7"] },
    { value: null, expected: [] },
    { value: { value: "first" }, expected: [] },
  ])("normalizes CSV or loose string-list input", ({ value, expected }) => {
    expect(normalizeCsvOrLooseStringList(value)).toEqual(expected);
  });

  it("normalizes sorted unique trimmed string lists", () => {
    expect(normalizeSortedUniqueTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual(["a", "b"]);
    expect(normalizeSortedUniqueTrimmedStringList(["z", 1, " a "] as unknown[])).toEqual([
      "a",
      "z",
    ]);
  });

  it("normalizes unique single-or-list string values", () => {
    expect(normalizeUniqueSingleOrTrimmedStringList([" b ", "a", "b", "", "a"])).toEqual([
      "b",
      "a",
    ]);
    expect(normalizeUniqueSingleOrTrimmedStringList(" b ")).toEqual(["b"]);
  });

  it("normalizes slug-like labels while preserving supported symbols", () => {
    expect(normalizeHyphenSlug("  Team Room  ")).toBe("team-room");
    expect(normalizeHyphenSlug(" #My_Channel + Alerts ")).toBe("#my_channel-+-alerts");
    expect(normalizeHyphenSlug("..foo---bar..")).toBe("foo-bar");
    expect(normalizeHyphenSlug(undefined)).toBe("");
    expect(normalizeHyphenSlug(null)).toBe("");
  });

  it("collapses repeated separators and trims leading/trailing punctuation", () => {
    expect(normalizeHyphenSlug("  ...Hello   /  World---  ")).toBe("hello-world");
    expect(normalizeHyphenSlug(" ###Team@@@Room### ")).toBe("###team@@@room###");
  });

  it("normalizes @/# prefixed slugs used by channel allowlists", () => {
    expect(normalizeAtHashSlug(" #My_Channel + Alerts ")).toBe("my-channel-alerts");
    expect(normalizeAtHashSlug("@@Room___Name")).toBe("room-name");
    expect(normalizeAtHashSlug(undefined)).toBe("");
    expect(normalizeAtHashSlug(null)).toBe("");
  });

  it("strips repeated prefixes and collapses separator-only results", () => {
    expect(normalizeAtHashSlug("###__Room  Name__")).toBe("room-name");
    expect(normalizeAtHashSlug("@@@___")).toBe("");
  });

  it.each([
    ["技术讨论组", "技术讨论组"],
    ["  AI 助手群  ", "ai-助手群"],
    ["友達グループ", "友達グループ"],
    ["개발자 모임", "개발자-모임"],
    ["Team 技术讨论", "team-技术讨论"],
    ["#OpenClaw中文群", "#openclaw中文群"],
    ["Команда разработки", "команда-разработки"],
    ["فريق التطوير", "فريق-التطوير"],
  ])("preserves Unicode letters in normalizeHyphenSlug: %s", (input, expected) => {
    expect(normalizeHyphenSlug(input)).toBe(expected);
  });

  it.each([
    ["Cafe\u0301 Team", "café-team"],
    ["हिन्दी चर्चा", "हिन्दी-चर्चा"],
    ["ห้อง แช็ต", "ห้อง-แช็ต"],
  ])("preserves combining marks in normalizeHyphenSlug: %s", (input, expected) => {
    expect(normalizeHyphenSlug(input)).toBe(expected);
  });

  it.each([
    ["#技术频道", "技术频道"],
    ["@中文群组", "中文群组"],
    ["#日本語チャンネル", "日本語チャンネル"],
    ["#한국어채널", "한국어채널"],
    ["#Команда разработки", "команда-разработки"],
    ["@فريق التطوير", "فريق-التطوير"],
    ["#OpenClaw中文群", "openclaw中文群"],
  ])("preserves Unicode letters in normalizeAtHashSlug: %s", (input, expected) => {
    expect(normalizeAtHashSlug(input)).toBe(expected);
  });

  it.each([
    ["#Cafe\u0301_Team", "café-team"],
    ["@हिन्दी चर्चा", "हिन्दी-चर्चा"],
    ["#ห้อง แช็ต", "ห้อง-แช็ต"],
  ])("preserves combining marks in normalizeAtHashSlug: %s", (input, expected) => {
    expect(normalizeAtHashSlug(input)).toBe(expected);
  });
});
