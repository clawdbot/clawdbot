import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import { ensureMoltbotModelsJson } from "./models-config.js";
import { getDmHistoryLimitFromSessionKey } from "./pi-embedded-runner.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        throw new Error("boom");
      }
      const stream = new actual.AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            timestamp: Date.now(),
          },
        });
      });
      return stream;
    },
  };
});

const _makeOpenAiConfig = (modelIds: string[]) =>
  ({
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  }) satisfies MoltbotConfig;

const _ensureModels = (cfg: MoltbotConfig, agentDir: string) =>
  ensureMoltbotModelsJson(cfg, agentDir) as unknown;

const _textFromContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const _readSessionMessages = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        },
    )
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as { role?: string; content?: unknown });
};

describe("getDmHistoryLimitFromSessionKey", () => {
  it("returns undefined when sessionKey is undefined", () => {
    expect(getDmHistoryLimitFromSessionKey(undefined, {})).toBeUndefined();
  });
  it("returns undefined when config is undefined", () => {
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", undefined)).toBeUndefined();
  });
  it("returns dmHistoryLimit for telegram provider", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 15 } },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(15);
  });
  it("returns dmHistoryLimit for whatsapp provider", () => {
    const config = {
      channels: { whatsapp: { dmHistoryLimit: 20 } },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("whatsapp:dm:123", config)).toBe(20);
  });
  it("returns dmHistoryLimit for agent-prefixed session keys", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10 } },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:123", config)).toBe(10);
  });
  it("strips thread suffix from dm session keys", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 10, dms: { "123": { historyLimit: 7 } } } },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:123:thread:999", config)).toBe(
      7,
    );
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:123:topic:555", config)).toBe(7);
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123:thread:999", config)).toBe(7);
  });
  it("keeps non-numeric thread markers in dm ids", () => {
    const config = {
      channels: {
        telegram: { dms: { "user:thread:abc": { historyLimit: 9 } } },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:user:thread:abc", config)).toBe(
      9,
    );
  });
  it("returns undefined for non-dm session kinds", () => {
    const config = {
      channels: {
        telegram: { dmHistoryLimit: 15 },
        slack: { dmHistoryLimit: 10 },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:beta:slack:channel:c1", config)).toBeUndefined();
    expect(getDmHistoryLimitFromSessionKey("telegram:slash:123", config)).toBeUndefined();
  });
  it("returns undefined for unknown provider", () => {
    const config = {
      channels: { telegram: { dmHistoryLimit: 15 } },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("unknown:dm:123", config)).toBeUndefined();
  });
  it("returns undefined when provider config has no dmHistoryLimit", () => {
    const config = { channels: { telegram: {} } } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBeUndefined();
  });
  it("handles all supported providers", () => {
    const providers = [
      "telegram",
      "whatsapp",
      "discord",
      "slack",
      "signal",
      "imessage",
      "msteams",
      "nextcloud-talk",
    ] as const;

    for (const provider of providers) {
      const config = {
        channels: { [provider]: { dmHistoryLimit: 5 } },
      } as MoltbotConfig;
      expect(getDmHistoryLimitFromSessionKey(`${provider}:dm:123`, config)).toBe(5);
    }
  });
  it("handles per-DM overrides for all supported providers", () => {
    const providers = [
      "telegram",
      "whatsapp",
      "discord",
      "slack",
      "signal",
      "imessage",
      "msteams",
      "nextcloud-talk",
    ] as const;

    for (const provider of providers) {
      // Test per-DM override takes precedence
      const configWithOverride = {
        channels: {
          [provider]: {
            dmHistoryLimit: 20,
            dms: { user123: { historyLimit: 7 } },
          },
        },
      } as MoltbotConfig;
      expect(getDmHistoryLimitFromSessionKey(`${provider}:dm:user123`, configWithOverride)).toBe(7);

      // Test fallback to provider default when user not in dms
      expect(getDmHistoryLimitFromSessionKey(`${provider}:dm:otheruser`, configWithOverride)).toBe(
        20,
      );

      // Test with agent-prefixed key
      expect(
        getDmHistoryLimitFromSessionKey(`agent:main:${provider}:dm:user123`, configWithOverride),
      ).toBe(7);
    }
  });
  it("returns per-DM override when set", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: { "123": { historyLimit: 5 } },
        },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(5);
  });
});
