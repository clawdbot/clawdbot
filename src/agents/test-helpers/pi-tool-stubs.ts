import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

export function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}
