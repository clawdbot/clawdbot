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
    expect(
      resolveOpenAITransportTurnState({
        provider: "openai",
        modelId: nativeModel.id,
        model: nativeModel,
        sessionId: "session-123",
        turnId: "turn-123",
        attempt: 2,
        transport: "websocket",
      }),
    ).toMatchObject({
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
        "x-openclaw-turn-id": "turn-123",
        "x-openclaw-turn-attempt": "2",
      },
      metadata: {
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
        openclaw_turn_attempt: "2",
        openclaw_transport: "websocket",
      },
    });
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
    expect(
      resolveOpenAITransportTurnState({
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
      }),
    ).toMatchObject({
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
        "x-openclaw-turn-id": "turn-123",
        "x-openclaw-turn-attempt": "2",
      },
    });
  });

  it("returns websocket session headers and cooldown for native routes", () => {
    expect(
      resolveOpenAIWebSocketSessionPolicy({
        provider: "openai",
        modelId: nativeModel.id,
        model: nativeModel,
        sessionId: "session-123",
      }),
    ).toMatchObject({
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
      },
      degradeCooldownMs: 60_000,
    });
  });

  it("treats Azure routes as native OpenAI-family transports", () => {
    expect(
      resolveOpenAIWebSocketSessionPolicy({
        provider: "azure-openai-responses",
        modelId: "gpt-5.4",
        model: {
          ...nativeModel,
          provider: "azure-openai-responses",
          baseUrl: "https://demo.openai.azure.com/openai/v1",
        },
        sessionId: "session-123",
      }),
    ).toMatchObject({
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
      },
      degradeCooldownMs: 60_000,
    });
  });

  it("treats ChatGPT Codex backend routes as native OpenAI-family transports", () => {
    expect(
      resolveOpenAIWebSocketSessionPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        model: {
          ...nativeModel,
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api",
        },
        sessionId: "session-123",
      }),
    ).toMatchObject({
      headers: {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
      },
      degradeCooldownMs: 60_000,
    });
  });
});
