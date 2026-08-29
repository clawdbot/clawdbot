import { describe, expect, it, vi } from "vitest";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";

function createActiveSession() {
  const convertToLlm = vi.fn((input: AgentMessage[]) => input as never);
  const activeSession = {
    agent: {
      reset: vi.fn(),
      state: { messages: [] },
      convertToLlm,
    },
  } as unknown as Pick<AgentSession, "agent">;
  return { activeSession, convertToLlm };
}

function createSessionManager(): ReturnType<typeof guardSessionManager> {
  return {
    getLeafEntry: () => undefined,
  } as unknown as ReturnType<typeof guardSessionManager>;
}

function runtimeContextCarrier(): AgentMessage {
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content: "runtime context",
    timestamp: 1,
  } as AgentMessage;
}

function activeUser(): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "Reply exactly: PONG" }],
    timestamp: 2,
  } as AgentMessage;
}

async function convertWithModel(model: Record<string, unknown>) {
  const { activeSession } = createActiveSession();
  prepareEmbeddedAttemptSessionBoundary({
    activeSession,
    attempt: {
      model: model as never,
      prompt: "Reply exactly: PONG",
      trigger: "user",
    },
    getUserTranscriptContexts: () => undefined,
    isRawModelRun: false,
    preparedUserTurnMessage: undefined,
    sessionManager: createSessionManager(),
    setActiveSessionSystemPrompt: vi.fn(),
  });

  return await activeSession.agent.convertToLlm([runtimeContextCarrier(), activeUser()]);
}

describe("runtime-context carrier placement at the LLM boundary", () => {
  it("keeps the carrier before the active user for native Ollama", async () => {
    const converted = await convertWithModel({
      api: "ollama",
      provider: "ollama",
      id: "gpt-oss:20b",
      baseUrl: "http://127.0.0.1:11434",
    });

    expect(converted.map((message) => message.role)).toEqual(["custom", "user"]);
  });

  it("keeps the carrier before the active user for local OpenAI-compatible models", async () => {
    const converted = await convertWithModel({
      api: "openai-completions",
      provider: "local",
      id: "gpt-oss:20b",
      baseUrl: "http://127.0.0.1:11434/v1",
      compat: {},
    });

    expect(converted.map((message) => message.role)).toEqual(["custom", "user"]);
  });

  it("keeps tail placement for OpenAI-compatible models with prompt-cache capability", async () => {
    const converted = await convertWithModel({
      api: "openai-completions",
      provider: "custom-cache",
      id: "cached-model",
      baseUrl: "https://example.invalid/v1",
      compat: { supportsPromptCacheKey: true },
    });

    expect(converted.map((message) => message.role)).toEqual(["user", "custom"]);
  });
});
