import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runQaCharacterEval,
  type QaCharacterEvalJudgment,
  type QaCharacterEvalParams,
} from "./character-eval.js";
import type { QaSuiteResult } from "./suite.js";

type CharacterRunSuiteParams = Parameters<NonNullable<QaCharacterEvalParams["runSuite"]>>[0];
type CharacterRunJudgeParams = Parameters<NonNullable<QaCharacterEvalParams["runJudge"]>>[0];
type TestJudgeRanking = Pick<QaCharacterEvalJudgment, "model" | "rank" | "score" | "summary"> &
  Partial<Pick<QaCharacterEvalJudgment, "strengths" | "weaknesses">>;

function makeJudgeReply(rankings: TestJudgeRanking[]) {
  return JSON.stringify({ rankings });
}

function makeRunJudge(rankings: TestJudgeRanking[]) {
  return vi.fn(async (_params: CharacterRunJudgeParams) => makeJudgeReply(rankings));
}

function defaultModelTranscript(model: string) {
  return `USER Alice: hi\n\nASSISTANT openclaw: reply from ${model}`;
}

function makeReplySuiteResult(params: CharacterRunSuiteParams, transcript?: string) {
  return makeSuiteResult({
    outputDir: params.outputDir,
    model: params.primaryModel,
    transcript: transcript ?? defaultModelTranscript(params.primaryModel),
  });
}

function makeRunSuite(transcriptForModel: (model: string) => string = defaultModelTranscript) {
  return vi.fn(async (params: CharacterRunSuiteParams) =>
    makeReplySuiteResult(params, transcriptForModel(params.primaryModel)),
  );
}

function makeSuiteResult(params: { outputDir: string; model: string; transcript: string }) {
  return {
    outputDir: params.outputDir,
    reportPath: path.join(params.outputDir, "qa-suite-report.md"),
    summaryPath: path.join(params.outputDir, "qa-suite-summary.json"),
    report: "# report",
    watchUrl: "http://127.0.0.1:43124",
    scenarios: [
      {
        name: "Character vibes",
        status: "pass",
        steps: [
          {
            name: `transcript for ${params.model}`,
            status: "pass",
            details: params.transcript,
          },
        ],
      },
    ],
  } satisfies QaSuiteResult;
}

