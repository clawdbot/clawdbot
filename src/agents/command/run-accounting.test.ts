import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createCodeModeStats } from "../code-mode-stats.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../embedded-agent-runner/usage-accumulator.js";
import {
  beginActiveAgentCommandModelCall,
  bindAgentCommandRunAccounting,
  createRunAccountingAccumulator,
  resolveAgentCommandRunAccounting,
  runWithAgentCommandAccounting,
} from "./run-accounting.js";
import type { AgentCommandRunAccountingSnapshot } from "./run-accounting.types.js";

describe("command run accounting", () => {
  it("counts one active auxiliary model call and preserves authoritative zero cost", async () => {
    expect(beginActiveAgentCommandModelCall()).toBeUndefined();
    let snapshot: AgentCommandRunAccountingSnapshot | undefined;

    await runWithAgentCommandAccounting(async (accounting) => {
      const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
      candidate.selectRuntime("embedded");
      candidate.markModelCallInstrumentationInstalled();
      const call = beginActiveAgentCommandModelCall();
      call?.settle({
        outcome: "completed",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
          providerBilledCost: { totalUsd: 0, coverage: "complete" },
        },
      });
      call?.settle({
        outcome: "failed",
        provider: "openai",
        model: "ignored",
      });
      candidate.settle("returned");
      snapshot = accounting.project();
    });

    expect(snapshot).toMatchObject({
      modelCalls: { total: 1, completed: 1, failed: 0 },
      costUsd: 0,
      coverage: {
        modelCalls: { state: "complete" },
        cost: { state: "complete" },
      },
    });
  });

  it("never tops up a provider-billed subtotal with catalog estimates", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    accounting.beginModelCall().settle({
      outcome: "completed",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
        providerBilledCost: { totalUsd: 0.25, coverage: "complete" },
      },
    });
    accounting.beginModelCall().settle({
      outcome: "completed",
      provider: "openai",
      model: "gpt-test",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-test",
                  cost: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      costUsd: 0.25,
      coverage: {
        cost: { state: "partial", reasons: ["partial_provider_billed_cost"] },
      },
    });
  });

  it("accumulates submissions, admitted model calls, usage, tools, and lifecycle samples", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const accounting = createRunAccountingAccumulator(1_000);
    const first = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    first.selectRuntime("embedded");
    first.markModelCallInstrumentationInstalled();
    first.beginAgentSubmission().settle("failed");
    first.beginModelCall().settle("failed");
    const firstStats = createCodeModeStats();
    firstStats.controlCalls.exec = 1;
    firstStats.bridgeLifecycle.registered = 2;
    firstStats.bridgeLifecycle.unresolvedAtExtraction = 2;
    first.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { input: 10, output: 2, total: 12 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 2, tools: ["read", "write"], failures: 1 },
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: firstStats,
      codeModeLifecycleObserved: true,
    });
    first.settle("returned");

    const second = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    second.selectRuntime("embedded");
    second.markModelCallInstrumentationInstalled();
    second.beginAgentSubmission().settle("completed");
    second.beginModelCall().settle("completed");
    second.beginModelCall().settle("completed");
    const secondStats = createCodeModeStats();
    secondStats.controlCalls.exec = 1;
    secondStats.controlCalls.wait = 1;
    secondStats.bridgeLifecycle.registered = 1;
    secondStats.bridgeLifecycle.unresolvedAtExtraction = 1;
    second.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { input: 20, output: 3, cacheRead: 4, total: 27 },
      assistantTurns: 2,
      assistantTurnsObserved: true,
      assistantTurnsWithUsage: 2,
      toolSummary: { calls: 2, tools: ["write", "search"] },
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: secondStats,
      codeModeLifecycleObserved: true,
    });
    accounting.observeCodeModeFinalQuiescence("quiescent");
    second.settle("returned");
    vi.setSystemTime(1_025);

    expect(accounting.project()).toMatchObject({
      candidates: {
        total: 2,
        returned: 2,
        threw: 0,
        runtimes: { embedded: 2, cli: 0, native: 0, cloud: 0, unknown: 0 },
        entries: [
          { provider: "openai", model: "gpt-test", runtime: "embedded", outcome: "returned" },
          { provider: "openai", model: "gpt-test", runtime: "embedded", outcome: "returned" },
        ],
        truncated: 0,
      },
      agentSubmissions: { total: 2, completed: 1, failed: 1 },
      modelCalls: { total: 3, completed: 2, failed: 1 },
      assistantTurns: 3,
      usage: {
        input: 30,
        output: 5,
        cacheRead: 4,
        total: 39,
      },
      toolSummary: {
        calls: 4,
        tools: ["read", "write", "search"],
        failures: 1,
      },
      commandExecutionDurationMs: 25,
      coverage: {
        candidates: { state: "complete" },
        agentSubmissions: { state: "complete" },
        modelCalls: { state: "complete" },
        assistantTurns: { state: "complete" },
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "complete" },
          cacheRead: { state: "partial", reasons: ["partial_usage"] },
          cacheWrite: { state: "unavailable", reasons: ["partial_usage"] },
          reasoningTokens: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
        tools: { state: "complete" },
        agentTime: { state: "unavailable", reasons: ["not_observed"] },
        commandExecutionDuration: { state: "complete" },
        wallLatency: { state: "unavailable", reasons: ["not_instrumented"] },
        providerTransport: { state: "unavailable", reasons: ["not_observed"] },
      },
      codeMode: {
        engaged: true,
        stats: {
          controlCalls: { exec: 2, wait: 1 },
          bridgeLifecycle: { registered: 3 },
        },
        lifecycle: {
          maxUnresolvedAtExtraction: 2,
          attemptsWithUnresolved: 2,
          finalQuiescence: { state: "quiescent" },
        },
      },
    });
    expect(
      accounting.project().codeMode?.stats?.bridgeLifecycle.unresolvedAtExtraction,
    ).toBeUndefined();
    vi.useRealTimers();
  });

  it("marks opaque CLI work unavailable instead of projecting zero as known", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "claude-cli", model: "opus" });
    candidate.selectRuntime("cli");
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      candidates: {
        total: 1,
        returned: 1,
        runtimes: { cli: 1 },
        entries: [{ provider: "claude-cli", model: "opus", runtime: "cli", outcome: "returned" }],
      },
      coverage: {
        candidates: { state: "complete" },
        agentSubmissions: { state: "unavailable", reasons: ["cli_runtime"] },
        assistantTurns: { state: "unavailable", reasons: ["cli_runtime"] },
        usage: { state: "unavailable", reasons: ["cli_runtime"] },
        tools: { state: "unavailable", reasons: ["cli_runtime"] },
        cost: { state: "unavailable", reasons: ["cli_runtime"] },
        providerTransport: {
          state: "unavailable",
          reasons: ["not_observed", "not_instrumented"],
        },
      },
    });
    expect(accounting.project()).not.toHaveProperty("agentSubmissions");
    expect(accounting.project()).not.toHaveProperty("usage");
    expect(accounting.project()).not.toHaveProperty("assistantTurns");
    expect(accounting.project()).not.toHaveProperty("toolSummary");
  });

  it("marks every observed usage bucket partial when another runtime is opaque", () => {
    const accounting = createRunAccountingAccumulator();
    const embedded = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    embedded.selectRuntime("embedded");
    embedded.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { input: 10, output: 2, total: 12 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    embedded.settle("returned");
    const cli = accounting.beginCandidate({ provider: "claude-cli", model: "opus" });
    cli.selectRuntime("cli");
    cli.settle("returned");

    expect(accounting.project().coverage.usageBuckets).toMatchObject({
      input: { state: "partial", reasons: expect.arrayContaining(["cli_runtime"]) },
      output: { state: "partial", reasons: expect.arrayContaining(["cli_runtime"]) },
      total: { state: "partial", reasons: expect.arrayContaining(["cli_runtime"]) },
    });
  });

  it("labels observed cost as a partial subtotal when another attempt lacks usage", () => {
    const accounting = createRunAccountingAccumulator();
    const observed = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    observed.selectRuntime("embedded");
    observed.markModelCallInstrumentationInstalled();
    observed.beginModelCall().settle("completed");
    observed.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-test",
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    observed.settle("returned");
    const missing = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    missing.selectRuntime("embedded");
    missing.markModelCallInstrumentationInstalled();
    missing.beginModelCall().settle("completed");
    missing.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurns: 1,
      assistantTurnsObserved: true,
      assistantTurnsWithUsage: 0,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    missing.settle("returned");

    expect(accounting.project()).toMatchObject({
      costUsd: 3,
      coverage: {
        usage: { state: "partial", reasons: ["missing_usage", "partial_usage"] },
        cost: { state: "partial", reasons: ["missing_usage", "partial_usage"] },
      },
    });
  });

  it("prices usage against the effective observed model, not the candidate identity", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "base-model" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "anthropic",
      model: "effective-model",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "base-model",
                  cost: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
            anthropic: {
              models: [
                {
                  id: "effective-model",
                  cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      costUsd: 5,
      candidates: {
        entries: [
          {
            provider: "openai",
            model: "base-model",
            runtime: "embedded",
            outcome: "returned",
            effectiveModels: {
              entries: [{ provider: "anthropic", model: "effective-model" }],
              truncated: 0,
            },
          },
        ],
      },
    });
  });

  it("reports exact zero usage and cost when instrumentation proves no model calls", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurns: 0,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        total: 0,
      },
      costUsd: 0,
      coverage: {
        usage: { state: "complete" },
        cost: { state: "complete" },
      },
    });
  });

  it("treats all-zero placeholder pricing as unknown", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "unpriced" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall().settle("completed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "unpriced",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "unpriced",
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 100, output: 50, total: 150 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).not.toHaveProperty("costUsd");
    expect(accounting.project().coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["partial_usage", "missing_pricing"],
    });
  });

  it("treats all-zero tiered pricing as unknown", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "unpriced" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall().settle("completed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "unpriced",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "unpriced",
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        range: [0],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 100, output: 50, total: 150 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).not.toHaveProperty("costUsd");
    expect(accounting.project().coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["partial_usage", "missing_pricing"],
    });
  });

  it("does not price aggregated multi-call usage with request-tiered rates", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "tiered" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall().settle("completed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "tiered",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "tiered",
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    tieredPricing: [
                      {
                        input: 2,
                        output: 3,
                        cacheRead: 0,
                        cacheWrite: 0,
                        range: [0],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000, output: 1_000_000, total: 2_000_000 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).not.toHaveProperty("costUsd");
    expect(accounting.project().coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["partial_usage", "tiered_pricing_aggregate"],
    });
  });

  it("keeps input-only and total-only usage sparse with per-bucket coverage", () => {
    const inputOnly = createRunAccountingAccumulator();
    const inputCandidate = inputOnly.beginCandidate({ provider: "openai", model: "gpt-test" });
    inputCandidate.selectRuntime("embedded");
    inputCandidate.markModelCallInstrumentationInstalled();
    inputCandidate.beginModelCall().settle("completed");
    inputCandidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-test",
                  cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 1 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      usage: { input: 1_000_000 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    inputCandidate.settle("returned");

    expect(inputOnly.project()).toMatchObject({
      usage: { input: 1_000_000 },
      costUsd: 2,
      coverage: {
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "unavailable", reasons: ["partial_usage"] },
        },
        cost: { state: "partial", reasons: ["partial_usage"] },
      },
    });
    expect(inputOnly.project().usage).toEqual({ input: 1_000_000 });

    const totalOnly = createRunAccountingAccumulator();
    const totalCandidate = totalOnly.beginCandidate({ provider: "openai", model: "gpt-test" });
    totalCandidate.selectRuntime("embedded");
    totalCandidate.markModelCallInstrumentationInstalled();
    totalCandidate.beginModelCall().settle("completed");
    totalCandidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: { total: 7 },
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    totalCandidate.settle("returned");

    expect(totalOnly.project().usage).toEqual({ total: 7 });
    expect(totalOnly.project()).not.toHaveProperty("costUsd");
    expect(totalOnly.project()).toMatchObject({
      coverage: {
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
        cost: { state: "unavailable", reasons: ["partial_usage"] },
      },
    });
  });

  it("preserves producer-observed zero buckets without zero-filling absent buckets", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      total: 120,
    });
    const usage = toNormalizedUsage(usageAccumulator);
    if (!usage) {
      throw new Error("expected aggregated usage");
    }
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall().settle("completed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage,
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
      coverage: {
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "complete" },
          cacheRead: { state: "complete" },
          cacheWrite: { state: "complete" },
          reasoningTokens: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
      },
    });
  });

  it("does not mark a bucket complete when a later provider call omits it", () => {
    const usageAccumulator = createUsageAccumulator();
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 100,
      output: 20,
      cacheRead: 0,
      total: 120,
    });
    mergeUsageIntoAccumulator(usageAccumulator, {
      input: 80,
      output: 10,
      total: 90,
    });
    const usage = toNormalizedUsage(usageAccumulator);
    if (!usage) {
      throw new Error("expected aggregated usage");
    }
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall().settle("completed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage,
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      usage: { input: 180, output: 30, total: 210 },
      coverage: {
        usage: { state: "partial", reasons: ["partial_usage"] },
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "complete" },
          cacheRead: { state: "unavailable", reasons: ["partial_usage"] },
          total: { state: "complete" },
        },
      },
    });
    expect(accounting.project().usage).not.toHaveProperty("cacheRead");
  });

  it("degrades observed model metrics when command-owned work is opaque", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        total: 12,
      },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.markOpaqueWork("settled_finalization_failed");
    candidate.markOpaqueWork("session_core_compaction");
    candidate.settle("returned");

    expect(accounting.project().coverage).toMatchObject({
      candidates: { state: "complete" },
      agentSubmissions: { state: "complete" },
      assistantTurns: {
        state: "partial",
        reasons: ["settled_finalization_failed"],
      },
      usage: {
        state: "partial",
        reasons: ["not_instrumented", "settled_finalization_failed", "session_core_compaction"],
      },
      tools: {
        state: "partial",
        reasons: ["settled_finalization_failed"],
      },
      cost: {
        state: "unavailable",
        reasons: [
          "not_instrumented",
          "missing_pricing",
          "settled_finalization_failed",
          "session_core_compaction",
        ],
      },
      providerTransport: {
        state: "unavailable",
        reasons: ["not_observed", "not_instrumented"],
      },
    });
  });

  it("settles candidate, submission, and model-call handles at most once", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    const submission = candidate.beginAgentSubmission();
    const modelCall = candidate.beginModelCall();

    submission.settle("failed");
    submission.settle("completed");
    modelCall.settle("completed");
    modelCall.settle("failed");
    candidate.settle("threw");
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      candidates: { total: 1, returned: 0, threw: 1 },
      agentSubmissions: { total: 1, completed: 0, failed: 1 },
      modelCalls: { total: 1, completed: 1, failed: 0 },
    });
  });

  it("retains authoritative zeros and omits unobserved embedded fields", () => {
    const accounting = createRunAccountingAccumulator();
    const observed = accounting.beginCandidate({ provider: "openai", model: "observed" });
    observed.selectRuntime("embedded");
    observed.observeEmbeddedAttempt({
      provider: "openai",
      model: "observed",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    observed.settle("returned");

    expect(accounting.project()).toMatchObject({
      assistantTurns: 0,
      toolSummary: { calls: 0, tools: [] },
      coverage: {
        assistantTurns: { state: "complete" },
        tools: { state: "complete" },
      },
    });

    const opaque = createRunAccountingAccumulator();
    const missing = opaque.beginCandidate({ provider: "openai", model: "opaque" });
    missing.selectRuntime("embedded");
    missing.observeEmbeddedAttempt({
      provider: "openai",
      model: "opaque",
      assistantTurnsObserved: false,
      toolsObserved: false,
      codeModeLifecycleObserved: false,
    });
    missing.settle("returned");

    expect(opaque.project()).not.toHaveProperty("assistantTurns");
    expect(opaque.project()).not.toHaveProperty("toolSummary");
    expect(opaque.project()).toMatchObject({
      coverage: {
        assistantTurns: { state: "unavailable", reasons: ["not_observed"] },
        tools: { state: "unavailable", reasons: ["not_observed"] },
      },
    });
  });

  it("projects exact zero model work as complete zero turns and tools", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      modelCalls: { total: 0, completed: 0, failed: 0 },
      assistantTurns: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        total: 0,
      },
      toolSummary: { calls: 0, tools: [] },
      costUsd: 0,
      providerTransport: {
        logicalCalls: { total: 0, totalKind: "exact", outcomeKind: "exact" },
        attempts: { total: 0, totalKind: "exact" },
        connections: { total: 0, totalKind: "exact" },
        fallbacks: { total: 0, totalKind: "exact" },
        providerFallbacks: { total: 0, totalKind: "exact" },
        zeroSubmissions: { total: 0, totalKind: "exact" },
        events: { total: 0, totalKind: "exact" },
      },
      coverage: {
        modelCalls: { state: "complete" },
        assistantTurns: { state: "complete" },
        usage: { state: "complete" },
        tools: { state: "complete" },
        cost: { state: "complete" },
        providerTransport: { state: "complete" },
      },
    });
  });

  it("omits unobserved Code Mode lifecycle counts", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const lifecycle = accounting.project().codeMode?.lifecycle;
    expect(lifecycle).toEqual({
      finalQuiescence: { state: "unavailable", reasons: ["not_observed"] },
    });
  });

  it("omits whole-run Code Mode lifecycle counts when any relevant attempt is unobserved", () => {
    const accounting = createRunAccountingAccumulator();
    const observed = accounting.beginCandidate({ provider: "openai", model: "observed" });
    observed.selectRuntime("embedded");
    const stats = createCodeModeStats();
    stats.bridgeLifecycle.unresolvedAtExtraction = 0;
    observed.observeEmbeddedAttempt({
      provider: "openai",
      model: "observed",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeStats: stats,
      codeModeLifecycleObserved: true,
    });
    observed.settle("returned");
    const missing = accounting.beginCandidate({ provider: "openai", model: "missing" });
    missing.selectRuntime("embedded");
    missing.observeEmbeddedAttempt({
      provider: "openai",
      model: "missing",
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeEngaged: true,
      codeModeLifecycleObserved: false,
    });
    missing.settle("returned");

    expect(accounting.project().codeMode?.lifecycle).toEqual({
      finalQuiescence: { state: "unavailable", reasons: ["not_observed"] },
    });
  });

  it("ignores primitive snapshot targets", () => {
    expect(() =>
      bindAgentCommandRunAccounting("provider exploded", {
        candidates: {
          total: 0,
          returned: 0,
          threw: 0,
          runtimes: { embedded: 0, cli: 0, native: 0, cloud: 0, unknown: 0 },
          entries: [],
          truncated: 0,
        },
        agentSubmissions: { total: 0, completed: 0, failed: 0 },
        modelCalls: { total: 0, completed: 0, failed: 0 },
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoningTokens: 0,
          total: 0,
        },
        commandExecutionDurationMs: 0,
        coverage: {
          candidates: { state: "unavailable", reasons: ["not_observed"] },
          agentSubmissions: { state: "unavailable", reasons: ["not_observed"] },
          modelCalls: { state: "unavailable", reasons: ["not_observed"] },
          assistantTurns: { state: "unavailable", reasons: ["not_observed"] },
          usage: { state: "unavailable", reasons: ["not_observed"] },
          usageBuckets: {
            input: { state: "unavailable", reasons: ["not_observed"] },
            output: { state: "unavailable", reasons: ["not_observed"] },
            cacheRead: { state: "unavailable", reasons: ["not_observed"] },
            cacheWrite: { state: "unavailable", reasons: ["not_observed"] },
            reasoningTokens: { state: "unavailable", reasons: ["not_observed"] },
            total: { state: "unavailable", reasons: ["not_observed"] },
          },
          tools: { state: "unavailable", reasons: ["not_observed"] },
          cost: { state: "unavailable", reasons: ["not_observed"] },
          agentTime: { state: "unavailable", reasons: ["not_observed"] },
          commandExecutionDuration: { state: "complete" },
          wallLatency: { state: "unavailable", reasons: ["not_instrumented"] },
          providerTransport: { state: "unavailable", reasons: ["not_observed"] },
        },
      }),
    ).not.toThrow();
    expect(resolveAgentCommandRunAccounting("provider exploded")).toBeUndefined();
  });

  it("retains snapshots on thrown Error objects", () => {
    const error = new Error("provider exploded");
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.settle("threw");

    bindAgentCommandRunAccounting(error, accounting.project());

    expect(resolveAgentCommandRunAccounting(error)).toMatchObject({
      candidates: {
        total: 1,
        returned: 0,
        threw: 1,
        entries: [
          {
            provider: "openai",
            model: "gpt-test",
            runtime: "embedded",
            outcome: "threw",
          },
        ],
      },
    });
  });

  it("attaches accounting to early object failures without rewriting primitives", async () => {
    const failure = new Error("startup failed");
    let caughtError: unknown;
    try {
      await runWithAgentCommandAccounting(async () => {
        throw failure;
      });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBe(failure);
    expect(resolveAgentCommandRunAccounting(failure)?.coverage.candidates).toEqual({
      state: "unavailable",
      reasons: ["not_observed"],
    });

    let caughtPrimitive: unknown;
    const rejectPrimitive = vi.fn().mockRejectedValue("provider exploded");
    try {
      await runWithAgentCommandAccounting(async () => await rejectPrimitive());
    } catch (error) {
      caughtPrimitive = error;
    }
    expect(caughtPrimitive).toBe("provider exploded");
    expect(resolveAgentCommandRunAccounting(caughtPrimitive)).toBeUndefined();
  });
});
