import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";
import * as worker from "./code-mode-worker.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

it.each([false, true])(
  "keeps headless timer continuations within their admitted budget (checkpoint=%s)",
  async (checkpoint) => {
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      // The general headless harness uses 60s; exercise the production 10s slice under its 30s wall cap.
      overrides: { timeoutMs: 10_000 },
      code:
        (checkpoint ? "await yield_control(); " : "") +
        "await new Promise(resolve => setTimeout(resolve, 0)); return 1;",
    });
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: 1,
      toolCallCount: 0,
    });
  },
);

it.each(["headless", "interactive"] as const)(
  "continues %s after a checkpoint and actual tool reply exactly once",
  async (mode) => {
    const tool = pluginToolWithExecute("reply_once", "Return one reply", async () => {
      await nextTurn();
      return jsonResult({ value: 1 });
    });
    const code =
      'text("before"); await yield_control(); const reply = await reply_once({}); text("after"); return reply.value;';
    if (mode === "headless") {
      const result = await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([tool]),
        code,
        overrides: { timeoutMs: 10_000 },
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value: 1,
        toolCallCount: 1,
        output: [
          { type: "text", text: "before" },
          { type: "text", text: "after" },
        ],
      });
    } else {
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
      const first = resultDetails(
        await expectDefined(h.tools[0], "exec").execute("budget-exec", { code }),
      );
      expect(first).toMatchObject({
        status: "waiting",
        output: [{ type: "text", text: "before" }],
      });
      const final = resultDetails(
        await expectDefined(h.tools[1], "wait").execute("budget-wait", { runId: first.runId }),
      );
      expect(final, JSON.stringify(final)).toMatchObject({
        status: "completed",
        value: 1,
        output: [{ type: "text", text: "after" }],
      });
    }
    expect(tool.execute).toHaveBeenCalledOnce();
  },
);

it.each(["headless", "interactive"] as const)(
  "uses the exact prepared worker grant after delayed %s admission",
  async (mode) => {
    const admissions: number[] = [];
    const offers: Array<{ grant: number; requested: number }> = [];
    const originalRun: unknown = Object.getOwnPropertyDescriptor(
      WorkerTaskPool.prototype,
      "run",
    )?.value;
    if (typeof originalRun !== "function") {
      throw new Error("expected the original pool method");
    }
    // SAFETY: This is the concrete run method captured from its owning prototype; call() supplies the actual pool receiver.
    const runPool = originalRun as WorkerTaskPool<unknown, unknown>["run"];
    const poolSpy = vi.spyOn(WorkerTaskPool.prototype, "run");
    poolSpy.mockImplementation(function (this: WorkerTaskPool<unknown, unknown>, input, options) {
      return runPool.call(
        this,
        async () => {
          await delay(30);
          // SAFETY: The pool input is a factory only after its callable shape is checked.
          const prepared: unknown =
            typeof input === "function" ? await (input as () => unknown)() : input;
          if (
            isRecord(prepared) &&
            prepared.kind === "resume" &&
            isRecord(prepared.config) &&
            typeof prepared.config.timeoutMs === "number"
          ) {
            admissions.push(prepared.config.timeoutMs);
          }
          return prepared;
        },
        options,
      );
    });
    const runWorker = worker.runCodeModeWorker;
    const workerSpy = vi.spyOn(worker, "runCodeModeWorker").mockImplementation(async (...args) => {
      const inline = args[4];
      if (!inline) {
        return await runWorker(...args);
      }
      return await runWorker(args[0], args[1], args[2], args[3], {
        ...inline,
        onBoundary: async (boundary, context) => {
          const command = await inline.onBoundary(boundary, context);
          if (command.kind === "continue") {
            offers.push({ grant: context.maxTimeoutMs, requested: command.timeoutMs });
          }
          return command;
        },
      });
    });
    const tool = pluginToolWithExecute("budget_reply", "Return a reply", async () => jsonResult(1));
    const code = "await yield_control(); await budget_reply({}); await budget_reply({}); return 2;";
    try {
      if (mode === "headless") {
        const result = await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([tool]),
          code,
          overrides: { timeoutMs: 10_000 },
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "completed",
          value: 2,
          toolCallCount: 2,
        });
      } else {
        const h = createCodeModeHarness();
        applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
        const first = resultDetails(
          await expectDefined(h.tools[0], "exec").execute("grant-exec", { code }),
        );
        expect(first.status).toBe("waiting");
        const final = resultDetails(
          await expectDefined(h.tools[1], "wait").execute("grant-wait", { runId: first.runId }),
        );
        expect(final, JSON.stringify(final)).toMatchObject({ status: "completed", value: 2 });
      }
      expect(admissions).toHaveLength(1);
      const admitted = expectDefined(admissions[0], "resumed task grant");
      expect(admitted).toBeGreaterThan(0);
      expect(admitted).toBeLessThan(10_000);
      expect(offers).toHaveLength(2);
      for (const offer of offers) {
        expect(offer.grant).toBe(admitted);
        expect(offer.requested).toBeGreaterThan(0);
        expect(offer.requested).toBeLessThanOrEqual(admitted);
        expect(offer.requested).toBeLessThanOrEqual(10_000);
      }
      expect(tool.execute).toHaveBeenCalledTimes(2);
    } finally {
      workerSpy.mockRestore();
      poolSpy.mockRestore();
    }
  },
);

it.each([0, 1])(
  "keeps the worker grant authoritative for continuation offset %s",
  async (excess) => {
    const config = resolveCodeModeConfig({ tools: { codeMode: true } });
    const released = vi.fn();
    const result = await worker.runCodeModeWorker(
      {
        kind: "exec",
        config,
        catalog: [],
        namespaces: [],
        source: "await new Promise(resolve => setTimeout(resolve, 0)); return 1;",
      },
      config.timeoutMs + 2000,
      undefined,
      undefined,
      {
        onBoundary: async (boundary, { maxTimeoutMs }) => ({
          kind: "continue",
          timeoutMs: maxTimeoutMs + excess,
          pendingRequests: [],
          settledRequests: boundary.pendingRequests.map(({ id }) => ({
            id,
            ok: true,
            json: "null",
          })),
          onConsumed: released,
        }),
      },
    );
    expect(result, JSON.stringify(result)).toMatchObject(
      excess === 0
        ? { status: "completed", value: { json: "1" } }
        : { status: "failed", code: "timeout" },
    );
    expect(released).toHaveBeenCalledOnce();
  },
);
