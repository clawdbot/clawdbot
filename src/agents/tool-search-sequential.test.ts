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

function fakeTool(name: string, executionMode?: "sequential"): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {} },
    ...(executionMode ? { executionMode } : {}),
    execute: vi.fn(async () => jsonResult({ name })),
  };
}

describe("sequential tools across catalog surfaces", () => {
  it("keeps sequential tools visible instead of hiding them behind Tool Search", () => {
    const catalogRef = createToolSearchCatalogRef();
    const compacted = applyToolSearchCatalog({
      tools: [
        fakeTool(TOOL_SEARCH_RAW_TOOL_NAME),
        fakeTool(TOOL_DESCRIBE_RAW_TOOL_NAME),
        fakeTool(TOOL_CALL_RAW_TOOL_NAME),
        fakeTool("ask_user", "sequential"),
        fakeTool("lookup"),
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
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["lookup"]);
  });

  it("keeps sequential tools visible instead of hiding them behind Code Mode", () => {
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
      tools: [...controls, fakeTool("ask_user", "sequential"), fakeTool("lookup")],
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
    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["lookup"]);
  });

  it("omits sequential tools from headless catalogs", () => {
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({
      catalogRef,
      tools: [fakeTool("ask_user", "sequential"), fakeTool("lookup")],
    });

    expect(catalogRef.current?.entries.map((entry) => entry.name)).toEqual(["lookup"]);
  });
});
