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
  ensureMoltbotModelsJson(cfg, agentDir);

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
  it("falls back to provider default when per-DM not set", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: { "456": { historyLimit: 5 } },
        },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(15);
  });
  it("returns per-DM override for agent-prefixed keys", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 20,
          dms: { "789": { historyLimit: 3 } },
        },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("agent:main:telegram:dm:789", config)).toBe(3);
  });
  it("handles userId with colons (e.g., email)", () => {
    const config = {
      channels: {
        msteams: {
          dmHistoryLimit: 10,
          dms: { "user@example.com": { historyLimit: 7 } },
        },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("msteams:dm:user@example.com", config)).toBe(7);
  });
  it("returns undefined when per-DM historyLimit is not set", () => {
    const config = {
      channels: {
        telegram: {
          dms: { "123": {} },
        },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBeUndefined();
  });
  it("returns 0 when per-DM historyLimit is explicitly 0 (unlimited)", () => {
    const config = {
      channels: {
        telegram: {
          dmHistoryLimit: 15,
          dms: { "123": { historyLimit: 0 } },
        },
      },
    } as MoltbotConfig;
    expect(getDmHistoryLimitFromSessionKey("telegram:dm:123", config)).toBe(0);
  });
});
