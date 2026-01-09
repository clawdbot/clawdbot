import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "clawdbot-config-" });
}

/**
 * Helper to test env var overrides. Saves/restores env vars and resets modules.
 */
async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.resetModules();
  }
}

describe("config identity defaults", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("does not derive mentionPatterns when identity is set", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            agents: {
              list: [
                {
                  id: "main",
                  identity: {
                    name: "Samantha",
                    theme: "helpful sloth",
                    emoji: "🦥",
                  },
                },
              ],
            },
            messages: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.messages?.groupChat?.mentionPatterns).toBeUndefined();
    });
  });

  it("defaults ackReactionScope without setting ackReaction", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            agents: {
              list: [
                {
                  id: "main",
                  identity: {
                    name: "Samantha",
                    theme: "helpful sloth",
                    emoji: "🦥",
                  },
                },
              ],
            },
            messages: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.ackReaction).toBeUndefined();
      expect(cfg.messages?.ackReactionScope).toBe("group-mentions");
    });
  });

  it("keeps ackReaction unset when identity is missing", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            messages: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.ackReaction).toBeUndefined();
      expect(cfg.messages?.ackReactionScope).toBe("group-mentions");
    });
  });

  it("does not override explicit values", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            agents: {
              list: [
                {
                  id: "main",
                  identity: {
                    name: "Samantha Sloth",
                    theme: "space lobster",
                    emoji: "🦞",
                  },
                  groupChat: { mentionPatterns: ["@clawd"] },
                },
              ],
            },
            messages: {
              responsePrefix: "✅",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBe("✅");
      expect(cfg.agents?.list?.[0]?.groupChat?.mentionPatterns).toEqual([
        "@clawd",
      ]);
    });
  });

  it("supports provider textChunkLimit config", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            messages: {
              messagePrefix: "[clawdbot]",
              responsePrefix: "🦞",
              // legacy field should be ignored (moved to providers)
              textChunkLimit: 9999,
            },
            whatsapp: { allowFrom: ["+15555550123"], textChunkLimit: 4444 },
            telegram: { enabled: true, textChunkLimit: 3333 },
            discord: {
              enabled: true,
              textChunkLimit: 1999,
              maxLinesPerMessage: 17,
            },
            signal: { enabled: true, textChunkLimit: 2222 },
            imessage: { enabled: true, textChunkLimit: 1111 },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.whatsapp?.textChunkLimit).toBe(4444);
      expect(cfg.telegram?.textChunkLimit).toBe(3333);
      expect(cfg.discord?.textChunkLimit).toBe(1999);
      expect(cfg.discord?.maxLinesPerMessage).toBe(17);
      expect(cfg.signal?.textChunkLimit).toBe(2222);
      expect(cfg.imessage?.textChunkLimit).toBe(1111);

      const legacy = (cfg.messages as unknown as Record<string, unknown>)
        .textChunkLimit;
      expect(legacy).toBeUndefined();
    });
  });

  it("respects empty responsePrefix to disable identity defaults", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            agents: {
              list: [
                {
                  id: "main",
                  identity: {
                    name: "Samantha",
                    theme: "helpful sloth",
                    emoji: "🦥",
                  },
                },
              ],
            },
            messages: { responsePrefix: "" },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBe("");
    });
  });

  it("does not synthesize agent/session when absent", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            messages: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.messages?.groupChat?.mentionPatterns).toBeUndefined();
      expect(cfg.agents).toBeUndefined();
      expect(cfg.session).toBeUndefined();
    });
  });

  it("does not derive responsePrefix from identity emoji", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            agents: {
              list: [
                {
                  id: "main",
                  identity: {
                    name: "Clawd",
                    theme: "space lobster",
                    emoji: "🦞",
                  },
                },
              ],
            },
            messages: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
    });
  });
});

