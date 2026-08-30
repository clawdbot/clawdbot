import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  expectCodeModeSharedBudget,
  expectOriginalCodeModeMarker,
  pluginTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

const fakeTool = pluginToolWithExecute;
afterEach(resetCodeModeTestState);
describe("Code Mode output provenance", () => {
  it.each([
    {
      name: "original 1KiB",
      cap: 1024,
      first: "🦞".repeat(140),
      last: "é".repeat(240),
      value: true,
      fail: false,
    },
    {
      name: "default budget",
      cap: undefined,
      first: "🦞".repeat(9000),
      last: "é".repeat(18000),
      value: true,
      fail: false,
    },
    {
      name: "clipped leg with literal replacement character",
      cap: 1024,
      first: "�" + "🦞".repeat(1000),
      last: "é".repeat(80),
      value: true,
      fail: false,
    },
    {
      name: "final value",
      cap: 1024,
      first: "x".repeat(700),
      last: "",
      value: { payload: "é".repeat(1000) },
      fail: false,
    },
    {
      name: "cumulative error",
      cap: 1024,
      first: "🦞".repeat(140),
      last: "é".repeat(240),
      value: true,
      fail: true,
    },
  ])(
    "bounds original output and values across worker legs: $name",
    async ({ cap, first, last, value, fail }) => {
      const tool = fakeTool("output_boundary", "Output boundary", async () =>
        jsonResult({ ok: true }),
      );
      const result = await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([tool]),
        code: `text(${JSON.stringify(first)}); await output_boundary({}); ${last ? `text(${JSON.stringify(last)});` : ""} ${fail ? 'throw new Error("DIAGNOSTIC" + "é".repeat(4000));' : `return ${JSON.stringify(value)};`}`,
        ...(cap ? { overrides: { maxOutputBytes: cap } } : {}),
      });
      expect(result.status).toBe(fail ? "failed" : "completed");
      expectCodeModeSharedBudget(result, cap ?? 65536);
      const original = [
        { type: "text", text: first },
        ...(last ? [{ type: "text", text: last }] : []),
      ];
      expectOriginalCodeModeMarker(result.output[0], original);
      if (result.status === "completed") {
        if (value === true) {
          expect(result.value).toBe(true);
        } else {
          expectOriginalCodeModeMarker(result.value, value);
        }
      } else {
        expect(result.code).toBe("internal_error");
        expect(result.error).toMatch(/^Error: DIAGNOSTIC.*\[error truncated\]$/s);
      }
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(result.toolCallCount).toBe(1);
    },
  );

  it.each(["interactive", "headless"])(
    "preserves emission-time conversion and marker-looking data through %s",
    async (mode) => {
      const literal = {
        truncated: true,
        prefix: "guest",
        omittedBytes: 123,
        guidance: "data",
        kind: "prefix",
        json: "claimed",
        originalBytes: 99999,
      };
      const code = `const literal = ${JSON.stringify(literal)};
      const mutable = { label: "before" };
      json(mutable); text(mutable); mutable.label = "after";
      json(literal); json(undefined); text(undefined); json(12n);
      await yield_control(); mutable.label = "later"; json(mutable);
      return literal;`;
      let result;
      if (mode === "headless") {
        result = await runCodeModeScriptHeadless({ ctx: createHeadlessCodeModeHarness(), code });
      } else {
        const h = createCodeModeHarness();
        applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
        const first = resultDetails(await h.tools[0]!.execute("conversion", { code }));
        expect(first.status).toBe("waiting");
        const final = await waitUntilCompleted({ details: first, waitTool: h.tools[1]! });
        result = {
          ...final,
          output: [...(first.output as unknown[]), ...(final.output as unknown[])],
        };
      }
      expect(result).toMatchObject({
        status: "completed",
        value: literal,
        output: [
          { type: "json", value: { label: "before" } },
          { type: "text", text: '{"label":"before"}' },
          { type: "json", value: literal },
          { type: "json", value: null },
          { type: "text", text: "null" },
          { type: "json", value: "12" },
          { type: "json", value: { label: "later" } },
        ],
      });
    },
  );

  it.each(["interactive", "headless"])(
    "counts actual bridge markers as guest data through %s",
    async (mode) => {
      const payload = { text: "🦞".repeat(1000) };
      const fixture = fakeTool("marker_fixture", "Large nested result", async () =>
        jsonResult(payload),
      );
      const code =
        "const marker = await marker_fixture({}); text(JSON.stringify(marker)); await yield_control(); json(marker); return true;";
      let result;
      let marker: unknown;
      if (mode === "headless") {
        const ctx = createHeadlessCodeModeHarness([fixture]);
        const control = await runCodeModeScriptHeadless({
          ctx,
          code: "return await marker_fixture({});",
          overrides: { maxOutputBytes: 1024 },
        });
        if (control.status !== "completed") {
          throw new Error(control.error);
        }
        marker = control.value;
        result = await runCodeModeScriptHeadless({
          ctx,
          code,
          overrides: { maxOutputBytes: 1024 },
        });
      } else {
        const { ctx } = createCodeModeHarness();
        const config = { tools: { codeMode: { enabled: true, maxOutputBytes: 1024 } } };
        const tools = createCodeModeTools({ ...ctx, config, runtimeConfig: config });
        applyCodeModeCatalog({ ...ctx, config, tools: [...tools, fixture] });
        marker = resultDetails(
          await tools[0]!.execute("marker", { code: "return await marker_fixture({});" }),
        ).value;
        result = await waitUntilCompleted({
          details: resultDetails(await tools[0]!.execute("emit-marker", { code })),
          waitTool: tools[1]!,
        });
      }
      expectOriginalCodeModeMarker(marker, payload);
      expect(result).toMatchObject({ status: "completed", value: true });
      expectCodeModeSharedBudget(result, 1024);
      expectOriginalCodeModeMarker((result.output as unknown[])[0], [
        { type: "text", text: JSON.stringify(marker) },
        { type: "json", value: marker },
      ]);
      expect(fixture.execute).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "reports only unsettled pending tool calls without replaying output (clipped=%s)",
    async (clipped) => {
      const catalogRef = createToolSearchCatalogRef();
      const config = {
        tools: {
          codeMode: {
            enabled: true,
            timeoutMs: 500,
            maxOutputBytes: 1024,
          },
        },
      } as never;
      const ctx = {
        config,
        runtimeConfig: config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      };
      const codeModeTools = createCodeModeTools(ctx);
      applyCodeModeCatalog({
        tools: [
          ...codeModeTools,
          pluginTool("fake_fast", "Fast helper"),
          pluginToolWithExecute(
            "fake_slow",
            "Slow helper",
            async () => await new Promise<never>(() => {}),
          ),
        ],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const first = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          "code-call-timeout",
          {
            code: `
          text(${JSON.stringify("before timeout".repeat(clipped ? 200 : 1))});
          const fast = fake_fast({});
          const slow = fake_slow({});
          await fast;
          await slow;
          return "done";
        `,
          },
        ),
      );
      expect(first.status).toBe("waiting");
      if (clipped) {
        expectOriginalCodeModeMarker((first.output as unknown[])[0], [
          { type: "text", text: "before timeout".repeat(200) },
        ]);
      } else {
        expect(first.output).toEqual([{ type: "text", text: "before timeout" }]);
      }
      // The fast call may settle as the snapshot is parked, but the slow call must remain pending.
      expect(first.pendingToolCalls).toContainEqual(
        expect.objectContaining({ id: "bridge:callValue:2", method: "callValue" }),
      );
      const runId = first.runId;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") {
        throw new Error("expected code mode run id");
      }

      const activeRun = testing.activeRuns.get(runId);
      expect(activeRun).toBeDefined();
      activeRun!.config.timeoutMs = 100;

      const second = resultDetails(
        await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
          "code-wait-timeout",
          { runId },
        ),
      );

      expect(second.status).toBe("waiting");
      expect(second.output).toEqual([]);
      expect(second.pendingToolCalls).toEqual([expect.objectContaining({ method: "callValue" })]);

      const third = resultDetails(
        await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
          "code-wait-timeout-again",
          { runId },
        ),
      );

      expect(third.status).toBe("waiting");
      expect(third.output).toEqual([]);
      expect(third.pendingToolCalls).toEqual([expect.objectContaining({ method: "callValue" })]);
    },
  );
});
