import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../runtime/index.js";

/**
 * Small reusable agent-tool stubs for tests that only need inventory shape.
 */
/** Creates a no-op tool with an empty object schema. */
export function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}