describe("config env vars", () => {
  it("applies env vars from env block when missing", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            env: { OPENROUTER_API_KEY: "config-key" },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ OPENROUTER_API_KEY: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.OPENROUTER_API_KEY).toBe("config-key");
      });
    });
  });

  it("does not override existing env vars", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            env: { OPENROUTER_API_KEY: "config-key" },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride(
        { OPENROUTER_API_KEY: "existing-key" },
        async () => {
          const { loadConfig } = await import("./config.js");
          loadConfig();
          expect(process.env.OPENROUTER_API_KEY).toBe("existing-key");
        },
      );
    });
  });

  it("applies env vars from env.vars when missing", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            env: { vars: { GROQ_API_KEY: "gsk-config" } },
          },
          null,
          2,
        ),
        "utf-8",
      );

      await withEnvOverride({ GROQ_API_KEY: undefined }, async () => {
        const { loadConfig } = await import("./config.js");
        loadConfig();
        expect(process.env.GROQ_API_KEY).toBe("gsk-config");
      });
    });
  });
});

describe("config pruning defaults", () => {
  it("defaults contextPruning mode to adaptive", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify({ agents: { defaults: {} } }, null, 2),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("adaptive");
    });
  });

  it("does not override explicit contextPruning mode", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          { agents: { defaults: { contextPruning: { mode: "off" } } } },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.contextPruning?.mode).toBe("off");
    });
  });
});

describe("config discord", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("loads discord guild map + dm group settings", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            discord: {
              enabled: true,
              dm: {
                enabled: true,
                allowFrom: ["steipete"],
                groupEnabled: true,
                groupChannels: ["clawd-dm"],
              },
              guilds: {
                "123": {
                  slug: "friends-of-clawd",
                  requireMention: false,
                  users: ["steipete"],
                  channels: {
                    general: { allow: true },
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.discord?.enabled).toBe(true);
      expect(cfg.discord?.dm?.groupEnabled).toBe(true);
      expect(cfg.discord?.dm?.groupChannels).toEqual(["clawd-dm"]);
      expect(cfg.discord?.guilds?.["123"]?.slug).toBe("friends-of-clawd");
      expect(cfg.discord?.guilds?.["123"]?.channels?.general?.allow).toBe(true);
    });
  });
});

describe("config msteams", () => {
  it("accepts replyStyle at global/team/channel levels", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      msteams: {
        replyStyle: "top-level",
        teams: {
          team123: {
            replyStyle: "thread",
            channels: {
              chan456: { replyStyle: "top-level" },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.msteams?.replyStyle).toBe("top-level");
      expect(res.config.msteams?.teams?.team123?.replyStyle).toBe("thread");
      expect(
        res.config.msteams?.teams?.team123?.channels?.chan456?.replyStyle,
      ).toBe("top-level");
    }
  });

  it("rejects invalid replyStyle", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      msteams: { replyStyle: "nope" },
    });
    expect(res.ok).toBe(false);
  });
});

