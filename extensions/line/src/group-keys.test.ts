import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Line tests cover group keys plugin behavior.
import { describe, expect, it } from "vitest";
import {
  resolveExactLineGroupConfigKey,
  resolveLineGroupConfigEntry,
  resolveLineGroupLookupIds,
  resolveLineGroupsConfig,
} from "./group-keys.js";
import { resolveLineGroupRequireMention } from "./group-policy.js";
import type { LineGroupConfig } from "./types.js";

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
      requireMention: true,
      systemPrompt: "Room prompt",
    });
    expect(resolveLineGroupConfigEntry(groups, { groupId: "missing" })).toEqual({
      requireMention: true,
    });
  });

  it("keeps the settings an operator only wrote on the wildcard", () => {
    // A room entry that says nothing about mentions must not silently turn the
    // wildcard's `requireMention: false` back into the mention-gated default.
    const groups = {
      "*": { requireMention: false, systemPrompt: "House rules" },
      C1: { skills: ["deploy"] },
    };

    expect(resolveLineGroupConfigEntry(groups, { groupId: "C1" })).toEqual({
      requireMention: false,
      systemPrompt: "House rules",
      skills: ["deploy"],
    });
  });

  it("resolves mentions the same way the channel reports them", () => {
    // The inbound gate reads this entry while `/status` and the turn's activation
    // directive read the scope tree. They answer the same question, so a room the
    // wildcard opened must not be gated by one and open to the other.
    const groups: Record<string, LineGroupConfig> = {
      "*": { requireMention: false },
      C1: { systemPrompt: "team bot" },
    };
    const cfg = { channels: { line: { groups } } } as unknown as OpenClawConfig;

    const entry = resolveLineGroupConfigEntry(groups, { groupId: "C1" });
    expect(entry?.requireMention !== false).toBe(
      resolveLineGroupRequireMention({ cfg, accountId: null, groupId: "C1" }),
    );
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
    } as OpenClawConfig;

    expect(resolveLineGroupsConfig(cfg, "work")).toEqual({
      "group:g1": { requireMention: false },
    });
    expect(
      resolveExactLineGroupConfigKey({
        groups: resolveLineGroupsConfig(cfg, "work"),
        groupId: "g1",
      }),
    ).toBe("group:g1");
    expect(
      resolveExactLineGroupConfigKey({
        groups: resolveLineGroupsConfig(cfg, "default"),
        groupId: "g1",
      }),
    ).toBe(undefined);
  });
});

describe("line group policy", () => {
  it("preserves candidate precedence and falls back to wildcard", () => {
    const cfg = {
      channels: {
        line: {
          groups: {
            same: {
              requireMention: false,
            },
            "group:same": {
              requireMention: true,
            },
            "room:same": {
              requireMention: true,
            },
            "group:typed": {
              requireMention: false,
            },
            "room:typed": {
              requireMention: true,
            },
            "*": {
              requireMention: false,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveLineGroupRequireMention({ cfg, groupId: "same" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "room:same" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "group:same" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "typed" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "group:typed" })).toBe(false);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "room:typed" })).toBe(true);
    expect(resolveLineGroupRequireMention({ cfg, groupId: "other" })).toBe(false);
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
    } as OpenClawConfig;

    expect(resolveLineGroupRequireMention({ cfg, groupId: "g123", accountId: "work" })).toBe(false);
  });
});
