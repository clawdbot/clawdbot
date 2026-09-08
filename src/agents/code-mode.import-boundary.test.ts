import { expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("./subagents/registry/subagent-registry.js", () => {
  throw new Error("ordinary Code Mode must not load the subagent registry");
});

vi.mock("./tools/agents-wait-tool.js", () => {
  throw new Error("ordinary Code Mode must not load the collector waiter");
});

vi.mock("../skills/workshop/service-query.js", () => {
  throw new Error("ordinary Code Mode must not load Skill Workshop proposal queries");
});

it.each([false, true])(
  "executes ordinary tools without optional runtime imports (swarm=%s)",
  async (enabled) => {
    const { applyCodeModeCatalog, createCodeModeTools } = await import("./code-mode.js");
    const { runUntilCompleted } = await import("./code-mode.test-support.js");
    const { createToolSearchCatalogRef, clearToolSearchCatalog } =
      await import("./tool-search-catalog.js");
    const catalogRef = createToolSearchCatalogRef();
    const config = { tools: { codeMode: true, swarm: { enabled } } };
    const ctx = { config, runtimeConfig: config, catalogRef };
    const tools = createCodeModeTools(ctx);
    const execute = vi.fn(async () => ({ content: [], details: { answer: 42 } }));
    const ordinary: AnyAgentTool = {
      name: "ordinary",
      label: "Ordinary",
      description: "Return a structured answer.",
      parameters: { type: "object", properties: {} },
      execute,
    };
    try {
      applyCodeModeCatalog({ tools: [...tools, ordinary], config, catalogRef });
      const [execTool, waitTool] = tools;
      if (!execTool || !waitTool) {
        throw new Error("expected Code Mode controls");
      }
      const result = await runUntilCompleted({
        execTool,
        waitTool,
        code: "return await ordinary({});",
      });
      expect(result).toMatchObject({ status: "completed", value: { answer: 42 } });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  },
);
