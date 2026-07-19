import { describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { BEFORE_TOOL_CALL_HOOK_CONTEXT } from "../agents/before-tool-call-metadata.js";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronScriptRuntime } from "./trigger-script.js";

type EvaluatorDeps = Parameters<typeof createCronScriptRuntime>[0];
type HeadlessParams = Parameters<NonNullable<EvaluatorDeps["runHeadless"]>>[0];
type PrepareParams = Parameters<NonNullable<EvaluatorDeps["prepareRuntime"]>>[0];

const beforeToolCallTesting = { BEFORE_TOOL_CALL_HOOK_CONTEXT };

function completed(params: { value: unknown; output?: unknown[] }): CodeModeHeadlessResult {
  return {
    status: "completed",
    value: params.value,
    output: params.output ?? [],
    toolCallCount: 0,
  };
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("preparation aborted");
}

function createPreparedRuntime(config: OpenClawConfig) {
  const tool = wrapToolWithBeforeToolCallHook(
    {
      name: "probe",
      label: "Probe",
      description: "Probe tool",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    } satisfies AnyAgentTool,
    { config, agentId: "main", sessionKey: "cron:test:trigger" },
  );
  return {
    tools: [tool],
    ctx: {
      config,
      runtimeConfig: config,
      agentId: "main",
      sessionKey: "cron:test:trigger",
    },
    hookContext: { config, agentId: "main", sessionKey: "cron:test:trigger" },
  };
}

function createEvaluator(
  runHeadless: (
    params: Parameters<
      NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
    >[0],
  ) => Promise<CodeModeHeadlessResult>,
) {
  const config = {} as OpenClawConfig;
  const prepareRuntime = vi.fn(async () => createPreparedRuntime(config));
  return {
    evaluate: createCronScriptRuntime({ config, runHeadless, prepareRuntime }).evaluateTrigger,
    prepareRuntime,
  };
}

function createCronTriggerEvaluator(deps: EvaluatorDeps) {
  return createCronScriptRuntime(deps).evaluateTrigger;
}

