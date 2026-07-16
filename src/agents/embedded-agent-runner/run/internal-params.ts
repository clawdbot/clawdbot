import type { AgentExecutionAuthBinding } from "../../execution-auth-binding.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export type RunEmbeddedAgentInternalParams = RunEmbeddedAgentParams & {
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
  authProfileStateMode?: "read-write" | "read-only";
  /** Ring-zero tool override, supplied only by the OpenClaw orchestrator. */
  systemAgentTool?: SystemAgentToolOptions;
};

export type RunEmbeddedAgentParamsWithSessionFile = RunEmbeddedAgentInternalParams & {
  sessionFile: string;
};
