// Focused incomplete-turn behavior coverage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_RESPONSE_RETRY_INSTRUCTION,
  runEmbeddedAgent,
  makeLastAssistant,
  makeRunParams,
  expectWarnMessageWith,
  runAttemptCall,
} from "./run.incomplete-turn.test-helpers.js";
import {
  mockedClassifyFailoverReason,
  mockedRunEmbeddedAttempt,
  mockedResolveModelAsync,
  resetRunIncompleteTurnOwnerMocks,
} from "./run.incomplete-turn.test-support.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";

describe("runEmbeddedAgent incomplete-turn safety", () => {
  beforeEach(() => {
    resetRunIncompleteTurnOwnerMocks();
  });

  it("retries zero-token empty Claude stop turns with a visible-answer continuation instruction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          provider: "anthropic",
          model: "claude-opus-4.7",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Claude answer."],
        lastAssistant: makeLastAssistant({
          provider: "anthropic",
          model: "claude-opus-4.7",
          content: [{ type: "text", text: "Visible Claude answer." }],
          usage: {
            input: 100,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 105,
          },
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-empty-zero-usage-claude-continuation", {
        provider: "anthropic",
        model: "claude-opus-4.7",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("retries empty openai-compatible stop turns even when the backend reports output tokens", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "qwen3.6-27b",
        provider: "llamacpp",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          api: "openai-completions",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          usage: {
            input: 512,
            output: 103,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 615,
          },
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible local answer."],
        lastAssistant: makeLastAssistant({
          api: "openai-completions",
          provider: "llamacpp",
          model: "qwen3.6-27b",
          content: [{ type: "text", text: "Visible local answer." }],
          usage: {
            input: 640,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 645,
          },
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-empty-openai-compatible-stop-continuation", {
        provider: "llamacpp",
        model: "qwen3.6-27b",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("retries empty Anthropic-compatible stop turns even when the provider is not Kimi", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "claude-opus-4-7",
        provider: "sub2api",
        contextWindow: 200000,
        api: "anthropic-messages",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          api: "anthropic-messages",
          provider: "sub2api",
          model: "claude-opus-4-7",
          usage: {
            input: 2048,
            output: 3100,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 5148,
          },
        }),
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Visible Anthropic-compatible answer."],
        lastAssistant: makeLastAssistant({
          api: "anthropic-messages",
          provider: "sub2api",
          model: "claude-opus-4-7",
          content: [{ type: "text", text: "Visible Anthropic-compatible answer." }],
          usage: {
            input: 2300,
            output: 8,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2308,
          },
        }),
      }),
    );

    await runEmbeddedAgent(
      makeRunParams("run-empty-anthropic-compatible-stop-continuation", {
        provider: "sub2api",
        model: "claude-opus-4-7",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const secondCall = runAttemptCall(1);
    expect(secondCall.prompt).toContain(EMPTY_RESPONSE_RETRY_INSTRUCTION);
    expectWarnMessageWith("empty response detected");
  });

  it("surfaces an error after exhausting empty-response retries", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [{ type: "text", text: "" }],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-empty-response-exhausted", { model: "gpt-5.4" }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expectWarnMessageWith("empty response retries exhausted");
  });

  it("surfaces an error after exhausting reasoning-only retries without a visible answer", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_reasoning_exhausted",
                type: "reasoning",
              }),
            },
          ],
        }),
      }),
    );

    const result = await runEmbeddedAgent(
      makeRunParams("run-reasoning-only-exhausted", {
        model: "gpt-5.4",
        reasoningLevel: "on",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("Please try again");
    expectWarnMessageWith("reasoning-only retries exhausted");
  });

  it("preserves a terminal tool presentation after reasoning-only retries are exhausted", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    const reasoningOnlyAttempt = async () =>
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: makeLastAssistant({
          stopReason: "end_turn",
          model: "gpt-5.4",
          content: [
            {
              type: "thinking",
              thinking: "internal reasoning",
              thinkingSignature: JSON.stringify({
                id: "rs_reasoning_terminal_presentation",
                type: "reasoning",
              }),
            },
          ],
        }),
      });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      (
        attemptParams as {
          onToolOutcome?: (observation: {
            toolName: string;
            argsHash: string;
            resultHash: string;
            terminalPresentation?: string;
          }) => void;
        }
      ).onToolOutcome?.({
        toolName: "web_fetch",
        argsHash: "args",
        resultHash: "result",
        terminalPresentation: "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      });
      return reasoningOnlyAttempt();
    });
    mockedRunEmbeddedAttempt.mockImplementation(reasoningOnlyAttempt);

    const result = await runEmbeddedAgent(
      makeRunParams("run-reasoning-terminal-presentation", {
        model: "gpt-5.4",
        reasoningLevel: "on",
      }),
    );

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.payloads).toEqual([
      {
        text:
          "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
  });
});
