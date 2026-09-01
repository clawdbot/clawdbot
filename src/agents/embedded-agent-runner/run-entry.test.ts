import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FailoverReason } from "../failover/signal.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import type { ModelFallbackRunOptions } from "../model-fallback-attempt.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type FallbackRunnerParams = {
  provider: string;
  model: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareCandidateChain?: (
    candidates: ReadonlyArray<{
      provider: string;
      model: string;
      routeOrigin: "requested" | "configured-fallback";
      routeResolution: "raw";
    }>,
  ) => Promise<void> | void;
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
  canFallbackAfterError?: (params: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => boolean | Promise<boolean>;
  mergeExhaustedResult?: (params: {
    latestResult: EmbeddedAgentRunResult;
    preferredResult: EmbeddedAgentRunResult;
  }) => EmbeddedAgentRunResult;
  run: (
    provider: string,
    model: string,
    options: ModelFallbackRunOptions,
  ) => Promise<EmbeddedAgentRunResult>;
};

function initialAttemptOptions(params: FallbackRunnerParams): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "initial",
    },
  };
}

function fallbackAttemptOptions(
  params: FallbackRunnerParams,
  fallbackReason: FailoverReason,
): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "fallback",
      fallbackReason,
    },
  };
}

const state = vi.hoisted(() => ({
  runWithModelFallback: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(async (_params: unknown) => undefined),
  selectAgentHarness: vi.fn(({ provider }: { provider: string }) => ({
    id: provider === "fallback-provider" ? "fallback-harness" : "primary-harness",
    contextEngineHostCapabilities: [],
  })),
  discardedAttempts: [] as string[],
  finalizedAttempts: [] as string[],
}));

vi.mock("../harness/context-engine-turn-attempt.js", () => ({
  discardContextEngineTurnAttemptIntent: vi.fn(
    ({ facts }: { facts: ContextEngineTurnAttemptFacts }) => {
      state.discardedAttempts.push(facts.sessionIdUsed);
    },
  ),
  finalizeAcceptedContextEngineTurn: vi.fn(async ({ facts }) => {
    state.finalizedAttempts.push(facts.sessionIdUsed);
  }),
}));

vi.mock("../model-fallback-runner.js", () => ({
  runWithModelFallback: (params: FallbackRunnerParams) => state.runWithModelFallback(params),
}));

vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (params: unknown) =>
    state.ensureSelectedAgentHarnessPlugin(params),
}));

vi.mock("../harness/selection.js", () => ({
  selectAgentHarness: (params: { provider: string }) => state.selectAgentHarness(params),
}));

function makeResult(params: {
  provider: string;
  model: string;
  classification?: "empty";
  meta?: Partial<EmbeddedAgentRunResult["meta"]>;
}): EmbeddedAgentRunResult {
  return {
    payloads: params.classification ? [] : [{ text: "recovered" }],
    meta: {
      durationMs: 10,
      aborted: false,
      providerStarted: true,
      stopReason: "completed",
      agentHarnessResultClassification: params.classification,
      agentMeta: {
        sessionId: "session-1",
        provider: params.provider,
        model: params.model,
      },
      ...params.meta,
    },
  };
}

function recordTurnAttempt(
  record: ((facts: ContextEngineTurnAttemptFacts) => void) | undefined,
  label: string,
): void {
  if (!record) {
    throw new Error("expected context-engine turn candidate callback");
  }
  record({
    boundary: {
      admission: {
        agentId: "main",
        sessionId: label,
        sessionKey: `agent:main:${label}`,
        storePath: `/${label}.sqlite`,
        generation: "generation-1",
        entryId: `${label}-user`,
        rawSeq: 1,
        effectiveParentId: null,
        activeMessagePosition: 0,
        logicalTurnId: `${label}-turn`,
        role: "user",
      },
      terminal: {
        agentId: "main",
        sessionId: label,
        sessionKey: `agent:main:${label}`,
        storePath: `/${label}.sqlite`,
        generation: "generation-1",
        entryId: `${label}-assistant`,
        rawSeq: 2,
        effectiveParentId: `${label}-user`,
        activeMessagePosition: 1,
      },
    },
    sessionIdUsed: label,
    promptError: false,
    aborted: false,
    yieldAborted: false,
  });
}

