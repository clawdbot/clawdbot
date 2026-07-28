import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { streamAnthropic } from "@openclaw/ai/internal/anthropic";
import { afterEach, describe, expect, it } from "vitest";
import type { Context, Message, Model } from "../../llm/types.js";
import type { AgentMessage } from "../runtime/index.js";
import { SessionManager } from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tool-result-replay-"));
  tempPaths.push(dir);
  return dir;
}

function toLlmContext(context: { messages: AgentMessage[] }): Context {
  const messages = context.messages.filter(
    (message): message is Message =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  );
  return { messages };
}

function makeAnthropicModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
}

async function writeSessionWithToolResultContent(
  sessionFile: string,
  content: unknown,
): Promise<void> {
  const entries = [
    {
      type: "session",
      version: 3,
      id: "string-tool-result-session",
      timestamp: "2026-07-01T00:00:00.000Z",
      cwd: "/tmp/tool-result-replay",
    },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-07-01T00:00:01.000Z",
      message: { role: "user", content: "run lookup", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-07-01T00:00:02.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        stopReason: "toolUse",
        timestamp: 2,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
      },
    },
    {
      type: "message",
      id: "tool-result-1",
      parentId: "assistant-1",
      timestamp: "2026-07-01T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        content,
        isError: false,
        timestamp: 3,
      },
    },
  ];
  await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function writeSessionWithAssistantContent(
  sessionFile: string,
  content: unknown,
): Promise<void> {
  const entries = [
    {
      type: "session",
      version: 3,
      id: "string-assistant-session",
      timestamp: "2026-07-01T00:00:00.000Z",
      cwd: "/tmp/tool-result-replay",
    },
    {
      type: "message",
      id: "user-1",
      parentId: null,
      timestamp: "2026-07-01T00:00:01.000Z",
      message: { role: "user", content: "say hello", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-07-01T00:00:02.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        stopReason: "stop",
        timestamp: 2,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content,
      },
    },
  ];
  await fs.writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("SessionManager tool-result replay", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("normalizes string tool-result content loaded from JSONL", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await writeSessionWithToolResultContent(sessionFile, "lookup result text");

    const sessionManager = SessionManager.open(sessionFile, dir, "/tmp/tool-result-replay");
    const context = sessionManager.buildSessionContext();
    const toolResult = context.messages.find((message) => message.role === "toolResult");
    if (!toolResult || toolResult.role !== "toolResult") {
      throw new Error("tool result message missing");
    }

    expect(toolResult.content).toEqual([{ type: "text", text: "lookup result text" }]);
  });

  it("replays string assistant JSONL content as Anthropic assistant text", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await writeSessionWithAssistantContent(sessionFile, "assistant replay text");
    const context = SessionManager.open(
      sessionFile,
      dir,
      "/tmp/tool-result-replay",
    ).buildSessionContext();
    const assistant = context.messages.find((message) => message.role === "assistant");
    if (!assistant || assistant.role !== "assistant") {
      throw new Error("assistant message missing");
    }
    expect(assistant.content).toEqual([{ type: "text", text: "assistant replay text" }]);

    let capturedPayload: unknown;
    const stream = streamAnthropic(makeAnthropicModel(), toLlmContext(context), {
      apiKey: "sk-ant-provider",
      onPayload: (payload) => {
        capturedPayload = payload;
        throw new Error("stop before network");
      },
    });

    await stream.result();

    const payload = capturedPayload as {
      messages: Array<{
        role: string;
        content: string | Array<{ type?: unknown; text?: unknown }>;
      }>;
    };
    const assistantPayload = payload.messages.find((message) => message.role === "assistant");

    expect(assistantPayload?.content).toEqual([{ type: "text", text: "assistant replay text" }]);
  });

  it("replays string tool-result JSONL content as Anthropic tool text", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    await writeSessionWithToolResultContent(sessionFile, "lookup result text");
    const context = SessionManager.open(
      sessionFile,
      dir,
      "/tmp/tool-result-replay",
    ).buildSessionContext();

    let capturedPayload: unknown;
    const stream = streamAnthropic(makeAnthropicModel(), toLlmContext(context), {
      apiKey: "sk-ant-provider",
      onPayload: (payload) => {
        capturedPayload = payload;
        throw new Error("stop before network");
      },
    });

    await stream.result();

    const payload = capturedPayload as {
      messages: Array<{
        role: string;
        content: Array<{ type?: unknown; content?: unknown }>;
      }>;
    };
    const toolResultBlock = payload.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");

    expect(toolResultBlock?.content).toBe("lookup result text");
  });

  it("replays object tool-result JSONL content as structured Anthropic tool text", async () => {
    const dir = await makeTempDir();
    const sessionFile = path.join(dir, "session.jsonl");
    const content = { output: "status card text" };
    await writeSessionWithToolResultContent(sessionFile, content);

    const context = SessionManager.open(
      sessionFile,
      dir,
      "/tmp/tool-result-replay",
    ).buildSessionContext();
    const toolResult = context.messages.find((message) => message.role === "toolResult");
    if (!toolResult || toolResult.role !== "toolResult") {
      throw new Error("tool result message missing");
    }
    expect(toolResult.content).toEqual([content]);

    let capturedPayload: unknown;
    const stream = streamAnthropic(makeAnthropicModel(), toLlmContext(context), {
      apiKey: "sk-ant-provider",
      onPayload: (payload) => {
        capturedPayload = payload;
        throw new Error("stop before network");
      },
    });

    await stream.result();

    const payload = capturedPayload as {
      messages: Array<{
        role: string;
        content: Array<{ type?: unknown; content?: unknown }>;
      }>;
    };
    const toolResultBlock = payload.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result");

    expect(String(toolResultBlock?.content)).toContain("status card text");
  });
});