describe("Nix integration (U3, U5, U9)", () => {
  describe("U3: isNixMode env var detection", () => {
    it("isNixMode is false when CLAWDBOT_NIX_MODE is not set", async () => {
      await withEnvOverride({ CLAWDBOT_NIX_MODE: undefined }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is false when CLAWDBOT_NIX_MODE is empty", async () => {
      await withEnvOverride({ CLAWDBOT_NIX_MODE: "" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is false when CLAWDBOT_NIX_MODE is not '1'", async () => {
      await withEnvOverride({ CLAWDBOT_NIX_MODE: "true" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is true when CLAWDBOT_NIX_MODE=1", async () => {
      await withEnvOverride({ CLAWDBOT_NIX_MODE: "1" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(true);
      });
    });
  });

  describe("U5: CONFIG_PATH and STATE_DIR env var overrides", () => {
    it("STATE_DIR_CLAWDBOT defaults to ~/.clawdbot when env not set", async () => {
      await withEnvOverride({ CLAWDBOT_STATE_DIR: undefined }, async () => {
        const { STATE_DIR_CLAWDBOT } = await import("./config.js");
        expect(STATE_DIR_CLAWDBOT).toMatch(/\.clawdbot$/);
      });
    });

    it("STATE_DIR_CLAWDBOT respects CLAWDBOT_STATE_DIR override", async () => {
      await withEnvOverride(
        { CLAWDBOT_STATE_DIR: "/custom/state/dir" },
        async () => {
          const { STATE_DIR_CLAWDBOT } = await import("./config.js");
          expect(STATE_DIR_CLAWDBOT).toBe(path.resolve("/custom/state/dir"));
        },
      );
    });

    it("CONFIG_PATH_CLAWDBOT defaults to ~/.clawdbot/clawdbot.json when env not set", async () => {
      await withEnvOverride(
        { CLAWDBOT_CONFIG_PATH: undefined, CLAWDBOT_STATE_DIR: undefined },
        async () => {
          const { CONFIG_PATH_CLAWDBOT } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDBOT).toMatch(
            /\.clawdbot[\\/]clawdbot\.json$/,
          );
        },
      );
    });

    it("CONFIG_PATH_CLAWDBOT respects CLAWDBOT_CONFIG_PATH override", async () => {
      await withEnvOverride(
        { CLAWDBOT_CONFIG_PATH: "/nix/store/abc/clawdbot.json" },
        async () => {
          const { CONFIG_PATH_CLAWDBOT } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDBOT).toBe("/nix/store/abc/clawdbot.json");
        },
      );
    });

    it("CONFIG_PATH_CLAWDBOT uses STATE_DIR_CLAWDBOT when only state dir is overridden", async () => {
      await withEnvOverride(
        {
          CLAWDBOT_CONFIG_PATH: undefined,
          CLAWDBOT_STATE_DIR: "/custom/state",
        },
        async () => {
          const { CONFIG_PATH_CLAWDBOT } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDBOT).toBe(
            path.join(path.resolve("/custom/state"), "clawdbot.json"),
          );
        },
      );
    });
  });

  describe("U6: gateway port resolution", () => {
    it("uses default when env and config are unset", async () => {
      await withEnvOverride({ CLAWDBOT_GATEWAY_PORT: undefined }, async () => {
        const { DEFAULT_GATEWAY_PORT, resolveGatewayPort } = await import(
          "./config.js"
        );
        expect(resolveGatewayPort({})).toBe(DEFAULT_GATEWAY_PORT);
      });
    });

    it("prefers CLAWDBOT_GATEWAY_PORT over config", async () => {
      await withEnvOverride({ CLAWDBOT_GATEWAY_PORT: "19001" }, async () => {
        const { resolveGatewayPort } = await import("./config.js");
        expect(resolveGatewayPort({ gateway: { port: 19002 } })).toBe(19001);
      });
    });

    it("falls back to config when env is invalid", async () => {
      await withEnvOverride({ CLAWDBOT_GATEWAY_PORT: "nope" }, async () => {
        const { resolveGatewayPort } = await import("./config.js");
        expect(resolveGatewayPort({ gateway: { port: 19003 } })).toBe(19003);
      });
    });
  });

  describe("U9: telegram.tokenFile schema validation", () => {
    it("accepts config with only botToken", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdbot");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdbot.json"),
          JSON.stringify({
            telegram: { botToken: "123:ABC" },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.botToken).toBe("123:ABC");
        expect(cfg.telegram?.tokenFile).toBeUndefined();
      });
    });

    it("accepts config with only tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdbot");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdbot.json"),
          JSON.stringify({
            telegram: { tokenFile: "/run/agenix/telegram-token" },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
        expect(cfg.telegram?.botToken).toBeUndefined();
      });
    });

    it("accepts config with both botToken and tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdbot");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdbot.json"),
          JSON.stringify({
            telegram: {
              botToken: "fallback:token",
              tokenFile: "/run/agenix/telegram-token",
            },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.botToken).toBe("fallback:token");
        expect(cfg.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
      });
    });
  });
});