describe("runEmbeddedAgentEntry", () => {
  beforeEach(() => {
    state.discardedAttempts.length = 0;
    state.finalizedAttempts.length = 0;
    state.ensureSelectedAgentHarnessPlugin.mockReset().mockResolvedValue(undefined);
    state.selectAgentHarness
      .mockReset()
      .mockImplementation(({ provider }: { provider: string }) => ({
        id: provider === "fallback-provider" ? "fallback-harness" : "primary-harness",
        contextEngineHostCapabilities: [],
      }));
    state.runWithModelFallback
      .mockReset()
      .mockImplementation(async (params: FallbackRunnerParams) => {
        await params.prepareCandidateChain?.([
          {
            provider: params.provider,
            model: params.model,
            routeOrigin: "requested",
            routeResolution: "raw",
          },
          {
            provider: "fallback-provider",
            model: "fallback-model",
            routeOrigin: "configured-fallback",
            routeResolution: "raw",
          },
        ]);
        await params.prepareAgentHarnessRuntime?.({
          provider: params.provider,
          model: params.model,
          agentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride?.(
            params.provider,
            params.model,
          ),
        });
        const primaryResult = await params.run(params.provider, params.model, {
          ...initialAttemptOptions(params),
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
          agentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride?.(
            fallbackProvider,
            fallbackModel,
          ),
        });
        const result = await params.run(fallbackProvider, fallbackModel, {
          ...fallbackAttemptOptions(params, "format"),
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
      const candidateLeases: object[] = [];
      const reconciled: Array<{ provider: string; model: string }> = [];
      const result = await runEmbeddedAgentEntry({
        selection: { cfg, provider: "primary-provider", model: "primary-model" },
        identity: {
          runId: "run-shared-fallback",
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
          candidateLeases.push(options.contextEngineLogicalTurnLease);
          return makeResult({
            provider,
            model,
            classification: options.isFallbackRetry ? undefined : "empty",
            meta: options.isFallbackRetry
              ? {
                  executionTrace: {
                    winnerProvider: provider,
                    winnerModel: model,
                    attempts: [
                      {
                        provider,
                        model,
                        result: "same_model_transient",
                        reason: "rate_limit",
                      },
                      { provider, model, result: "success" },
                    ],
                    fallbackUsed: false,
                    runner: "embedded",
                  },
                  agentMeta: {
                    sessionId: "session-1",
                    provider,
                    model,
                    terminalReceipt: {
                      runId: "run-shared-fallback",
                      sessionId: "session-1",
                      turnId: "turn-1",
                      requested: { provider, model },
                      effective: { provider, model, responseModel: model },
                      successfulToolNames: [],
                      rerouted: false,
                    },
                  },
                }
              : undefined,
          });
        },
      });
      await result.settleSessionOverride();
      await result.settleSessionOverride();
      return { result, candidateCalls, candidateLeases, reconciled };
    };

    const channel = await runMode("channel-delivery");
    const command = await runMode("command-rpc");

    expect(channel.candidateCalls).toEqual(command.candidateCalls);
    expect(channel.result.outcome).toBe("completed");
    expect(channel.result.provider).toBe("fallback-provider");
    expect(channel.result.model).toBe("fallback-model");
    expect(channel.result.attempts).toEqual(command.result.attempts);
    expect(channel.result.terminal).toEqual(command.result.terminal);
    expect(channel.result.result.meta.executionTrace).toEqual({
      winnerProvider: "fallback-provider",
      winnerModel: "fallback-model",
      attempts: [
        {
          provider: "primary-provider",
          model: "primary-model",
          result: "candidate_failed",
          reason: "format",
        },
        {
          provider: "fallback-provider",
          model: "fallback-model",
          result: "same_model_transient",
          reason: "rate_limit",
        },
        { provider: "fallback-provider", model: "fallback-model", result: "success" },
      ],
      fallbackUsed: true,
      runner: "embedded",
    });
    expect(channel.result.result.meta.agentMeta?.terminalReceipt).toMatchObject({
      requested: { provider: "primary-provider", model: "primary-model" },
      effective: { provider: "fallback-provider", model: "fallback-model" },
      rerouted: true,
    });
    expect(channel.result.terminal.metadata.terminalReceipt).toMatchObject({
      requested: { provider: "primary-provider", model: "primary-model" },
      effective: { provider: "fallback-provider", model: "fallback-model" },
      rerouted: true,
      terminalDisposition: "not-visible",
    });
    expect(channel.candidateLeases[0]).toBe(channel.candidateLeases[1]);
    expect(state.selectAgentHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fallback-provider",
        modelId: "fallback-model",
      }),
    );
    expect(channel.reconciled).toEqual(command.reconciled);
    expect(channel.reconciled).toEqual([
      { provider: "fallback-provider", model: "fallback-model" },
    ]);
  });

  it("preflights caller-resolved CLI hosts instead of the model harness", async () => {
    const resolveContextEngineHost = vi.fn((provider: string) => ({
      id: `cli:${provider}`,
      label: `CLI backend "${provider}"`,
      capabilities: [],
    }));
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");

    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "cli-host-preflight", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
        resolveContextEngineHost,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) =>
        makeResult({
          provider,
          model,
          classification: provider === "primary-provider" ? "empty" : undefined,
        }),
    });

    expect(resolveContextEngineHost).toHaveBeenCalledWith("primary-provider", "primary-model");
    expect(resolveContextEngineHost).toHaveBeenCalledWith("fallback-provider", "fallback-model");
    expect(state.selectAgentHarness).not.toHaveBeenCalled();
  });

  it("registers lazy harness plugins before selecting preflight hosts", async () => {
    const events: string[] = [];
    state.ensureSelectedAgentHarnessPlugin.mockImplementation(async (params: unknown) => {
      events.push(`ensure:${(params as { provider: string }).provider}`);
    });
    state.selectAgentHarness.mockImplementation(({ provider }: { provider: string }) => {
      events.push(`select:${provider}`);
      return {
        id: `${provider}-harness`,
        contextEngineHostCapabilities: [],
      };
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");

    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "lazy-plugin-preflight", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: (provider) => `${provider}-harness`,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) =>
        makeResult({
          provider,
          model,
          classification: provider === "primary-provider" ? "empty" : undefined,
        }),
    });

    expect(events).toEqual([
      "ensure:primary-provider",
      "select:primary-provider",
      "ensure:fallback-provider",
      "select:fallback-provider",
    ]);
  });

  it("leaves maintenance fallback classification to thrown candidate errors", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      expect(params.classifyResult).toBeUndefined();
      expect(params.mergeExhaustedResult).toBeUndefined();
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
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

  it("finalizes only the accepted fallback candidate after its attempt releases ownership", async () => {
    let primaryReleased = false;
    let fallbackReleased = false;
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "settle-winner", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        const label = provider === "primary-provider" ? "primary" : "fallback";
        recordTurnAttempt(options.onContextEngineTurnCandidate, label);
        if (label === "primary") {
          primaryReleased = true;
        } else {
          fallbackReleased = true;
        }
        return makeResult({
          provider,
          model,
          classification: label === "primary" ? "empty" : undefined,
        });
      },
    });

    expect(primaryReleased).toBe(true);
    expect(fallbackReleased).toBe(true);
    expect(state.finalizedAttempts).toEqual(["fallback"]);
  });

  it("accepts an empty result after a committed side effect and finalizes it once", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      expect(
        params.classifyResult?.({
          result,
          provider: params.provider,
          model: params.model,
          attempt: 1,
          total: 1,
        }),
      ).toBeUndefined();
      return {
        outcome: "completed" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-side-effect", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => true },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
        return makeResult({ provider, model, classification: "empty" });
      },
    });

    expect(state.finalizedAttempts).toEqual(["candidate"]);
  });

  it("does not finalize any candidate when fallback is exhausted", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const preferredResult = await params.run(
        params.provider,
        params.model,
        initialAttemptOptions(params),
      );
      const latestResult = await params.run(
        "fallback-provider",
        "fallback-model",
        fallbackAttemptOptions(params, "unknown"),
      );
      return {
        outcome: "exhausted" as const,
        result: params.mergeExhaustedResult?.({ latestResult, preferredResult }) ?? latestResult,
        provider: "fallback-provider",
        model: "fallback-model",
        attempts: [],
      };
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-exhausted", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        recordTurnAttempt(options.onContextEngineTurnCandidate, provider);
        return makeResult({ provider, model, classification: "empty" });
      },
    });

    expect(state.finalizedAttempts).toEqual([]);
    expect(state.discardedAttempts).toEqual(["fallback-provider"]);
  });

  it.each([
    {
      label: "yielded",
      meta: { yielded: true, livenessState: "paused" as const, stopReason: "end_turn" },
    },
    { label: "aborted", meta: { aborted: true, stopReason: "error" } },
    { label: "timed out", meta: { timeoutPhase: "provider" as const, stopReason: "timeout" } },
    {
      label: "errored",
      meta: {
        error: { kind: "retry_limit" as const, message: "provider failed" },
        stopReason: "error",
      },
    },
  ])("does not finalize a $label candidate", async ({ meta }) => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      return {
        outcome: "completed" as const,
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId: "settle-non-terminal", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => true },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
        return makeResult({ provider, model, meta });
      },
    });

    expect(state.finalizedAttempts).toEqual([]);
    expect(state.discardedAttempts).toEqual(["candidate"]);
  });

  it("does not finalize a candidate when classification throws", async () => {
    const classificationError = new Error("classification failed");
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
      params.classifyResult?.({
        result,
        provider: params.provider,
        model: params.model,
        attempt: 1,
        total: 1,
      });
      throw classificationError;
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    await expect(
      runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "provider", model: "model" },
        identity: { runId: "settle-classifier-throw", agentId: "main", sessionId: "session-1" },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" },
          resolveRuntimeOverride: () => undefined,
        },
        behavior: {
          kind: "channel-delivery",
          readDeliveryEvidence: () => {
            throw classificationError;
          },
        },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          recordTurnAttempt(options.onContextEngineTurnCandidate, "candidate");
          return makeResult({ provider, model, classification: "empty" });
        },
      }),
    ).rejects.toBe(classificationError);

    expect(state.finalizedAttempts).toEqual([]);
    expect(state.discardedAttempts).toEqual(["candidate"]);
  });

  it("does not replay a thrown channel-delivery attempt that already delivered its reply (#113788)", async () => {
    const failure = new Error("insufficient quota");
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      // Mirror the fallback loop's thrown-error exit: the attempt error bypasses
      // result classification, so the error-path backstop is the only guard that
      // can stop the next candidate from replaying the delivered turn.
      await expect(
        params.run(params.provider, params.model, initialAttemptOptions(params)),
      ).rejects.toBe(failure);
      const allowed = await params.canFallbackAfterError?.({
        provider: params.provider,
        model: params.model,
        error: failure,
        attempt: 1,
        total: 2,
      });
      expect(allowed).toBe(false);
      throw failure;
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    const runCandidate = vi.fn(async (_provider: string, _model: string) => {
      throw failure;
    });

    await expect(
      runEmbeddedAgentEntry({
        selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
        identity: { runId: "channel-throw", agentId: "main", sessionId: "session-1" },
        harness: {
          workspaceDir: "/tmp/workspace",
          preparation: { kind: "direct" },
          resolveRuntimeOverride: () => undefined,
        },
        behavior: {
          kind: "channel-delivery",
          readDeliveryEvidence: () => ({
            hasDirectlySentBlockReply: true,
            hasBlockReplyPipelineOutput: false,
          }),
        },
        sessionOverride: { kind: "preserve" },
        runCandidate,
      }),
    ).rejects.toBe(failure);

    expect(runCandidate).toHaveBeenCalledTimes(1);
  });

  it("still falls back when a thrown channel-delivery attempt delivered nothing", async () => {
    const failure = new Error("insufficient quota");
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await expect(
        params.run(params.provider, params.model, initialAttemptOptions(params)),
      ).rejects.toBe(failure);
      const allowed = await params.canFallbackAfterError?.({
        provider: params.provider,
        model: params.model,
        error: failure,
        attempt: 1,
        total: 2,
      });
      expect(allowed).toBe(true);
      const fallbackProvider = "fallback-provider";
      const fallbackModel = "fallback-model";
      const result = await params.run(fallbackProvider, fallbackModel, {
        ...fallbackAttemptOptions(params, "billing"),
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
            error: failure.message,
            reason: "billing" as const,
          },
        ],
      };
    });
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    const runCandidate = vi.fn(async (provider: string, model: string) => {
      if (provider === "primary-provider") {
        throw failure;
      }
      return makeResult({ provider, model });
    });

    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "primary-provider", model: "primary-model" },
      identity: { runId: "channel-throw-empty", agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: {
        kind: "channel-delivery",
        readDeliveryEvidence: () => ({
          hasDirectlySentBlockReply: false,
          hasBlockReplyPipelineOutput: false,
        }),
      },
      sessionOverride: { kind: "preserve" },
      runCandidate,
    });

    expect(runCandidate).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("completed");
    expect(result.provider).toBe("fallback-provider");
  });

  it("retains non-visible follow-up results for terminal delivery", async () => {
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      const result = await params.run(params.provider, params.model, initialAttemptOptions(params));
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

  it.each([
    {
      name: "embedded visible reply",
      meta: { finalAssistantVisibleText: "visible", finalAssistantRawText: "visible" },
      expected: { disposition: "visible", text: "visible" },
    },
    {
      name: "CLI exact silence",
      meta: { finalAssistantVisibleText: "NO_REPLY", finalAssistantRawText: "NO_REPLY" },
      expected: { disposition: "silent" },
    },
    {
      name: "CLI punctuation-wrapped silence",
      meta: { finalAssistantVisibleText: "NO_REPLY...", finalAssistantRawText: "NO_REPLY..." },
      expected: { disposition: "silent" },
    },
    {
      name: "normalized silence without raw text",
      meta: { finalAssistantVisibleText: "no_reply" },
      expected: { disposition: "silent" },
    },
    {
      name: "clean empty reply",
      meta: {},
      expected: { disposition: "empty" },
    },
  ])("records the producer-owned terminal snapshot for $name", async ({ name, meta, expected }) => {
    const runId = `terminal-${name}`;
    state.runWithModelFallback.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      outcome: "completed" as const,
      result: await params.run(params.provider, params.model, initialAttemptOptions(params)),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }));
    const { runEmbeddedAgentEntry } = await import("./run-entry.js");
    const result = await runEmbeddedAgentEntry({
      selection: { cfg: {}, provider: "provider", model: "model" },
      identity: { runId, agentId: "main", sessionId: "session-1" },
      harness: {
        workspaceDir: "/tmp/workspace",
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => undefined,
      },
      behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model) => ({
        ...makeResult({ provider, model }),
        meta: {
          ...makeResult({ provider, model }).meta,
          ...meta,
          agentMeta: Object.assign(
            {
              sessionId: "session-1",
              provider,
              model,
            },
            {
              terminalReceipt: {
                runId,
                sessionId: "session-1",
                turnId: "turn-1",
                requested: { provider, model },
                effective: { provider, model, responseModel: model },
                successfulToolNames: ["read"],
                rerouted: false,
              },
            },
          ),
        },
      }),
    });

    expect(result.terminal.metadata.terminalReply).toEqual(expected);
    expect(result.terminal.metadata.terminalReceipt).toMatchObject({
      runId,
      terminalDisposition: expected.disposition === "visible" ? "visible" : "not-visible",
    });
  });
});
