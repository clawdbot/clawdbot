import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import {
  collectDiscordMissingEnvTokenWarnings,
  collectDiscordNumericIdWarnings,
  discordDoctor,
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./doctor.js";

describe("discord doctor", () => {
  it("normalizes legacy discord streaming aliases for runtime config", () => {
    const normalize = discordDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          discord: {
            streamMode: "block",
            chunkMode: "newline",
            blockStreaming: true,
            draftChunk: {
              minChars: 120,
            },
            accounts: {
              work: {
                streaming: false,
                blockStreamingCoalesce: {
                  idleMs: 250,
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.config.channels?.discord).toEqual({
      streaming: {
        mode: "block",
        chunkMode: "newline",
        block: {
          enabled: true,
        },
        preview: {
          chunk: {
            minChars: 120,
          },
        },
      },
      accounts: {
        work: {
          streaming: {
            mode: "off",
            block: {
              coalesce: {
                idleMs: 250,
              },
            },
          },
        },
      },
    });
    expect(result.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming.mode (block).",
      "Moved channels.discord.chunkMode → channels.discord.streaming.chunkMode.",
      "Moved channels.discord.blockStreaming → channels.discord.streaming.block.enabled.",
      "Moved channels.discord.draftChunk → channels.discord.streaming.preview.chunk.",
      "Moved channels.discord.accounts.work.streaming (boolean) → channels.discord.accounts.work.streaming.mode (off).",
      "Moved channels.discord.accounts.work.blockStreamingCoalesce → channels.discord.accounts.work.streaming.block.coalesce.",
    ]);
  });

  it("moves account voice.tts.edge into providers.microsoft", () => {
    const normalize = discordDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          discord: {
            accounts: {
              main: {
                voice: {
                  tts: {
                    edge: {
                      voice: "en-US-JennyNeural",
                    },
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toContain(
      "Moved channels.discord.accounts.main.voice.tts.edge → channels.discord.accounts.main.voice.tts.providers.microsoft.",
    );
    const mainTts = result.config.channels?.discord?.accounts?.main?.voice?.tts as
      | Record<string, unknown>
      | undefined;
    expect(mainTts?.providers).toEqual({
      microsoft: {
        voice: "en-US-JennyNeural",
      },
    });
    expect(mainTts?.edge).toBeUndefined();
  });

  it("moves legacy guild channel allow toggles into enabled", () => {
    const normalize = discordDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          discord: {
            guilds: {
              "100": {
                channels: {
                  general: {
                    allow: false,
                  },
                },
              },
            },
            accounts: {
              work: {
                guilds: {
                  "200": {
                    channels: {
                      help: {
                        allow: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Moved channels.discord.guilds.100.channels.general.allow → channels.discord.guilds.100.channels.general.enabled.",
      "Moved channels.discord.accounts.work.guilds.200.channels.help.allow → channels.discord.accounts.work.guilds.200.channels.help.enabled.",
    ]);
    expect(result.config.channels?.discord?.guilds?.["100"]?.channels?.general).toEqual({
      enabled: false,
    });
    expect(
      result.config.channels?.discord?.accounts?.work?.guilds?.["200"]?.channels?.help,
    ).toEqual({
      enabled: true,
    });
  });

  it("moves legacy guild channel agentId into a top-level route binding", () => {
    const normalize = discordDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          discord: {
            guilds: {
              "100": {
                channels: {
                  "200": {
                    requireMention: false,
                    agentId: "video",
                  },
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result.changes).toEqual([
      "Moved channels.discord.guilds.100.channels.200.agentId → top-level bindings[] route for Discord channel 200.",
    ]);
    expect(result.config.channels?.discord?.guilds?.["100"]?.channels?.["200"]).toEqual({
      requireMention: false,
    });
    expect(result.config.bindings).toEqual([
      {
        agentId: "video",
        match: {
          channel: "discord",
          guildId: "100",
          peer: { kind: "channel", id: "200" },
        },
      },
    ]);
  });

  it("moves account-scoped guild channel agentId into an account-scoped route binding", () => {
    const normalize = discordDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const result = normalize({
      cfg: {
        channels: {
          discord: {
            accounts: {
              work: {
                guilds: {
                  "100": {
                    channels: {
                      "200": {
                        agentId: "support",
                      },
                    },
                  },
                },
              },
            },
          },
        },
        bindings: [{ agentId: "main", match: { channel: "discord" } }],
      } as never,
    });

    expect(result.changes).toEqual([
      "Moved channels.discord.accounts.work.guilds.100.channels.200.agentId → top-level bindings[] route for Discord channel 200.",
    ]);
    expect(
      result.config.channels?.discord?.accounts?.work?.guilds?.["100"]?.channels?.["200"],
    ).toEqual({});
    expect(result.config.bindings).toEqual([
      { agentId: "main", match: { channel: "discord" } },
      {
        agentId: "support",
        match: {
          channel: "discord",
          accountId: "work",
          guildId: "100",
          peer: { kind: "channel", id: "200" },
        },
      },
    ]);
  });

  it("removes legacy guild channel agentId when a matching route binding already exists", () => {
    const normalize = discordDoctor.normalizeCompatibilityConfig;
    expect(normalize).toBeDefined();
    if (!normalize) {
      return;
    }

    const existingBinding = {
      agentId: "video",
      match: {
        channel: "discord",
        guildId: "100",
        peer: { kind: "channel", id: "200" },
      },
    };
    const result = normalize({
      cfg: {
        channels: {
          discord: {
            guilds: {
              "100": {
                channels: {
                  "200": {
                    agentId: "video",
                  },
                },
              },
            },
          },
        },
        bindings: [existingBinding],
      } as never,
    });

    expect(result.changes).toEqual([
      "Removed channels.discord.guilds.100.channels.200.agentId; a matching top-level bindings[] route already exists for Discord channel 200.",
    ]);
    expect(result.config.channels?.discord?.guilds?.["100"]?.channels?.["200"]).toEqual({});
    expect(result.config.bindings).toEqual([existingBinding]);
  });

  it("finds numeric id entries across discord scopes", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: [123],
          dm: { allowFrom: ["ok"], groupChannels: [456] },
          execApprovals: { approvers: [789] },
          guilds: {
            main: {
              users: [111],
              roles: [222],
              channels: { general: { users: [333], roles: [444] } },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const hits = scanDiscordNumericIdEntries(cfg);
    expect(hits.map((hit) => hit.path)).toEqual([
      "channels.discord.allowFrom[0]",
      "channels.discord.dm.groupChannels[0]",
      "channels.discord.execApprovals.approvers[0]",
      "channels.discord.guilds.main.users[0]",
      "channels.discord.guilds.main.roles[0]",
      "channels.discord.guilds.main.channels.general.users[0]",
      "channels.discord.guilds.main.channels.general.roles[0]",
    ]);
  });

  it("repairs safe numeric ids into strings and warns for unsafe lists", () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: [123],
          dm: { allowFrom: [99] },
          guilds: { main: { users: [111], roles: [222] } },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairDiscordNumericIds(cfg, "openclaw doctor --fix");
    expect(result.config.channels?.discord?.allowFrom).toEqual(["123"]);
    expect(result.config.channels?.discord?.dm?.allowFrom).toEqual(["99"]);
    expect(result.config.channels?.discord?.guilds?.main?.users).toEqual(["111"]);
    expect(result.config.channels?.discord?.guilds?.main?.roles).toEqual(["222"]);
    expect(result.changes).not.toHaveLength(0);
    expect(result.warnings).toEqual([]);
  });

  it("formats repair guidance for unsafe numeric ids", () => {
    const warnings = collectDiscordNumericIdWarnings({
      hits: [{ path: "channels.discord.allowFrom[0]", entry: 106232522769186816, safe: false }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings[0]).toContain("cannot be auto-repaired");
    expect(warnings[1]).toContain("openclaw doctor --fix");
  });

  it("warns when default env fallback token is missing after migration", async () => {
    const cfg = {
      channels: {
        discord: {
          allowFrom: ["123"],
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectDiscordMissingEnvTokenWarnings({ cfg, env: {} })).toEqual([
      expect.stringContaining("DISCORD_BOT_TOKEN is absent"),
    ]);
    expect(
      collectDiscordMissingEnvTokenWarnings({ cfg, env: { DISCORD_BOT_TOKEN: "Bot tok" } }),
    ).toEqual([]);
    expect(
      await discordDoctor.collectPreviewWarnings?.({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
        env: {},
      }),
    ).toEqual([expect.stringContaining("DISCORD_BOT_TOKEN is absent")]);
  });

  it("does not warn about DISCORD_BOT_TOKEN when a non-default account is selected", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            work: {
              token: "Bot work-token",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectDiscordMissingEnvTokenWarnings({ cfg, env: {} })).toEqual([]);
  });
});
