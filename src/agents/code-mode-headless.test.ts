import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import { runCodeModeScriptHeadless, type CodeModeHeadlessResult } from "./code-mode.js";
import { testing } from "./code-mode.test-support.js";
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

function createHeadlessHarness(
  tools: AnyAgentTool[] = [],
  options: { swarmEnabled?: boolean } = {},
): ToolSearchToolContext {
  const config = {
    tools: {
      codeMode: { enabled: false, timeoutMs: 60_000 },
      ...(options.swarmEnabled ? { swarm: true } : {}),
    },
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
    testing.setTypescriptRuntimeForTest(null);
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
          const first = await tools.callValue("openclaw:core:headless_first", {});
          const second = await tools.callValue("openclaw:core:headless_second", {
            value: first.value,
          });
          return second;
        `,
        wallClockMs: 120_000,
      }),
    );

    expect(result.value).toEqual({ input: { value: 2 } });
    expect(result.toolCallCount).toBe(2);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it("keeps the headless race winner when the later-started tool settles first", async () => {
    let firstAborted = false;
    const first = fakeTool("headless_first_race", async (_toolCallId, _input, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            firstAborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return jsonResult({ winner: "first" });
    });
    const second = fakeTool("headless_second_race", async () => jsonResult({ winner: "second" }));

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([first, second]),
        code: `return await Promise.race([
          tools.callValue("openclaw:core:headless_first_race", {}),
          tools.callValue("openclaw:core:headless_second_race", {}),
        ]);`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toEqual({ winner: "second" });
    expect(result.toolCallCount).toBe(2);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(firstAborted).toBe(false);
  });

  it("drains a headless nested combinator after its outer race wins", async () => {
    let nestedAborted = false;
    const never = fakeTool("headless_nested_race_never", async (_toolCallId, _input, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            nestedAborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return jsonResult({ winner: "nested" });
    });
    const fast = fakeTool("headless_nested_race_fast", async () => jsonResult({ winner: "fast" }));

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([never, fast]),
        code: `return await Promise.race([
          Promise.all([tools.callValue("openclaw:core:headless_nested_race_never", {})]),
          tools.callValue("openclaw:core:headless_nested_race_fast", {}),
        ]);`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toEqual({ winner: "fast" });
    expect(result.toolCallCount).toBe(2);
    expect(never.execute).toHaveBeenCalledOnce();
    expect(fast.execute).toHaveBeenCalledOnce();
    expect(nestedAborted).toBe(false);
  });

  it.each([
    {
      label: "directly",
      auditCode: 'void tools.callValue("openclaw:core:headless_early_audit", {});',
    },
    {
      label: "in a detached already-settled Promise.race",
      auditCode:
        'void Promise.race([tools.callValue("openclaw:core:headless_early_audit", {}), Promise.resolve()]);',
    },
    {
      label: "in a detached Promise.all",
      auditCode: 'void Promise.all([tools.callValue("openclaw:core:headless_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.allSettled",
      auditCode:
        'void Promise.allSettled([tools.callValue("openclaw:core:headless_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.any",
      auditCode: 'void Promise.any([tools.callValue("openclaw:core:headless_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.race",
      auditCode: 'void Promise.race([tools.callValue("openclaw:core:headless_early_audit", {})]);',
    },
  ])(
    "drains a headless detached audit started $label before an awaited nested call",
    async ({ auditCode }) => {
      let auditCompleted = false;
      let auditAborted = false;
      const audit = fakeTool("headless_early_audit", async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              auditAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        auditCompleted = true;
        return jsonResult({ recorded: true });
      });
      const fast = fakeTool("headless_awaited_fast", async () => jsonResult({ winner: "fast" }));

      const result = expectCompleted(
        await runCodeModeScriptHeadless({
          ctx: createHeadlessHarness([audit, fast]),
          code: `${auditCode}
          return await tools.callValue("openclaw:core:headless_awaited_fast", {});`,
          wallClockMs: 5_000,
        }),
      );

      expect(result.value).toEqual({ winner: "fast" });
      expect(result.toolCallCount).toBe(2);
      expect(audit.execute).toHaveBeenCalledOnce();
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(auditCompleted).toBe(true);
      expect(auditAborted).toBe(false);
    },
  );

  it("drains a headless race winner's detached audit and its slower race branch", async () => {
    let loserAborted = false;
    const winner = fakeTool("headless_race_winner", async () => jsonResult({ winner: "fast" }));
    const loser = fakeTool("headless_race_loser", async (_toolCallId, _input, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            loserAborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return jsonResult({ winner: "slow" });
    });
    const audit = fakeTool("headless_race_audit", async () => jsonResult({ recorded: true }));

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([winner, loser, audit]),
        code: `return Promise.race([
          tools.callValue("openclaw:core:headless_race_winner", {}),
          tools.callValue("openclaw:core:headless_race_loser", {}),
        ]).then((value) => {
          void tools.callValue("openclaw:core:headless_race_audit", {});
          return value;
        });`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toEqual({ winner: "fast" });
    expect(result.toolCallCount).toBe(3);
    expect(winner.execute).toHaveBeenCalledOnce();
    expect(loser.execute).toHaveBeenCalledOnce();
    expect(audit.execute).toHaveBeenCalledOnce();
    expect(loserAborted).toBe(false);
  });

  it("drains every detached headless tool before completing the guest", async () => {
    const first = fakeTool("headless_detached_first", async () => jsonResult({ name: "first" }));
    const second = fakeTool("headless_detached_second", async () => jsonResult({ name: "second" }));

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([first, second]),
        code: `void tools.callValue("openclaw:core:headless_detached_first", {});
          void tools.callValue("openclaw:core:headless_detached_second", {});
          return "done";`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toBe("done");
    expect(result.toolCallCount).toBe(2);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
  });

  it.each(["race", "any"] as const)(
    "preserves the headless Promise.%s winner while draining the slower nested tool",
    async (combinator) => {
      let slowAborted = false;
      let slowCompleted = false;
      const fast = fakeTool("headless_fast", async () => jsonResult({ winner: "fast" }));
      const slow = fakeTool("headless_slow", async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              slowAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        slowCompleted = true;
        return jsonResult({ winner: "slow" });
      });

      const result = expectCompleted(
        await runCodeModeScriptHeadless({
          ctx: createHeadlessHarness([fast, slow]),
          code: `return await Promise.${combinator}([
            tools.callValue("openclaw:core:headless_fast", {}),
            tools.callValue("openclaw:core:headless_slow", {}),
          ]);`,
          wallClockMs: 5_000,
        }),
      );

      expect(result.value).toEqual({ winner: "fast" });
      expect(result.toolCallCount).toBe(2);
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(slow.execute).toHaveBeenCalledOnce();
      expect(slowCompleted).toBe(true);
      expect(slowAborted).toBe(false);
    },
  );

  it("preserves headless fail-fast Promise.all while draining the slower nested tool", async () => {
    let slowAborted = false;
    let slowCompleted = false;
    const failed = fakeTool("headless_failed", async () => {
      throw new Error("fast failure");
    });
    const slow = fakeTool("headless_slow", async (_toolCallId, _input, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            slowAborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      slowCompleted = true;
      return jsonResult({ winner: "slow" });
    });

    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([failed, slow]),
        code: `try {
          await Promise.all([
            tools.callValue("openclaw:core:headless_failed", {}),
            tools.callValue("openclaw:core:headless_slow", {}),
          ]);
          return "unexpected success";
        } catch (error) {
          return error.message;
        }`,
        wallClockMs: 5_000,
      }),
    );

    expect(result.value).toBe("fast failure");
    expect(result.toolCallCount).toBe(2);
    expect(failed.execute).toHaveBeenCalledOnce();
    expect(slow.execute).toHaveBeenCalledOnce();
    expect(slowCompleted).toBe(true);
    expect(slowAborted).toBe(false);
  });

  it("does not expose collector globals without resumable snapshot state", async () => {
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([], { swarmEnabled: true }),
        code: "return [typeof agents, typeof phase, typeof log];",
      }),
    );

    expect(result.value).toEqual(["undefined", "undefined", "undefined"]);
  });

  it.each([
    {
      name: "template-literal import text",
      code: "return `import('node:fs')`;",
      value: "import('node:fs')",
    },
    {
      name: "template-literal require text",
      code: "return `require('node:fs')`;",
      value: "require('node:fs')",
    },
    {
      name: "nested template-literal module text",
      code: "return `outer ${`require('node:fs')`}`;",
      value: "outer require('node:fs')",
    },
    {
      name: "regular-expression module text",
      code: 'return /import.meta/.test("import.meta");',
      value: true,
    },
    {
      name: "ordinary import method",
      code: "const api = { import(value) { return value; } }; return api.import(42);",
      value: 42,
    },
    {
      name: "ordinary require method",
      code: "const api = { require(value) { return value; } }; return api.require(42);",
      value: 42,
    },
    {
      name: "ordinary import metadata property",
      code: "const api = { import: { meta: 42 } }; return api.import.meta;",
      value: 42,
    },
  ])("executes harmless $name in a headless guest worker", async ({ code, value }) => {
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code,
      }),
    );

    expect(result.value).toBe(value);
    expect(result.toolCallCount).toBe(0);
  });

  it("executes module-shaped regular expressions in a TypeScript headless guest", async () => {
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        language: "typescript",
        code: 'const value: number = 1; return /import.meta/.test("import.meta");',
      }),
    );

    expect(result.value).toBe(true);
    expect(result.toolCallCount).toBe(0);
  });

  it.each([
    String.raw`return r\u0065quire('node:fs');`,
    "return require?.('node:fs');",
    "return (require)('node:fs');",
    "return (0, require)('node:fs');",
    "const load = require; return load('node:fs');",
    "return module.require('node:fs');",
    "return process.getBuiltinModule('node:fs');",
    "return `${import('node:fs')}`;",
    "return `${require('node:fs')}`;",
    "return `${`nested ${import('node:fs')}`}`;",
    "return `${`nested ${require('node:fs')}`}`;",
    "const message = `import('node:fs')`; return require('node:fs');",
    "let value = 1; return value++ / import('node:fs');",
    "let value = 1; return value-- / import('node:fs');",
    "const value = { of: 1 }; return value.of / import('node:fs');",
    "const value = { return: 1 }; return value.return / import('node:fs');",
    "const value = { if() { return 1; } }; return value.if() / import('node:fs');",
    "const value = { return: 1 }; return value?.return / import('node:fs') / 1;",
    "const value = { return: 1 }; return value?.return / require('node:fs') / 1;",
    "const value = { if() { return 1; } }; return value?.if() / import('node:fs');",
    "function run() { const await = 1; return await / (globalThis.pending = import('node:fs')); } run(); return globalThis.pending;",
    "class Guest { #return = 1; run() { return this.#return / (globalThis.pending = import('node:fs')); } } new Guest().run(); return globalThis.pending;",
  ])("rejects executable module access in a headless guest: %s", async (code) => {
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code,
      }),
    );

    expect(result.code).toBe("invalid_input");
    expect(result.error).toContain("module access is disabled");
    expect(result.toolCallCount).toBe(0);
  });

  it.each(["import('node:fs')", "require('node:fs')"])(
    "rejects astral-shifted TypeScript module access in a headless guest: %s",
    async (moduleAccess) => {
      const result = expectFailed(
        await runCodeModeScriptHeadless({
          ctx: createHeadlessHarness(),
          language: "typescript",
          code: `const padding: string = "${"😀".repeat(96)}"; return ${moduleAccess};`,
        }),
      );

      expect(result.code).toBe("invalid_input");
      expect(result.error).toContain("module access is disabled");
      expect(result.toolCallCount).toBe(0);
    },
  );

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

  it("counts first-class node operations against the headless tool budget", async () => {
    const nodesTool = fakeTool("nodes", async () => jsonResult({ nodes: [] }));

    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([nodesTool]),
        code: `
          await nodes.list();
          await nodes.list();
          return true;
        `,
        maxToolCalls: 1,
        wallClockMs: 5_000,
      }),
    );

    expect(result.code).toBe("tool_budget_exceeded");
    expect(result.toolCallCount).toBe(2);
    expect(nodesTool.execute).toHaveBeenCalledOnce();
  });

  it("fails an awaiting promise without bridge work before resuming a worker", async () => {
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        code: "await new Promise(() => {}); return true;",
        wallClockMs: 5_000,
      }),
    );

    expect(result.code).toBe("internal_error");
    expect(result.error).toContain("pending without host work");
    expect(result.toolCallCount).toBe(0);
  });

  it("bounds output and returned values across separate worker legs", async () => {
    const tool = fakeTool("output_boundary", async () => jsonResult({ ok: true }));

    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([tool]),
        code: `
          text("x".repeat(700));
          await tools.call("openclaw:core:output_boundary", {});
          return "y".repeat(700);
        `,
        overrides: { maxOutputBytes: 1_024 },
      }),
    );

    expect(result.code).toBe("output_limit_exceeded");
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("honors cron payload tool budgets above the old headless cap", async () => {
    const tool = fakeTool("budgeted", async () => jsonResult({ ok: true }));
    const result = expectCompleted(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness([tool]),
        code: `
          for (let index = 0; index < 129; index += 1) {
            await tools.call("openclaw:core:budgeted", {});
          }
          return true;
        `,
        maxToolCalls: 200,
        wallClockMs: 120_000,
      }),
    );

    expect(result.value).toBe(true);
    expect(result.toolCallCount).toBe(129);
    expect(tool.execute).toHaveBeenCalledTimes(129);
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

  it("honors cron payload wall-clock limits above the old headless cap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const toolStarted = createDeferred();
    const slow = fakeTool("slow_leg", async () => {
      toolStarted.resolve();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 330_000);
      });
      return jsonResult({ ok: true });
    });
    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessHarness([slow]),
      code: `
        await tools.call("openclaw:core:slow_leg", {});
        return true;
      `,
      wallClockMs: 360_000,
    });

    await toolStarted.promise;
    let settled = false;
    void resultPromise.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);

    const result = expectCompleted(await resultPromise);
    expect(result.value).toBe(true);
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

  it("times out an unfinished headless TypeScript runtime load", async () => {
    testing.setTypescriptRuntimeForTest(new Promise<typeof import("typescript")>(() => {}));

    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessHarness(),
        language: "typescript",
        code: "return 42;",
        wallClockMs: 25,
      }),
    );

    expect(result).toMatchObject({
      code: "timeout",
      error: "code mode headless wall-clock timeout exceeded",
      output: [],
      toolCallCount: 0,
    });
  });

  it("aborts an unfinished headless TypeScript runtime load", async () => {
    testing.setTypescriptRuntimeForTest(new Promise<typeof import("typescript")>(() => {}));
    const controller = new AbortController();
    const resultPromise = runCodeModeScriptHeadless({
      ctx: createHeadlessHarness(),
      language: "typescript",
      code: "return 42;",
      signal: controller.signal,
    });

    controller.abort();

    expect(expectFailed(await resultPromise)).toMatchObject({
      code: "aborted",
      error: "code mode execution aborted",
      output: [],
      toolCallCount: 0,
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