describe("talk api key fallback", () => {
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
  });

  afterEach(() => {
    process.env.ELEVENLABS_API_KEY = previousEnv;
  });

  it("injects talk.apiKey from profile when config is missing", async () => {
    await withTempHome(async (home) => {
      await fs.writeFile(
        path.join(home, ".profile"),
        "export ELEVENLABS_API_KEY=profile-key\n",
        "utf-8",
      );

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.config?.talk?.apiKey).toBe("profile-key");
      expect(snap.exists).toBe(false);
    });
  });

  it("prefers ELEVENLABS_API_KEY env over profile", async () => {
    await withTempHome(async (home) => {
      await fs.writeFile(
        path.join(home, ".profile"),
        "export ELEVENLABS_API_KEY=profile-key\n",
        "utf-8",
      );
      process.env.ELEVENLABS_API_KEY = "env-key";

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.config?.talk?.apiKey).toBe("env-key");
    });
  });
});

describe("talk.voiceAliases", () => {
  it("accepts a string map of voice aliases", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: "EXAVITQu4vr4xnSDxMaL",
          Roger: "CwhRBWXzGAHq8TQ4Fs17",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-string voice alias values", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: 123,
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe("legacy config detection", () => {
  it("rejects routing.allowFrom", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      routing: { allowFrom: ["+15555550123"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("routing.allowFrom");
    }
  });

  it("rejects routing.groupChat.requireMention", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      routing: { groupChat: { requireMention: false } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("routing.groupChat.requireMention");
    }
  });

  it("migrates routing.allowFrom to whatsapp.allowFrom", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { allowFrom: ["+15555550123"] },
    });
    expect(res.changes).toContain(
      "Moved routing.allowFrom → whatsapp.allowFrom.",
    );
    expect(res.config?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
    expect(res.config?.routing?.allowFrom).toBeUndefined();
  });

  it("migrates routing.groupChat.requireMention to whatsapp/telegram/imessage groups", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { groupChat: { requireMention: false } },
    });
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → whatsapp.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → telegram.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → imessage.groups."*".requireMention.',
    );
    expect(res.config?.whatsapp?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.imessage?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.routing?.groupChat?.requireMention).toBeUndefined();
  });

  it("migrates routing.groupChat.mentionPatterns to messages.groupChat.mentionPatterns", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { groupChat: { mentionPatterns: ["@clawd"] } },
    });
    expect(res.changes).toContain(
      "Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.",
    );
    expect(res.config?.messages?.groupChat?.mentionPatterns).toEqual([
      "@clawd",
    ]);
    expect(res.config?.routing?.groupChat?.mentionPatterns).toBeUndefined();
  });

  it("migrates routing agentToAgent/queue/transcribeAudio to tools/messages/audio", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: {
        agentToAgent: { enabled: true, allow: ["main"] },
        queue: { mode: "queue", cap: 3 },
        transcribeAudio: { command: ["echo", "hi"], timeoutSeconds: 2 },
      },
    });
    expect(res.changes).toContain(
      "Moved routing.agentToAgent → tools.agentToAgent.",
    );
    expect(res.changes).toContain("Moved routing.queue → messages.queue.");
    expect(res.changes).toContain(
      "Moved routing.transcribeAudio → audio.transcription.",
    );
    expect(res.config?.tools?.agentToAgent).toEqual({
      enabled: true,
      allow: ["main"],
    });
    expect(res.config?.messages?.queue).toEqual({
      mode: "queue",
      cap: 3,
    });
    expect(res.config?.audio?.transcription).toEqual({
      command: ["echo", "hi"],
      timeoutSeconds: 2,
    });
    expect(res.config?.routing).toBeUndefined();
  });

  it("migrates agent config into agents.defaults and tools", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      agent: {
        model: "openai/gpt-5.2",
        tools: { allow: ["sessions.list"], deny: ["danger"] },
        elevated: { enabled: true, allowFrom: { discord: ["user:1"] } },
        bash: { timeoutSec: 12 },
        sandbox: { tools: { allow: ["browser.open"] } },
        subagents: { tools: { deny: ["sandbox"] } },
      },
    });
    expect(res.changes).toContain("Moved agent.tools.allow → tools.allow.");
    expect(res.changes).toContain("Moved agent.tools.deny → tools.deny.");
    expect(res.changes).toContain("Moved agent.elevated → tools.elevated.");
    expect(res.changes).toContain("Moved agent.bash → tools.bash.");
    expect(res.changes).toContain(
      "Moved agent.sandbox.tools → tools.sandbox.tools.",
    );
    expect(res.changes).toContain(
      "Moved agent.subagents.tools → tools.subagents.tools.",
    );
    expect(res.changes).toContain("Moved agent → agents.defaults.");
    expect(res.config?.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.2",
      fallbacks: [],
    });
    expect(res.config?.tools?.allow).toEqual(["sessions.list"]);
    expect(res.config?.tools?.deny).toEqual(["danger"]);
    expect(res.config?.tools?.elevated).toEqual({
      enabled: true,
      allowFrom: { discord: ["user:1"] },
    });
    expect(res.config?.tools?.bash).toEqual({ timeoutSec: 12 });
    expect(res.config?.tools?.sandbox?.tools).toEqual({
      allow: ["browser.open"],
    });
    expect(res.config?.tools?.subagents?.tools).toEqual({
      deny: ["sandbox"],
    });
    expect((res.config as { agent?: unknown }).agent).toBeUndefined();
  });

  it("rejects telegram.requireMention", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("telegram.requireMention");
    }
  });

  it("rejects gateway.token", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      gateway: { token: "legacy-token" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.token");
    }
  });

  it("migrates gateway.token to gateway.auth.token", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      gateway: { token: "legacy-token" },
    });
    expect(res.changes).toContain("Moved gateway.token → gateway.auth.token.");
    expect(res.config?.gateway?.auth?.token).toBe("legacy-token");
    expect(res.config?.gateway?.auth?.mode).toBe("token");
    expect((res.config?.gateway as { token?: string })?.token).toBeUndefined();
  });

  it('rejects telegram.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      telegram: { dmPolicy: "open", allowFrom: ["123456789"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("telegram.allowFrom");
    }
  });

  it('accepts telegram.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      telegram: { dmPolicy: "open", allowFrom: ["*"] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.telegram?.dmPolicy).toBe("open");
    }
  });

  it("defaults telegram.dmPolicy to pairing when telegram section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ telegram: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.telegram?.dmPolicy).toBe("pairing");
    }
  });

  it("defaults telegram.streamMode to partial when telegram section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ telegram: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.telegram?.streamMode).toBe("partial");
    }
  });

  it('rejects whatsapp.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      whatsapp: { dmPolicy: "open", allowFrom: ["+15555550123"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("whatsapp.allowFrom");
    }
  });

  it('accepts whatsapp.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      whatsapp: { dmPolicy: "open", allowFrom: ["*"] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.whatsapp?.dmPolicy).toBe("open");
    }
  });

  it("defaults whatsapp.dmPolicy to pairing when whatsapp section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ whatsapp: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.whatsapp?.dmPolicy).toBe("pairing");
    }
  });

  it('rejects signal.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      signal: { dmPolicy: "open", allowFrom: ["+15555550123"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("signal.allowFrom");
    }
  });

  it('accepts signal.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      signal: { dmPolicy: "open", allowFrom: ["*"] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.signal?.dmPolicy).toBe("open");
    }
  });

  it("defaults signal.dmPolicy to pairing when signal section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ signal: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.signal?.dmPolicy).toBe("pairing");
    }
  });

  it('rejects imessage.dmPolicy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      imessage: { dmPolicy: "open", allowFrom: ["+15555550123"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("imessage.allowFrom");
    }
  });

  it('accepts imessage.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      imessage: { dmPolicy: "open", allowFrom: ["*"] },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.imessage?.dmPolicy).toBe("open");
    }
  });

  it("defaults imessage.dmPolicy to pairing when imessage section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ imessage: {} });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.imessage?.dmPolicy).toBe("pairing");
    }
  });

  it('rejects discord.dm.policy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      discord: { dm: { policy: "open", allowFrom: ["123"] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("discord.dm.allowFrom");
    }
  });

  it('rejects slack.dm.policy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      slack: { dm: { policy: "open", allowFrom: ["U123"] } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("slack.dm.allowFrom");
    }
  });

  it("rejects legacy agent.model string", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agent: { model: "anthropic/claude-opus-4-5" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "agent.model")).toBe(true);
    }
  });

  it("migrates telegram.requireMention to telegram.groups.*.requireMention", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      telegram: { requireMention: false },
    });
    expect(res.changes).toContain(
      'Moved telegram.requireMention → telegram.groups."*".requireMention.',
    );
    expect(res.config?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.telegram?.requireMention).toBeUndefined();
  });

  it("migrates legacy model config to agent.models + model lists", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      agent: {
        model: "anthropic/claude-opus-4-5",
        modelFallbacks: ["openai/gpt-4.1-mini"],
        imageModel: "openai/gpt-4.1-mini",
        imageModelFallbacks: ["anthropic/claude-opus-4-5"],
        allowedModels: ["anthropic/claude-opus-4-5", "openai/gpt-4.1-mini"],
        modelAliases: { Opus: "anthropic/claude-opus-4-5" },
      },
    });

    expect(res.config?.agents?.defaults?.model?.primary).toBe(
      "anthropic/claude-opus-4-5",
    );
    expect(res.config?.agents?.defaults?.model?.fallbacks).toEqual([
      "openai/gpt-4.1-mini",
    ]);
    expect(res.config?.agents?.defaults?.imageModel?.primary).toBe(
      "openai/gpt-4.1-mini",
    );
    expect(res.config?.agents?.defaults?.imageModel?.fallbacks).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
    expect(
      res.config?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"],
    ).toMatchObject({ alias: "Opus" });
    expect(
      res.config?.agents?.defaults?.models?.["openai/gpt-4.1-mini"],
    ).toBeTruthy();
    expect(res.config?.agent).toBeUndefined();
  });

  it("surfaces legacy issues in snapshot", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ routing: { allowFrom: ["+15555550123"] } }),
        "utf-8",
      );

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.length).toBe(1);
      expect(snap.legacyIssues[0]?.path).toBe("routing.allowFrom");
    });
  });
});

describe("multi-agent agentDir validation", () => {
  it("rejects shared agents.list agentDir", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const shared = path.join(tmpdir(), "clawdbot-shared-agentdir");
    const res = validateConfigObject({
      agents: {
        list: [
          { id: "a", agentDir: shared },
          { id: "b", agentDir: shared },
        ],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "agents.list")).toBe(true);
      expect(res.issues[0]?.message).toContain("Duplicate agentDir");
    }
  });

  it("throws on shared agentDir during loadConfig()", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdbot");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdbot.json"),
        JSON.stringify(
          {
            agents: {
              list: [
                { id: "a", agentDir: "~/.clawdbot/agents/shared/agent" },
                { id: "b", agentDir: "~/.clawdbot/agents/shared/agent" },
              ],
            },
            bindings: [{ agentId: "a", match: { provider: "telegram" } }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { loadConfig } = await import("./config.js");
      expect(() => loadConfig()).toThrow(/duplicate agentDir/i);
      expect(spy.mock.calls.flat().join(" ")).toMatch(/Duplicate agentDir/i);
      spy.mockRestore();
    });
  });
});
