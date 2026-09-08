import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";

function createActiveSession(messages: AgentMessage[] = []) {
  const reset = vi.fn();
  const convertToLlm = vi.fn((input: AgentMessage[]) => input as never);
  const activeSession = {
    agent: {
      reset,
      state: { messages },
      convertToLlm,
    },
  } as unknown as Pick<AgentSession, "agent">;
  return { activeSession, convertToLlm, reset };
}

function createSessionManager(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof guardSessionManager> {
  return {
    getLeafEntry: () => undefined,
    getSessionTarget: () => undefined,
    ...overrides,
  } as unknown as ReturnType<typeof guardSessionManager>;
}

describe("prepareEmbeddedAttemptSessionBoundary carrier relocation", () => {
  it("does not relocate runtime context carrier to tail when provider is ollama", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "ollama",
        model: { id: "gpt-oss:20b", api: "ollama", baseUrl: "http://127.0.0.1:11434" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.customType).toBe("openclaw.runtime-context");
    expect(converted[1]?.role).toBe("user");
  });

  it("relocates runtime context carrier to tail for cloud providers like anthropic", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "anthropic",
        model: {
          id: "claude-opus-5",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
        },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.role).toBe("user");
    expect(converted[1]?.customType).toBe("openclaw.runtime-context");
  });

  it("does not relocate carrier to tail for custom local provider with api ollama", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "ollama-fast",
        model: { id: "llama3", api: "ollama", baseUrl: "http://example.com" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.customType).toBe("openclaw.runtime-context");
    expect(converted[1]?.role).toBe("user");
  });

  it("does not relocate carrier to tail for custom provider with loopback baseUrl", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "my-vllm",
        model: { id: "llama3", baseUrl: "http://127.0.0.1:8000/v1" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.customType).toBe("openclaw.runtime-context");
    expect(converted[1]?.role).toBe("user");
  });

  it("relocates carrier to tail for cloud models behind local proxies (LiteLLM, local reverse proxies)", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "openai",
        model: { id: "gpt-5", api: "openai-completions", baseUrl: "http://127.0.0.1:4000/v1" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.role).toBe("user");
    expect(converted[1]?.customType).toBe("openclaw.runtime-context");
  });

  it("relocates carrier to tail for Ollama cloud models (*:cloud) behind local endpoint", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "ollama",
        model: { id: "kimi-k2.5:cloud", api: "ollama", baseUrl: "http://127.0.0.1:11434" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.role).toBe("user");
    expect(converted[1]?.customType).toBe("openclaw.runtime-context");
  });

  it("relocates carrier to tail for the built-in ollama-cloud provider with bare model IDs", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "ollama-cloud",
        model: { id: "gpt-oss:120b", api: "ollama", baseUrl: "https://ollama.com" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.role).toBe("user");
    expect(converted[1]?.customType).toBe("openclaw.runtime-context");
  });

  it("relocates carrier to tail for provider: ollama pointing to a hosted endpoint with bare model IDs", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "ollama",
        model: { id: "gpt-oss:20b", api: "ollama", baseUrl: "https://ollama.com/v1" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.role).toBe("user");
    expect(converted[1]?.customType).toBe("openclaw.runtime-context");
  });

  it("does not relocate carrier to tail for self-hosted sglang provider with non-local endpoint", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "sglang",
        model: {
          id: "meta-llama/Llama-3-70b-Instruct",
          provider: "sglang",
          baseUrl: "http://gpu-cluster.internal.org:30000/v1",
        },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.customType).toBe("openclaw.runtime-context");
    expect(converted[1]?.role).toBe("user");
  });

  it("relocates carrier to tail for the bundled LiteLLM cloud route", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "litellm",
        model: {
          id: "claude-opus-4-6",
          api: "openai-completions",
          baseUrl: "http://localhost:4000",
        },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.role).toBe("user");
    expect(converted[1]?.customType).toBe("openclaw.runtime-context");
  });

  it("preserves before-user carrier placement across multi-turn local sessions with prior turns", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "second question",
        provider: "ollama",
        model: { id: "gpt-oss:20b", api: "ollama", baseUrl: "http://127.0.0.1:11434" },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const prevUser = {
      role: "user",
      content: "first question",
      timestamp: 1,
    } as unknown as AgentMessage;
    const prevAssistant = {
      role: "assistant",
      content: "first answer",
      timestamp: 2,
    } as unknown as AgentMessage;
    const currentCarrier = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>{"turn":2}<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      details: { runtimeContextCarrier: true },
      timestamp: 3,
    } as unknown as AgentMessage;
    const currentUser = {
      role: "user",
      content: "second question",
      timestamp: 4,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      prevUser,
      prevAssistant,
      currentCarrier,
      currentUser,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
      content?: string;
    }>;

    expect(converted).toHaveLength(4);
    expect(converted[0]?.role).toBe("user");
    expect(converted[0]?.content).toContain("first question");
    expect(converted[1]?.role).toBe("assistant");
    expect(converted[1]?.content).toEqual([{ type: "text", text: "first answer" }]);
    // The current carrier stays immediately before the current user turn
    expect(converted[2]?.customType).toBe("openclaw.runtime-context");
    expect(converted[2]?.content).toContain('turn":2');
    expect(converted[3]?.role).toBe("user");
    expect(converted[3]?.content).toContain("second question");
  });

  it("relocates carrier to tail across multi-turn cloud / LiteLLM sessions with prior turns", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "second question",
        provider: "litellm",
        model: {
          id: "claude-opus-4-6",
          api: "openai-completions",
          baseUrl: "http://localhost:4000",
        },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const prevUser = {
      role: "user",
      content: "first question",
      timestamp: 1,
    } as unknown as AgentMessage;
    const prevAssistant = {
      role: "assistant",
      content: "first answer",
      timestamp: 2,
    } as unknown as AgentMessage;
    const currentCarrier = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>{"turn":2}<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
      details: { runtimeContextCarrier: true },
      timestamp: 3,
    } as unknown as AgentMessage;
    const currentUser = {
      role: "user",
      content: "second question",
      timestamp: 4,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      prevUser,
      prevAssistant,
      currentCarrier,
      currentUser,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
      content?: string;
    }>;

    expect(converted).toHaveLength(4);
    expect(converted[0]?.role).toBe("user");
    expect(converted[0]?.content).toContain("first question");
    expect(converted[1]?.role).toBe("assistant");
    expect(converted[1]?.content).toEqual([{ type: "text", text: "first answer" }]);
    // In cloud/LiteLLM mode, the carrier relocates to tail after current user
    expect(converted[2]?.role).toBe("user");
    expect(converted[2]?.content).toContain("second question");
    expect(converted[3]?.customType).toBe("openclaw.runtime-context");
    expect(converted[3]?.content).toContain('turn":2');
  });

  it("does not relocate carrier to tail for locally served gpt-oss models (custom-local, loopback)", async () => {
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        prompt: "hi",
        provider: "custom-local",
        model: {
          id: "openai/gpt-oss-20b",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8000/v1",
        },
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const carrierMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "internal context",
      details: { runtimeContextCarrier: true },
      timestamp: 1,
    } as unknown as AgentMessage;
    const userMessage = {
      role: "user",
      content: "hi",
      timestamp: 2,
    } as unknown as AgentMessage;

    const converted = (await activeSession.agent.convertToLlm([
      carrierMessage,
      userMessage,
    ])) as unknown as Array<{
      role: string;
      customType?: string;
    }>;
    expect(converted[0]?.customType).toBe("openclaw.runtime-context");
    expect(converted[1]?.role).toBe("user");
  });
});
