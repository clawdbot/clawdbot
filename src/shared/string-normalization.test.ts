import { describe, expect, it } from "vitest";
import {
  normalizeAtHashSlug,
  normalizeHyphenSlug,
  normalizeStringEntries,
  normalizeStringEntriesLower,
} from "./string-normalization.js";

describe("shared/string-normalization", () => {
  it("normalizes mixed allow-list entries", () => {
    expect(normalizeStringEntries([" a ", 42, "", "  ", "z"])).toEqual(["a", "42", "z"]);
    expect(normalizeStringEntries([" ok ", null, { toString: () => " obj " }])).toEqual([
      "ok",
      "null",
      "obj",
    ]);
    expect(normalizeStringEntries(undefined)).toEqual([]);
  });

  it("normalizes mixed allow-list entries to lowercase", () => {
    expect(normalizeStringEntriesLower([" A ", "MiXeD", 7])).toEqual(["a", "mixed", "7"]);
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
