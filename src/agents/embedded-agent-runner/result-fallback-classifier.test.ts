// Coverage for deciding when embedded run results should trigger model fallback.
import { describe, expect, it } from "vitest";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../failover/user-copy.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
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

  it("classifies Google invalid-key result payloads before fallback settlement", () => {
    const rawError =
      "Google Generative AI API error (400): API key not valid. Please pass a valid API key. [code=INVALID_ARGUMENT]";

    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      result: {
        payloads: [{ isError: true, text: rawError }],
        meta: { durationMs: 42 },
      },
    });

    expect(result).toEqual({
      message: `google/gemini-3.1-pro-preview ended with a provider error: ${rawError}`,
      reason: "auth",
      code: "embedded_error_payload",
      rawError,
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

  it("advances to the configured fallback after a generic external runner failure", async () => {
    const runs: Array<{ provider: string; model: string }> = [];
    const result = await runWithModelFallback({
      cfg: undefined,
      provider: "external",
      model: "primary",
      fallbacksOverride: ["external/fallback"],
      skipAuthProfileRuntime: true,
      run: async (provider, model) => {
        runs.push({ provider, model });
        return runs.length === 1
          ? {
              payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
              meta: { durationMs: 1 },
            }
          : { payloads: [{ text: "fallback ok" }], meta: { durationMs: 1 } };
      },
      classifyResult: ({ provider, model, result: runResult }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: runResult,
        }),
    });

    expect(runs).toEqual([
      { provider: "external", model: "primary" },
      { provider: "external", model: "fallback" },
    ]);
    expect(result.result.payloads).toEqual([{ text: "fallback ok" }]);
    expect(result.attempts[0]).toMatchObject({
      provider: "external",
      model: "primary",
      reason: "format",
      code: "generic_external_run_failure",
      error: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
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

  it.each([
    {
      name: "non-text visible content",
      payload: {
        text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        mediaUrl: "https://example.com/failure-screenshot.png",
        channelData: { delivered: true },
      },
    },
    {
      name: "interactive content",
      payload: {
        text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        interactive: { type: "button", label: "Retry" },
      },
    },
  ])("does not retry generic external runner failure text with $name", ({ payload }) => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "external",
        model: "primary",
        result: { payloads: [payload], meta: { durationMs: 42 } },
      }),
    ).toBeNull();
  });

  it("does not retry generic external runner failure text after committed delivery", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "external",
        model: "primary",
        result: {
          payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
          messagingToolSentTexts: ["already delivered"],
          meta: { durationMs: 42 },
        },
      }),
    ).toBeNull();
  });

  it("preserves hook blocks with generic external runner failure text", () => {
    expect(
      classifyEmbeddedAgentRunResultForModelFallback({
        provider: "external",
        model: "primary",
        result: {
          payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
          meta: {
            durationMs: 42,
            error: { kind: "hook_block", message: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
          },
        },
      }),
    ).toBeNull();
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

  it.each([
    {
      name: "empty",
      payloads: [],
      code: "empty_result",
      suffix: "without a visible assistant reply",
    },
    {
      name: "whitespace-only",
      payloads: [{ text: "   " }],
      code: "empty_result",
      suffix: "without a visible assistant reply",
    },
    {
      name: "reasoning-only",
      payloads: [{ isReasoning: true, text: "thinking about the answer" }],
      code: "reasoning_only_result",
      suffix: "with reasoning only",
    },
    {
      name: "mixed reasoning-plus-blank",
      payloads: [{ isReasoning: true, text: "thinking about the answer" }, { text: "   " }],
      code: "empty_result",
      suffix: "without a visible assistant reply",
    },
    {
      name: "commentary-only",
      payloads: [{ isCommentary: true, text: "progress only" }],
      code: "empty_result",
      suffix: "without a visible assistant reply",
    },
    {
      name: "explicitly hidden",
      payloads: [{ visible: false, text: "internal" }],
      code: "empty_result",
      suffix: "without a visible assistant reply",
    },
    {
      name: "blank error",
      payloads: [{ isError: true, text: " " }],
      code: "empty_result",
      suffix: "without a visible assistant reply",
    },
  ])("classifies $name non-GPT completions as fallback-worthy", ({ payloads, code, suffix }) => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "zai",
      model: "glm-5.2",
      result: {
        payloads,
        meta: { durationMs: 42 },
      },
    });

    expect(result).toEqual({
      message: `zai/glm-5.2 ended ${suffix}`,
      reason: "format",
      code,
    });
  });

  it.each([
    {
      name: "mixed reasoning-plus-visible text",
      payloads: [{ isReasoning: true, text: "thinking" }, { text: "Here is the answer" }],
    },
    { name: "media-only", payloads: [{ mediaUrl: "https://example.test/result.png" }] },
    {
      name: "rich error",
      payloads: [{ isError: true, mediaUrl: "https://example.test/error.png" }],
    },
  ])("keeps $name completions successful", ({ payloads }) => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "zai",
      model: "glm-5.2",
      result: {
        payloads,
        meta: { durationMs: 42 },
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
