import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }): {
  builtInTools: NonNullable<CreateAgentSessionOptions["tools"]>;
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools } = options;
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools),
  };
}
