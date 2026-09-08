// Discord tests cover access plugin behavior.
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createDiscordLivePolicyReader } from "../monitor/live-policy.js";
import { authorizeDiscordVoiceIngress } from "./access.js";

const baseCfg = { commands: { useAccessGroups: true } } as OpenClawConfig;

describe("authorizeDiscordVoiceIngress", () => {
  it("applies published guild policy over retained voice startup settings", async () => {
    let cfg: OpenClawConfig = {
      channels: { discord: { groupPolicy: "allowlist", guilds: {} } },
    };
    const readPolicy = createDiscordLivePolicyReader({
      cfg,
      accountId: "default",
      token: "synthetic-token",
      readConfig: () => cfg,
    });
    const params = {
      readPolicy,
      cfg,
      discordConfig: {},
      accountId: "default",
      guildId: "111",
      channelId: "222",
      channelSlug: "",
      memberRoleIds: [],
      sender: { id: "333" },
    };
    expect((await authorizeDiscordVoiceIngress(params)).ok).toBe(false);
    cfg = {
      channels: {
        discord: {
          groupPolicy: "allowlist",
          guilds: { "111": { channels: { "222": { users: ["333"] } } } },
        },
      },
    };
    expect((await authorizeDiscordVoiceIngress(params)).ok).toBe(true);
    cfg = { channels: { discord: { groupPolicy: "disabled", guilds: {} } } };
    expect((await authorizeDiscordVoiceIngress(params)).ok).toBe(false);
  });

  it("blocks speakers outside the configured channel user allowlist", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          g1: {
            channels: {
              c1: {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-guest",
        name: "guest",
      },
    });

    expect(access).toEqual({
      ok: false,
      message: "You are not authorized to use this command.",
    });
  });

  it("allows speakers that match the configured channel user allowlist", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          g1: {
            channels: {
              c1: {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-owner",
        name: "owner",
      },
    });

    expect(access).toEqual({
      ok: true,
      channelConfig: {
        allowed: true,
        requireMention: undefined,
        ignoreOtherMentions: undefined,
        skills: undefined,
        enabled: undefined,
        users: ["discord:u-owner"],
        roles: undefined,
        systemPrompt: undefined,
        includeThreadStarter: undefined,
        autoThread: undefined,
        autoThreadName: undefined,
        autoArchiveDuration: undefined,
        matchKey: "c1",
        matchSource: "direct",
      },
    });
  });

  it("allows slug-keyed guild configs when manager context only has guild name", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          "guild-one": {
            channels: {
              "*": {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      guildName: "Guild One",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-owner",
        name: "owner",
      },
    });

    expect(access).toEqual({
      ok: true,
      channelConfig: {
        allowed: true,
        requireMention: undefined,
        ignoreOtherMentions: undefined,
        skills: undefined,
        enabled: undefined,
        users: ["discord:u-owner"],
        roles: undefined,
        systemPrompt: undefined,
        includeThreadStarter: undefined,
        autoThread: undefined,
        autoThreadName: undefined,
        autoArchiveDuration: undefined,
        matchKey: "*",
        matchSource: "wildcard",
      },
    });
  });

  it("allows wildcard guild configs when only the guild id is available", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          "*": {
            channels: {
              "*": {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-owner",
        name: "owner",
      },
    });

    expect(access).toEqual({
      ok: true,
      channelConfig: {
        allowed: true,
        requireMention: undefined,
        ignoreOtherMentions: undefined,
        skills: undefined,
        enabled: undefined,
        users: ["discord:u-owner"],
        roles: undefined,
        systemPrompt: undefined,
        includeThreadStarter: undefined,
        autoThread: undefined,
        autoThreadName: undefined,
        autoArchiveDuration: undefined,
        matchKey: "*",
        matchSource: "wildcard",
      },
    });
  });

  it("blocks commands when channel id is unavailable for an allowlisted channel", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        guilds: {
          g1: {
            users: ["discord:u-owner"],
            channels: {
              c1: {
                users: ["discord:u-owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-owner",
        name: "owner",
      },
    });

    expect(access).toEqual({
      ok: false,
      message: "This channel is not allowlisted for voice commands.",
    });
  });

  it("ignores dangerous name matching for voice ingress", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        dangerouslyAllowNameMatching: true,
        guilds: {
          g1: {
            channels: {
              c1: {
                users: ["owner"],
              },
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      sender: {
        id: "u-guest",
        name: "owner",
      },
    });

    expect(access).toEqual({
      ok: false,
      message: "You are not authorized to use this command.",
    });
  });

  it("uses resolved account command allowFrom over merged Discord config", async () => {
    const access = await authorizeDiscordVoiceIngress({
      cfg: baseCfg,
      discordConfig: {
        allowFrom: ["discord:u-root"],
        guilds: {
          g1: {
            channels: {
              c1: {},
            },
          },
        },
      } as DiscordAccountConfig,
      groupPolicy: "allowlist",
      guildId: "g1",
      channelId: "c1",
      channelSlug: "",
      memberRoleIds: [],
      admissionAllowFrom: ["discord:u-account"],
      sender: {
        id: "u-account",
        name: "owner",
      },
    });

    expect(access).toEqual({
      ok: true,
      channelConfig: {
        allowed: true,
        requireMention: undefined,
        ignoreOtherMentions: undefined,
        skills: undefined,
        enabled: undefined,
        users: undefined,
        roles: undefined,
        systemPrompt: undefined,
        includeThreadStarter: undefined,
        autoThread: undefined,
        autoThreadName: undefined,
        autoArchiveDuration: undefined,
        matchKey: "c1",
        matchSource: "direct",
      },
    });
  });
});
