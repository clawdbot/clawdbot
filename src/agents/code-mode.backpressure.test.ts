import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CodeModeWorkerResult } from "./code-mode-runtime.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  resolveCodeModeConfig,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

// Both public entry points use the real QuickJS worker and normal tool executor.
function harness(headless: boolean, limit: number, tool: AnyAgentTool) {
  const config: OpenClawConfig = {
    tools: { codeMode: { enabled: true, maxPendingToolCalls: limit } },
  };
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "backpressure-session",
    sessionKey: "agent:main:backpressure",
    runId: "backpressure-run",
    catalogRef: createToolSearchCatalogRef(),
  };
  const tools = createCodeModeTools(ctx);
  applyCodeModeCatalog({ ...ctx, tools: [...tools, tool] });
  return async (
    code: string,
    signal?: AbortSignal,
    maxToolCalls = 200,
  ): Promise<Record<string, unknown>> => {
    if (headless) {
      return await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([tool]),
        code,
        overrides: { maxPendingToolCalls: limit },
        maxToolCalls,
        signal,
      });
    }
    return resultDetails(
      await expectDefined(tools[0], "exec tool").execute("backpressure-exec", { code }, signal),
    );
  };
}

afterEach(() => {
  try {
    expect(testing.activeRuns.size).toBe(0);
  } finally {
    resetCodeModeTestState();
  }
});

