import type { AgentExecutionAttribution } from "../../agent-execution-attribution.js";
import type { AgentExecutionAuthBinding } from "../../execution-auth-binding.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export type AgentExecutionAttributionInfo = {
  lifecycleGeneration?: string;
  attribution?: AgentExecutionAttribution;
};

export type RunEmbeddedAgentInternalParams = RunEmbeddedAgentParams & {
  /** Admission-owned execution correlation carried unchanged across attempts. */
  attribution?: AgentExecutionAttribution;
  /** Private observer for host-owned attribution after final execution admission. */
  onExecutionAttributionChanged?: (info: AgentExecutionAttributionInfo) => void;
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
  authProfileStateMode?: "read-write" | "read-only";
  /** Keep staged setup config and credentials outside configured Gateway ownership. */
  preparedModelRuntimeMode?: "isolated-read-only";
  /** Ring-zero tool override, supplied only by the OpenClaw orchestrator. */
  systemAgentTool?: SystemAgentToolOptions;
};

export type RunEmbeddedAgentParamsWithSessionFile = RunEmbeddedAgentInternalParams & {
  sessionFile: string;
};
