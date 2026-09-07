import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SettledBridgeRequest } from "./code-mode-worker-types.js";
import * as worker from "./code-mode-worker.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  runUntilCompleted,
  resultDetails,
  waitUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

afterEach(resetCodeModeTestState);

describe.each(["interactive", "headless"] as const)("Code Mode %s program data", (mode) => {
  async function run(
    tools: AnyAgentTool[],
    code: string,
    limits: { maxOutputBytes?: number; memoryLimitBytes?: number; maxSnapshotBytes?: number } = {},
    skills: Array<{
      name: string;
      description: string;
      location: string;
      source: { filePath: string; readContent: string };
    }> = [],
  ) {
    if (mode === "headless") {
      return await runCodeModeScriptHeadless({
        ctx: { ...createHeadlessCodeModeHarness(tools), codeModeSkills: skills },
        code,
        overrides: { maxOutputBytes: 1024, ...limits },
        maxToolCalls: 128,
      });
    }
    const { ctx } = createCodeModeHarness({ codeModeSkills: skills });
    const config = { tools: { codeMode: { enabled: true, maxOutputBytes: 1024, ...limits } } };
    const controls = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
    applyCodeModeCatalog({ ...ctx, config, tools: [...controls, ...tools] });
    return await runUntilCompleted({ execTool: controls[0]!, waitTool: controls[1]!, code });
  }

  it.each([
    { count: 20, parked: false },
    { count: 2000, parked: false },
    { count: 2000, parked: true },
  ])("filters validated rows (count=$count, parked=$parked)", async ({ count, parked }) => {
    const rows = Array.from({ length: count }, (_, id) => ({ id, paid: id % 2 === 0 }));
    const tool = pluginToolWithExecute("shipment_rows", "List shipment rows", async () =>
      jsonResult(rows),
    );
    tool.outputSchema = Type.Array(
      Type.Object({ id: Type.Number(), paid: Type.Boolean() }, { additionalProperties: false }),
    );
    const code =
      "const pending = shipment_rows({}); " +
      (parked ? "await yield_control(); " : "") +
      "const rows = await pending; return { count: rows.filter(row => !row.paid).length, last: rows.at(-1).id };";
    const result = await run([tool], code);
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: { count: count / 2, last: count - 1 },
    });
  });
  it.each([false, true])(
    "refuses aggregate overflow without replacing success shapes (parked=%s)",
    async (parked) => {
      const bytes = 6 * 1024 * 1024;
      const tool = pluginToolWithExecute("large_page", "Read a large page", async () =>
        jsonResult("x".repeat(bytes)),
      );
      const code =
        "const pages = Promise.allSettled([large_page({}), large_page({})]); " +
        (parked ? "await yield_control(); " : "") +
        'return (await pages).map(item => item.status === "fulfilled" ? { length: item.value.length } : { error: item.reason.message });';
      const result = await run([tool], code);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value: [
          { length: bytes },
          { error: expect.stringMatching(/program-data budget exceeded.*Paginate/) },
        ],
      });
      expect(tool.execute).toHaveBeenCalledTimes(2);
    },
  );

  it("reuses aggregate capacity across sequential pages", async () => {
    const bytes = 512 * 1024;
    const tool = pluginToolWithExecute("data_page", "Read a page", async () =>
      jsonResult("x".repeat(bytes)),
    );
    const result = await run(
      [tool],
      "let size = 0; for (let i = 0; i < 36; i++) size += (await data_page({})).length; return size;",
      { memoryLimitBytes: 16 * 1024 * 1024, maxSnapshotBytes: 64 * 1024 * 1024 },
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: bytes * 36,
    });
    expect(tool.execute).toHaveBeenCalledTimes(36);
  });

  it.each([4000, 11 * 1024 * 1024])(
    "serves whole skill instructions or refuses admission (%s bytes)",
    async (bytes) => {
      const body = "x".repeat(bytes - 4) + "END!";
      const skill = {
        name: "demo",
        description: "Full instructions",
        location: "/skills/demo/SKILL.md",
        source: { filePath: "/skills/demo/SKILL.md", readContent: body },
      };
      const result = await run(
        [],
        'try { const body = await skills.read("demo"); return { length: body.length, tail: body.slice(-4) }; } catch (error) { return { error: error.message }; }',
        {},
        [skill],
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value:
          bytes < 10 * 1024 * 1024
            ? { length: bytes, tail: "END!" }
            : { error: expect.stringMatching(/program-data budget exceeded/) },
      });
    },
  );
});

