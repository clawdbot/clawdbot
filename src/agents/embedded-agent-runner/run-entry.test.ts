import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type CandidateOptions = {
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
};

type FallbackRunnerParams = {
  provider: string;
  model: string;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
  classifyResult?: (params: {
    result: EmbeddedAgentRunResult;
    provider: string;
    model: string;
    attempt: number;
    total: number;
  }) => unknown;
  mergeExhaustedResult?: (params: {
    latestResult: EmbeddedAgentRunResult;
    preferredResult: EmbeddedAgentRunResult;
  }) => EmbeddedAgentRunResult;
  run: (
    provider: string,
    model: string,
    options?: CandidateOptions,
  ) => Promise<EmbeddedAgentRunResult>;
};

const state = vi.hoisted(() => ({
  runWithModelFallback: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(async (_params: unknown) => undefined),
}));

vi.mock("../model-fallback.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => state.runWithModelFallback(params),
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (params: unknown) =>
    state.ensureSelectedAgentHarnessPlugin(params),
}));

function makeResult(params: {
  provider: string;
  model: string;
  classification?: "empty";
}): EmbeddedAgentRunResult {
  return {
    payloads: params.classification ? [] : [{ text: "recovered" }],
    meta: {
      durationMs: 10,
      aborted: false,
      yielded: true,
      providerStarted: true,
      stopReason: "end_turn",
      agentHarnessResultClassification: params.classification,
      agentMeta: {
        sessionId: "session-1",
        provider: params.provider,
        model: params.model,
      },
    },
  };
}

describe("runEmbeddedAgentEntry", () => {
  beforeEach(() => {
    state.ensureSelectedAgentHarnessPlugin.mockClear();
    state.runWithModelFallback
      .mockReset()
      .mockImplementation(async (params: FallbackRunnerParams) => {
        await params.prepareAgentHarnessRuntime?.({
          provider: params.provider,
          model: params.model,
        });
        const primaryResult = await params.run(params.provider, params.model, {
          allowTransientCooldownProbe: true,
        });
        const classification = await params.classifyResult?.({
          result: primaryResult,
          provider: params.provider,
          model: params.model,
          attempt: 1,
          total: 2,
        });
        expect(classification).toBeTruthy();
        const fallbackProvider = "fallback-provider";
        const fallbackModel = "fallback-model";
        await params.prepareAgentHarnessRuntime?.({
          provider: fallbackProvider,
          model: fallbackModel,
        });
        const result = await params.run(fallbackProvider, fallbackModel, {
          isFinalFallbackAttempt: true,
        });
        return {
          outcome: "completed" as const,
          result,
          provider: fallbackProvider,
          model: fallbackModel,
          attempts: [
            {
              provider: params.provider,
              model: params.model,
              error: "empty result",
              reason: "format" as const,
            },
          ],
        };
      });
  });

  it("keeps shared fallback and terminal behavior aligned across entry modes", async () => {
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    const cfg: OpenClawConfig = {};
    const runMode = async (behavior: "channel-delivery" | "command-rpc") => {
      const candidateCalls: Array<{
        provider: string;
        model: string;
        isFallbackRetry: boolean;
      }> = [];
      const reconciled: Array<{ provider: string; model: string }> = [];
      const result = await runEmbeddedAgentEntry({
        selection: { cfg, provider: "primary-provider", model: "primary-model" },
        identity: {
          runId: `run-${behavior}`,
          agentId: "main",
          sessionId: "session-1",
        },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" },
          resolveRuntimeOverride: () => undefined,
        },
        behavior:
          behavior === "channel-delivery"
            ? {
                kind: "channel-delivery" as const,
                readDeliveryEvidence: () => ({
                  hasDirectlySentBlockReply: false,
                  hasBlockReplyPipelineOutput: false,
                }),
              }
            : {
                kind: "command-rpc" as const,
                hasCommittedSideEffect: () => false,
              },
        sessionOverride: {
          kind: "reconcile-completed",
          reconcile: async (candidate) => {
            reconciled.push(candidate);
          },
        },
        runCandidate: async (provider, model, options) => {
          candidateCalls.push({ provider, model, isFallbackRetry: options.isFallbackRetry });
          return makeResult({
            provider,
            model,
            classification: options.isFallbackRetry ? undefined : "empty",
          });
        },
      });
      await result.settleSessionOverride();
      await result.settleSessionOverride();
      return { result, candidateCalls, reconciled };
    };

    const channel = await runMode("channel-delivery");
    const command = await runMode("command-rpc");

    expect(channel.candidateCalls).toEqual(command.candidateCalls);
    expect(channel.result.outcome).toBe("completed");
    expect(channel.result.provider).toBe("fallback-provider");
    expect(channel.result.model).toBe("fallback-model");
    expect(channel.result.attempts).toEqual(command.result.attempts);
    expect(channel.result.terminal).toEqual(command.result.terminal);
    expect(channel.reconciled).toEqual(command.reconciled);
    expect(channel.reconciled).toEqual([
      { provider: "fallback-provider", model: "fallback-model" },
    ]);
  });

  it("leaves maintenance fallback classification to thrown candidate errors", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      expect(params.classifyResult).toBeUndefined();
      expect(params.mergeExhaustedResult).toBeUndefined();
      const result = await params.run(params.provider, params.model);
      return {
        outcome: "completed" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "maintenance", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) => makeResult({ provider, model }),
    });

    expect(result.result.payloads).toEqual([{ text: "recovered" }]);
  });

  it("retains non-visible follow-up results for terminal delivery", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model);
      expect(
        params.classifyResult?.({
          result,
          provider: params.provider,
          model: params.model,
          attempt: 1,
          total: 1,
        }),
      ).toMatchObject({
        code: "empty_result",
        preserveResultOnExhaustion: true,
        preserveResultPriority: -1,
      });
      return {
        outcome: "exhausted" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "followup", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: { kind: "followup-delivery" },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) =>
        makeResult({ provider, model, classification: "empty" }),
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.result.payloads).toEqual([]);
  });
});
