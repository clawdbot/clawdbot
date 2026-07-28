import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveAgentRingZeroTools } from "./agent-tools.ring-zero-context.js";
import {
  applyCodeModeCatalog,
  isCodeModeEngagedForModel,
  resolveCodeModeConfig,
} from "./code-mode.js";
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
  model?: { compat?: unknown };
  toolsEnabled: boolean;
  disableTools?: boolean;
  isRawModelRun: boolean;
  skillWorkshopProposalOnly?: boolean;
  toolsAllow?: readonly string[];
};

export function resolveAgentToolSurfacePlan(params: AgentToolSurfacePlanParams) {
  const codeModeConfig = resolveCodeModeConfig(params.config, params.agentId);
  const toolSearchRuntimeConfig = resolveAgentToolSearchRuntimeConfig({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    forceDirectMessageTool: params.forceDirectMessageTool,
  });
  const toolSearchConfig = resolveToolSearchConfig(toolSearchRuntimeConfig);
  const toolsAvailable =
    params.toolsEnabled &&
    getActiveAgentRingZeroTools().length === 0 &&
    params.disableTools !== true &&
    !params.isRawModelRun &&
    // Proposal-only workshop runs are deliberately narrow single-tool runs;
    // code-mode indirection and tool-search catalogs are pure overhead.
    params.skillWorkshopProposalOnly !== true &&
    params.toolsAllow?.length !== 0;
  const codeModeControlsEnabled =
    toolsAvailable && isCodeModeEngagedForModel(codeModeConfig, params.model);
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
  const applyCatalog = codeModeControlsEnabled
    ? applyCodeModeCatalog
    : toolSearchConfig.mode === "directory"
      ? applyToolSchemaDirectoryCatalog
      : applyToolSearchCatalog;
  return applyCatalog({
    ...catalogParams,
    // Code mode reads the base config; tool-search modes read the run's
    // resolved tool-search runtime config.
    config: codeModeControlsEnabled ? catalogParams.config : toolSearchRuntimeConfig,
    directToolNames,
  });
}
