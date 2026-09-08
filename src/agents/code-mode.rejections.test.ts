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
    {
      name: "detached promise",
      code: 'void Promise.reject(new Error("lost failure"));',
      userFrame: true,
    },
    { name: "detached tool", code: "void failing_tool({});", userFrame: true },
    {
      name: "detached combinator",
      code: "void Promise.all([failing_tool({})]);",
      userFrame: true,
    },
    {
      name: "rejection before snapshot",
      code: 'void Promise.reject(new Error("lost failure")); await yield_control();',
      userFrame: true,
    },
    {
      name: "timer callback",
      code: 'setTimeout(() => { throw new Error("lost failure"); }, 0);',
      userFrame: true,
    },
  ])("reports an unhandled $name instead of success", async ({ code, userFrame }) => {
    const { ctx, config, catalogRef, tools } = createCodeModeHarness();
    const failing = pluginToolWithExecute("failing_tool", "Fails without an outcome", async () => {
      throw new Error("lost failure");
    });
    applyCodeModeCatalog({ ...ctx, config, catalogRef, tools: [...tools, failing] });
    const result = await runUntilCompleted({
      execTool: expectDefined(tools[0], "exec"),
      waitTool: expectDefined(tools[1], "wait"),
      code: `const marker = true;\n${code} return "done";`,
    });
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("lost failure"),
    });
    expect(String(result.error)).not.toContain("openclaw-code-mode:controller.js");
    if (userFrame) {
      expect(String(result.error)).toMatch(/openclaw-code-mode:user\.js:2:\d+/);
    }
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each(["wait", "headless"] as const)(
    "reports the submitted JavaScript line through %s",
    async (mode) => {
      const code = "const value = 1;\nvalue();";
      let result;
      if (mode === "headless") {
        result = await runCodeModeScriptHeadless({ ctx: createHeadlessCodeModeHarness(), code });
      } else {
        const { ctx, tools, config, catalogRef } = createCodeModeHarness();
        applyCodeModeCatalog({ ...ctx, config, catalogRef, tools });
        result = await runUntilCompleted({
          execTool: expectDefined(tools[0], "exec"),
          waitTool: expectDefined(tools[1], "wait"),
          code: `await yield_control();\n${code}`,
        });
      }
      expect(result).toMatchObject({
        status: "failed",
        error: expect.stringContaining("TypeError"),
      });
      if (result.status !== "failed") {
        throw new Error("Expected guest runtime failure");
      }
      expect(String(result.error)).toContain(
        `openclaw-code-mode:user.js:${mode === "wait" ? 3 : 2}:`,
      );
      expect(String(result.error)).not.toContain("<eval>");
      expect(String(result.error)).not.toContain("controller.js");
    },
  );

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

  it.each(["exec", "wait", "headless"])(
    "preserves handled tool error diagnostics through %s",
    async (mode) => {
      const failing = pluginToolWithExecute("failing_tool", "Handled failure", async () => {
        throw new Error("synthetic actionable cause");
      });
      const code = `
      const results = await Promise.allSettled([failing_tool({}), Promise.resolve("ok")]);
      const failure = results[0].reason;
      failure.code = "SYNTHETIC";
      ${mode === "wait" ? "await yield_control();" : ""}
      text(failure);
      json({ results });
      return { results };
    `;
      let result;
      if (mode === "headless") {
        result = await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([failing]),
          code,
        });
      } else {
        const { ctx, config, catalogRef, tools } = createCodeModeHarness();
        applyCodeModeCatalog({ ...ctx, config, catalogRef, tools: [...tools, failing] });
        result = await runUntilCompleted({
          execTool: expectDefined(tools[0], "exec"),
          waitTool: expectDefined(tools[1], "wait"),
          code,
        });
      }
      const failure = {
        name: "Error",
        message: "synthetic actionable cause",
        code: "SYNTHETIC",
        effectStatus: "unknown",
        location: expect.stringMatching(/openclaw-code-mode:user\.js:2:/),
      };
      const value = {
        results: [
          { status: "rejected", reason: failure },
          { status: "fulfilled", value: "ok" },
        ],
      };
      expect(result).toMatchObject({ status: "completed", value });
      expect(result.output).toEqual([
        { type: "text", text: expect.any(String) },
        { type: "json", value },
      ]);
      expect(
        JSON.parse(
          expectDefined((result.output as Array<{ text: string }>)[0], "text output").text,
        ),
      ).toEqual(failure);
      expect(JSON.stringify(result.output)).not.toContain("controller.js");
      expect(failing.execute).toHaveBeenCalledTimes(1);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("projects nested Errors before their custom toJSON can hide the failure", async () => {
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness(),
      code: `
        let invoked = false;
        const error = new TypeError("visible diagnostic");
        error.toJSON = () => { invoked = true; throw new Error("hidden"); };
        json({ error });
        text(error);
        return { error, invoked };
      `,
    });
    const error = { name: "TypeError", message: "visible diagnostic" };
    expect(result).toMatchObject({ status: "completed", value: { error, invoked: false } });
    expect(result.output).toEqual([
      { type: "json", value: { error } },
      { type: "text", text: JSON.stringify(error) },
    ]);
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
