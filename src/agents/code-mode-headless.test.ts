import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import { runCodeModeScriptHeadless, testing, type CodeModeHeadlessResult } from "./code-mode.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(execute) as AnyAgentTool["execute"],
  };
}

function createHeadlessHarness(tools: AnyAgentTool[] = []): ToolSearchToolContext {
  const config = {
    tools: { codeMode: { enabled: false, timeoutMs: 60_000 } },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  return {
    config,
    runtimeConfig: config,
    agentId: "main",
    catalogRef,
  };
}

function expectCompleted(result: CodeModeHeadlessResult) {
  expect(result.status).toBe("completed");
  if (result.status !== "completed") {
    throw new Error(result.error);
  }
  return result;
}

function expectFailed(result: CodeModeHeadlessResult) {
  expect(result.status).toBe("failed");
  if (result.status !== "failed") {
    throw new Error("expected headless code mode failure");
  }
  return result;
}

describe("headless Code Mode", () => {
  afterEach(() => {
    vi.useRealTimers();
    expect(testing.activeRuns.size).toBe(0);
    testing.activeRuns.clear();
    testing.resumingRunIds.clear();
  });

  it("completes multi-round tool calls without publishing active runs", async () => {
    const first = fakeTool("headless_first", async () => {
      expect(testing.activeRuns.size).toBe(0);
      return jsonResult({ value: 2 });
    });
    const second = fakeTool("headless_second", async (_toolCallId, input) => {
      expect(testing.activeRuns.size).toBe(0);
      return jsonResult({ input });
    });
    const ctx = createHeadlessHarness([first, second]);

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx,
        code: `
          const first = await tools.call("openclaw:core:headless_first", {});
          const second = await tools.call("openclaw:core:headless_second", {
            value: first.result.details.value,
          });
          return second.result.details;
        `,
        wallClockMs: 120_000,
      }),
    );

    expect(result.value).toEqual({ input: { value: 2 } });
    expect(result.toolCallCount).toBe(2);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("injects deeply frozen trigger state and emits replacement state through json", async () => {
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code: `
          json({
            fire: true,
            frozen: Object.isFrozen(trigger) &&
              Object.isFrozen(trigger.state) &&
              Object.isFrozen(trigger.state.nested),
            emptyKey: trigger.state[""],
            state: { count: trigger.state.count + 1 },
          });
          return "done";
        `,
        extraNamespaces: [
          {
            id: "cron:trigger",
            globalName: "trigger",
            scope: {
              kind: "object",
              entries: [
                [
                  "state",
                  {
                    kind: "value",
                    value: { "": 7, count: 4, nested: { stable: true } },
                  },
                ],
              ],
            },
          },
        ],
      }),
    );

    expect(result.output).toEqual([
      {
        type: "json",
        value: { fire: true, frozen: true, emptyKey: 7, state: { count: 5 } },
      },
    ]);
  });

  it("rejects colliding injected namespace globals", async () => {
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code: "return true;",
        extraNamespaces: [
          {
            id: "cron:trigger",
            globalName: "trigger",
            scope: { kind: "object", entries: [] },
          },
          {
            id: "plugin:trigger",
            globalName: "trigger",
            scope: { kind: "object", entries: [] },
          },
        ],
      }),
    );

    expect(result.code).toBe("invalid_input");
    expect(result.error).toContain("namespace collision");
  });

  it("fails before settling tool calls beyond the total budget", async () => {
    const tool = fakeTool("budgeted", async () => jsonResult({ ok: true }));
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([tool]),
        code: `
          await tools.call("openclaw:core:budgeted", {});
          await tools.call("openclaw:core:budgeted", {});
          return true;
        `,
        maxToolCalls: 1,
        wallClockMs: 120_000,
      }),
    );

    expect(result.code).toBe("tool_budget_exceeded");
    expect(result.toolCallCount).toBe(2);
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("enforces one wall-clock deadline across worker and tool legs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const toolStarted = createDeferred();
    const slow = fakeTool("slow_leg", async (_toolCallId, _input, signal) => {
      toolStarted.resolve();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return jsonResult({ ok: true });
    });
    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessHarness([slow]),
      code: `
        await tools.call("openclaw:core:slow_leg", {});
        return true;
      `,
      wallClockMs: 15_000,
    });

    // Advance the shared deadline only after the real worker reaches the tool leg.
    await toolStarted.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    const result = expectFailed(await resultPromise);

    expect(result.code).toBe("timeout");
    expect(result.toolCallCount).toBe(1);
  });

  it("settles yield_control inline and resumes to completion", async () => {
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code: `
          const yielded = await yield_control("pause");
          return { yielded, resumed: true };
        `,
      }),
    );

    expect(result.value).toEqual({
      yielded: { status: "yielded", reason: "pause" },
      resumed: true,
    });
    expect(result.toolCallCount).toBe(0);
  });

  it("terminates an in-flight worker leg when aborted", async () => {
    const ctx = createHeadlessHarness();
    const config = testing.resolveCodeModeHeadlessConfig(ctx);
    const controller = new AbortController();
    const resultPromise = testing.runCodeModeWorker(
      {
        kind: "exec",
        source: "while (true) {}",
        config,
        catalog: [],
        apiFiles: [],
        namespaces: [],
      },
      5000,
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);

    await expect(resultPromise).resolves.toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
  });

  it("classifies caller aborts before the worker leg as aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code: "return true;",
        signal: controller.signal,
      }),
    );

    expect(result).toMatchObject({
      code: "aborted",
      error: "code mode execution aborted",
    });
  });

  it("keeps worker-leg wall-clock expiry classified as timeout", async () => {
    const ctx = createHeadlessHarness();
    const config = testing.resolveCodeModeHeadlessConfig(ctx);
    const headlessScope = testing.createHeadlessAbortScope(undefined, 100);
    try {
      const result = await testing.runCodeModeWorker(
        {
          kind: "exec",
          source: "while (true) {}",
          config,
          catalog: [],
          apiFiles: [],
          namespaces: [],
        },
        5_000,
        undefined,
        headlessScope.signal,
      );

      expect(result).toMatchObject({
        status: "failed",
        code: "timeout",
        error: "code mode timeout exceeded",
      });
    } finally {
      headlessScope.cleanup();
    }
  });

  it.each([
    {
      name: "syntax errors",
      code: "return (;",
      expectedCode: "internal_error",
      overrides: undefined,
    },
    {
      name: "output overages",
      code: `text("x".repeat(2048)); return true;`,
      expectedCode: "output_limit_exceeded",
      overrides: { maxOutputBytes: 1024 },
    },
  ])("classifies $name", async ({ code, expectedCode, overrides }) => {
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code,
        overrides,
      }),
    );

    expect(result.code).toBe(expectedCode);
  });

  it("clamps headless limit overrides to worker-safe bounds", () => {
    const config = testing.resolveCodeModeHeadlessConfig(createHeadlessHarness(), {
      timeoutMs: 1,
      memoryLimitBytes: 1,
      maxOutputBytes: 1,
      maxSnapshotBytes: 1,
      maxPendingToolCalls: 999,
    });

    expect(config).toMatchObject({
      timeoutMs: 100,
      memoryLimitBytes: 1024 * 1024,
      maxOutputBytes: 1024,
      maxSnapshotBytes: 1024,
      maxPendingToolCalls: 128,
    });
  });
});
