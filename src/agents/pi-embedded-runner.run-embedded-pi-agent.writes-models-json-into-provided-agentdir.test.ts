import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import { ensureClawdbotModelsJson } from "./models-config.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
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
  });

  const buildAssistantErrorMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [] as const,
    stopReason: "error" as const,
    errorMessage: "boom",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") return buildAssistantErrorMessage(model);
      return buildAssistantMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") return buildAssistantErrorMessage(model);
      return buildAssistantMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      const stream = new actual.AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
        });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner.js").runEmbeddedPiAgent;

beforeEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner.js"));
});

const makeOpenAiConfig = (modelIds: string[]) =>
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
  }) satisfies ClawdbotConfig;

const ensureModels = (cfg: ClawdbotConfig, agentDir: string) =>
  ensureClawdbotModelsJson(cfg, agentDir);

const testSessionKey = "agent:test:embedded-models";
const immediateEnqueue = async <T>(task: () => Promise<T>) => task();

const textFromContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionMessages = async (sessionFile: string) => {
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

describe("runEmbeddedPiAgent", () => {
  it("writes models.json into the provided agentDir", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-workspace-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = {
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            apiKey: "sk-minimax-test",
            models: [
              {
                id: "MiniMax-M2.1",
                name: "MiniMax M2.1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies ClawdbotConfig;

    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: testSessionKey,
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "hi",
        provider: "definitely-not-a-provider",
        model: "definitely-not-a-model",
        timeoutMs: 1,
        agentDir,
        enqueue: immediateEnqueue,
      }),
    ).rejects.toThrow(/Unknown model:/);

    await expect(fs.stat(path.join(agentDir, "models.json"))).resolves.toBeTruthy();
  });
  it("persists the first user message before assistant output", { timeout: 60_000 }, async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-workspace-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = makeOpenAiConfig(["mock-1"]);
    await ensureModels(cfg, agentDir);

    await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: testSessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hello",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      enqueue: immediateEnqueue,
    });

    const messages = await readSessionMessages(sessionFile);
    const firstUserIndex = messages.findIndex(
      (message) => message?.role === "user" && textFromContent(message.content) === "hello",
    );
    const firstAssistantIndex = messages.findIndex((message) => message?.role === "assistant");
    expect(firstUserIndex).toBeGreaterThanOrEqual(0);
    if (firstAssistantIndex !== -1) {
      expect(firstUserIndex).toBeLessThan(firstAssistantIndex);
    }
  });
  it("persists the user message when prompt fails before assistant output", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-workspace-"));
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = makeOpenAiConfig(["mock-error"]);
    await ensureModels(cfg, agentDir);

    const result = await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: testSessionKey,
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "boom",
      provider: "openai",
      model: "mock-error",
      timeoutMs: 5_000,
      agentDir,
      enqueue: immediateEnqueue,
    });
    expect(result.payloads[0]?.isError).toBe(true);

    const messages = await readSessionMessages(sessionFile);
    const userIndex = messages.findIndex(
      (message) => message?.role === "user" && textFromContent(message.content) === "boom",
    );
    expect(userIndex).toBeGreaterThanOrEqual(0);
  });
});
