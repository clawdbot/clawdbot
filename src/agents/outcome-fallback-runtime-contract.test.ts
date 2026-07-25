// Verifies embedded runtime outcome classifications drive model fallback correctly.

import { expectDefined } from "@openclaw/normalization-core";
import {
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./embedded-agent-runner/result-fallback-classifier.js";
import { runWithModelFallback } from "./model-fallback.js";

vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: () => false,
}));

const contractFallbackOverride = [
  // Keep fallback target aligned with the plugin-sdk runtime contract fixture.
  `${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider}/${OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel}`,
];

describe("Outcome/fallback runtime contract - embedded runtime fallback classifier", () => {
  beforeAll(async () => {
    await runWithModelFallback({
      cfg: undefined,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      fallbacksOverride: [],
      run: vi.fn().mockResolvedValue(createContractRunResult({ meta: { durationMs: 1 } })),
      skipAuthProfileRuntime: true,
    });
  });

  const fallbackClassificationCases = [
    ["empty", "empty_result"],
    ["reasoning-only", "reasoning_only_result"],
    ["planning-only", "planning_only_result"],
  ] as const;

  it.each(fallbackClassificationCases)(
    "maps harness classification %s to a format fallback code",
    (classification, code) => {
      const fallback = classifyEmbeddedAgentRunResultForModelFallback({
        provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
        model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        result: createContractRunResult({
          meta: {
            durationMs: 1,
            agentHarnessResultClassification: classification,
          },
        }),
      });
      if (!fallback || !("reason" in fallback)) {
        throw new Error(`Expected format fallback detail for ${classification}`);
      }
      expect(fallback?.reason).toBe("format");
      expect(fallback?.code).toBe(code);
    },
  );

  it("advances to the configured fallback after a classified GPT-5 terminal result", async () => {
    const primary = createContractRunResult({
      meta: {
        durationMs: 1,
        agentHarnessResultClassification: "empty",
      },
    });
    const fallback = createContractRunResult({
      payloads: [{ text: "fallback ok" }],
      meta: { durationMs: 1, finalAssistantVisibleText: "fallback ok" },
    });
    const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

    const result = await runWithModelFallback<ReturnType<typeof createContractRunResult>>({
      cfg: undefined,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      fallbacksOverride: contractFallbackOverride,
      run,
      classifyResult: ({ provider, model, result: resultValue }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultValue,
        }),
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
      skipAuthProfileRuntime: true,
    });

    expect(result.outcome).toBe("completed");
    expect(result.result).toBe(fallback);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.at(1)).toEqual([
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
      { isFinalFallbackAttempt: true },
    ]);
    expect(result.attempts[0]?.provider).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider);
    expect(result.attempts[0]?.model).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel);
    expect(result.attempts[0]?.reason).toBe("format");
    expect(result.attempts[0]?.code).toBe("empty_result");
  });

  it("preserves a tool-authored summary when fallback candidates are exhausted", async () => {
    const terminalSummary =
      "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
      "Agent couldn't generate a response.";
    const incomplete = createContractRunResult({
      payloads: [{ text: terminalSummary, isError: true }],
      meta: {
        durationMs: 1,
        toolSummary: { calls: 1, tools: ["web_fetch"] },
        error: {
          kind: "incomplete_turn",
          message: "Agent couldn't generate a response.",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
    });

    const result = await runWithModelFallback<ReturnType<typeof createContractRunResult>>({
      cfg: undefined,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      fallbacksOverride: [],
      run: vi.fn().mockResolvedValue(incomplete),
      classifyResult: ({ provider, model, result: resultValue }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultValue,
        }),
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
      skipAuthProfileRuntime: true,
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result).toBe(incomplete);
    expect(result.result.payloads).toEqual([{ text: terminalSummary, isError: true }]);
    expect(result.attempts).toMatchObject([
      {
        provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
        model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        reason: "format",
        code: "incomplete_result",
      },
    ]);
  });

  it("preserves the latest structured summary after all fallback candidates are exhausted", async () => {
    const primary = createContractRunResult({
      payloads: [{ text: "Primary terminal summary", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn",
          message: "Primary incomplete",
          fallbackSafe: true,
        },
      },
    });
    const fallback = createContractRunResult({
      payloads: [{ text: "Fallback terminal summary", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn",
          message: "Fallback incomplete",
          fallbackSafe: true,
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

    const result = await runWithModelFallback({
      cfg: undefined,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      fallbacksOverride: contractFallbackOverride,
      run,
      classifyResult: ({ provider, model, result: resultValue }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultValue,
        }),
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
      skipAuthProfileRuntime: true,
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result).toBe(fallback);
    expect(result.provider).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider);
    expect(result.model).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel);
    expect(result.attempts).toHaveLength(2);
  });

  it("keeps a richer terminal presentation over a later generic incomplete result", async () => {
    const primary = createContractRunResult({
      payloads: [{ text: "Primary terminal summary", isError: true }],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "primary-session",
          sessionFile: "/tmp/primary.jsonl",
          provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        },
        error: {
          kind: "incomplete_turn",
          message: "Primary incomplete",
          fallbackSafe: true,
          terminalPresentation: true,
        },
      },
    });
    const fallback = createContractRunResult({
      payloads: [{ text: "Generic fallback incomplete", isError: true }],
      meta: {
        durationMs: 1,
        agentMeta: {
          sessionId: "fallback-session",
          sessionFile: "/tmp/fallback.jsonl",
          provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
        },
        executionTrace: {
          winnerProvider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
          winnerModel: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
          fallbackUsed: true,
          runner: "embedded",
          attempts: [
            {
              provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
              model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
              result: "success",
            },
          ],
        },
        error: {
          kind: "incomplete_turn",
          message: "Fallback incomplete",
          fallbackSafe: true,
        },
      },
    });
    const run = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);

    const result = await runWithModelFallback<ReturnType<typeof createContractRunResult>>({
      cfg: undefined,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      fallbacksOverride: contractFallbackOverride,
      run,
      classifyResult: ({ provider, model, result: resultValue }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultValue,
        }),
      mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
      skipAuthProfileRuntime: true,
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result.payloads).toBe(primary.payloads);
    expect(result.result.meta.error).toBe(primary.meta.error);
    expect(result.result.meta.agentMeta).toBe(fallback.meta.agentMeta);
    expect(result.result.meta.executionTrace).toEqual({
      winnerProvider: undefined,
      winnerModel: undefined,
      fallbackUsed: true,
      runner: "embedded",
      attempts: undefined,
    });
    expect(result.provider).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider);
    expect(result.model).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel);
    expect(result.attempts).toHaveLength(2);
  });

  it("rethrows an unrecognized final failure instead of hiding it behind an earlier summary", async () => {
    const primary = createContractRunResult({
      payloads: [{ text: "Primary terminal summary", isError: true }],
      meta: {
        durationMs: 1,
        error: {
          kind: "incomplete_turn",
          message: "Primary incomplete",
          fallbackSafe: true,
        },
      },
    });
    const finalError = new Error("fallback runtime crashed");
    const run = vi.fn().mockResolvedValueOnce(primary).mockRejectedValueOnce(finalError);

    await expect(
      runWithModelFallback<ReturnType<typeof createContractRunResult>>({
        cfg: undefined,
        provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
        model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        fallbacksOverride: contractFallbackOverride,
        run,
        classifyResult: ({ provider, model, result: resultValue }) =>
          classifyEmbeddedAgentRunResultForModelFallback({
            provider,
            model,
            result: resultValue,
          }),
        skipAuthProfileRuntime: true,
      }),
    ).rejects.toBe(finalError);
    expect(run).toHaveBeenCalledTimes(2);
  });

  const nonFallbackCases = [
    {
      name: "intentional NO_REPLY",
      result: createContractRunResult({
        meta: { durationMs: 1, finalAssistantRawText: "NO_REPLY" },
      }),
    },
    {
      name: "visible reply",
      result: createContractRunResult({
        payloads: [{ text: "visible answer" }],
        meta: { durationMs: 1 },
      }),
    },
    {
      name: "abort",
      result: createContractRunResult({
        meta: { durationMs: 1, aborted: true, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "structured replay side effect",
      result: createContractRunResult({
        meta: {
          durationMs: 1,
          replayInvalid: true,
          toolSummary: { calls: 1, tools: ["message"] },
        },
      }),
    },
    {
      name: "messaging text side effect",
      result: createContractRunResult({
        messagingToolSentTexts: ["sent out of band"],
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "messaging media side effect",
      result: createContractRunResult({
        messagingToolSentMediaUrls: ["https://example.test/image.png"],
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "messaging target side effect",
      result: createContractRunResult({
        messagingToolSentTargets: [{ tool: "message", provider: "slack", to: "channel-1" }],
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "cron side effect",
      result: createContractRunResult({
        successfulCronAdds: 1,
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
    },
    {
      name: "direct block reply",
      result: createContractRunResult({
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
      hasDirectlySentBlockReply: true,
    },
    {
      name: "block reply pipeline output",
      result: createContractRunResult({
        meta: { durationMs: 1, agentHarnessResultClassification: "empty" },
      }),
      hasBlockReplyPipelineOutput: true,
    },
  ];

  it("does not classify terminal results with visible output or side effects as fallbacks", () => {
    // Any visible reply or out-of-band side effect is a successful terminal outcome.
    for (const contractCase of nonFallbackCases) {
      expect(
        classifyEmbeddedAgentRunResultForModelFallback({
          provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
          result: contractCase.result,
          hasDirectlySentBlockReply: contractCase.hasDirectlySentBlockReply,
          hasBlockReplyPipelineOutput: contractCase.hasBlockReplyPipelineOutput,
        }),
      ).toBeNull();
    }
  });

  it("keeps running on the primary when terminal output is not classified as fallback", async () => {
    const contractCase = expectDefined(nonFallbackCases[0], "nonFallbackCases[0] test invariant");
    const run = vi.fn().mockResolvedValue(contractCase.result);
    const result = await runWithModelFallback({
      cfg: undefined,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      fallbacksOverride: contractFallbackOverride,
      run,
      classifyResult: ({ provider, model, result: resultLocal }) =>
        classifyEmbeddedAgentRunResultForModelFallback({
          provider,
          model,
          result: resultLocal,
          hasDirectlySentBlockReply: contractCase.hasDirectlySentBlockReply,
          hasBlockReplyPipelineOutput: contractCase.hasBlockReplyPipelineOutput,
        }),
      skipAuthProfileRuntime: true,
    });

    expect(result.outcome).toBe("completed");
    expect(result.result).toBe(contractCase.result);
    expect(result.attempts).toStrictEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
