import { describe, expect, it } from "vitest";
import { createRunAccountingAccumulator } from "./run-accounting.js";

const EXPECTED_CANDIDATE_DETAIL_LIMIT = 32;
const EXPECTED_EFFECTIVE_MODEL_DETAIL_LIMIT = 8;
const EXPECTED_IDENTITY_CHARACTER_LIMIT = 256;
const EXPECTED_TOOL_NAME_LIMIT = 64;

describe("command run accounting bounds", () => {
  it("caps ordered cumulative tool names without losing aggregate counts", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    const tools = Array.from(
      { length: EXPECTED_TOOL_NAME_LIMIT + 2 },
      (_, index) => `tool-${index}`,
    );
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurnsObserved: true,
      toolSummary: {
        calls: tools.length + 1,
        tools: [...tools, tools[0]!],
        failures: 2,
        totalToolTimeMs: 50,
      },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(snapshot.toolSummary).toMatchObject({
      calls: EXPECTED_TOOL_NAME_LIMIT + 3,
      failures: 2,
      totalToolTimeMs: 50,
    });
    expect(snapshot.toolSummary?.tools).toEqual(tools.slice(0, EXPECTED_TOOL_NAME_LIMIT));
    expect(snapshot.toolNamesTruncated).toBe(true);
    expect(snapshot.coverage.tools).toEqual({
      state: "partial",
      reasons: ["tool_details_truncated"],
    });
  });

  it("bounds each cumulative tool name", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "gpt-test" });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: "openai",
      model: "gpt-test",
      assistantTurnsObserved: true,
      toolSummary: { calls: 1, tools: [`tool-${"x".repeat(300)}`] },
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(Array.from(snapshot.toolSummary?.tools[0] ?? "")).toHaveLength(
      EXPECTED_IDENTITY_CHARACTER_LIMIT,
    );
    expect(snapshot.toolNamesTruncated).toBe(true);
    expect(snapshot.coverage.tools).toEqual({
      state: "partial",
      reasons: ["tool_details_truncated"],
    });
  });

  it("bounds ordered candidate details while preserving exact totals", () => {
    const accounting = createRunAccountingAccumulator();
    for (let index = 0; index < EXPECTED_CANDIDATE_DETAIL_LIMIT + 2; index += 1) {
      const candidate = accounting.beginCandidate({
        provider: "openai",
        model: `model-${index}`,
      });
      candidate.selectRuntime("embedded");
      candidate.settle(index % 2 === 0 ? "returned" : "threw");
    }

    const snapshot = accounting.project();
    expect(snapshot.candidates.total).toBe(EXPECTED_CANDIDATE_DETAIL_LIMIT + 2);
    expect(snapshot.candidates.entries).toHaveLength(EXPECTED_CANDIDATE_DETAIL_LIMIT);
    expect(snapshot.candidates.entries[0]?.model).toBe("model-0");
    expect(snapshot.candidates.entries.at(-1)?.model).toBe(
      `model-${EXPECTED_CANDIDATE_DETAIL_LIMIT - 1}`,
    );
    expect(snapshot.candidates.truncated).toBe(2);
    expect(snapshot.coverage.candidates).toEqual({
      state: "partial",
      reasons: ["candidate_details_truncated"],
    });
  });

  it("bounds ordered effective model identities per candidate", () => {
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({ provider: "openai", model: "base" });
    candidate.selectRuntime("embedded");
    for (let index = 0; index < EXPECTED_EFFECTIVE_MODEL_DETAIL_LIMIT + 2; index += 1) {
      candidate.observeEmbeddedAttempt({
        provider: "openai",
        model: `effective-${index}`,
        assistantTurnsObserved: true,
        toolsObserved: true,
        codeModeLifecycleObserved: false,
      });
    }
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(snapshot.candidates.entries[0]?.effectiveModels.entries).toHaveLength(
      EXPECTED_EFFECTIVE_MODEL_DETAIL_LIMIT,
    );
    expect(snapshot.candidates.entries[0]?.effectiveModels.truncated).toBe(2);
    expect(snapshot.coverage.candidates).toEqual({
      state: "partial",
      reasons: ["effective_model_details_truncated"],
    });
  });

  it("bounds candidate and effective model identity strings", () => {
    const oversizedProvider = `provider-${"p".repeat(EXPECTED_IDENTITY_CHARACTER_LIMIT + 10)}`;
    const oversizedModel = `model-${"m".repeat(EXPECTED_IDENTITY_CHARACTER_LIMIT + 10)}`;
    const accounting = createRunAccountingAccumulator();
    const candidate = accounting.beginCandidate({
      provider: oversizedProvider,
      model: oversizedModel,
    });
    candidate.selectRuntime("embedded");
    candidate.observeEmbeddedAttempt({
      provider: oversizedProvider,
      model: oversizedModel,
      assistantTurnsObserved: true,
      toolsObserved: true,
      codeModeLifecycleObserved: false,
    });
    candidate.settle("returned");

    const snapshot = accounting.project();
    expect(Array.from(snapshot.candidates.entries[0]?.provider ?? "")).toHaveLength(
      EXPECTED_IDENTITY_CHARACTER_LIMIT,
    );
    expect(Array.from(snapshot.candidates.entries[0]?.model ?? "")).toHaveLength(
      EXPECTED_IDENTITY_CHARACTER_LIMIT,
    );
    expect(
      Array.from(snapshot.candidates.entries[0]?.effectiveModels.entries[0]?.provider ?? ""),
    ).toHaveLength(EXPECTED_IDENTITY_CHARACTER_LIMIT);
    expect(snapshot.coverage.candidates).toEqual({
      state: "partial",
      reasons: ["candidate_identity_truncated"],
    });
  });
});
