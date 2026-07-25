// Coverage for deciding when embedded run results should trigger model fallback.
import { describe, expect, it } from "vitest";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../auto-reply/reply/agent-runner-failure-copy.js";
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

  it("classifies structured provider upstream_error payloads as fallback-worthy", () => {
    const rawError =
      '{"error":{"message":"Upstream request failed","type":"upstream_error","param":"","code":null}}';

    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai-compatible",
      model: "primary-model",
      result: {
        payloads: [
          {
            isError: true,
            text: rawError,
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message: `openai-compatible/primary-model ended with a provider error: ${rawError}`,
      reason: "server_error",
      code: "embedded_error_payload",
      rawError,
    });
  });

  it("classifies structured provider overloaded_error payloads as fallback-worthy", () => {
    const rawError =
      '{"error":{"message":"Provider overloaded","type":"overloaded_error","param":"","code":null}}';

    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai-compatible",
      model: "primary-model",
      result: {
        payloads: [
          {
            isError: true,
            text: rawError,
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message: `openai-compatible/primary-model ended with a provider error: ${rawError}`,
      reason: "overloaded",
      code: "embedded_error_payload",
      rawError,
    });
  });

  it("classifies generic external runner failure text as fallback-worthy", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      result: {
        payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message:
        "claude-cli/claude-sonnet-4-6 ended with a generic external runner failure: " +
        GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
      reason: "format",
      code: "generic_external_run_failure",
      rawError: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
    });
  });

  it("classifies Codex subscription usage-limit payloads as rate-limit fallback", () => {
    const errorText =
      "You've reached your Codex subscription usage limit. " +
      "Next reset in 32 minutes, Jun 20 at 3:44 PM EDT. " +
      "Wait until the reset time, use another Codex account if available, " +
      "or switch to another configured model/provider.";

    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text: errorText,
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toEqual({
      message: "openai/gpt-5.5 ended with a provider error: " + errorText,
      reason: "rate_limit",
      code: "embedded_error_payload",
      rawError: errorText,
    });
  });

  it("does not classify normal visible assistant output as fallback-worthy", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      result: {
        payloads: [{ text: "Here is the requested answer." }],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry generic external runner failure text mixed with non-text visible content", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      result: {
        payloads: [
          {
            text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
            mediaUrl: "https://example.com/failure-screenshot.png",
            channelData: { delivered: true },
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry generic external runner failure text mixed with interactive content", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      result: {
        payloads: [
          {
            text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
            interactive: { type: "button", label: "Retry" },
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not retry generic external runner failure text after committed delivery", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      result: {
        payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
        messagingToolSentTexts: ["already delivered"],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });

  it("preserves hook block results with generic external runner failure text", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      result: {
        payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
        meta: {
          durationMs: 42,
          error: {
            kind: "hook_block",
            message: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
          },
        },
      },
    });

    expect(result).toBeNull();
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

  it("does not fallback on deliberate silent terminal replies after payload filtering", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          finalAssistantRawText: "NO_REPLY",
          finalAssistantVisibleText: "NO_REPLY",
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

  it("keeps tool-authored incomplete summaries fallback-eligible", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [
          {
            isError: true,
            text:
              "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
              "⚠️ Agent couldn't generate a response. Please try again.",
          },
        ],
        meta: {
          durationMs: 42,
          replayInvalid: true,
          agentHarnessResultClassification: "empty",
          toolSummary: {
            calls: 1,
          },
          error: {
            kind: "incomplete_turn",
            message: "Agent couldn't generate a response.",
            fallbackSafe: true,
            terminalPresentation: true,
          },
        },
      },
    });

    expect(result).toEqual({
      message:
        "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
        "⚠️ Agent couldn't generate a response. Please try again.",
      reason: "format",
      code: "incomplete_result",
      preserveResultOnExhaustion: true,
      preserveResultPriority: 1,
    });
  });

  it("does not fallback after structured replay state records potential side effects", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          replayInvalid: true,
          agentHarnessResultClassification: "reasoning-only",
        },
      },
    });

    expect(result).toBeNull();
  });

  it("keeps side-effecting incomplete tool turns out of fallback before harness classification", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [{ isError: true, text: "Agent couldn't generate a response." }],
        meta: {
          durationMs: 42,
          agentHarnessResultClassification: "empty",
          toolSummary: {
            calls: 1,
          },
          error: {
            kind: "incomplete_turn",
            message: "Agent couldn't generate a response.",
            fallbackSafe: false,
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it("does not trust fallback-safe metadata over concrete outbound delivery evidence", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "openai",
      model: "gpt-5.5",
      result: {
        payloads: [{ isError: true, text: "Agent couldn't generate a response." }],
        messagingToolSentTexts: ["already delivered"],
        meta: {
          durationMs: 42,
          error: {
            kind: "incomplete_turn",
            message: "Agent couldn't generate a response.",
            fallbackSafe: true,
          },
        },
      },
    });

    expect(result).toBeNull();
  });
});
