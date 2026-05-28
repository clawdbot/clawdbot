import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../runtime/index.js";

export function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}
