import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { authorizeDiscordVoiceIngress } from "./access.js";

const baseCfg = { commands: { useAccessGroups: true } } as OpenClawConfig;

describe("authorizeDiscordVoiceIngress", () => {
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

    expect(access).toMatchObject({ ok: true });
    expect(access.ok && access.channelConfig?.users).toEqual(["discord:u-owner"]);
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

    expect(access).toMatchObject({ ok: true });
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

    expect(access).toMatchObject({ ok: true });
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

  it("uses resolved account owner allowFrom over merged Discord config", async () => {
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
      ownerAllowFrom: ["discord:u-account"],
      sender: {
        id: "u-account",
        name: "owner",
      },
    });

    expect(access).toMatchObject({ ok: true });
  });
});
