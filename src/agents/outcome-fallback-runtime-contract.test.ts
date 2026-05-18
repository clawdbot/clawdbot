import {
  createContractFallbackConfig,
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithModelFallback } from "./model-fallback.js";
import { classifyEmbeddedPiRunResultForModelFallback } from "./pi-embedded-runner/result-fallback-classifier.js";

vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: () => false,
}));

describe("Outcome/fallback runtime contract - Pi fallback classifier", () => {
  beforeAll(async () => {
    await runWithModelFallback({
      cfg: {} as OpenClawConfig,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
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
      const fallback = classifyEmbeddedPiRunResultForModelFallback({
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

    const result = await runWithModelFallback({
      cfg: createContractFallbackConfig() as unknown as OpenClawConfig,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      run,
      classifyResult: ({ provider, model, result }) =>
        classifyEmbeddedPiRunResultForModelFallback({
          provider,
          model,
          result,
        }),
      skipAuthProfileRuntime: true,
    });

    expect(result.result).toBe(fallback);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.at(1)).toEqual([
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
      OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
    ]);
    expect(result.attempts[0]?.provider).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider);
    expect(result.attempts[0]?.model).toBe(OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel);
    expect(result.attempts[0]?.reason).toBe("format");
    expect(result.attempts[0]?.code).toBe("empty_result");
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
      name: "tool summary side effect",
      result: createContractRunResult({
        meta: { durationMs: 1, toolSummary: { calls: 1, tools: ["message"] } },
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
    for (const contractCase of nonFallbackCases) {
      expect(
        classifyEmbeddedPiRunResultForModelFallback({
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
    const contractCase = nonFallbackCases[0];
    const run = vi.fn().mockResolvedValue(contractCase.result);
    const result = await runWithModelFallback({
      cfg: createContractFallbackConfig() as unknown as OpenClawConfig,
      provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
      model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
      run,
      classifyResult: ({ provider, model, result }) =>
        classifyEmbeddedPiRunResultForModelFallback({
          provider,
          model,
          result,
          hasDirectlySentBlockReply: contractCase.hasDirectlySentBlockReply,
          hasBlockReplyPipelineOutput: contractCase.hasBlockReplyPipelineOutput,
        }),
      skipAuthProfileRuntime: true,
    });

    expect(result.result).toBe(contractCase.result);
    expect(result.attempts).toStrictEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
