import { describe, expect, it, vi } from "vitest";
import {
  createContractFallbackConfig,
  createContractRunResult,
  OUTCOME_FALLBACK_RUNTIME_CONTRACT,
} from "../../test/helpers/agents/outcome-fallback-runtime-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithModelFallback } from "./model-fallback.js";
import { classifyEmbeddedPiRunResultForModelFallback } from "./pi-embedded-runner/result-fallback-classifier.js";

vi.mock("./auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: () => false,
}));

describe("Outcome/fallback runtime contract - Pi fallback classifier", () => {
  it.each([
    ["empty", "empty_result"],
    ["reasoning-only", "reasoning_only_result"],
    ["planning-only", "planning_only_result"],
  ] as const)(
    "maps harness classification %s to a format fallback code",
    (classification, code) => {
      expect(
        classifyEmbeddedPiRunResultForModelFallback({
          provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
          model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
          result: createContractRunResult({
            meta: {
              durationMs: 1,
              agentHarnessResultClassification: classification,
            },
          }),
        }),
      ).toMatchObject({
        reason: "format",
        code,
      });
    },
  );

  it.each([
    ["empty", "empty_result"],
    ["reasoning-only", "reasoning_only_result"],
    ["planning-only", "planning_only_result"],
  ] as const)(
    "advances to the configured fallback after a classified GPT-5 %s terminal result",
    async (classification, code) => {
      const primary = createContractRunResult({
        meta: {
          durationMs: 1,
          agentHarnessResultClassification: classification,
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
      });

      expect(result.result).toBe(fallback);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]).toEqual([
        OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackProvider,
        OUTCOME_FALLBACK_RUNTIME_CONTRACT.fallbackModel,
      ]);
      expect(result.attempts[0]).toMatchObject({
        provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
        model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        reason: "format",
        code,
      });
    },
  );

  it.each([
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
  ])("does not fallback for $name", async (contractCase) => {
    expect(
      classifyEmbeddedPiRunResultForModelFallback({
        provider: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryProvider,
        model: OUTCOME_FALLBACK_RUNTIME_CONTRACT.primaryModel,
        result: contractCase.result,
        hasDirectlySentBlockReply: contractCase.hasDirectlySentBlockReply,
        hasBlockReplyPipelineOutput: contractCase.hasBlockReplyPipelineOutput,
      }),
    ).toBeNull();

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
    });

    expect(result.result).toBe(contractCase.result);
    expect(result.attempts).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
