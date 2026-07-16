import { describe, expect, it } from "vitest";
import {
  resolveExactLineGroupConfigKey,
  resolveLineGroupConfigEntry,
  resolveLineGroupLookupIds,
  resolveLineGroupsConfig,
} from "./group-keys.js";
import { resolveLineGroupRequireMention } from "./group-policy.js";

describe("resolveLineGroupLookupIds", () => {
  it("expands raw ids to both prefixed candidates", () => {
    expect(resolveLineGroupLookupIds("abc123")).toEqual(["abc123", "group:abc123", "room:abc123"]);
  });

  it("preserves prefixed ids while also checking the raw id", () => {
    expect(resolveLineGroupLookupIds("room:abc123")).toEqual(["abc123", "room:abc123"]);
    expect(resolveLineGroupLookupIds("group:abc123")).toEqual(["abc123", "group:abc123"]);
  });
});

describe("resolveLineGroupConfigEntry", () => {
  it("matches raw, prefixed, and wildcard group config entries", () => {
    const groups = {
      "group:g1": { requireMention: false },
      "room:r1": { systemPrompt: "Room prompt" },
      "*": { requireMention: true },
    };

    expect(resolveLineGroupConfigEntry(groups, { groupId: "g1" })).toEqual({
      requireMention: false,
    });
    expect(resolveLineGroupConfigEntry(groups, { roomId: "r1" })).toEqual({
      systemPrompt: "Room prompt",
    });
    expect(resolveLineGroupConfigEntry(groups, { groupId: "missing" })).toEqual({
      requireMention: true,
    });
  });
});

describe("account-scoped LINE groups", () => {
  it("resolves the effective account-scoped groups map", () => {
    const cfg = {
      channels: {
        line: {
          groups: {
            "*": { requireMention: true },
          },
          accounts: {
            work: {
              groups: {
                "group:g1": { requireMention: false },
              },
            },
          },
        },
      },
    } as any;

    expect(resolveLineGroupsConfig(cfg, "work")).toEqual({
      "group:g1": { requireMention: false },
    });
    expect(resolveExactLineGroupConfigKey({ cfg, accountId: "work", groupId: "g1" })).toBe(
      "group:g1",
    );
    expect(resolveExactLineGroupConfigKey({ cfg, accountId: "default", groupId: "g1" })).toBe(
      undefined,
    );
  });
});

describe("line group policy", () => {
  it("matches raw and prefixed LINE group keys for requireMention", () => {
    const cfg = {
      channels: {
        line: {
          groups: {
            "room:r123": {
              requireMention: false,
            },
            "group:g123": {
              requireMention: false,
            },
            "*": {
              requireMention: true,
            },
          },
        },
      },
    } as any;

    expect(resolveLineGroupRequireMention({ cfg, groupId: "r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "room:r123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "group:g123" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "other" })).toBe(true);
  });

  it("uses account-scoped prefixed LINE group config for requireMention", () => {
    const cfg = {
      channels: {
        line: {
          groups: {
            "*": {
              requireMention: true,
            },
          },
          accounts: {
            work: {
              groups: {
                "group:g123": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    } as any;

    expect(resolveLineGroupRequireMention({ cfg, groupId: "g123", accountId: "work" })).toBe(false);
  });
});