it("clears host and worker-input aliases while retained readiness promises stay payload-free", async () => {
  const original = worker.runCodeModeWorker;
  const arrays: SettledBridgeRequest[][] = [];
  const aliases: SettledBridgeRequest[] = [];
  const spy = vi.spyOn(worker, "runCodeModeWorker").mockImplementation(async (input, ...args) => {
    // Production owns the worker input; retain its exact aliases to detect premature accounting-only release.
    const resume = input as { kind: string; settledRequests?: SettledBridgeRequest[] };
    if (resume.kind === "resume" && resume.settledRequests) {
      arrays.push(resume.settledRequests);
      aliases.push(...resume.settledRequests);
    }
    return await original(input, ...args);
  });
  const h = createCodeModeHarness();
  const success = pluginToolWithExecute("reply_success", "Read data", async () =>
    jsonResult("x".repeat(200000)),
  );
  const failure = pluginToolWithExecute("reply_failure", "Fail", async () => {
    throw new Error("failure:" + "x".repeat(200000));
  });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, success, failure] });
  try {
    const first = resultDetails(
      await h.tools[0]!.execute("aliases", {
        code: "const replies = Promise.allSettled([reply_success({}), reply_failure({})]); await yield_control(); return (await replies).map(reply => reply.status);",
      }),
    );
    expect(first.status).toBe("waiting");
    const retainedState = testing.activeRuns.get(String(first.runId))!;
    const ready = await Promise.all(retainedState.pending.map((entry) => entry.promise));
    expect(ready.every((value) => value === undefined)).toBe(true);
    const final = await waitUntilCompleted({ details: first, waitTool: h.tools[1]! });
    expect(final).toMatchObject({ status: "completed", value: ["fulfilled", "rejected"] });
    expect(aliases.some((reply) => reply.ok)).toBe(true);
    expect(aliases.some((reply) => !reply.ok)).toBe(true);
    expect(arrays.every((array) => array.length === 0)).toBe(true);
    expect(aliases.every((reply) => reply.json === "")).toBe(true);
    for (const pending of retainedState.pending) {
      expect(await pending.promise).toBeUndefined();
      expect(() => pending.reply.take()).toThrow("unavailable");
    }
  } finally {
    spy.mockRestore();
    clearToolSearchCatalog(h.ctx);
  }
});

it.each(["cancel", "expiry"])(
  "does not retain a late tool completion after parked %s",
  async (close) => {
    const started = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();
    const h = createCodeModeHarness();
    const tool = pluginToolWithExecute("late_page", "Signal-ignoring data source", async () => {
      started.resolve();
      await release.promise;
      finished.resolve();
      return jsonResult("late".repeat(300000));
    });
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    try {
      const first = resultDetails(
        await h.tools[0]!.execute("late", {
          code: "const page = late_page({}); await yield_control(); return (await page).length;",
        }),
      );
      expect(first.status).toBe("waiting");
      await started.promise;
      const retained = testing.activeRuns.get(String(first.runId))!;
      if (close === "expiry") {
        testing.removeExpiredRuns(retained.expiresAt + 1);
      } else {
        clearToolSearchCatalog(h.ctx);
      }
      await Promise.all(retained.pending.map((entry) => entry.promise));
      release.resolve();
      await finished.promise;
      await Promise.resolve();
      expect(retained.owner.signal.aborted).toBe(true);
      expect(testing.activeRuns.size).toBe(0);
      for (const pending of retained.pending) {
        expect(() => pending.reply.take()).toThrow("unavailable");
      }
      expect(tool.execute).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      clearToolSearchCatalog(h.ctx);
    }
  },
);

it("releases each guest-discarded timer lease before the cell closes", async () => {
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
  try {
    let result = resultDetails(
      await h.tools[0]!.execute("discarded-timers", {
        code: `for (let i = 0; i < 6; i++) {
        const timer = setTimeout(() => { throw new Error("discarded timer fired"); }, 60_000);
        await yield_control("armed");
        clearTimeout(timer);
        await yield_control("cleared");
      }
      return "done";`,
      }),
    );
    for (let round = 0; round < 6; round++) {
      expect(result.status).toBe("waiting");
      const parked = testing.activeRuns.get(String(result.runId))!;
      const timer = parked.pending.find((entry) => entry.method === "sleep")!;
      expect(timer).toBeDefined();
      expect(timer.settled).toBeUndefined();
      const release = vi.spyOn(timer.reply, "release");
      result = resultDetails(await h.tools[1]!.execute("discard-timer", { runId: result.runId }));
      expect(result.status).toBe("waiting");
      expect(parked.owner.signal.aborted).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      expect(() => timer.reply.take()).toThrow("unavailable");
      expect(
        testing.activeRuns
          .get(String(result.runId))!
          .pending.some((entry) => entry.id === timer.id),
      ).toBe(false);
      release.mockRestore();
      result = resultDetails(await h.tools[1]!.execute("next-timer", { runId: result.runId }));
    }
    expect(result).toMatchObject({ status: "completed", value: "done" });
  } finally {
    clearToolSearchCatalog(h.ctx);
    vi.restoreAllMocks();
  }
});
