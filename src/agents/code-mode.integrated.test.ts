import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("integrated public Code Mode", () => {
  it.each(["exec", "wait", "headless"])(
    "keeps 12 MiB live through timer/tool boundaries: %s",
    async (mode) => {
      const target = pluginToolWithExecute("rows", "Read rows", async () => jsonResult([{ n: 7 }]));
      const code =
        'const heap = new Uint8Array(12 * 1024 * 1024); heap[0] = 73; console.log("once"); await new Promise(resolve => setTimeout(resolve, 0)); const data = await rows({}); return [heap.length, heap[0], data[0].n];';
      let result;
      if (mode === "headless") {
        result = await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([target]),
          code,
        });
      } else {
        const { ctx, config, tools } = createCodeModeHarness();
        applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
        result = resultDetails(
          await tools[0]!.execute("integrated", {
            code: (mode === "wait" ? "await yield_control(); " : "") + code,
          }),
        );
        if (mode === "wait") {
          expect(result.status).toBe("waiting");
          result = resultDetails(await tools[1]!.execute("resume", { runId: result.runId }));
        }
      }
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value: [12582912, 73, 7],
        output: [{ type: "text", text: "once" }],
      });
      expect(target.execute).toHaveBeenCalledOnce();
    },
  );

  it("still enforces the actual checkpoint limit", async () => {
    const { ctx, config, tools } = createCodeModeHarness();
    applyCodeModeCatalog({ ...ctx, config, tools });
    const result = resultDetails(
      await tools[0]!.execute("checkpoint", {
        code: "const heap = new Uint8Array(12 * 1024 * 1024); await yield_control(); return heap.length;",
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
  });

  it.each([
    {
      label: "bad field",
      code: "const x = await contract({count: 1}); return x.missing;",
      unknown: false,
    },
    { label: "bad args", code: 'await contract({count: "bad"});', unknown: false },
    {
      label: "unknown output",
      code: "const x = await contract({count: 1}); return x.count;",
      unknown: true,
    },
  ])("preflight refuses $label before all effects", async ({ code, unknown }) => {
    const target = pluginToolWithExecute("contract", "Contract", async () =>
      jsonResult({ count: 1 }),
    );
    target.parameters = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    if (!unknown) {
      target.outputSchema = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    }
    const { ctx, config, tools } = createCodeModeHarness();
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
    const result = resultDetails(
      await tools[0]!.execute("preflight", {
        code: "await contract({count: 1});\n" + code,
        language: "typescript",
        typecheck: true,
      }),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "failed",
      code: "invalid_input",
      bridgeDispatchStarted: false,
      failurePhase: "input",
    });
    expect(result.error).toContain("openclaw-code-mode:user.ts:2:");
    expect(target.execute).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows valid typed composition (preflight=%s)", async (typecheck) => {
    const target = pluginToolWithExecute("contract", "Contract", async () =>
      jsonResult({ count: 7 }),
    );
    target.parameters = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    target.outputSchema = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    const { ctx, config, tools } = createCodeModeHarness();
    applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
    const result = resultDetails(
      await tools[0]!.execute("preflight", {
        code: "const x = await contract({count: 1}); console.log(x.count); return x.count;",
        language: "typescript",
        typecheck,
      }),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "completed", value: 7 });
    expect(target.execute).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "refuses a new host effect after the boundary deadline (resume=%s)",
    async (resume) => {
      const target = pluginToolWithExecute("late_effect", "Must not dispatch late", async () =>
        jsonResult({ done: true }),
      );
      const { ctx, config, tools } = createCodeModeHarness();
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const original = worker.runCodeModeWorker;
      const spy = vi.spyOn(worker, "runCodeModeWorker").mockImplementation(async (...args) => {
        const inline = args[4];
        if (!inline) {
          return await original(...args);
        }
        return await original(args[0], args[1], args[2], args[3], {
          ...inline,
          onBoundary: async (boundary, context) => {
            if (boundary.pendingRequests.some((request) => request.method === "callValue")) {
              clock.mockReturnValue(100_000);
            }
            return await inline.onBoundary(boundary, context);
          },
        });
      });
      try {
        let result = resultDetails(
          await tools[0]!.execute("late", {
            code: (resume ? "await yield_control(); " : "") + "return await late_effect({});",
          }),
        );
        if (resume) {
          expect(result.status).toBe("waiting");
          result = resultDetails(await tools[1]!.execute("late-resume", { runId: result.runId }));
        }
        expect(target.execute).not.toHaveBeenCalled();
        expect(result, JSON.stringify(result)).toMatchObject({ status: "failed", code: "timeout" });
      } finally {
        spy.mockRestore();
        clock.mockRestore();
      }
    },
  );
});
