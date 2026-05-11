import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  resolveOpenAITransportTurnState,
  resolveOpenAIWebSocketSessionPolicy,
} from "./transport-policy.js";

describe("openai transport policy", () => {
  const nativeModel = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } satisfies ProviderRuntimeModel;

  const proxyModel = {
    ...nativeModel,
    id: "proxy-model",
    name: "Proxy Model",
    baseUrl: "https://proxy.example.com/v1",
  } satisfies ProviderRuntimeModel;

  it("builds native turn state for direct OpenAI routes", () => {
    const state = resolveOpenAITransportTurnState({
      provider: "openai",
      modelId: nativeModel.id,
      model: nativeModel,
      sessionId: "session-123",
      turnId: "turn-123",
      attempt: 2,
      transport: "websocket",
    });
    expect(state?.headers?.["x-client-request-id"]).toBe("session-123");
    expect(state?.headers?.["x-openclaw-session-id"]).toBe("session-123");
    expect(state?.headers?.["x-openclaw-turn-id"]).toBe("turn-123");
    expect(state?.headers?.["x-openclaw-turn-attempt"]).toBe("2");
    expect(state?.metadata?.openclaw_session_id).toBe("session-123");
    expect(state?.metadata?.openclaw_turn_id).toBe("turn-123");
    expect(state?.metadata?.openclaw_turn_attempt).toBe("2");
    expect(state?.metadata?.openclaw_transport).toBe("websocket");
  });

  it("skips turn state for proxy-like OpenAI routes", () => {
    expect(
      resolveOpenAITransportTurnState({
        provider: "openai",
        modelId: proxyModel.id,
        model: proxyModel,
        sessionId: "session-123",
        turnId: "turn-123",
        attempt: 1,
        transport: "stream",
      }),
    ).toBeUndefined();
  });

  it("keeps Codex request identity session-scoped while adding turn metadata", () => {
    const state = resolveOpenAITransportTurnState({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      model: {
        ...nativeModel,
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      },
      sessionId: "session-123",
      turnId: "turn-123",
      attempt: 2,
      transport: "stream",
    });
    expect(state?.headers?.["x-client-request-id"]).toBe("session-123");
    expect(state?.headers?.["x-openclaw-session-id"]).toBe("session-123");
    expect(state?.headers?.["x-openclaw-turn-id"]).toBe("turn-123");
    expect(state?.headers?.["x-openclaw-turn-attempt"]).toBe("2");
  });

  it("returns websocket session headers and cooldown for native routes", () => {
    const policy = resolveOpenAIWebSocketSessionPolicy({
      provider: "openai",
      modelId: nativeModel.id,
      model: nativeModel,
      sessionId: "session-123",
    });
    expect(policy?.headers?.["x-client-request-id"]).toBe("session-123");
    expect(policy?.headers?.["x-openclaw-session-id"]).toBe("session-123");
    expect(policy?.degradeCooldownMs).toBe(60_000);
  });

  it("treats Azure routes as native OpenAI-family transports", () => {
    const policy = resolveOpenAIWebSocketSessionPolicy({
      provider: "azure-openai-responses",
      modelId: "gpt-5.4",
      model: {
        ...nativeModel,
        provider: "azure-openai-responses",
        baseUrl: "https://demo.openai.azure.com/openai/v1",
      },
      sessionId: "session-123",
    });
    expect(policy?.headers?.["x-client-request-id"]).toBe("session-123");
    expect(policy?.headers?.["x-openclaw-session-id"]).toBe("session-123");
    expect(policy?.degradeCooldownMs).toBe(60_000);
  });

  it("treats ChatGPT Codex backend routes as native OpenAI-family transports", () => {
    const policy = resolveOpenAIWebSocketSessionPolicy({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      model: {
        ...nativeModel,
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      },
      sessionId: "session-123",
    });
    expect(policy?.headers?.["x-client-request-id"]).toBe("session-123");
    expect(policy?.headers?.["x-openclaw-session-id"]).toBe("session-123");
    expect(policy?.degradeCooldownMs).toBe(60_000);
  });
});
