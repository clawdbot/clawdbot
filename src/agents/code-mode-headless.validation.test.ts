import { expect, it, vi } from "vitest";
import { runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

it("rejects schema-invalid nested input before headless tool execution", async () => {
  const strict: AnyAgentTool = {
    name: "headless_strict",
    label: "headless_strict",
    description: "Strict headless test tool",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: vi.fn(async () => jsonResult({ unexpected: true })),
  };
  const config = { tools: { codeMode: { enabled: false, timeoutMs: 60_000 } } } as never;
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [strict] });
  const ctx: ToolSearchToolContext = { config, runtimeConfig: config, agentId: "main", catalogRef };

  const result = await runCodeModeScriptHeadless({
    ctx,
    code: "return await headless_strict({ value: 42 });",
    wallClockMs: 120_000,
  });

  expect(result.status).toBe("failed");
  if (result.status !== "failed") {
    throw new Error("expected headless Code Mode failure");
  }
  expect(result.error).toContain("value");
  expect(result.toolCallCount).toBe(1);
  expect(strict.execute).not.toHaveBeenCalled();
});
