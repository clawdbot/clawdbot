import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { consumeRepairableCodeModeFailure } from "./code-mode-repair-provenance.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  pluginTool,
  resetCodeModeTestState,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";

describe.each(["interactive", "headless"] as const)("Code Mode %s search", (mode) => {
  afterEach(resetCodeModeTestState);

  function setup(maxOutputBytes = 1_024, maxSearchLimit = 50) {
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { codeMode: { enabled: true, maxOutputBytes, maxSearchLimit } } };
    const ctx = { config, catalogRef };
    const tools = createCodeModeTools(ctx);
    const targets = Array.from({ length: 50 }, (_, index) =>
      pluginTool(
        `shipment_${String(index).padStart(2, "0")}_${"long_name_".repeat(5)}`,
        "Find shipment",
      ),
    );
    applyCodeModeCatalog({ tools: [...tools, ...targets], config, catalogRef });
    const run = async (code: string) =>
      mode === "headless"
        ? await runCodeModeScriptHeadless({ ctx, code })
        : await runUntilCompleted({
            execTool: expectDefined(tools[0], "exec"),
            waitTool: expectDefined(tools[1], "wait"),
            code,
          });
    return { run, targets };
  }

  it("rejects overflowing search results and leaves narrowed discovery callable", async () => {
    const { run, targets } = setup();
    const overflow = await run(
      'return (await catalog.search("shipment", { limit: 50 })).map(tool => tool.callableName);',
    );
    expect(overflow, JSON.stringify(overflow)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/search.*narrow.*limit/i),
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }
    if (mode === "interactive") {
      expect(consumeRepairableCodeModeFailure(overflow)).toBe(true);
    }

    const narrowed = await run(`
      const matches = await catalog.search("shipment", { limit: 1 });
      if (!Object.isFrozen(matches) || matches.length !== 1) throw new Error("invalid handles");
      return await matches[0]({ value: "ship" });
    `);
    expect(narrowed).toMatchObject({
      status: "completed",
      value: { name: targets[0]?.name, input: { value: "ship" } },
    });
    expect(targets[0]?.execute).toHaveBeenCalledOnce();
    for (const target of targets.slice(1)) {
      expect(target.execute).not.toHaveBeenCalled();
    }
    expect(testing.activeRuns.size).toBe(0);
    expect(testing.resumingRunIds.size).toBe(0);
  });

  it.each([
    {
      name: "genuine no-match",
      query: "zzzz_missing_tool",
      options: "{ limit: 50 }",
      bytes: 1_024,
      max: 50,
      count: 0,
    },
    {
      name: "default output budget",
      query: "shipment",
      options: "{ limit: 50 }",
      bytes: 65_536,
      max: 50,
      count: 50,
    },
    {
      name: "omitted limit clamp",
      query: "shipment",
      options: "undefined",
      bytes: 1_024,
      max: 3,
      count: 3,
    },
    {
      name: "explicit limit clamp",
      query: "shipment",
      options: "{ limit: 50 }",
      bytes: 1_024,
      max: 3,
      count: 3,
    },
  ])("preserves $name", async ({ query, options, bytes, max, count }) => {
    const { run, targets } = setup(bytes, max);
    const result = await run(`
      const matches = await catalog.search(${JSON.stringify(query)}, ${options});
      return { count: matches.length, frozen: Object.isFrozen(matches), callable: matches.every(tool => typeof tool === "function") };
    `);
    expect(result).toMatchObject({
      status: "completed",
      value: { count, frozen: true, callable: true },
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }
  });
});
