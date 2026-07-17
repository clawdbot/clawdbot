import { describe, expect, it, vi } from "vitest";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

type YieldTestTool = AnyAgentTool & { canYield?: boolean };

function fakeTool(params: {
  name: string;
  executionMode?: "sequential";
  canYield?: boolean;
}): YieldTestTool {
  return {
    name: params.name,
    label: params.name,
    description: `${params.name} test tool`,
    parameters: { type: "object", properties: {} },
    ...(params.executionMode ? { executionMode: params.executionMode } : {}),
    ...(params.canYield ? { canYield: true } : {}),
    execute: vi.fn(async () => jsonResult({ name: params.name })),
  };
}

describe("sequential tools across catalog surfaces", () => {
  it("keeps only yield-capable sequential tools visible in Tool Search", () => {
    const catalogRef = createToolSearchCatalogRef();
    const compacted = applyToolSearchCatalog({
      tools: [
        fakeTool({ name: TOOL_SEARCH_RAW_TOOL_NAME }),
        fakeTool({ name: TOOL_DESCRIBE_RAW_TOOL_NAME }),
        fakeTool({ name: TOOL_CALL_RAW_TOOL_NAME }),
        fakeTool({ name: "ask_user", executionMode: "sequential", canYield: true }),
        fakeTool({ name: "batcher", executionMode: "sequential" }),
        fakeTool({ name: "lookup" }),
      ],
      config: { tools: { toolSearch: { enabled: true, mode: "tools" } } } as never,
      catalogRef,
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      TOOL_SEARCH_RAW_TOOL_NAME,
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      TOOL_CALL_RAW_TOOL_NAME,
      "ask_user",
    ]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "batcher",
      "lookup",
    ]);
  });

  it("keeps only yield-capable sequential tools visible in Code Mode", () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { codeMode: true } } as never;
    const controls = createCodeModeTools({
      config,
      runtimeConfig: config,
      sessionId: "session-sequential-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-sequential-code-mode",
      catalogRef,
    });
    const compacted = applyCodeModeCatalog({
      tools: [
        ...controls,
        fakeTool({ name: "ask_user", executionMode: "sequential", canYield: true }),
        fakeTool({ name: "batcher", executionMode: "sequential" }),
        fakeTool({ name: "lookup" }),
      ],
      config,
      sessionId: "session-sequential-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-sequential-code-mode",
      catalogRef,
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      controls[0]?.name,
      controls[1]?.name,
      "ask_user",
    ]);
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "batcher",
      "lookup",
    ]);
  });

  it("omits only yield-capable sequential tools from headless catalogs", () => {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: [
        fakeTool({ name: "ask_user", executionMode: "sequential", canYield: true }),
        fakeTool({ name: "batcher", executionMode: "sequential" }),
        fakeTool({ name: "lookup" }),
      ],
    });

    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual([
      "batcher",
      "lookup",
    ]);
  });
});
