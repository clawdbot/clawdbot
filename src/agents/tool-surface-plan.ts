import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import {
  applyCodeModeCatalog,
  isCodeModeEngagedForModel,
  resolveCodeModeConfig,
} from "./code-mode.js";
import { normalizeToolPolicyName } from "./tool-policy-shared.js";
import { resolveAgentToolSearchRuntimeConfig } from "./tool-search-runtime-config.js";
import type { ToolSearchConfig } from "./tool-search-types.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";

type AgentToolSurfacePlanParams = {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  forceDirectMessageTool: boolean;
  model?: { compat?: unknown; toolSearchMode?: "tools" | false };
  modelProvider?: string;
  modelId?: string;
  codeModeOverride?: boolean | "auto";
  toolsEnabled: boolean;
  disableTools?: boolean;
  isRawModelRun: boolean;
  toolsAllow?: readonly string[];
  forceCodeModeControls?: boolean;
};

export function resolveAgentToolSurfacePlan(params: AgentToolSurfacePlanParams) {
  // Private completion replies have one message capability. Ordinary forced
  // delivery keeps message direct while other tools can still use discovery.
  const completionPrivateMessageOnly =
    params.forceDirectMessageTool &&
    params.toolsAllow?.length === 1 &&
    normalizeToolPolicyName(params.toolsAllow[0] ?? "") === "message";
  const codeModeConfig = resolveCodeModeConfig(
    params.config,
    params.agentId,
    params.modelProvider && params.modelId
      ? { provider: params.modelProvider, modelId: params.modelId }
      : undefined,
  );
  codeModeConfig.enabled = params.codeModeOverride ?? codeModeConfig.enabled;
  const toolSearchRuntimeConfig = resolveAgentToolSearchRuntimeConfig({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    completionPrivateMessageOnly,
    model: params.model,
  });
  const toolSearchConfig = resolveToolSearchConfig(toolSearchRuntimeConfig);
  const toolsAvailable =
    params.toolsEnabled &&
    getActiveAgentRingZeroTools().length === 0 &&
    params.disableTools !== true &&
    !params.isRawModelRun &&
    params.toolsAllow?.length !== 0 &&
    !completionPrivateMessageOnly;
  const codeModeControlsEnabled =
    toolsAvailable &&
    // Restart recovery continues one provider turn. Keep its original control
    // schema even when the reloaded config disables Code Mode for new turns.
    (params.forceCodeModeControls === true ||
      isCodeModeEngagedForModel(codeModeConfig, params.model));
  const toolSearchControlsEnabled =
    toolsAvailable && !codeModeControlsEnabled && toolSearchConfig.enabled;
  return {
    codeModeControlsEnabled,
    toolSearchControlsEnabled,
    toolSearchConfig,
    toolSearchRuntimeConfig,
  };
}

type CodeModeCatalogParams = Parameters<typeof applyCodeModeCatalog>[0];
type ApplyAgentToolSurfaceCatalogParams = Omit<CodeModeCatalogParams, "directToolNames"> & {
  /** Required key (may be undefined for a config-less run): the tool-search
   * branches resolve their mode from this, so omitting it would silently
   * downgrade the run to schema defaults. */
  toolSearchRuntimeConfig: OpenClawConfig | undefined;
  codeModeControlsEnabled: boolean;
  toolSearchConfig: ToolSearchConfig;
  forceDirectMessageTool: boolean;
};

export function applyAgentToolSurfaceCatalog({
  codeModeControlsEnabled,
  toolSearchConfig,
  toolSearchRuntimeConfig,
  forceDirectMessageTool,
  ...catalogParams
}: ApplyAgentToolSurfaceCatalogParams) {
  // When the message tool is the only reply path it must stay directly visible
  // in every search mode; a hidden delivery tool can leave the run mute.
  const directToolNames = forceDirectMessageTool ? ["message"] : [];
  if (codeModeControlsEnabled) {
    return applyCodeModeCatalog({
      ...catalogParams,
      config: catalogParams.config,
      directToolNames,
    });
  }
  const applyCatalog =
    toolSearchConfig.mode === "directory"
      ? applyToolSchemaDirectoryCatalog
      : applyToolSearchCatalog;
  return applyCatalog({
    ...catalogParams,
    config: toolSearchRuntimeConfig,
    directToolNames,
  });
}
