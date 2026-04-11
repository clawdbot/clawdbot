import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  collectDiscordNumericIdWarnings,
  discordDoctor,
  maybeRepairDiscordNumericIds,
  scanDiscordNumericIdEntries,
} from "./doctor.js";

describe("discord doctor", () => {
  it("normalizes legacy discord streaming aliases into the nested streaming shape", () => {
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

    expect(result.config.channels?.discord?.streaming).toEqual({
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
    });
    expect(result.config.channels?.discord?.accounts?.work?.streaming).toEqual({
      mode: "off",
      block: {
        coalesce: {
          idleMs: 250,
        },
      },
    });
    expect(result.changes).toEqual(
      expect.arrayContaining([
        "Moved channels.discord.streamMode → channels.discord.streaming.mode (block).",
        "Moved channels.discord.chunkMode → channels.discord.streaming.chunkMode.",
        "Moved channels.discord.blockStreaming → channels.discord.streaming.block.enabled.",
        "Moved channels.discord.draftChunk → channels.discord.streaming.preview.chunk.",
        "Moved channels.discord.accounts.work.streaming (boolean) → channels.discord.accounts.work.streaming.mode (off).",
        "Moved channels.discord.accounts.work.blockStreamingCoalesce → channels.discord.accounts.work.streaming.block.coalesce.",
      ]),
    );
  });

  it("does not duplicate streaming.mode change messages when streamMode wins over boolean streaming", () => {
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
            streaming: false,
          },
        },
      } as never,
    });

    expect(result.config.channels?.discord?.streaming).toEqual({
      mode: "block",
    });
    expect(
      result.changes.filter((change) => change.includes("channels.discord.streaming.mode")),
    ).toEqual(["Moved channels.discord.streamMode → channels.discord.streaming.mode (block)."]);
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
});