describe("runQaCharacterEval", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-character-eval-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("runs each requested model and writes a judged report with transcripts", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      const model = params.primaryModel;
      const transcript = `USER Alice: prompt for ${model}\n\nASSISTANT openclaw: reply from ${model}`;
      return makeSuiteResult({ outputDir: params.outputDir, model, transcript });
    });
    const runJudge = makeRunJudge([
      {
        model: "openai/gpt-5.4",
        rank: 1,
        score: 9.1,
        summary: "Most natural.",
        strengths: ["vivid"],
        weaknesses: ["none"],
      },
      {
        model: "codex-cli/test-model",
        rank: 2,
        score: 7,
        summary: "Readable but flatter.",
        strengths: ["coherent"],
        weaknesses: ["less funny"],
      },
    ]);

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "codex-cli/test-model", "openai/gpt-5.4"],
      scenarioId: "character-vibes-gollum",
      candidateFastMode: true,
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(runSuite).toHaveBeenCalledTimes(2);
    expect(runSuite).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerMode: "live-frontier",
        primaryModel: "openai/gpt-5.4",
        alternateModel: "openai/gpt-5.4",
        fastMode: true,
        scenarioIds: ["character-vibes-gollum"],
      }),
    );
    expect(runJudge).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeModel: "openai/gpt-5.4",
        judgeThinkingDefault: "xhigh",
        judgeFastMode: false,
        timeoutMs: 300_000,
      }),
    );
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]?.rankings.map((ranking) => ranking.model)).toEqual([
      "openai/gpt-5.4",
      "codex-cli/test-model",
    ]);

    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("Execution: local QA gateway child processes, not Docker");
    expect(report).toContain("Judges: openai/gpt-5.4");
    expect(report).toContain("Judge model labels: visible");
    expect(report).toContain("## Judge Rankings");
    expect(report).toContain("### openai/gpt-5.4");
    expect(report).toContain("reply from openai/gpt-5.4");
    expect(report).toContain("reply from codex-cli/test-model");
    expect(report).toContain("Judge thinking: xhigh");
    expect(report).toContain("- Timeout: 5m");
    expect(report).toContain("Fast mode: on");
    expect(report).toContain("Duration:");
    expect(report).not.toContain("Duration ms:");
    expect(report).not.toContain("Judge Raw Reply");
  });

  it("can hide candidate model refs from judge prompts and map rankings back", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript: "USER Alice: hi\n\nASSISTANT openclaw: anonymous reply",
      }),
    );
    const runJudge = vi.fn(async (params: CharacterRunJudgeParams) => {
      expect(params.prompt).toContain("## CANDIDATE candidate-01");
      expect(params.prompt).toContain("## CANDIDATE candidate-02");
      expect(params.prompt).not.toContain("openai/gpt-5.4");
      expect(params.prompt).not.toContain("codex-cli/test-model");
      return makeJudgeReply([
        {
          model: "candidate-02",
          rank: 1,
          score: 9.1,
          summary: "Better vibes.",
        },
        {
          model: "candidate-01",
          rank: 2,
          score: 7.4,
          summary: "Solid.",
        },
      ]);
    });

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "codex-cli/test-model"],
      judgeModels: ["openai/gpt-5.4"],
      judgeBlindModels: true,
      runSuite,
      runJudge,
    });

    expect(result.judgments[0]?.blindModels).toBe(true);
    expect(result.judgments[0]?.rankings.map((ranking) => ranking.model)).toEqual([
      "codex-cli/test-model",
      "openai/gpt-5.4",
    ]);
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("Judge model labels: blind");
    expect(report).toContain("1. codex-cli/test-model - 9.1 - Better vibes.");
  });

  it("defaults to the character eval model panel when no models are provided", async () => {
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge([
      { model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" },
      { model: "openai/gpt-5.2", rank: 2, score: 7.5, summary: "ok" },
      { model: "openai/gpt-5", rank: 3, score: 7.2, summary: "ok" },
      { model: "anthropic/claude-opus-4-6", rank: 4, score: 7, summary: "ok" },
      { model: "anthropic/claude-sonnet-4-6", rank: 5, score: 6.8, summary: "ok" },
      { model: "zai/glm-5.1", rank: 6, score: 6.3, summary: "ok" },
      { model: "moonshot/kimi-k2.5", rank: 7, score: 6.2, summary: "ok" },
      { model: "google/gemini-3.1-pro-preview", rank: 8, score: 6, summary: "ok" },
    ]);

    await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: [],
      runSuite,
      runJudge,
    });

    expect(runSuite).toHaveBeenCalledTimes(8);
    expect(runSuite.mock.calls.map(([params]) => params.primaryModel)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.2",
      "openai/gpt-5",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "zai/glm-5.1",
      "moonshot/kimi-k2.5",
      "google/gemini-3.1-pro-preview",
    ]);
    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "xhigh",
      "xhigh",
      "xhigh",
      "high",
      "high",
      "high",
      "high",
      "high",
    ]);
    expect(runSuite.mock.calls.map(([params]) => params.fastMode)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(runJudge).toHaveBeenCalledTimes(2);
    expect(runJudge.mock.calls.map(([params]) => params.judgeModel)).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-opus-4-6",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeThinkingDefault)).toEqual([
      "xhigh",
      "high",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeFastMode)).toEqual([false, false]);
  });

  it("runs candidate models with bounded concurrency while preserving result order", async () => {
    let activeRuns = 0;
    let maxActiveRuns = 0;
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRuns -= 1;
      return makeReplySuiteResult(params);
    });
    const runJudge = makeRunJudge([
      { model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" },
      { model: "anthropic/claude-sonnet-4-6", rank: 2, score: 7, summary: "ok" },
      { model: "moonshot/kimi-k2.5", rank: 3, score: 6, summary: "ok" },
    ]);

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6", "moonshot/kimi-k2.5"],
      candidateConcurrency: 2,
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(maxActiveRuns).toBe(2);
    expect(result.runs.map((run) => run.model)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
      "moonshot/kimi-k2.5",
    ]);
  });

  it("defaults candidate and judge concurrency to sixteen", async () => {
    let activeRuns = 0;
    let maxActiveRuns = 0;
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRuns -= 1;
      return makeReplySuiteResult(params);
    });
    let activeJudges = 0;
    let maxActiveJudges = 0;
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) => {
      activeJudges += 1;
      maxActiveJudges = Math.max(maxActiveJudges, activeJudges);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeJudges -= 1;
      return makeJudgeReply(
        Array.from({ length: 20 }, (_, index) => ({
          model: `provider/model-${index + 1}`,
          rank: index + 1,
          score: 10 - index,
          summary: "ok",
        })),
      );
    });

    await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: Array.from({ length: 20 }, (_, index) => `provider/model-${index + 1}`),
      judgeModels: Array.from({ length: 20 }, (_, index) => `judge/model-${index + 1}`),
      runSuite,
      runJudge,
    });

    expect(maxActiveRuns).toBe(16);
    expect(maxActiveJudges).toBe(16);
  });

  it("marks raw provider error transcripts as failed output", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript:
          "USER Alice: Are you awake?\n\nASSISTANT OpenClaw QA: 400 model `qwen3.6-plus` is not supported.",
      }),
    );
    const runJudge = makeRunJudge([
      { model: "qwen/qwen3.6-plus", rank: 1, score: 0.5, summary: "failed" },
    ]);

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["qwen/qwen3.6-plus"],
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(result.runs[0]).toMatchObject({
      model: "qwen/qwen3.6-plus",
      status: "fail",
      error: "model unsupported error leaked into transcript",
    });
  });

  it("marks raw tool failure transcripts as failed output", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript: "ASSISTANT OpenClaw QA: ⚠️ ✍️ Write: to /tmp/precious.html failed",
      }),
    );
    const runJudge = makeRunJudge([
      { model: "qwen/qwen3.5-plus", rank: 1, score: 0.5, summary: "failed" },
    ]);

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["qwen/qwen3.5-plus"],
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(result.runs[0]).toMatchObject({
      model: "qwen/qwen3.5-plus",
      status: "fail",
      error: "tool failure leaked into transcript",
    });
  });

  it("marks generic channel fallback transcripts as failed output", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript:
          "ASSISTANT OpenClaw QA: ⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.",
      }),
    );
    const runJudge = makeRunJudge([
      { model: "qa/generic-fallback-model", rank: 1, score: 0.5, summary: "failed" },
    ]);

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["qa/generic-fallback-model"],
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(result.runs[0]).toMatchObject({
      model: "qa/generic-fallback-model",
      status: "fail",
      error: "generic request failure leaked into transcript",
    });
  });

  it("marks idle-timeout fallback transcripts as failed output", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript:
          "ASSISTANT OpenClaw QA: The model did not produce a response before the LLM idle timeout. Please try again, or increase `agents.defaults.llm.idleTimeoutSeconds` in your config.",
      }),
    );
    const runJudge = makeRunJudge([
      { model: "google/gemini-test", rank: 1, score: 0.5, summary: "failed" },
    ]);

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["google/gemini-test"],
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(result.runs[0]).toMatchObject({
      model: "google/gemini-test",
      status: "fail",
      error: "LLM timeout leaked into transcript",
    });
  });

  it("marks leaked harness coordination transcripts as failed output", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) =>
      makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript:
          "ASSISTANT OpenClaw QA: checking thread context; then post a tight progress reply here.\nQA_LEAK_OK",
      }),
    );
    const runJudge = makeRunJudge([
      { model: "codex/gpt-5.4", rank: 1, score: 0.5, summary: "failed" },
    ]);

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["codex/gpt-5.4"],
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(result.runs[0]).toMatchObject({
      model: "codex/gpt-5.4",
      status: "fail",
      error: "internal harness/meta text leaked into transcript",
    });
  });

  it("lets explicit candidate thinking override the default panel", async () => {
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge([
      { model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" },
      { model: "moonshot/kimi-k2.5", rank: 2, score: 7, summary: "ok" },
    ]);

    await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "moonshot/kimi-k2.5"],
      candidateThinkingDefault: "medium",
      candidateThinkingByModel: { "moonshot/kimi-k2.5": "high" },
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "medium",
      "high",
    ]);
  });

  it("lets model-specific options override candidate and judge defaults", async () => {
    const runSuite = makeRunSuite();
    const runJudge = makeRunJudge([{ model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" }]);

    await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "moonshot/kimi-k2.5"],
      candidateFastMode: true,
      candidateThinkingDefault: "medium",
      candidateModelOptions: {
        "openai/gpt-5.4": { thinkingDefault: "xhigh", fastMode: false },
      },
      judgeModels: ["openai/gpt-5.4", "anthropic/claude-opus-4-6"],
      judgeThinkingDefault: "medium",
      judgeModelOptions: {
        "openai/gpt-5.4": { thinkingDefault: "xhigh", fastMode: true },
        "anthropic/claude-opus-4-6": { thinkingDefault: "high" },
      },
      runSuite,
      runJudge,
    });

    expect(runSuite.mock.calls.map(([params]) => params.thinkingDefault)).toEqual([
      "xhigh",
      "medium",
    ]);
    expect(runSuite.mock.calls.map(([params]) => params.fastMode)).toEqual([false, true]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeThinkingDefault)).toEqual([
      "xhigh",
      "high",
    ]);
    expect(runJudge.mock.calls.map(([params]) => params.judgeFastMode)).toEqual([true, false]);
  });

  it("keeps failed model runs in the report for grader context", async () => {
    const runSuite = vi.fn(async (params: CharacterRunSuiteParams) => {
      if (params.primaryModel === "codex-cli/test-model") {
        throw new Error("backend unavailable");
      }
      return makeSuiteResult({
        outputDir: params.outputDir,
        model: params.primaryModel,
        transcript: "USER Alice: hi\n\nASSISTANT openclaw: hello",
      });
    });
    const runJudge = vi.fn(async (_params: CharacterRunJudgeParams) =>
      JSON.stringify({
        rankings: [{ model: "openai/gpt-5.4", rank: 1, score: 8, summary: "ok" }],
      }),
    );

    const result = await runQaCharacterEval({
      repoRoot: tempRoot,
      outputDir: path.join(tempRoot, "character"),
      models: ["openai/gpt-5.4", "codex-cli/test-model"],
      judgeModels: ["openai/gpt-5.4"],
      runSuite,
      runJudge,
    });

    expect(result.runs.map((run) => run.status)).toEqual(["pass", "fail"]);
    expect(result.runs[1]?.error).toContain("backend unavailable");
    const report = await fs.readFile(result.reportPath, "utf8");
    expect(report).toContain("backend unavailable");
  });
});
