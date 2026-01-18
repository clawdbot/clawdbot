import { describe, expect, it } from "vitest";

import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "./channel-config.js";

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
  it("prefers direct matches over parent and wildcard", () => {
    const entries = { a: { allow: true }, parent: { allow: false }, "*": { allow: false } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["a"],
      parentKeys: ["parent"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries.a);
    expect(match.matchSource).toBe("direct");
    expect(match.matchKey).toBe("a");
  });

  it("falls back to parent when direct misses", () => {
    const entries = { parent: { allow: false }, "*": { allow: true } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["missing"],
      parentKeys: ["parent"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries.parent);
    expect(match.matchSource).toBe("parent");
    expect(match.matchKey).toBe("parent");
  });

  it("falls back to wildcard when no direct or parent match", () => {
    const entries = { "*": { allow: true } };
    const match = resolveChannelEntryMatchWithFallback({
      entries,
      keys: ["missing"],
      parentKeys: ["still-missing"],
      wildcardKey: "*",
    });
    expect(match.entry).toBe(entries["*"]);
    expect(match.matchSource).toBe("wildcard");
    expect(match.matchKey).toBe("*");
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

describe("resolveNestedAllowlistDecision", () => {
  it("allows when outer allowlist is disabled", () => {
    expect(
      resolveNestedAllowlistDecision({
        outerConfigured: false,
        outerMatched: false,
        innerConfigured: false,
        innerMatched: false,
      }),
    ).toBe(true);
  });

  it("blocks when outer allowlist is configured but missing match", () => {
    expect(
      resolveNestedAllowlistDecision({
        outerConfigured: true,
        outerMatched: false,
        innerConfigured: false,
        innerMatched: false,
      }),
    ).toBe(false);
  });

  it("requires inner match when inner allowlist is configured", () => {
    expect(
      resolveNestedAllowlistDecision({
        outerConfigured: true,
        outerMatched: true,
        innerConfigured: true,
        innerMatched: false,
      }),
    ).toBe(false);
    expect(
      resolveNestedAllowlistDecision({
        outerConfigured: true,
        outerMatched: true,
        innerConfigured: true,
        innerMatched: true,
      }),
    ).toBe(true);
  });
});
