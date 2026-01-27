import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import { ensureMoltbotModelsJson } from "./models-config.js";
import { limitHistoryTurns } from "./pi-embedded-runner.js";

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

describe("limitHistoryTurns", () => {
  const makeMessages = (roles: ("user" | "assistant")[]): AgentMessage[] =>
    roles.map((role, i) => ({
      role,
      content: [{ type: "text", text: `message ${i}` }],
    }));

  it("returns all messages when limit is undefined", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, undefined)).toBe(messages);
  });
  it("returns all messages when limit is 0", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 0)).toBe(messages);
  });
  it("returns all messages when limit is negative", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, -1)).toBe(messages);
  });
  it("returns empty array when messages is empty", () => {
    expect(limitHistoryTurns([], 5)).toEqual([]);
  });
  it("keeps all messages when fewer user turns than limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant"]);
    expect(limitHistoryTurns(messages, 10)).toBe(messages);
  });
  it("limits to last N user turns", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 2);
    expect(limited.length).toBe(4);
    expect(limited[0].content).toEqual([{ type: "text", text: "message 2" }]);
  });
  it("handles single user turn limit", () => {
    const messages = makeMessages(["user", "assistant", "user", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(limited[0].content).toEqual([{ type: "text", text: "message 4" }]);
    expect(limited[1].content).toEqual([{ type: "text", text: "message 5" }]);
  });
  it("handles messages with multiple assistant responses per user turn", () => {
    const messages = makeMessages(["user", "assistant", "assistant", "user", "assistant"]);
    const limited = limitHistoryTurns(messages, 1);
    expect(limited.length).toBe(2);
    expect(limited[0].role).toBe("user");
    expect(limited[1].role).toBe("assistant");
  });
  it("preserves message content integrity", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "1", name: "exec", arguments: {} }],
      },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
    ];
    const limited = limitHistoryTurns(messages, 1);
    expect(limited[0].content).toEqual([{ type: "text", text: "second" }]);
    expect(limited[1].content).toEqual([{ type: "text", text: "response" }]);
  });
});
