import { messageToolOwnsVisibleReply } from "../../auto-reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HookContext } from "../agent-tools.before-tool-call.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
} from "../code-mode.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import {
  filterLocalModelLeanTools,
  resolveLocalModelLeanPreserveToolNames,
} from "../local-model-lean.js";
import type { ScheduledToolPolicyContext } from "../scheduled-tool-policy.js";
import { filterRuntimeCompatibleTools } from "../tool-schema-projection.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogRef,
  type ToolSearchCatalogToolExecutor,
} from "../tool-search.js";
import { applyAgentToolSurfaceCatalog, resolveAgentToolSurfacePlan } from "../tool-surface-plan.js";
import type { AnyAgentTool } from "../tools/common.js";

const TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES = [
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
];
const CODE_MODE_CONTROL_ALLOWLIST_NAMES = [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME];

export type AgentHarnessToolSurfaceRuntime = {
  codeModeControlsEnabled: boolean;
  compactTools: (
    tools: AnyAgentTool[],
    options?: { hookContext?: HookContext; localModelLeanApplied?: boolean },
  ) => {
    tools: AnyAgentTool[];
  };
  config: OpenClawConfig | undefined;
  includeToolSearchControls: boolean;
  runtimeToolAllowlist: string[] | undefined;
  toolSearchCatalogRef: ToolSearchCatalogRef | undefined;
  toolSearchControlsEnabled: boolean;
  cleanup: () => void;
  toolSearchCatalogExecutor: ToolSearchCatalogToolExecutor | undefined;
};

export function createAgentHarnessToolSurfaceRuntime(params: {
  abortSignal?: AbortSignal;
  agentId?: string;
  config?: OpenClawConfig;
  disableTools?: boolean;
  executeTool: ToolSearchCatalogToolExecutor;
  forceMessageTool?: boolean;
  isRawModelRun?: boolean;
  /** Prepared model row carrying catalog compat; required for `"auto"` code-mode resolution. */
  model?: { compat?: unknown };
  modelId?: string;
  modelProvider?: string;
  modelToolsEnabled: boolean;
  prompt?: string;
  runId?: string;
  runtimeToolAllowlist?: readonly string[];
  sessionId?: string;
  sessionKey?: string;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  sourceReplyDeliveryMode?: string;
  skillWorkshopProposalOnly?: boolean;
  toolsAllow?: readonly string[];
}): AgentHarnessToolSurfaceRuntime {
  const forceDirectMessageTool = messageToolOwnsVisibleReply(params);
  const {
    codeModeControlsEnabled,
    toolSearchControlsEnabled,
    toolSearchConfig,
    toolSearchRuntimeConfig,
  } = resolveAgentToolSurfacePlan({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    forceDirectMessageTool,
    model: params.model,
    toolsEnabled: params.modelToolsEnabled,
    disableTools: params.disableTools,
    isRawModelRun: params.isRawModelRun === true,
    skillWorkshopProposalOnly: params.skillWorkshopProposalOnly,
    toolsAllow: params.toolsAllow,
  });
  const toolSearchCatalogRef =
    toolSearchControlsEnabled || codeModeControlsEnabled ? createToolSearchCatalogRef() : undefined;
  const runtimeToolAllowlist =
    (toolSearchControlsEnabled || codeModeControlsEnabled) && params.runtimeToolAllowlist
      ? [
          ...new Set([
            ...params.runtimeToolAllowlist,
            ...(toolSearchControlsEnabled ? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES : []),
            ...(codeModeControlsEnabled ? CODE_MODE_CONTROL_ALLOWLIST_NAMES : []),
          ]),
        ]
      : params.runtimeToolAllowlist
        ? [...params.runtimeToolAllowlist]
        : undefined;
  const toolSearchCatalogExecutor =
    toolSearchControlsEnabled || codeModeControlsEnabled ? params.executeTool : undefined;
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
    runtimeToolAllowlist,
    scheduledToolPolicy: params.scheduledToolPolicy,
  });
  const preserveToolNames = resolveLocalModelLeanPreserveToolNames({
    toolNames: capabilityProfile.policy.explicitToolOverrideAllowlist,
    forceMessageTool: params.forceMessageTool,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
  });
  const compactTools = (
    tools: AnyAgentTool[],
    options: { hookContext?: HookContext; localModelLeanApplied?: boolean } = {},
  ): { tools: AnyAgentTool[] } => {
    // Native harness callers may supply raw tools, while the bundled tool constructor
    // already applied the full prepared policy and must not be filtered a second time.
    const projectedUncompactedTools = options.localModelLeanApplied
      ? tools
      : filterLocalModelLeanTools({
          tools,
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          preserveToolNames,
        });
    const uncompactedProjection = filterRuntimeCompatibleTools(projectedUncompactedTools);
    let effectiveTools = [...uncompactedProjection.tools];
    const codeModeTools = codeModeControlsEnabled
      ? createCodeModeTools({
          config: params.config,
          runtimeConfig: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          catalogRef: toolSearchCatalogRef,
          abortSignal: params.abortSignal,
          executeTool: params.executeTool,
        })
      : [];
    const compacted = applyAgentToolSurfaceCatalog({
      // `codeModeTools` is empty unless code-mode controls are on, so this stays
      // exactly `effectiveTools` for the tool-search branches.
      tools: [...codeModeTools, ...effectiveTools],
      config: params.config,
      toolSearchRuntimeConfig,
      codeModeControlsEnabled,
      toolSearchConfig,
      forceDirectMessageTool,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      runId: params.runId,
      catalogRef: toolSearchCatalogRef,
      toolHookContext: options.hookContext,
    });
    const projectedCompactedTools = options.localModelLeanApplied
      ? compacted.tools
      : filterLocalModelLeanTools({
          tools: compacted.tools,
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          preserveToolNames,
        });
    effectiveTools = [...filterRuntimeCompatibleTools(projectedCompactedTools).tools];
    return { tools: effectiveTools };
  };
  return {
    codeModeControlsEnabled,
    compactTools,
    config: toolSearchControlsEnabled ? toolSearchRuntimeConfig : params.config,
    includeToolSearchControls: toolSearchControlsEnabled,
    runtimeToolAllowlist,
    toolSearchCatalogRef,
    toolSearchControlsEnabled,
    cleanup: () => {
      clearToolSearchCatalog({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        runId: params.runId,
        catalogRef: toolSearchCatalogRef,
      });
    },
    toolSearchCatalogExecutor,
  };
}
