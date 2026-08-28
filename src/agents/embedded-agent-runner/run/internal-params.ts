import type { AgentExecutionAuthBinding } from "../../execution-auth-binding.js";
import type { PreparedModelRuntimePluginGeneration } from "../../prepared-model-runtime.types.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import type { RunEmbeddedAgentParams } from "./params.js";

export type RunEmbeddedAgentInternalParams = RunEmbeddedAgentParams & {
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
  /** Maintenance needs the winning profile, not native runtime artifact capture. */
  onSuccessfulAuthProfile?: (profileId: string | undefined) => void;
  authProfileStateMode?: "read-write" | "read-only";
  /** Prepare only the requested candidate with this runtime; fallbacks keep their own policy. */
  agentHarnessRuntimePreparationHint?: string;
  /** Keep staged setup config and credentials outside configured Gateway ownership. */
  preparedModelRuntimeMode?: "isolated-read-only";
  /** Ring-zero tool override, supplied only by the OpenClaw orchestrator. */
  systemAgentTool?: SystemAgentToolOptions;
  /** Gateway-private lifecycle generation selected before command admission. */
  pluginGeneration?: PreparedModelRuntimePluginGeneration;
};

export type RunEmbeddedAgentParamsWithSessionFile = RunEmbeddedAgentInternalParams & {
  sessionFile: string;
};
