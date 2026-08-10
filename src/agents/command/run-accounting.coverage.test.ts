import { describe, expect, it } from "vitest";
import {
  bindAgentCommandRunAccounting,
  createRunAccountingAccumulator,
  resolveAgentCommandRunAccounting,
} from "./run-accounting.js";

describe("command run accounting coverage", () => {
  it("does not project legacy submissions keys", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginAgentSubmission().settle("completed");
    candidate.beginModelCall().settle("completed");
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(snapshot).toHaveProperty("agentSubmissions");
    expect(snapshot.coverage).toHaveProperty("agentSubmissions");
    expect(snapshot).toHaveProperty("modelCalls");
    expect(snapshot.coverage).toHaveProperty("modelCalls");
    expect(snapshot).not.toHaveProperty("submissions");
    expect(snapshot.coverage).not.toHaveProperty("submissions");
  });

  it("reports admitted but unsettled model calls as partial", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall();
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      modelCalls: { total: 1, completed: 0, failed: 0 },
      coverage: {
        modelCalls: { state: "partial", reasons: ["model_call_unsettled"] },
        usage: {
          state: "unavailable",
          reasons: ["missing_usage", "model_call_unsettled"],
        },
        cost: {
          state: "unavailable",
          reasons: ["missing_usage", "model_call_unsettled"],
        },
      },
    });
  });

  it("does not report failed model calls without usage as fully covered", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall().settle("failed");
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      modelCalls: { total: 1, completed: 0, failed: 1 },
      coverage: {
        modelCalls: { state: "complete" },
        usage: { state: "unavailable", reasons: ["missing_usage"] },
        cost: { state: "unavailable", reasons: ["missing_usage"] },
      },
    });
  });

  it("accepts authoritative usage from a failed model call", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.beginModelCall().settle("failed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
        total: 0,
      },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      assistantTurnsWithUsage: 1,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      costUsd: 0,
      coverage: {
        usage: { state: "complete" },
        cost: { state: "complete" },
      },
    });
  });

  it("retains authoritative zero calls for an instrumented embedded candidate", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.markModelCallInstrumentationInstalled();
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
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
      costUsd: 0,
      coverage: {
        agentSubmissions: { state: "complete" },
        modelCalls: { state: "complete" },
        usage: { state: "complete" },
        usageBuckets: {
          input: { state: "complete" },
          output: { state: "complete" },
          cacheRead: { state: "complete" },
          cacheWrite: { state: "complete" },
          reasoningTokens: { state: "complete" },
          total: { state: "complete" },
        },
        cost: { state: "complete" },
      },
    });
  });

  it("taints every affected metric when one embedded candidate is unobserved", () => {
    const accounting = createRunAccountingAccumulator();
    const observed = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    observed.selectRuntime("embedded");
    observed.markModelCallInstrumentationInstalled();
    observed.beginModelCall().settle("completed");
    observed.observeEmbeddedAttempt({
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
      assistantTurnsWithUsage: 1,
      toolSummary: { calls: 1, tools: ["read"] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    observed.settle("returned");

    const unobserved = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    unobserved.selectRuntime("embedded");
    unobserved.settle("returned");

    expect(accounting.project().coverage).toMatchObject({
      modelCalls: { state: "partial", reasons: ["not_instrumented"] },
      assistantTurns: { state: "partial", reasons: ["not_observed"] },
      usage: { state: "partial", reasons: ["not_instrumented"] },
      usageBuckets: {
        input: { state: "partial", reasons: ["not_instrumented"] },
      },
      tools: { state: "partial", reasons: ["not_observed"] },
      cost: {
        state: "unavailable",
        reasons: ["not_instrumented", "missing_pricing"],
      },
    });
  });

  it("does not trust zero calls from an uninstrumented embedded harness", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      coverage: {
        modelCalls: { state: "unavailable", reasons: ["not_instrumented"] },
      },
    });
    expect(accounting.project()).not.toHaveProperty("modelCalls");
  });

  it("reports unsettled outer submissions as partial", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.beginAgentSubmission();
    candidate.settle("returned");

    expect(accounting.project()).toMatchObject({
      agentSubmissions: { total: 1, completed: 0, failed: 0 },
      coverage: {
        agentSubmissions: {
          state: "partial",
          reasons: ["agent_submission_unsettled"],
        },
      },
    });
  });

  it("isolates stored snapshots from producer and consumer mutation", () => {
    const target = {};
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.beginAgentSubmission().settle("completed");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test-effective",
      usage: { input: 10, output: 2, total: 12 },
      assistantTurns: 1,
      assistantTurnsObserved: true,
      assistantTurnsWithUsage: 1,
      toolSummary: { calls: 1, tools: ["read"] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.markOpaqueWork("post_turn_compaction");
    candidate.settle("returned");

    const projected = accounting.project();
    bindAgentCommandRunAccounting(target, projected);
    projected.candidates.entries[0]!.effectiveModels.entries[0]!.model = "mutated producer";
    projected.toolSummary!.tools.push("producer-tool");

    const firstResolved = resolveAgentCommandRunAccounting(target);
    expect(firstResolved?.candidates.entries[0]?.effectiveModels.entries[0]?.model).toBe(
      "gpt-test-effective",
    );
    firstResolved!.candidates.entries[0]!.effectiveModels.entries.push({
      provider: "mutated",
      model: "consumer",
    });
    firstResolved!.toolSummary!.tools.push("consumer-tool");
    if (firstResolved!.coverage.usage.state !== "partial") {
      throw new Error("expected partial usage coverage");
    }
    firstResolved!.coverage.usage.reasons.push("not_observed");

    const secondResolved = resolveAgentCommandRunAccounting(target);
    expect(secondResolved?.candidates.entries[0]?.effectiveModels.entries).toEqual([
      { provider: "openai", model: "gpt-test-effective" },
    ]);
    expect(secondResolved?.toolSummary?.tools).toEqual(["read"]);
    expect(secondResolved?.coverage.usage).toEqual({
      state: "partial",
      reasons: ["partial_usage", "not_instrumented", "post_turn_compaction"],
    });
  });

  it("does not report complete usage when one assistant turn omits usage", () => {
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
      assistantTurns: 2,
      assistantTurnsObserved: true,
      assistantTurnsWithUsage: 1,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(snapshot.usage).toEqual({
      input: 10,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
      total: 12,
    });
    expect(snapshot.coverage.usage).toEqual({
      state: "partial",
      reasons: ["missing_usage", "not_instrumented"],
    });
    expect(snapshot.coverage.usageBuckets.input).toEqual({
      state: "partial",
      reasons: ["missing_usage", "partial_usage", "not_instrumented"],
    });
    expect(snapshot.coverage.cost).toMatchObject({
      state: "unavailable",
      reasons: expect.arrayContaining(["missing_usage"]),
    });
  });

  it("does not report complete cost for a legacy multi-turn usage aggregate", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
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
      } as never,
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 12,
      },
      assistantTurns: 2,
      assistantTurnsObserved: true,
      toolSummary: { calls: 0, tools: [] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    expect(accounting.project().coverage.cost).toEqual({
      state: "partial",
      reasons: ["missing_usage", "not_instrumented"],
    });
  });

  it.each([
    "session_core_compaction",
    "session_extension_compaction",
    "native_harness_compaction",
    "deferred_context_engine_maintenance",
    "post_turn_compaction",
  ] as const)("%s taints only hidden model-work surfaces", (reason) => {
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
      toolSummary: { calls: 1, tools: ["read"] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.beginAgentSubmission().settle("completed");
    candidate.markOpaqueWork(reason);
    candidate.settle("returned");

    const coverage = accounting.project().coverage;
    expect(coverage.candidates).toEqual({ state: "complete" });
    expect(coverage.agentSubmissions).toEqual({ state: "complete" });
    expect(coverage.modelCalls).toEqual({
      state: "unavailable",
      reasons: ["not_instrumented", reason],
    });
    expect(coverage.assistantTurns).toEqual({ state: "complete" });
    expect(coverage.tools).toEqual({ state: "complete" });
    expect(coverage.usage).toEqual({
      state: "partial",
      reasons: ["not_instrumented", reason],
    });
    expect(coverage.usageBuckets.input).toEqual({
      state: "partial",
      reasons: ["not_instrumented", reason],
    });
    expect(coverage.cost).toEqual({
      state: "unavailable",
      reasons: ["not_instrumented", "missing_pricing", reason],
    });
    expect(coverage.providerTransport).toEqual({
      state: "unavailable",
      reasons: ["not_instrumented", reason],
    });
  });

  it("marks ACP model work unavailable without inventing candidates or submissions", () => {
    const accounting = createRunAccountingAccumulator();
    accounting.markOpaqueWork("acp_runtime");

    const snapshot = accounting.project();
    expect(snapshot.candidates.total).toBe(0);
    expect(snapshot.agentSubmissions).toBeUndefined();
    expect(snapshot.coverage.candidates).toEqual({
      state: "unavailable",
      reasons: ["not_observed"],
    });
    expect(snapshot.coverage.agentSubmissions).toEqual({
      state: "unavailable",
      reasons: ["not_observed"],
    });
    expect(snapshot.coverage.modelCalls).toEqual({
      state: "unavailable",
      reasons: ["not_observed", "acp_runtime"],
    });
    expect(snapshot.coverage.providerTransport).toEqual({
      state: "unavailable",
      reasons: ["not_instrumented", "acp_runtime"],
    });
  });

  it("preserves repeated opaque work as numeric lower-bound evidence", () => {
    const accounting = createRunAccountingAccumulator();
    accounting.markOpaqueWork("post_turn_compaction");
    accounting.markOpaqueWork("post_turn_compaction");

    expect(accounting.project()).toMatchObject({
      opaqueWork: {
        total: 2,
        byReason: {
          post_turn_compaction: 2,
        },
      },
    });
  });

  it("projects exact zero model work only from an explicit no-work fact", () => {
    const accounting = createRunAccountingAccumulator();
    const submission = accounting.beginAgentSubmission();
    submission.settle("completed");
    accounting.markNoModelWork();

    expect(accounting.project()).toMatchObject({
      agentSubmissions: { total: 1, completed: 1, failed: 0 },
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
      coverage: {
        agentSubmissions: { state: "complete" },
        modelCalls: { state: "complete" },
        usage: { state: "complete" },
        tools: { state: "complete" },
        cost: { state: "complete" },
      },
    });
  });
});
