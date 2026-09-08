import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { runBridgeRequest } from "./code-mode-bridge.js";
import { createCodeModeCatalogProjection } from "./code-mode-catalog.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { CodeModeProgramDataInbox } from "./code-mode-program-data.js";
import { resolveCodeModeConfig, toToolSearchConfig } from "./code-mode-runtime.js";
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
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { createToolSearchCatalogRef, registerHeadlessToolSearchCatalog } from "./tool-search.js";

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

  it("keeps discovery intact beyond the display budget and leaves narrowed discovery callable", async () => {
    const { run, targets } = setup();
    const overflow = await run(
      'const matches = await catalog.search("shipment", { limit: 50 }); return { count: matches.length, callable: matches.every(tool => typeof tool === "function") };',
    );
    expect(overflow, JSON.stringify(overflow)).toMatchObject({
      status: "completed",
      value: { count: 50, callable: true },
    });
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
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

it("refuses oversized discovery as a catchable bridge error and accepts a narrower query", async () => {
  const catalogRef = createToolSearchCatalogRef();
  const targets = Array.from({ length: 50 }, (_, i) =>
    pluginTool("shipment_" + i + "_".repeat(50), "Find shipment"),
  );
  registerHeadlessToolSearchCatalog({ catalogRef, tools: targets });
  const config = {
    tools: { codeMode: { enabled: true, maxSearchLimit: 50, maxSnapshotBytes: 1024 } },
  };
  const ctx = { config, catalogRef };
  const limits = resolveCodeModeConfig(config);
  const runtime = new ToolSearchRuntime(ctx, toToolSearchConfig(limits));
  const inbox = new CodeModeProgramDataInbox(limits);
  try {
    for (const limit of [50, 1]) {
      const reply = inbox.createReply(String(limit));
      expect(
        await runBridgeRequest({
          runtime,
          catalogProjection: createCodeModeCatalogProjection(runtime.all({ includeMcp: false })),
          namespaceRuntime: createCodeModeNamespaceRuntime(),
          parentToolCallId: "search-admission",
          codeModeRunId: "search-admission",
          remainingMs: 10000,
          ctx,
          reply,
          request: { id: String(limit), method: "search", args: ["shipment", { limit }] },
        }),
      ).toBeUndefined();
      const settled = reply.take();
      expect(settled.ok).toBe(limit === 1);
      const value = JSON.parse(settled.json);
      if (limit === 50) {
        expect(value).toMatch(/program-data budget exceeded/);
      } else {
        expect(value).toEqual([targets[0]!.name]);
      }
      reply.release();
    }
    for (const target of targets) {
      expect(target.execute).not.toHaveBeenCalled();
    }
  } finally {
    inbox.close();
  }
});
