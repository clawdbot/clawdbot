import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { typedCases } from "../test-utils/typed-cases.js";
import {
  type ChannelMatchSource,
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
  applyChannelMatchMeta,
  resolveChannelMatchConfig,
} from "./channel-config.js";
import { validateSenderIdentity } from "./sender-identity.js";

describe("buildChannelKeyCandidates", () => {
  it("dedupes and trims keys", () => {
    expect(buildChannelKeyCandidates(" a ", "a", "", "b", "b")).toEqual(["a", "b"]);
  });
});

describe("normalizeChannelSlug", () => {
  it("normalizes names into slugs", () => {
    expect(normalizeChannelSlug("My Team")).toBe("my-team");
    expect(normalizeChannelSlug("#General Chat")).toBe("general-chat");
    expect(normalizeChannelSlug(" Dev__Chat ")).toBe("dev-chat");
  });
});

describe("resolveChannelEntryMatch", () => {
  it("returns matched entry and wildcard metadata", () => {
    const entries = { a: { allow: true }, "*": { allow: false } };
    const match = resolveChannelEntryMatch({
      entries,
      keys: ["missing", "a"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries.a);
    expect(match.key).toBe("a");
    expect(match.wildcardEntry).toBe(entries["*"]);
    expect(match.wildcardKey).toBe("*");
  });
});

describe("resolveChannelEntryMatchWithFallback", () => {
  const fallbackCases = typedCases<{
    name: string;
    entries: Record<string, { allow: boolean }>;
    args: {
      keys: string[];
      parentKeys?: string[];
      wildcardKey?: string;
    };
    expectedEntryKey: string;
    expectedSource: ChannelMatchSource;
    expectedMatchKey: string;
  }>([
    {
      name: "prefers direct matches over parent and wildcard",
      entries: { a: { allow: true }, parent: { allow: false }, "*": { allow: false } },
      args: { keys: ["a"], parentKeys: ["parent"], wildcardKey: "*" },
      expectedEntryKey: "a",
      expectedSource: "direct",
      expectedMatchKey: "a",
    },
    {
      name: "falls back to parent when direct misses",
      entries: { parent: { allow: false }, "*": { allow: true } },
      args: { keys: ["missing"], parentKeys: ["parent"], wildcardKey: "*" },
      expectedEntryKey: "parent",
      expectedSource: "parent",
      expectedMatchKey: "parent",
    },
    {
      name: "falls back to wildcard when no direct or parent match",
      entries: { "*": { allow: true } },
      args: { keys: ["missing"], parentKeys: ["still-missing"], wildcardKey: "*" },
      expectedEntryKey: "*",
      expectedSource: "wildcard",
      expectedMatchKey: "*",
    },
  ]);

  it.each(fallbackCases)("$name", (testCase) => {
    const match = resolveChannelEntryMatchWithFallback({
      entries: testCase.entries,
      ...testCase.args,
    });
    expect(match.entry).toBe(testCase.entries[testCase.expectedEntryKey]);
    expect(match.matchSource).toBe(testCase.expectedSource);
    expect(match.matchKey).toBe(testCase.expectedMatchKey);
  });

  it("matches normalized keys when normalizeKey is provided", () => {
    const entries = { "My Team": { allow: true } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["my-team"],
      normalizeKey: normalizeChannelSlug,
    });
    expect(match.entry).toBe(entries["My Team"]);
    expect(match.matchSource).toBe("direct");
    expect(match.matchKey).toBe("My Team");
  });
});

describe("applyChannelMatchMeta", () => {
  it("copies match metadata onto resolved configs", () => {
    const base: { matchKey?: string; matchSource?: ChannelMatchSource } = {};
    const resolved = applyChannelMatchMeta(base, { matchKey: "general", matchSource: "direct" });
    expect(resolved.matchKey).toBe("general");
    expect(resolved.matchSource).toBe("direct");
  });
});

describe("resolveChannelMatchConfig", () => {
  it("returns null when no entry is matched", () => {
    const resolved = resolveChannelMatchConfig({ matchKey: "x" }, () => {
      const out: { matchKey?: string; matchSource?: ChannelMatchSource } = {};
      return out;
    });
    expect(resolved).toBeNull();
  });

  it("resolves entry and applies match metadata", () => {
    const resolved = resolveChannelMatchConfig(
      { entry: { allow: true }, matchKey: "*", matchSource: "wildcard" },
      () => {
        const out: { matchKey?: string; matchSource?: ChannelMatchSource } = {};
        return out;
      },
    );
    expect(resolved?.matchKey).toBe("*");
    expect(resolved?.matchSource).toBe("wildcard");
  });
});

describe("validateSenderIdentity", () => {
  it("allows direct messages without sender fields", () => {
    const ctx: MsgContext = { ChatType: "direct" };
    expect(validateSenderIdentity(ctx)).toStrictEqual([]);
  });

  it("requires some sender identity for non-direct chats", () => {
    const ctx: MsgContext = { ChatType: "group" };
    expect(validateSenderIdentity(ctx)).toContain(
      "missing sender identity (SenderId/SenderName/SenderUsername/SenderE164)",
    );
  });

  it("validates SenderE164 and SenderUsername shape", () => {
    const ctx: MsgContext = {
      ChatType: "group",
      SenderE164: "123",
      SenderUsername: "@ada lovelace",
    };
    expect(validateSenderIdentity(ctx)).toEqual([
      "invalid SenderE164: 123",
      'SenderUsername should not include "@": @ada lovelace',
      "SenderUsername should not include whitespace: @ada lovelace",
    ]);
  });
});

describe("resolveNestedAllowlistDecision", () => {
  const cases = [
    {
      name: "allows when outer allowlist is disabled",
      value: {
        outerConfigured: false,
        outerMatched: false,
        innerConfigured: false,
        innerMatched: false,
      },
      expected: true,
    },
    {
      name: "blocks when outer allowlist is configured but missing match",
      value: {
        outerConfigured: true,
        outerMatched: false,
        innerConfigured: false,
        innerMatched: false,
      },
      expected: false,
    },
    {
      name: "requires inner match when inner allowlist is configured",
      value: {
        outerConfigured: true,
        outerMatched: true,
        innerConfigured: true,
        innerMatched: false,
      },
      expected: false,
    },
    {
      name: "allows when both outer and inner allowlists match",
      value: {
        outerConfigured: true,
        outerMatched: true,
        innerConfigured: true,
        innerMatched: true,
      },
      expected: true,
    },
  ] as const;

  it.each(cases)("$name", ({ value, expected }) => {
    expect(resolveNestedAllowlistDecision(value)).toBe(expected);
  });
});