describe("cron trigger script evaluator", () => {
  it("prefers a valid returned value and injects trigger state", async () => {
    const runHeadless = vi.fn(async (_params: HeadlessParams) =>
      completed({
        value: { fire: true, message: "changed", state: { revision: 2 } },
        output: [{ type: "json", value: { fire: false, state: { revision: 1 } } }],
      }),
    );
    const { evaluate } = createEvaluator(runHeadless);

    await expect(
      evaluate({
        jobId: "job-value",
        script: "return result",
        state: { revision: 1 },
      }),
    ).resolves.toEqual({
      kind: "evaluated",
      fire: true,
      message: "changed",
      state: { revision: 2 },
    });
    expect(runHeadless).toHaveBeenCalledOnce();
    expect(runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        extraNamespaces: [
          {
            id: "cron:trigger",
            globalName: "trigger",
            scope: {
              kind: "object",
              entries: [["state", { kind: "value", value: { revision: 1 } }]],
            },
          },
        ],
      }),
    );
  });

  it("falls back to the last json output entry when the returned object is not a trigger result", async () => {
    const { evaluate } = createEvaluator(
      vi.fn(async () =>
        completed({
          value: { ignored: true },
          output: [
            { type: "json", value: { fire: false, state: { old: true } } },
            { type: "text", text: "ignored" },
            { type: "json", value: { fire: true, state: { current: true } } },
          ],
        }),
      ),
    );

    await expect(
      evaluate({ jobId: "job-json", script: "json(result)", state: null }),
    ).resolves.toEqual({
      kind: "evaluated",
      fire: true,
      state: { current: true },
    });
  });

  it("uses a fresh hook run scope for each evaluation", async () => {
    const contexts: Array<Record<symbol, unknown>> = [];
    const { evaluate, prepareRuntime } = createEvaluator(
      vi.fn(async (params) => {
        const wrapped = params.ctx.catalogRef?.current?.entries[0]?.tool;
        contexts.push((wrapped ?? {}) as Record<symbol, unknown>);
        return completed({ value: { fire: false } });
      }),
    );

    await evaluate({ jobId: "job-loop-scope", script: "return result", state: null });
    await evaluate({ jobId: "job-loop-scope", script: "return result", state: null });

    expect(prepareRuntime).toHaveBeenCalledOnce();
    const runIds = contexts.map((tool) => {
      const context = tool[beforeToolCallTesting.BEFORE_TOOL_CALL_HOOK_CONTEXT];
      return (context as { runId?: string } | undefined)?.runId;
    });
    expect(runIds[0]).toMatch(/^cron-trigger:job-loop-scope:/);
    expect(runIds[1]).toMatch(/^cron-trigger:job-loop-scope:/);
    expect(runIds[1]).not.toBe(runIds[0]);
  });

  it("single-flights concurrent runtime preparation for the same job", async () => {
    const config = {} as OpenClawConfig;
    let release: ((runtime: ReturnType<typeof createPreparedRuntime>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof createPreparedRuntime>>((resolve) => {
      release = resolve;
    });
    const prepareRuntime = vi.fn(async () => await pending);
    const runHeadless = vi.fn(async () => completed({ value: { fire: false } }));
    const evaluate = createCronTriggerEvaluator({ config, prepareRuntime, runHeadless });

    const first = evaluate({ jobId: "job-single-flight", script: "return result", state: null });
    const second = evaluate({ jobId: "job-single-flight", script: "return result", state: null });
    await vi.waitFor(() => expect(prepareRuntime).toHaveBeenCalledOnce());
    release?.(createPreparedRuntime(config));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "evaluated", fire: false },
      { kind: "evaluated", fire: false },
    ]);
    expect(runHeadless).toHaveBeenCalledTimes(2);
  });

  it("retries shared runtime preparation for a still-live evaluator after its owner aborts", async () => {
    const config = {} as OpenClawConfig;
    const prepareRuntime = vi.fn(async (params: PrepareParams) => {
      if (prepareRuntime.mock.calls.length === 1) {
        return await new Promise<never>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(abortReason(params.signal)), {
            once: true,
          });
        });
      }
      return createPreparedRuntime(config);
    });
    const runHeadless = vi.fn(async () => completed({ value: { fire: false } }));
    const evaluate = createCronTriggerEvaluator({ config, prepareRuntime, runHeadless });
    const controller = new AbortController();
    const first = evaluate({
      jobId: "job-shared-abort",
      script: "return result",
      state: null,
      abortSignal: controller.signal,
    });
    const second = evaluate({
      jobId: "job-shared-abort",
      script: "return result",
      state: null,
    });
    await vi.waitFor(() => expect(prepareRuntime).toHaveBeenCalledOnce());

    controller.abort();
    await expect(first).resolves.toMatchObject({ kind: "error", code: "aborted" });
    await expect(second).resolves.toEqual({ kind: "evaluated", fire: false });
    expect(prepareRuntime).toHaveBeenCalledTimes(2);
    expect(runHeadless).toHaveBeenCalledOnce();
  });

  it("retries shared runtime preparation after an earlier evaluator reaches its deadline", async () => {
    vi.useFakeTimers();
    try {
      const config = {} as OpenClawConfig;
      const prepareRuntime = vi.fn(async (params: PrepareParams) => {
        if (prepareRuntime.mock.calls.length === 1) {
          return await new Promise<never>((_resolve, reject) => {
            params.signal?.addEventListener("abort", () => reject(abortReason(params.signal)), {
              once: true,
            });
          });
        }
        return createPreparedRuntime(config);
      });
      const runHeadless = vi.fn(async () => completed({ value: { fire: false } }));
      const evaluate = createCronTriggerEvaluator({ config, prepareRuntime, runHeadless });
      const first = evaluate({
        jobId: "job-shared-timeout",
        script: "return result",
        state: null,
      });
      await vi.waitFor(() => expect(prepareRuntime).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1_000);
      const second = evaluate({
        jobId: "job-shared-timeout",
        script: "return result",
        state: null,
      });

      await vi.advanceTimersByTimeAsync(29_000);

      await expect(first).resolves.toMatchObject({ kind: "error", code: "timeout" });
      await expect(second).resolves.toEqual({ kind: "evaluated", fire: false });
      expect(prepareRuntime).toHaveBeenCalledTimes(2);
      expect(runHeadless).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a cached runtime when toolsAllow changes", async () => {
    const config = {} as OpenClawConfig;
    const prepareRuntime = vi.fn(async (_params: PrepareParams) => createPreparedRuntime(config));
    const runHeadless = vi.fn(async () => completed({ value: { fire: false } }));
    const evaluate = createCronTriggerEvaluator({ config, prepareRuntime, runHeadless });

    await evaluate({
      jobId: "job-tools-allow",
      script: "return result",
      state: null,
      toolsAllow: ["probe"],
    });
    await evaluate({
      jobId: "job-tools-allow",
      script: "return result",
      state: null,
      toolsAllow: ["exec"],
    });

    expect(prepareRuntime).toHaveBeenCalledTimes(2);
    expect(prepareRuntime.mock.calls.map(([params]) => params.toolsAllow)).toEqual([
      ["probe"],
      ["exec"],
    ]);
  });

  it.each([
    completed({ value: null }),
    completed({ value: { fire: "yes" } }),
    completed({ value: { fire: true, message: 42 } }),
  ])("rejects invalid result shapes", async (headlessResult) => {
    const { evaluate } = createEvaluator(vi.fn(async () => headlessResult));

    const result = await evaluate({ jobId: "job-invalid", script: "return bad", state: null });

    expect(result).toMatchObject({ kind: "error", code: "internal_error" });
  });

  it("rejects returned state larger than 16KB", async () => {
    const { evaluate } = createEvaluator(
      vi.fn(async () =>
        completed({ value: { fire: false, state: { value: "x".repeat(16 * 1024) } } }),
      ),
    );

    await expect(
      evaluate({ jobId: "job-large-state", script: "return result", state: null }),
    ).resolves.toEqual({
      kind: "error",
      code: "output_limit_exceeded",
      error: "cron trigger state exceeds the 16KB limit",
    });
  });

  it("returns busy instead of queueing a fourth concurrent evaluation", async () => {
    let release: ((result: CodeModeHeadlessResult) => void) | undefined;
    const pending = new Promise<CodeModeHeadlessResult>((resolve) => {
      release = resolve;
    });
    const runHeadless = vi.fn(async () => await pending);
    const { evaluate } = createEvaluator(runHeadless);
    const running = ["one", "two", "three"].map((jobId) =>
      evaluate({ jobId, script: "return result", state: null }),
    );
    await vi.waitFor(() => expect(runHeadless).toHaveBeenCalledTimes(3));

    const saturated = await evaluate({
      jobId: "four",
      script: "return result",
      state: null,
    });
    release?.(completed({ value: { fire: false } }));
    await Promise.all(running);

    expect(saturated).toEqual({ kind: "busy" });
    expect(runHeadless).toHaveBeenCalledTimes(3);
  });

  it("cancels runtime preparation when its only evaluator aborts", async () => {
    const config = {} as OpenClawConfig;
    let preparationSignal: AbortSignal | undefined;
    const prepareRuntime = vi.fn(async (params: { signal?: AbortSignal }): Promise<never> => {
      preparationSignal = params.signal;
      return await new Promise<never>((_resolve, reject) => {
        params.signal?.addEventListener(
          "abort",
          () => {
            const reason = params.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          },
          { once: true },
        );
      });
    });
    const runHeadless = vi.fn(async () => completed({ value: { fire: false } }));
    const evaluate = createCronTriggerEvaluator({ config, prepareRuntime, runHeadless });
    const controller = new AbortController();
    const evaluation = evaluate({
      jobId: "job-abort-preparation",
      script: "return result",
      state: null,
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => expect(prepareRuntime).toHaveBeenCalledOnce());

    controller.abort();

    await expect(evaluation).resolves.toMatchObject({
      kind: "error",
      code: "aborted",
      error: "cron trigger evaluation aborted",
    });
    await vi.waitFor(() => expect(preparationSignal?.aborted).toBe(true));
    expect(runHeadless).not.toHaveBeenCalled();
  });

  it("keeps the internal evaluation deadline classified as timeout", async () => {
    vi.useFakeTimers();
    try {
      const config = {} as OpenClawConfig;
      const prepareRuntime = vi.fn(async (params: { signal?: AbortSignal }): Promise<never> => {
        return await new Promise<never>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(abortReason(params.signal)), {
            once: true,
          });
        });
      });
      const evaluate = createCronTriggerEvaluator({
        config,
        prepareRuntime,
        runHeadless: vi.fn(async () => completed({ value: { fire: false } })),
      });
      const evaluation = evaluate({
        jobId: "job-preparation-timeout",
        script: "return result",
        state: null,
      });
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(evaluation).resolves.toMatchObject({
        kind: "error",
        code: "timeout",
        error: "cron trigger evaluation timed out",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cron script payload evaluator", () => {
  it("uses payload-grade capped budgets and exposes frozen trigger state", async () => {
    const config = {} as OpenClawConfig;
    const runHeadless = vi.fn(async (_params: HeadlessParams) =>
      completed({
        value: {
          notify: "queue changed",
          wake: "now",
          state: { revision: 2 },
          nextCheck: "5m",
        },
      }),
    );
    const runtime = createCronScriptRuntime({
      config,
      runHeadless,
      prepareRuntime: vi.fn(async () => createPreparedRuntime(config)),
    });

    await expect(
      runtime.executePayload({
        jobId: "payload-job",
        script: "return result",
        state: { revision: 1 },
        timeoutSeconds: 10_000,
        toolBudget: 10_000,
      }),
    ).resolves.toEqual({
      kind: "completed",
      notify: "queue changed",
      wake: "now",
      stateChanged: true,
      state: { revision: 2 },
      nextCheck: { delayMs: 300_000 },
    });
    expect(runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        maxToolCalls: 200,
        extraNamespaces: [
          {
            id: "cron:trigger",
            globalName: "trigger",
            scope: {
              kind: "object",
              entries: [["state", { kind: "value", value: { revision: 1 } }]],
            },
          },
        ],
      }),
    );
    const headlessParams = runHeadless.mock.calls[0]?.[0];
    expect(headlessParams?.wallClockMs).toBeGreaterThanOrEqual(899_000);
    expect(headlessParams?.wallClockMs).toBeLessThanOrEqual(900_000);
  });

  it("uses payload defaults and accepts an omitted result state", async () => {
    const config = {} as OpenClawConfig;
    const runHeadless = vi.fn(async (_params: HeadlessParams) => completed({ value: {} }));
    const runtime = createCronScriptRuntime({
      config,
      runHeadless,
      prepareRuntime: vi.fn(async () => createPreparedRuntime(config)),
    });

    await expect(
      runtime.executePayload({ jobId: "payload-defaults", script: "return {}", state: null }),
    ).resolves.toEqual({ kind: "completed", stateChanged: false });
    expect(runHeadless).toHaveBeenCalledWith(expect.objectContaining({ maxToolCalls: 50 }));
    const headlessParams = runHeadless.mock.calls[0]?.[0];
    expect(headlessParams?.wallClockMs).toBeGreaterThanOrEqual(299_000);
    expect(headlessParams?.wallClockMs).toBeLessThanOrEqual(300_000);
  });

  it("canonicalizes returned state to the JSON value that will be persisted", async () => {
    const config = {} as OpenClawConfig;
    const runtime = createCronScriptRuntime({
      config,
      runHeadless: vi.fn(async () =>
        completed({
          value: { state: { keep: 1, dropped: undefined, nonFinite: Number.NaN } },
        }),
      ),
      prepareRuntime: vi.fn(async () => createPreparedRuntime(config)),
    });

    await expect(
      runtime.executePayload({ jobId: "payload-json-state", script: "return state", state: null }),
    ).resolves.toEqual({
      kind: "completed",
      stateChanged: true,
      state: { keep: 1, nonFinite: null },
    });
  });

  it.each([
    [{ notify: 42 }, "notify must be a string"],
    [{ wake: "later" }, 'wake must be "now" or "next-heartbeat"'],
    [{ nextCheck: "tomorrowish" }, "nextCheck must be a positive duration"],
    [{ state: "x".repeat(17 * 1024) }, "state exceeds the 16KB limit"],
  ] as const)("rejects an invalid result %#", async (value, error) => {
    const config = {} as OpenClawConfig;
    const runtime = createCronScriptRuntime({
      config,
      runHeadless: vi.fn(async () => completed({ value })),
      prepareRuntime: vi.fn(async () => createPreparedRuntime(config)),
    });

    await expect(
      runtime.executePayload({ jobId: "payload-invalid", script: "return result", state: null }),
    ).resolves.toMatchObject({ kind: "error", error: expect.stringContaining(error) });
  });

  it("surfaces executor failures through the cron error contract", async () => {
    const config = {} as OpenClawConfig;
    const runtime = createCronScriptRuntime({
      config,
      runHeadless: vi.fn(async () => ({
        status: "failed" as const,
        code: "tool_budget_exceeded" as const,
        error: "tool budget exceeded",
        output: [],
        toolCallCount: 51,
      })),
      prepareRuntime: vi.fn(async () => createPreparedRuntime(config)),
    });

    await expect(
      runtime.executePayload({ jobId: "payload-failed", script: "return result", state: null }),
    ).resolves.toEqual({
      kind: "error",
      code: "tool_budget_exceeded",
      error: "tool budget exceeded",
    });
  });
});
