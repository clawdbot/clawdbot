import { vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

export function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: name + " test tool",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: name + " done" }],
      details: {},
    })),
  };
}
