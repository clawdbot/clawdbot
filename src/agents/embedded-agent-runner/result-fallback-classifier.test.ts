// Coverage for deciding when embedded run results should trigger model fallback.
import { describe, expect, it } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";

describe("classifyEmbeddedAgentRunResultForModelFallback", () => {
  it("does not fallback when sessions_spawn accepted a child session", () => {
    // Accepted child sessions mean the turn made progress even if the parent did
    // not emit a normal assistant reply.
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "mock-openai",
        model: "gpt-5.5",
        result: {
          meta: { durationMs: 1 },
          acceptedSessionSpawns: [
            {
              runId: "run-child",
              childSessionKey: "agent:qa:subagent:child",
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("classifies provider business-denial error payloads as fallback-worthy", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "zai",
      model: "glm-5.1",
      result: {
        payloads: [
          {
            isError: true,
            text: '{"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}',
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message:
        'zai/glm-5.1 ended with a provider error: {"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}',
      reason: "auth",
      code: "embedded_error_payload",
      rawError: '{"success":false,"code":"CE-011","message":"当前ak因违规请求被禁止访问该模型"}',
    });
  });

  it("preserves hook block results with auth-like error payload text", () => {
    // Hook policy blocks are intentional local decisions, not provider failures
    // that should rotate models.
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "custom",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text: "Access denied by policy",
          },
        ],
        meta: {
          durationMs: 42,
          error: {
            kind: "hook_block",
            message: "Access denied by policy",
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("uses provider-scoped failover matching for business-denial payloads", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openrouter",
      model: "claude-3.5-sonnet",
      result: {
        payloads: [
          {
            isError: true,
            text: "Key limit exceeded",
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message: "openrouter/claude-3.5-sonnet ended with a provider error: Key limit exceeded",
      reason: "billing",
      code: "embedded_error_payload",
      rawError: "Key limit exceeded",
    });
  });

  it("does not retry unclassified non-GPT error payloads", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "custom",
      model: "llama-3.1",
      result: {
        payloads: [
          {
            isError: true,
            text: "the model produced an application-level error",
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry non-business transport error payloads", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "custom",
      model: "llama-3.1",
      result: {
        payloads: [
          {
            isError: true,
            text: "HTTP 500: internal server error",
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });
});
