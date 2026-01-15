import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./test-helpers.js";

describe("legacy config detection", () => {
  it('accepts imessage.dmPolicy="open" with allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { imessage: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.imessage?.dmPolicy).toBe("open");
    }
  });
  it("defaults imessage.dmPolicy to pairing when imessage section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { imessage: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.imessage?.dmPolicy).toBe("pairing");
    }
  });
  it("defaults imessage.groupPolicy to allowlist when imessage section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { imessage: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.imessage?.groupPolicy).toBe("allowlist");
    }
  });
  it("defaults discord.groupPolicy to allowlist when discord section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { discord: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.discord?.groupPolicy).toBe("allowlist");
    }
  });
  it("defaults slack.groupPolicy to allowlist when slack section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { slack: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.slack?.groupPolicy).toBe("allowlist");
    }
  });
  it("defaults msteams.groupPolicy to allowlist when msteams section exists", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({ channels: { msteams: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.channels?.msteams?.groupPolicy).toBe("allowlist");
    }
  });
  it("rejects unsafe executable config values", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { imessage: { cliPath: "imsg; rm -rf /" } },
      tools: { audio: { transcription: { args: ["--model", "base"] } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "channels.imessage.cliPath")).toBe(true);
    }
  });
  it("accepts tools audio transcription without cli", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      tools: { audio: { transcription: { args: ["--model", "base"] } } },
    });
    expect(res.ok).toBe(true);
  });
  it("accepts path-like executable values with spaces", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { imessage: { cliPath: "/Applications/Imsg Tools/imsg" } },
      tools: {
        audio: {
          transcription: {
            args: ["--model"],
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
  it('rejects discord.dm.policy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { discord: { dm: { policy: "open", allowFrom: ["123"] } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.discord.dm.allowFrom");
    }
  });
  it('rejects slack.dm.policy="open" without allowFrom "*"', async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      channels: { slack: { dm: { policy: "open", allowFrom: ["U123"] } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.slack.dm.allowFrom");
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
  it("migrates telegram.requireMention to channels.telegram.groups.*.requireMention", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      telegram: { requireMention: false },
    });
    expect(res.changes).toContain(
      'Moved telegram.requireMention → channels.telegram.groups."*".requireMention.',
    );
    expect(res.config?.channels?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.channels?.telegram?.requireMention).toBeUndefined();
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

    expect(res.config?.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
    expect(res.config?.agents?.defaults?.model?.fallbacks).toEqual(["openai/gpt-4.1-mini"]);
    expect(res.config?.agents?.defaults?.imageModel?.primary).toBe("openai/gpt-4.1-mini");
    expect(res.config?.agents?.defaults?.imageModel?.fallbacks).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
    expect(res.config?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]).toMatchObject({
      alias: "Opus",
    });
    expect(res.config?.agents?.defaults?.models?.["openai/gpt-4.1-mini"]).toBeTruthy();
    expect(res.config?.agent).toBeUndefined();
  });
  it("auto-migrates legacy config in snapshot (no legacyIssues)", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ routing: { allowFrom: ["+15555550123"] } }),
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      try {
        const { readConfigFileSnapshot } = await import("./config.js");
        const snap = await readConfigFileSnapshot();

        expect(snap.valid).toBe(true);
        expect(snap.legacyIssues.length).toBe(0);

        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          channels?: { whatsapp?: { allowFrom?: string[] } };
          routing?: unknown;
        };
        expect(parsed.channels?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
        expect(parsed.routing).toBeUndefined();
        expect(
          warnSpy.mock.calls.some(([msg]) => String(msg).includes("Auto-migrated config")),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  it("auto-migrates claude-cli auth profile mode to oauth", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            auth: {
              profiles: {
                "anthropic:claude-cli": { provider: "anthropic", mode: "token" },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      try {
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.auth?.profiles?.["anthropic:claude-cli"]?.mode).toBe("oauth");

        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          auth?: { profiles?: Record<string, { mode?: string }> };
        };
        expect(parsed.auth?.profiles?.["anthropic:claude-cli"]?.mode).toBe("oauth");
        expect(
          warnSpy.mock.calls.some(([msg]) => String(msg).includes("Auto-migrated config")),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  it("auto-migrates legacy provider sections on load and writes back", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ whatsapp: { allowFrom: ["+1555"] } }, null, 2),
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      try {
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();

        expect(cfg.channels?.whatsapp?.allowFrom).toEqual(["+1555"]);
        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          channels?: { whatsapp?: { allowFrom?: string[] } };
          whatsapp?: unknown;
        };
        expect(parsed.channels?.whatsapp?.allowFrom).toEqual(["+1555"]);
        expect(parsed.whatsapp).toBeUndefined();
        expect(
          warnSpy.mock.calls.some(([msg]) => String(msg).includes("Auto-migrated config")),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  it("auto-migrates routing.allowFrom on load and writes back", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ routing: { allowFrom: ["+1666"] } }, null, 2),
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      try {
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();

        expect(cfg.channels?.whatsapp?.allowFrom).toEqual(["+1666"]);
        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          channels?: { whatsapp?: { allowFrom?: string[] } };
          routing?: unknown;
        };
        expect(parsed.channels?.whatsapp?.allowFrom).toEqual(["+1666"]);
        expect(parsed.routing).toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  it("auto-migrates bindings[].match.provider on load and writes back", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            bindings: [{ agentId: "main", match: { provider: "slack" } }],
          },
          null,
          2,
        ),
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      try {
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.bindings?.[0]?.match?.channel).toBe("slack");

        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          bindings?: Array<{ match?: { channel?: string; provider?: string } }>;
        };
        expect(parsed.bindings?.[0]?.match?.channel).toBe("slack");
        expect(parsed.bindings?.[0]?.match?.provider).toBeUndefined();
        expect(
          warnSpy.mock.calls.some(([msg]) => String(msg).includes("Auto-migrated config")),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  it("auto-migrates session.sendPolicy.rules[].match.provider on load and writes back", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            session: {
              sendPolicy: {
                rules: [{ action: "deny", match: { provider: "telegram" } }],
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      try {
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.session?.sendPolicy?.rules?.[0]?.match?.channel).toBe("telegram");

        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          session?: {
            sendPolicy?: {
              rules?: Array<{
                match?: { channel?: string; provider?: string };
              }>;
            };
          };
        };
        expect(parsed.session?.sendPolicy?.rules?.[0]?.match?.channel).toBe("telegram");
        expect(parsed.session?.sendPolicy?.rules?.[0]?.match?.provider).toBeUndefined();
        expect(
          warnSpy.mock.calls.some(([msg]) => String(msg).includes("Auto-migrated config")),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
  it("auto-migrates messages.queue.byProvider on load and writes back", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdbot", "clawdbot.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ messages: { queue: { byProvider: { whatsapp: "queue" } } } }, null, 2),
        "utf-8",
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.resetModules();
      try {
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.messages?.queue?.byChannel?.whatsapp).toBe("queue");

        const raw = await fs.readFile(configPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          messages?: {
            queue?: {
              byChannel?: Record<string, unknown>;
              byProvider?: unknown;
            };
          };
        };
        expect(parsed.messages?.queue?.byChannel?.whatsapp).toBe("queue");
        expect(parsed.messages?.queue?.byProvider).toBeUndefined();
        expect(
          warnSpy.mock.calls.some(([msg]) => String(msg).includes("Auto-migrated config")),
        ).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
