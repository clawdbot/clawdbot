import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdateRepairLoop } from "./update-repair-agent.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";

type UpdateRepairParams = Parameters<typeof runUpdateRepairLoop>[0];

const runtime = vi.hoisted(() => ({
  withUpdateRepairEnvironment: vi.fn((_target, run) => run()),
  prepareUpdateRepairInference: vi.fn(),
  runUpdateRepairTurn: vi.fn(),
}));
vi.mock("./update-repair-agent.runtime.js", () => runtime);

const target = {
  stateDir: "/fixture/state",
  configPath: "/fixture/config.json",
  workspaceDir: "/fixture/workspace",
  installRoot: "/fixture/install",
};
const unhealthy = (score: number): UpdateRepairValidation => ({
  ok: false,
  score,
  summary: `Remaining errors: ${-score}`,
});
const healthy = { ok: true, score: 0, summary: "Doctor passed" };
const route = {
  runner: "embedded",
  agentId: "owner",
  provider: "fixture",
  model: "repair",
  modelLabel: "fixture/repair",
  agentDir: "/fixture/agent",
  runConfig: {},
};
function turnResult(
  text = 'REPAIR_RESULT: {"status":"fixed","summary":"Corrected the installation."}',
  toolCalls = 1,
  status = "ok",
) {
  return {
    toolCalls,
    exitCode: status === "ok" ? 0 : 2,
    envelope: { model: "repair", provider: "fixture", final: text, status },
  };
}
function params(validate = vi.fn().mockResolvedValue(unhealthy(-2))): UpdateRepairParams {
  return { target, context: { error: "Candidate boot failed", phase: "validating" }, validate };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.prepareUpdateRepairInference.mockResolvedValue({
    ok: true,
    route,
    modelFallbacks: ["fixture/fallback"],
  });
  runtime.runUpdateRepairTurn.mockResolvedValue(turnResult());
});
afterEach(() => vi.restoreAllMocks());

