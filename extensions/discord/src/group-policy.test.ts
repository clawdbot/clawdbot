// Discord tests pin guild/channel ScopeTree policy precedence.
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import {
  resolveDiscordGroupRequireMention,
  resolveDiscordGroupToolPolicy,
} from "./group-policy.js";

function createCfg(discord: Record<string, unknown>): OpenClawConfig {
  return { channels: { discord } } as OpenClawConfig;
}

describe("discord group policy", () => {
  it("prefers a channel sender policy over the guild plain policy", () => {
    const cfg = createCfg({
      guilds: {
        guild: {
          tools: { deny: ["guild"] },
          channels: {
            channel: {
              toolsBySender: { "id:alice": { allow: ["channel-sender"] } },
            },
          },
        },
      },
    });

    expect(
      resolveDiscordGroupToolPolicy({
        cfg,
        groupSpace: "guild",
        groupId: "channel",
        senderId: "alice",
      }),
    ).toEqual({ allow: ["channel-sender"] });
    expect(
      resolveDiscordGroupToolPolicy({
        cfg,
        groupSpace: "guild",
        groupId: "channel",
        senderId: "bob",
      }),
    ).toEqual({ deny: ["guild"] });
  });

  it("does not use a channel wildcard as fallback", () => {
    expect(
      resolveDiscordGroupToolPolicy({
        cfg: createCfg({
          guilds: {
            guild: {
              tools: { allow: ["guild"] },
              channels: {
                "*": { tools: { deny: ["channel-wildcard"] } },
              },
            },
          },
        }),
        groupSpace: "guild",
        groupId: "missing",
      }),
    ).toEqual({ allow: ["guild"] });
  });

  it("uses the wildcard guild only when no guild matches", () => {
    const cfg = createCfg({
      guilds: {
        "*": {
          requireMention: false,
          tools: { allow: ["wildcard"] },
        },
        exact: {},
      },
    });

    expect(resolveDiscordGroupRequireMention({ cfg, groupSpace: "exact" })).toBe(true);
    expect(resolveDiscordGroupToolPolicy({ cfg, groupSpace: "exact" })).toBeUndefined();
    expect(resolveDiscordGroupRequireMention({ cfg, groupSpace: "missing" })).toBe(false);
    expect(resolveDiscordGroupToolPolicy({ cfg, groupSpace: "missing" })).toEqual({
      allow: ["wildcard"],
    });
  });

  it("matches normalized and hash-prefixed channel slugs", () => {
    const cfg = createCfg({
      guilds: {
        guild: {
          channels: {
            general: { tools: { allow: ["normalized"] } },
            "#ops-room": { tools: { allow: ["hash"] } },
          },
        },
      },
    });

    expect(
      resolveDiscordGroupToolPolicy({ cfg, groupSpace: "guild", groupChannel: "#General" }),
    ).toEqual({ allow: ["normalized"] });
    expect(
      resolveDiscordGroupToolPolicy({ cfg, groupSpace: "guild", groupChannel: "Ops Room" }),
    ).toEqual({ allow: ["hash"] });
  });

  it("keeps an account empty guild map from inheriting root guilds", () => {
    expect(
      resolveDiscordGroupRequireMention({
        cfg: createCfg({
          guilds: { guild: { requireMention: false } },
          accounts: { work: { guilds: {} } },
        }),
        accountId: "work",
        groupSpace: "guild",
      }),
    ).toBe(true);
  });

  it("keeps slash-bearing flat scope keys collision-free", () => {
    const cfg = createCfg({
      guilds: {
        "a/channel:b": { tools: { allow: ["slash-guild"] } },
        a: { channels: { b: { tools: { allow: ["nested-channel"] } } } },
      },
    });

    expect(resolveDiscordGroupToolPolicy({ cfg, groupSpace: "a/channel:b" })).toEqual({
      allow: ["slash-guild"],
    });
    expect(resolveDiscordGroupToolPolicy({ cfg, groupSpace: "a", groupId: "b" })).toEqual({
      allow: ["nested-channel"],
    });
  });
});
