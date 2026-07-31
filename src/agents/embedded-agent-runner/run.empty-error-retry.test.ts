// Coverage for retrying empty errored assistant turns in runEmbeddedAgent.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyAssistantFailoverReason,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

type AssistantContent = NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>["content"];

function emptyErrorAttempt(
  provider: string,
  model: string,
  outputTokens = 0,
  content: AssistantContent = [],
  errorMessage?: string,
): EmbeddedRunAttemptResult {
  // Models can report stopReason=error with no output after tool activity; that
  // is replay-safe only when the attempt metadata records no side effects.
  const assistant = {
    role: "assistant",
    stopReason: "error",
    provider,
    model,
    content,
    usage: { input: 100, output: outputTokens, totalTokens: 100 + outputTokens },
    ...(errorMessage ? { errorMessage } : {}),
  } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
  return makeAttemptResult({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

function successAttempt(provider: string, model: string): EmbeddedRunAttemptResult {
  const assistant = {
    role: "assistant",
    stopReason: "stop",
    provider,
    model,
    content: [{ type: "text", text: "Done." }],
    usage: { input: 100, output: 5, totalTokens: 105 },
  } as unknown as NonNullable<EmbeddedRunAttemptResult["lastAssistant"]>;
  return makeAttemptResult({
    assistantTexts: ["Done."],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

describe("runEmbeddedAgent silent-error retry", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("retries when a turn ends with stopReason=error and zero output tokens", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("ollama", "glm-5.1:cloud"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-basic",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("retries when stopReason=error emitted only thinking blocks and output tokens", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("anthropic", "claude-opus-4-8", 1120, [
        {
          type: "thinking",
          thinking: "internal reasoning before provider error",
          thinkingSignature: JSON.stringify({ id: "rs_error", type: "reasoning" }),
        },
      ]),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-4-8"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-empty-error-retry-thinking-only",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("retries thinking-only unknown provider errors before assistant failover", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt(
        "anthropic",
        "claude-opus-4-8",
        1120,
        [
          {
            type: "thinking",
            thinking: "internal reasoning before provider error",
            thinkingSignature: JSON.stringify({ id: "rs_error", type: "reasoning" }),
          },
        ],
        "An unknown error occurred",
      ),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-4-8"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-empty-error-retry-before-assistant-failover",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("does not intercept recognized timeout failover errors", async () => {
    mockedClassifyAssistantFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt(
        "anthropic",
        "claude-opus-4-8",
        1120,
        [
          {
            type: "thinking",
            thinking: "internal reasoning before provider error",
            thinkingSignature: JSON.stringify({ id: "rs_error", type: "reasoning" }),
          },
        ],
        "LLM request timed out.",
      ),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-empty-error-retry-timeout",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries server_error when the attempt is otherwise silent and side-effect-free", async () => {
    mockedClassifyAssistantFailoverReason.mockReturnValue("server_error");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("anthropic", "claude-opus-4-8", 0, [], "Internal server error"),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-4-8"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-empty-error-retry-server-error",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("does not intercept concrete non-transient failover errors", async () => {
    mockedClassifyFailoverReason.mockReturnValue("model_not_found");
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt(
        "anthropic",
        "missing-model",
        1120,
        [
          {
            type: "thinking",
            thinking: "internal reasoning before provider error",
            thinkingSignature: JSON.stringify({ id: "rs_missing_model", type: "reasoning" }),
          },
        ],
        "model not found",
      ),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "missing-model",
      runId: "run-empty-error-retry-non-transient",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("caps retries at MAX_EMPTY_ERROR_RETRIES and surfaces incomplete-turn error", async () => {
    // 1 initial + 3 retries = 4 attempts, all returning empty-error.
    for (let i = 0; i < 4; i += 1) {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(emptyErrorAttempt("ollama", "glm-5.1:cloud"));
    }

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-exhausted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("does not retry when stopReason=error but output tokens > 0", async () => {
    // Model produced something before erroring; surfacing that text is better
    // than silent resubmission.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("ollama", "glm-5.1:cloud", 12),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-with-output",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry when stopReason=stop and output=0 (out of scope)", async () => {
    // Clean stop with no output is a legitimate silent reply (e.g. NO_REPLY
    // token path), not a crash. Use a plain provider/model so this test stays
    // scoped to the silent-error retry instead of the empty-response retry.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "stop",
          provider: "plain-provider",
          model: "plain-model",
          content: [],
          usage: { input: 100, output: 0, totalTokens: 100 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "plain-provider",
      model: "plain-model",
      runId: "run-empty-error-retry-skip-clean-stop",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("retries for frontier models too — the fix is model-agnostic", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      emptyErrorAttempt("anthropic", "claude-opus-4-7"),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("anthropic", "claude-opus-4-7"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-7",
      runId: "run-empty-error-retry-frontier",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it("does not retry when the failed attempt recorded side effects", async () => {
    // Without per-attempt metadata, cumulative side effects remain fail-closed.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
        lastAssistant: {
          role: "assistant",
          stopReason: "error",
          provider: "ollama",
          model: "glm-5.1:cloud",
          content: [],
          usage: { input: 100, output: 0, totalTokens: 100 },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        toolMetas: [{ toolName: "browser", replaySafe: false }],
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("does not retry when currentAttemptReplayMetadata records same-attempt tool side effects", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        ...emptyErrorAttempt("ollama", "glm-5.1:cloud"),
        currentAttemptReplayMetadata: {
          hadPotentialSideEffects: true,
          replaySafe: false,
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-skip-same-attempt-tools",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("retries when prior turns had side effects but current 5xx attempt ran no tools", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        ...emptyErrorAttempt("ollama", "glm-5.1:cloud"),
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(successAttempt("ollama", "glm-5.1:cloud"));

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "ollama",
      model: "glm-5.1:cloud",
      runId: "run-empty-error-retry-prior-side-effects",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads).toBeUndefined();
  });

  it.each([
    [
      "client tool calls",
      { clientToolCalls: [{ name: "browser", params: { url: "https://example.com" } }] },
    ],
    ["yield", { yieldDetected: true }],
    ["approval prompts", { didSendDeterministicApprovalPrompt: true }],
    [
      "heartbeat responses",
      {
        heartbeatToolResponse: {
          outcome: "progress",
          notify: false,
          summary: "Still working",
        },
      },
    ],
    ["tool media", { toolMediaUrls: ["file:///tmp/render.png"] }],
    ["voice media", { toolAudioAsVoice: true }],
    ["trusted local media", { toolTrustedLocalMedia: true }],
    [
      "source reply payloads",
      { messagingToolSourceReplyPayloads: [{ text: "Delivered through the source reply." }] },
    ],
    ["delivered source replies", { didDeliverSourceReplyViaMessageTool: true }],
    ["tool errors", { lastToolError: { toolName: "read", error: "read failed" } }],
  ] satisfies Array<[string, Partial<EmbeddedRunAttemptResult>]>)(
    "does not retry after terminal %s",
    async (_label, attemptState) => {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          ...emptyErrorAttempt("anthropic", "claude-opus-4-8", 1120, [
            {
              type: "thinking",
              thinking: "internal reasoning before provider error",
              thinkingSignature: JSON.stringify({ id: "rs_error", type: "reasoning" }),
            },
          ]),
          ...attemptState,
        }),
      );

      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "anthropic",
        model: "claude-opus-4-8",
        runId: `run-empty-error-retry-terminal-${_label.replaceAll(" ", "-")}`,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    },
  );

  it("does not mark incomplete turns fallback-safe after a terminal heartbeat response", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        ...emptyErrorAttempt("anthropic", "claude-opus-4-8", 1120, [
          {
            type: "thinking",
            thinking: "internal reasoning before provider error",
            thinkingSignature: JSON.stringify({ id: "rs_heartbeat_error", type: "reasoning" }),
          },
        ]),
        heartbeatToolResponse: {
          outcome: "progress",
          notify: false,
          summary: "Still working",
        },
      }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-terminal-heartbeat-not-fallback-safe",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: false,
    });
  });
});