describe("runUpdateRepairLoop", () => {
  it("validates before inference and returns immediately for an already healthy target", async () => {
    const result = await runUpdateRepairLoop(params(vi.fn().mockResolvedValue(healthy)));
    expect(result).toEqual({ status: "repaired", attempts: [], finalValidation: healthy });
    expect(runtime.prepareUpdateRepairInference).not.toHaveBeenCalled();
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("uses the selected owner route and validates every turn before declaring repair", async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce(unhealthy(-2))
      .mockResolvedValueOnce(unhealthy(-1))
      .mockResolvedValueOnce(healthy);
    const events: string[] = [];
    const result = await runUpdateRepairLoop({
      ...params(validate),
      onEvent: (event) => events.push(event.type),
    });
    expect(result.status).toBe("repaired");
    expect(
      result.attempts.map((attempt) => [attempt.turn, attempt.toolCalls, attempt.summary]),
    ).toEqual([
      [1, 1, "Corrected the installation."],
      [2, 1, "Corrected the installation."],
    ]);
    expect(events).toEqual([
      "validation",
      "route-selected",
      "turn-started",
      "validation",
      "turn-finished",
      "turn-started",
      "validation",
      "turn-finished",
      "stopped",
    ]);
    expect(runtime.runUpdateRepairTurn.mock.calls[0]?.[0]).toMatchObject({
      target,
      route,
      modelFallbacks: ["fixture/fallback"],
      maxToolCalls: 40,
      timeoutMs: 300_000,
    });
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it.each([
    { scores: [-3, -2, -2], status: "improved", attempts: 2 },
    { scores: [-3, -3], status: "unrepaired", attempts: 1 },
    { scores: [-3, -2, -3], status: "unrepaired", attempts: 2 },
  ])("stops on no improvement or regression: $scores", async ({ scores, status, attempts }) => {
    const validate = vi.fn();
    for (const score of scores) {
      validate.mockResolvedValueOnce(unhealthy(score));
    }
    const result = await runUpdateRepairLoop(params(validate));
    expect(result.status).toBe(status);
    expect(result.attempts).toHaveLength(attempts);
    expect(runtime.runUpdateRepairTurn).toHaveBeenCalledTimes(attempts);
  });

  it("honors the turn budget even while every turn improves", async () => {
    const validate = vi
      .fn()
      .mockResolvedValueOnce(unhealthy(-4))
      .mockResolvedValueOnce(unhealthy(-3));
    const result = await runUpdateRepairLoop({ ...params(validate), budget: { maxTurns: 1 } });
    expect(result).toMatchObject({ status: "improved", reason: "turn-budget" });
    expect(result.attempts).toHaveLength(1);
  });

  it("aborts the turn at its deadline and validates any partial edits after draining", async () => {
    let drained = false;
    runtime.runUpdateRepairTurn.mockImplementationOnce(
      ({ signal }) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              drained = true;
              resolve(turnResult("Partial edit", 1, "timeout"));
            },
            { once: true },
          );
        }),
    );
    const validate = vi.fn().mockImplementation(async () => {
      if (validate.mock.calls.length > 1) {
        expect(drained).toBe(true);
      }
      return unhealthy(-1);
    });
    const result = await runUpdateRepairLoop({ ...params(validate), budget: { perTurnMs: 10 } });
    expect(result).toMatchObject({ status: "aborted", reason: "per-turn-budget" });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(1);
  });

  it("cancels and drains an oracle at the wall deadline and prevents late turns", async () => {
    let drained = false;
    const validate = vi.fn(
      (signal: AbortSignal) =>
        new Promise<UpdateRepairValidation>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              drained = true;
              reject(new Error("wall-clock-budget"));
            },
            { once: true },
          );
        }),
    );
    const result = await runUpdateRepairLoop({ ...params(validate), budget: { wallClockMs: 10 } });
    expect(result).toMatchObject({ status: "aborted", reason: "wall-clock-budget" });
    expect(drained).toBe(true);
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("returns at the wall deadline even if a read-only oracle never settles", async () => {
    const validate = vi.fn(() => new Promise<UpdateRepairValidation>(() => {}));
    const result = await runUpdateRepairLoop({ ...params(validate), budget: { wallClockMs: 10 } });
    expect(result).toMatchObject({ status: "aborted", reason: "wall-clock-budget" });
    expect(runtime.withUpdateRepairEnvironment).not.toHaveBeenCalled();
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it.each([{ calls: [2] }, { calls: [1, 1] }])(
    "shares the tool budget across improving turns: $calls",
    async ({ calls }) => {
      for (const toolCalls of calls) {
        runtime.runUpdateRepairTurn.mockResolvedValueOnce(turnResult("Partial repair", toolCalls));
      }
      const validate = vi.fn(async () => unhealthy(-4 + validate.mock.calls.length));
      const result = await runUpdateRepairLoop({
        ...params(validate),
        budget: { maxToolCalls: 2 },
      });
      expect(result).toMatchObject({ status: "aborted", reason: "tool-call-budget" });
      expect(result.attempts.map((attempt) => attempt.toolCalls)).toEqual(calls);
      expect(runtime.runUpdateRepairTurn.mock.calls.map(([input]) => input.maxToolCalls)).toEqual(
        calls.length === 1 ? [2] : [2, 1],
      );
      expect(validate).toHaveBeenCalledTimes(calls.length + 1);
      expect(result.attempts.at(-1)?.validation).toEqual(unhealthy(-3 + calls.length));
    },
  );

  it.each([
    ['REPAIR_RESULT: {"status":"partial","summary":"One error remains."}', "One error remains."],
    ['REPAIR_RESULT: {"status":"not-fixed","summary":"Needs a rebuild."}', "Needs a rebuild."],
    ["Plain final text", "Plain final text"],
    ["REPAIR_RESULT: garbage", "REPAIR_RESULT: garbage"],
    [
      'REPAIR_RESULT: {"status":"invented","summary":"Wrong"}',
      'REPAIR_RESULT: {"status":"invented","summary":"Wrong"}',
    ],
  ])(
    "parses bounded repair summaries without trusting a model's success claim: %s",
    async (text, summary) => {
      runtime.runUpdateRepairTurn.mockResolvedValueOnce(turnResult(text));
      const result = await runUpdateRepairLoop(params());
      expect(result.status).toBe("unrepaired");
      expect(result.attempts[0]?.summary).toBe(summary);
    },
  );

  it("caps the complete model prompt and redacts evidence and result summaries", async () => {
    runtime.runUpdateRepairTurn.mockResolvedValueOnce(
      turnResult(
        'REPAIR_RESULT: {"status":"fixed","summary":"token=sk-test-1234567890abcdefghij"}',
      ),
    );
    const input = params();
    input.context.symptoms = Array.from({ length: 30 }, () => "Symptom 😀".repeat(100));
    input.context.error = "token=sk-test-1234567890abcdefghij " + "failure ".repeat(2000);
    const result = await runUpdateRepairLoop(input);
    const prompt = runtime.runUpdateRepairTurn.mock.calls[0]?.[0].prompt as string;
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8192);
    expect(prompt).toContain("Never start, stop, or restart");
    expect(prompt).toContain("REPAIR_RESULT:");
    expect(prompt).not.toContain("sk-test-1234567890abcdefghij");
    expect(result.attempts[0]?.summary).not.toContain("sk-test-1234567890abcdefghij");
  });

  it("reports unavailable inference without starting a turn or throwing", async () => {
    runtime.prepareUpdateRepairInference.mockResolvedValueOnce({
      ok: false,
      reason: "No usable route.",
    });
    const result = await runUpdateRepairLoop(params());
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "No usable route.",
      attempts: [],
    });
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });

  it("redacts a credential before clipping a long unstructured repair summary", async () => {
    const secret = "sk-test-" + "x".repeat(80);
    runtime.runUpdateRepairTurn.mockResolvedValueOnce(
      turnResult(`token=${secret} ${"diagnostic ".repeat(90)}`),
    );
    const result = await runUpdateRepairLoop(params());
    expect(result.attempts[0]?.summary).not.toContain("x".repeat(20));
  });

  it("rejects a closed owner and a concurrent repair before either can execute", async () => {
    let release!: (value: UpdateRepairValidation) => void;
    const first = runUpdateRepairLoop(
      params(
        vi.fn(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        ),
      ),
    );
    // Wait for the oracle's admission, not a sleep or the eventual task result.
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect((await runUpdateRepairLoop(params())).status).toBe("unavailable");
    release(healthy);
    await first;
    expect((await runUpdateRepairLoop({ ...params(), isCurrent: () => false })).status).toBe(
      "aborted",
    );
    expect(runtime.runUpdateRepairTurn).not.toHaveBeenCalled();
  });
});
