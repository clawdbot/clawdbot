import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  expectCodeModeSharedBudget,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";

afterEach(resetCodeModeTestState);

describe("Code Mode bounded console", () => {
  it("emits ordered text without throwing for errors, cycles, or accessors across restore", async () => {
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
    const first = resultDetails(
      await h.tools[0]!.execute("console", {
        code:
          "const cycle = { ok: true }; cycle.self = cycle; const log = console.log; " +
          'text("first"); log("%s", "literal", undefined, 2n); console.info(cycle); ' +
          'console.warn({ get bad() { throw new Error("must not run"); } }); ' +
          'await yield_control(); console.error("not thrown"); console.debug([1, null]); ' +
          'log("last"); return { network: typeof fetch, node: typeof process };',
      }),
    );
    expect(first).toMatchObject({
      status: "waiting",
      output: [
        { type: "text", text: "first" },
        { type: "text", text: "%s literal undefined 2n" },
        { type: "text", text: '[info] {"ok":true,"self":"[Circular]"}' },
        { type: "text", text: '[warn] {"bad":"[Accessor]"}' },
      ],
    });
    const resumed = resultDetails(
      await h.tools[1]!.execute("resume-console", { runId: first.runId }),
    );
    expect(resumed).toMatchObject({
      status: "completed",
      value: { network: "undefined", node: "undefined" },
      output: [
        { type: "text", text: "[error] not thrown" },
        { type: "text", text: "[debug] [1,null]" },
        { type: "text", text: "last" },
      ],
    });
  });

  it.each([1024, 65_536])(
    "bounds inspection and repeated console output under the %i-byte shared result cap",
    async (maxOutputBytes) => {
      const result = await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness(),
        code:
          'const huge = { unicode: "🦞".repeat(100000), values: Array(100000).fill("x") }; ' +
          'console.log(huge); console.error(new Proxy({}, { ownKeys() { throw Error("bad proxy"); } })); ' +
          "for (let i = 0; i < 20000; i++) console.log(); await yield_control(); " +
          'console.log("after exhaustion"); return true;',
        overrides: { maxOutputBytes },
      });
      expect(result.status).toBe("completed");
      expectCodeModeSharedBudget(result, maxOutputBytes);
      expect(JSON.stringify(result.output)).toContain("🦞");
      if (maxOutputBytes === 65_536) {
        expect(result.output.length).toBeLessThan(700);
        expect(
          result.output.filter(
            (entry) =>
              isRecord(entry) &&
              entry.type === "text" &&
              entry.text === "[console output truncated]",
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(result.output)).not.toContain("after exhaustion");
        expect(JSON.stringify(result.output)).toContain("[Unserializable]");
      }
    },
  );
});
