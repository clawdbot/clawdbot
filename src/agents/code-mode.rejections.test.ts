import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  expectOriginalCodeModeMarker,
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resultDetails,
  resetCodeModeTestState,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";

describe("Code Mode promise rejection settlement", () => {
  afterEach(resetCodeModeTestState);

  it.each(["return", "throw"])(
    "does not repeat yielded output when %s text is truncated",
    async (action) => {
      const { ctx } = createCodeModeHarness();
      const config = { tools: { codeMode: { enabled: true, maxOutputBytes: 1_024 } } };
      const tools = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
      applyCodeModeCatalog({ ...ctx, config, tools });
      const first = resultDetails(
        await expectDefined(tools[0], "exec").execute("yield", {
          code: `text("already delivered"); await yield_control(); ${action} ${action === "throw" ? 'new Error("x".repeat(10000))' : '"x".repeat(10000)'};`,
        }),
      );
      expect(first.status).toBe("waiting");
      expect(first.output).toEqual([{ type: "text", text: "already delivered" }]);
      const final = resultDetails(
        await expectDefined(tools[1], "wait").execute("resume", { runId: first.runId }),
      );
      expect(final.status).toBe(action === "throw" ? "failed" : "completed");
      expect(final.output).toEqual([]);
      if (action === "return") {
        expectOriginalCodeModeMarker(final.value, "x".repeat(10000));
      }
    },
  );

  it.each([
    { name: "detached promise", code: 'void Promise.reject(new Error("lost failure"));' },
    { name: "detached tool", code: "void failing_tool({});" },
    { name: "detached combinator", code: "void Promise.all([failing_tool({})]);" },
    {
      name: "rejection before snapshot",
      code: 'void Promise.reject(new Error("lost failure")); await yield_control();',
    },
    {
      name: "timer callback",
      code: 'setTimeout(() => { throw new Error("lost failure"); }, 0);',
    },
  ])("reports an unhandled $name instead of success", async ({ code }) => {
    const { ctx, config, catalogRef, tools } = createCodeModeHarness();
    const failing = pluginToolWithExecute("failing_tool", "Fails without an outcome", async () => {
      throw new Error("lost failure");
    });
    applyCodeModeCatalog({ ...ctx, config, catalogRef, tools: [...tools, failing] });
    const result = await runUntilCompleted({
      execTool: expectDefined(tools[0], "exec"),
      waitTool: expectDefined(tools[1], "wait"),
      code: `${code} return "done";`,
    });
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("lost failure"),
    });
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    "try { await failing_tool({}); } catch {}",
    "void failing_tool({}).catch(() => {});",
    "await Promise.allSettled([failing_tool({})]);",
    'const rejected = Promise.reject(new Error("handled later")); await yield_control(); await rejected.catch(() => {});',
    'await Promise.race([Promise.resolve("winner"), failing_tool({})]);',
  ])("preserves handled rejection semantics: %s", async (code) => {
    const { ctx, config, catalogRef, tools } = createCodeModeHarness();
    const failing = pluginToolWithExecute("failing_tool", "Handled failure", async () => {
      throw new Error("handled failure");
    });
    applyCodeModeCatalog({ ...ctx, config, catalogRef, tools: [...tools, failing] });
    const result = await runUntilCompleted({
      execTool: expectDefined(tools[0], "exec"),
      waitTool: expectDefined(tools[1], "wait"),
      code: `${code} return "done";`,
    });
    expect(result).toMatchObject({ status: "completed", value: "done" });
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each(["exec", "wait", "headless"])("bounds failure diagnostics through %s", async (mode) => {
    const error = "Error: " + '\\"\n😀'.repeat(10_000);
    const code = `text("before failure"); ${mode === "wait" ? "await yield_control();" : ""} throw new Error(${JSON.stringify(error)});`;
    const maxOutputBytes = 1_024;
    let result;
    if (mode === "headless") {
      result = await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness(),
        code,
        overrides: { maxOutputBytes },
      });
    } else {
      const { ctx } = createCodeModeHarness();
      const config = { tools: { codeMode: { enabled: true, maxOutputBytes } } };
      const tools = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
      applyCodeModeCatalog({ ...ctx, config, tools });
      result = await runUntilCompleted({
        execTool: expectDefined(tools[0], "exec"),
        waitTool: expectDefined(tools[1], "wait"),
        code,
      });
    }
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("[error truncated]"),
    });
    if (result.status !== "failed") {
      throw new Error("expected a failed Code Mode result");
    }
    expect(
      Buffer.byteLength(JSON.stringify(result.error)) +
        Buffer.byteLength(JSON.stringify(result.output)),
    ).toBeLessThanOrEqual(maxOutputBytes);
  });
});