describe.each([false, true])("ordinary bridge backpressure, headless=%s", (headless) => {
  it.each([
    { limit: 16, count: 20, race: false },
    { limit: 2, count: 20, race: false },
    { limit: 1, count: 20, race: true },
    { limit: 16, count: 144, race: false },
  ])("drains $count calls inline with $limit slots, race=$race", async ({ limit, count, race }) => {
    const started = createDeferred();
    const release = createDeferred();
    const inputs: unknown[] = [];
    let active = 0;
    let maximum = 0;
    const tool = pluginToolWithExecute("probe", "Backpressure probe", async (_id, input) => {
      inputs.push(input);
      active++;
      maximum = Math.max(maximum, active);
      if (active === limit) {
        started.resolve();
      }
      try {
        await release.promise;
        return jsonResult(input);
      } finally {
        active--;
      }
    });
    tool.executionMode = "parallel";
    const run = harness(headless, limit, tool);
    const execution = run(
      "const calls = Array.from({ length: " +
        count +
        " }, (_, i) => probe({ value: String(i) }));" +
        (race
          ? 'return await Promise.race([Promise.all(calls), Promise.resolve("winner")]);'
          : 'const rows = await Promise.all(calls); return await probe({ value: rows.map(r => r.value).join(",") });'),
    );
    try {
      await Promise.race([started.promise, execution]);
      expect(active).toBe(limit);
    } finally {
      release.resolve();
      await execution;
    }
    const result = await execution;
    const expected = Array.from({ length: count }, (_, i) => ({ value: String(i) }));
    expect(result).toMatchObject({
      status: "completed",
      value: race ? "winner" : { value: expected.map((row) => row.value).join(",") },
    });
    expect(inputs).toEqual(
      race ? expected : [...expected, { value: expected.map((row) => row.value).join(",") }],
    );
    expect(maximum).toBe(limit);
    expect(active).toBe(0);
  });

  it.each([false, true])("refuses queue overflow atomically, caught=%s", async (caught) => {
    const tool = pluginToolWithExecute("probe", "Must not dispatch", async () => jsonResult({}));
    const run = harness(headless, 2, tool);
    const fanout = "for (let i = 0; i < 131; i++) void probe({ value: String(i) });";
    const result = await run(
      caught ? "try {" + fanout + '} catch (e) { text(e.message); } return "caught";' : fanout,
    );
    expect(result).toMatchObject({ status: "failed", code: "invalid_input" });
    expect(result.error).toContain("queue limit exceeded");
    expect(result.error).toContain("Await smaller batches");
    expect(tool.execute).not.toHaveBeenCalled();
    if (caught) {
      expect(result.output).toEqual([
        { type: "text", text: expect.stringContaining("queue limit exceeded") },
      ]);
    }
    // A failed admission belongs to one VM, not the reusable worker.
    expect(await run('return await probe({ value: "fresh" });')).toMatchObject({
      status: "completed",
    });
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("cancels queued timers without admitting them and drains live timer callbacks", async () => {
    const tool = pluginToolWithExecute("probe", "Timer probe", async (_id, input) =>
      jsonResult(input),
    );
    const result = await harness(
      headless,
      1,
      tool,
    )(
      'const first = probe({ value: "first" });' +
        'for (let i = 0; i < 160; i++) { const timer = setTimeout(() => { throw new Error("canceled timer fired"); }, 60000); clearTimeout(timer); }' +
        "const timers = Array.from({ length: 20 }, (_, i) => new Promise(resolve => setTimeout(async () => resolve(await probe({ value: String(i) })), 0)));" +
        "await first; return (await Promise.all(timers)).map(row => row.value);",
    );
    expect(result).toMatchObject({
      status: "completed",
      value: Array.from({ length: 20 }, (_, i) => String(i)),
    });
    expect(tool.execute).toHaveBeenCalledTimes(21);
  });

  it("drains queued siblings after a caught fail-fast Promise.all rejection", async () => {
    const tool = pluginToolWithExecute("probe", "Fail-fast probe", async (_id, input) => {
      if ((input as { value: string }).value === "0") {
        throw new Error("first failed");
      }
      return jsonResult(input);
    });
    const result = await harness(
      headless,
      2,
      tool,
    )(
      "try { await Promise.all(Array.from({ length: 20 }, (_, i) => probe({ value: String(i) }))); } catch (e) { return e.message; }",
    );
    expect(result).toMatchObject({ status: "completed", value: "first failed" });
    expect(tool.execute).toHaveBeenCalledTimes(20);
  });

  it("drops queued calls when the owner aborts the in-flight call", async () => {
    const started = createDeferred<AbortSignal | undefined>();
    const release = createDeferred();
    const controller = new AbortController();
    const tool = pluginToolWithExecute(
      "probe",
      "Canceled queue probe",
      async (_id, _input, signal) => {
        started.resolve(signal);
        await release.promise;
        return jsonResult({});
      },
    );
    const execution = harness(
      headless,
      1,
      tool,
    )(
      "return await Promise.all(Array.from({ length: 20 }, (_, i) => probe({ value: String(i) })));",
      controller.signal,
    );
    try {
      await Promise.race([started.promise, execution]);
      expect(tool.execute).toHaveBeenCalledOnce();
      controller.abort();
      expect(await execution).toMatchObject({ status: "failed", code: "aborted" });
      expect((await started.promise)?.aborted).toBe(true);
    } finally {
      controller.abort();
      release.resolve();
      await execution;
    }
    expect(tool.execute).toHaveBeenCalledOnce();
  });
});

it("preserves queued arguments, request IDs, and dependency order across partial snapshots", async () => {
  const config = resolveCodeModeConfig({
    tools: { codeMode: { enabled: true, maxPendingToolCalls: 3 } },
  });
  let result: CodeModeWorkerResult = await testing.runCodeModeWorker(
    {
      kind: "exec",
      config,
      catalog: [{ name: "probe", callableName: "probe", source: "openclaw" }],
      namespaces: [],
      source:
        'const calls = Array.from({ length: 20 }, (_, i) => { const input = { value: String(i) }; const call = probe(input); input.value = "mutated"; return call; });' +
        'const timer = setTimeout(() => { throw new Error("queued timer fired"); }, 60000);' +
        "await calls[2]; clearTimeout(timer);" +
        'const values = await Promise.all(calls); return await probe({ value: values.join(",") });',
    },
    10000,
  );
  const observed = new Map<string, unknown[]>();
  const completed = new Set<string>();
  for (let round = 0; result.status === "waiting" && round < 25; round++) {
    expect(result.pendingRequests.length).toBeLessThanOrEqual(3);
    for (const request of result.pendingRequests) {
      expect(completed.has(request.id)).toBe(false);
      if (observed.has(request.id)) {
        expect(request.args).toEqual(observed.get(request.id));
      } else {
        observed.set(request.id, request.args);
      }
    }
    // Settle the last request only; earlier siblings keep the same identity.
    const settled = expectDefined(result.pendingRequests.at(-1), "pending frontier");
    completed.add(settled.id);
    result = await testing.runCodeModeWorker(
      {
        kind: "resume",
        config,
        snapshot: result.snapshot,
        pendingRequests: result.pendingRequests.slice(0, -1),
        settledRequests: [
          {
            id: settled.id,
            ok: true,
            json: JSON.stringify((settled.args[1] as { value: string }).value),
          },
        ],
      },
      10000,
    );
  }
  const values = Array.from({ length: 20 }, (_, i) => String(i));
  expect(result).toMatchObject({
    status: "completed",
    value: { json: JSON.stringify(values.join(",")) },
  });
  expect([...observed.entries()]).toEqual(
    [...values, values.join(",")].map((value, i) => [
      "bridge:callValue:" + (i + 1),
      ["probe", { value }],
    ]),
  );
});

it("carries queued calls through a public exec/wait without replaying the prefix", async () => {
  const config: OpenClawConfig = { tools: { codeMode: true } };
  const ctx = {
    config,
    runtimeConfig: config,
    catalogRef: createToolSearchCatalogRef(),
    runId: "wait-backpressure",
    sessionId: "wait-session",
  };
  const tools = createCodeModeTools(ctx);
  const probe = pluginToolWithExecute("probe", "Wait queue probe", async (_id, input) =>
    jsonResult(input),
  );
  applyCodeModeCatalog({ ...ctx, tools: [...tools, probe] });
  const parked = resultDetails(
    await expectDefined(tools[0], "exec").execute("park", {
      code: 'const pause = yield_control("pause"); const calls = Array.from({ length: 20 }, (_, i) => probe({ value: String(i) })); await pause; return await Promise.all(calls);',
    }),
  );
  expect(parked.status).toBe("waiting");
  expect(testing.activeRuns.size).toBe(1);
  const result = resultDetails(
    await expectDefined(tools[1], "wait").execute("resume", { runId: parked.runId }),
  );
  expect(result).toMatchObject({
    status: "completed",
    value: Array.from({ length: 20 }, (_, i) => ({ value: String(i) })),
  });
  expect(probe.execute).toHaveBeenCalledTimes(20);
});

it("keeps the headless total tool-count guard while draining queued calls", async () => {
  const tool = pluginToolWithExecute("probe", "Budget probe", async () => jsonResult({}));
  const result = await harness(true, 2, tool)(
    "return await Promise.all(Array.from({ length: 20 }, () => probe({})));",
    undefined,
    5,
  );
  expect(result).toMatchObject({ status: "failed", code: "tool_budget_exceeded" });
  expect(tool.execute).toHaveBeenCalledTimes(4);
});
