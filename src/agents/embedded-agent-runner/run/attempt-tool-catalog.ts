/**
 * Builds the attempt-local tool catalog, allowlists, and execution context.
 * It may assume core and bundled tool preparation has completed.
 */
import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
import {
  type DiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { getPluginToolMeta } from "../../../plugins/tools.js";
import { resolveToolLoopDetectionConfig } from "../../agent-tools.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
} from "../../code-mode.js";
import type { ResolvedConversationCapabilityProfile } from "../../conversation-capability-profile.js";
import { filterLocalModelLeanTools } from "../../local-model-lean.js";
import { logAgentRuntimeToolDiagnostics } from "../../runtime-plan/tools.js";
import {
  buildEmptyExplicitToolAllowlistError,
  collectExplicitToolAllowlistSources,
} from "../../tool-allowlist-guard.js";
import { isToolAllowedByPolicyName } from "../../tool-policy-match.js";
import { normalizeToolName } from "../../tool-policy.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import {
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogToolExecutor,
  collectUniqueCatalogToolNames,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
} from "../../tool-search.js";
import { applyAgentToolSurfaceCatalog } from "../../tool-surface-plan.js";
import { log } from "../logger.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunTrigger } from "./params.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Prepares the attempt-local tool catalog, schema projection, and diagnostics.
 */

type PreparedToolBase = ReturnType<typeof prepareEmbeddedAttemptToolBase>;
type PreparedBundleTools = Awaited<ReturnType<typeof prepareEmbeddedAttemptBundleTools>>;
type ProviderRuntimeHandle = Parameters<typeof logAgentRuntimeToolDiagnostics>[0]["runtimeHandle"];

export function prepareEmbeddedAttemptToolCatalog(input: {
  attempt: EmbeddedRunAttemptParams;
  preparedToolBase: PreparedToolBase;
  bundleTools: Pick<PreparedBundleTools, "clientTools" | "uncompactedEffectiveTools">;
  effectiveCwd: string;
  effectiveWorkspace: string;
  sessionAgentId: string;
  sandboxSessionKey: string;
  runTrace: DiagnosticTraceContext;
  abortSignal: AbortSignal;
  executeCodeModeTool: ToolSearchCatalogToolExecutor;
  getProviderRuntimeHandle: () => ProviderRuntimeHandle;
  markStage: (name: string) => void;
}) {
  const { attempt, preparedToolBase } = input;
  const {
    codeModeControlsEnabledForRun,
    codeModeSkills,
    localModelLeanPreserveToolNames,
    runtimeCapabilityProfile,
    toolSearchConfig,
    toolSearchControlsEnabledForRun,
    toolSearchRuntimeConfig,
    toolsEnabled,
  } = preparedToolBase;
  const { clientTools, uncompactedEffectiveTools } = input.bundleTools;
  let effectiveTools = uncompactedEffectiveTools;
  const catalogToolHookContext = {
    agentId: input.sessionAgentId,
    config: attempt.config,
    cwd: input.effectiveCwd,
    sessionKey: input.sandboxSessionKey,
    sessionId: attempt.sessionId,
    runId: attempt.runId,
    approvalReviewerDeviceId: attempt.approvalReviewerDeviceId,
    channelId: attempt.currentChannelId,
    trace: input.runTrace,
    loopDetection: resolveToolLoopDetectionConfig({
      cfg: attempt.config,
      agentId: input.sessionAgentId,
    }),
    onToolOutcome: attempt.onToolOutcome,
    allocateToolOutcomeOrdinal: attempt.allocateToolOutcomeOrdinal,
  };
  const codeModeTools = codeModeControlsEnabledForRun
    ? createCodeModeTools({
        config: attempt.config,
        runtimeConfig: attempt.config,
        agentId: input.sessionAgentId,
        sessionKey: input.sandboxSessionKey,
        sessionId: attempt.sessionId,
        runId: attempt.runId,
        catalogRef: preparedToolBase.toolSearchCatalogRef,
        abortSignal: input.abortSignal,
        forceRestartSafeTools: attempt.forceRestartSafeTools,
        executeTool: input.executeCodeModeTool,
        codeModeSkills,
      })
    : [];
  const toolSearch = applyAgentToolSurfaceCatalog({
    // `codeModeTools` is empty unless code-mode controls are on, so this stays
    // exactly `effectiveTools` for the tool-search branches.
    tools: [...codeModeTools, ...effectiveTools],
    config: attempt.config,
    toolSearchRuntimeConfig,
    codeModeControlsEnabled: codeModeControlsEnabledForRun,
    toolSearchConfig,
    forceDirectMessageTool: preparedToolBase.forceDirectMessageTool,
    forceCodeModeControls: attempt.forceCodeModeTools,
    sessionId: attempt.sessionId,
    sessionKey: input.sandboxSessionKey,
    agentId: input.sessionAgentId,
    runId: attempt.runId,
    catalogRef: preparedToolBase.toolSearchCatalogRef,
    toolHookContext: catalogToolHookContext,
    codeModeSkills,
  });
  const projectedToolSearchTools = filterLocalModelLeanTools({
    tools: toolSearch.tools,
    config: attempt.config,
    agentId: input.sessionAgentId,
    preserveToolNames: localModelLeanPreserveToolNames,
  });
  const toolSearchSchemaProjection = filterRuntimeCompatibleTools(projectedToolSearchTools);
  logRuntimeToolSchemaQuarantine({
    diagnostics: toolSearchSchemaProjection.diagnostics,
    tools: projectedToolSearchTools,
    runId: attempt.runId,
    agentId: input.sessionAgentId,
    sessionKey: attempt.sessionKey,
    sessionId: attempt.sessionId,
  });
  effectiveTools = toolSearchSchemaProjection.tools.map((tool) =>
    wrapEmbeddedAttemptToolWithActivity(tool, attempt.runId),
  );
  if (toolSearch.compacted && !toolSearch.catalogReused) {
    input.markStage(codeModeControlsEnabledForRun ? "code-mode" : "tool-search");
    log.info(
      codeModeControlsEnabledForRun
        ? `code-mode: cataloged ${toolSearch.catalogToolCount} tools behind exec/wait`
        : toolSearchConfig.mode === "directory"
          ? `tool-search: cataloged ${toolSearch.catalogToolCount} tools behind compact directory surface`
          : `tool-search: cataloged ${toolSearch.catalogToolCount} tools behind compact prompt surface`,
    );
  }
  const deferredDirectoryToolsCallable =
    toolSearchControlsEnabledForRun &&
    toolSearchConfig.mode === "directory" &&
    toolSearch.catalogRegistered;
  input.markStage("bundle-tools");
  const explicitToolAllowlistSources = collectAttemptExplicitToolAllowlistSources({
    capabilityProfile: runtimeCapabilityProfile,
    toolsAllow: attempt.toolsAllow,
  });
  const toolSearchRunPlan = buildToolSearchRunPlan({
    visibleTools: effectiveTools,
    uncompactedTools: uncompactedEffectiveTools,
    clientTools,
    clientToolsCataloged:
      toolSearch.catalogRegistered &&
      (codeModeControlsEnabledForRun || toolSearchConfig.mode !== "directory"),
    catalogToolCount: toolSearch.catalogToolCount,
    controlsEnabled: toolSearchControlsEnabledForRun || codeModeControlsEnabledForRun,
    deferredToolsCallable: deferredDirectoryToolsCallable,
    controlNames: codeModeControlsEnabledForRun
      ? [CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME]
      : toolSearchConfig.mode === "directory"
        ? [TOOL_SEARCH_RAW_TOOL_NAME, TOOL_DESCRIBE_RAW_TOOL_NAME, TOOL_CALL_RAW_TOOL_NAME]
        : undefined,
    explicitAllowlistSources: explicitToolAllowlistSources,
  });
  const emptyExplicitToolAllowlistError = attempt.forceRestartSafeTools
    ? null
    : buildEmptyExplicitToolAllowlistError({
        sources: explicitToolAllowlistSources,
        callableToolNames: toolSearchRunPlan.emptyAllowlistCallableNames,
        toolsEnabled,
        disableTools: attempt.disableTools,
        toolsAllowExplicitlyEmpty: preparedToolBase.effectiveToolsAllow?.length === 0,
      });
  logAgentRuntimeToolDiagnostics({
    runtimePlan: attempt.runtimePlan,
    tools: effectiveTools,
    provider: attempt.provider,
    config: attempt.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    model: attempt.model,
    runtimeHandle: input.getProviderRuntimeHandle(),
  });

  return {
    catalogToolHookContext,
    deferredDirectoryToolsCallable,
    effectiveTools,
    emptyExplicitToolAllowlistError,
    toolSearch,
    toolSearchRunPlan,
  };
}

export function collectAttemptExplicitToolAllowlistSources(params: {
  // The attempt's single resolved profile: keeps these allowlist *sources*
  // in lockstep with the policy that actually constructed and filtered the
  // run's tools, instead of re-resolving with divergent session inputs.
  capabilityProfile: ResolvedConversationCapabilityProfile;
  toolsAllow?: string[];
}) {
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  } = params.capabilityProfile.policy;
  return collectExplicitToolAllowlistSources([
    { label: "tools.allow", allow: globalPolicy?.allow },
    { label: "tools.byProvider.allow", allow: globalProviderPolicy?.allow },
    {
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      allow: agentPolicy?.allow,
    },
    {
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      allow: agentProviderPolicy?.allow,
    },
    { label: "group tools.allow", allow: groupPolicy?.allow },
    { label: "sandbox tools.allow", allow: sandboxPolicy?.allow },
    { label: "subagent tools.allow", allow: subagentPolicy?.allow },
    { label: "inherited tools.allow", allow: inheritedToolPolicy?.allow },
    { label: "runtime toolsAllow", allow: params.toolsAllow, enforceWhenToolsDisabled: true },
  ]);
}

/**
 * Builds tool-search execution plans from allowlists and available controls.
 */

/** Tool-search control tools that may be auto-added when tool search is enabled. */
export const TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES = [
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
];

type CollectAllowedToolNamesParams = Parameters<typeof collectAllowedToolNames>[0];

/** Derived tool allowlists used for visible prompt tools, replay tools, and empty-allowlist checks. */
type ToolSearchRunPlan = {
  visibleAllowedToolNames: Set<string>;
  replayAllowedToolNames: Set<string>;
  liveAllowedToolNames: Set<string>;
  capabilityToolNames: Set<string>;
  emptyAllowlistCallableNames: string[];
};

function collectExplicitlyAllowedClientToolNames(params: {
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): string[] {
  return (params.clientTools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name?.trim()))
    .filter((name) =>
      params.explicitAllowlistSources.some((source) =>
        isToolAllowedByPolicyName(name, { allow: source.entries }),
      ),
    );
}

function collectOpenClawCapabilityToolNames(
  tools: CollectAllowedToolNamesParams["tools"],
): Set<string> {
  return collectAllowedToolNames({
    tools: tools.filter((tool) => getPluginToolMeta(tool)?.pluginId !== "bundle-mcp"),
  });
}

/**
 * Builds the complete tool-search allowlist plan for one run. Visible tools use
 * compacted prompt state, replay tools use uncompacted state, and catalog-backed
 * client tools are represented through synthetic tool-search callable names.
 */
export function buildToolSearchRunPlan(params: {
  visibleTools: CollectAllowedToolNamesParams["tools"];
  uncompactedTools: CollectAllowedToolNamesParams["tools"];
  clientTools?: CollectAllowedToolNamesParams["clientTools"];
  clientToolsCataloged: boolean;
  catalogToolCount: number;
  controlsEnabled: boolean;
  deferredToolsCallable?: boolean;
  controlNames?: readonly string[];
  explicitAllowlistSources: Array<{ entries: string[] }>;
}): ToolSearchRunPlan {
  const visibleAllowedToolNames = collectAllowedToolNames({
    tools: params.visibleTools,
    clientTools: params.clientToolsCataloged ? undefined : params.clientTools,
  });
  const replayAllowedToolNames = collectAllowedToolNames({
    tools: params.uncompactedTools,
    clientTools: params.clientTools,
  });
  const capabilityToolNames = collectOpenClawCapabilityToolNames(
    params.deferredToolsCallable ? params.uncompactedTools : params.visibleTools,
  );
  if (params.controlsEnabled) {
    // A control that was visible in the compacted prompt must remain allowed
    // during replay even when the uncompacted tool set would otherwise omit it.
    for (const controlName of params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES) {
      if (visibleAllowedToolNames.has(controlName)) {
        replayAllowedToolNames.add(controlName);
      }
    }
  }
  const liveAllowedToolNames = params.deferredToolsCallable
    ? collectUniqueCatalogToolNames(params.uncompactedTools)
    : visibleAllowedToolNames;
  if (params.deferredToolsCallable) {
    // Deferred resolution can hydrate catalog tools, but Tool Search controls
    // excluded from the visible surface are not catalog entries.
    for (const controlName of TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES) {
      if (!visibleAllowedToolNames.has(controlName)) {
        liveAllowedToolNames.delete(controlName);
        capabilityToolNames.delete(controlName);
      }
    }
    for (const visibleName of visibleAllowedToolNames) {
      liveAllowedToolNames.add(visibleName);
    }
  }
  const explicitControlAllowlistNames = new Set(
    params.explicitAllowlistSources.flatMap((source) =>
      source.entries.map((entry) => normalizeToolName(entry)),
    ),
  );
  const autoAddedControlNames = new Set(
    (params.controlsEnabled
      ? (params.controlNames ?? TOOL_SEARCH_CONTROL_ALLOWLIST_NAMES)
      : []
    ).filter((controlName) => !explicitControlAllowlistNames.has(normalizeToolName(controlName))),
  );
  const explicitlyAllowedClientToolNames = collectExplicitlyAllowedClientToolNames({
    clientTools: params.clientTools,
    explicitAllowlistSources: params.explicitAllowlistSources,
  });
  const emptyAllowlistVisibleToolNames = params.deferredToolsCallable
    ? collectAllowedToolNames({ tools: params.visibleTools })
    : visibleAllowedToolNames;
  const explicitClientCallableNames = params.clientToolsCataloged
    ? explicitlyAllowedClientToolNames.map((name) => `tool-search-client:${name}`)
    : params.deferredToolsCallable
      ? explicitlyAllowedClientToolNames
      : [];
  return {
    visibleAllowedToolNames,
    replayAllowedToolNames,
    liveAllowedToolNames,
    capabilityToolNames,
    emptyAllowlistCallableNames: [
      ...[...emptyAllowlistVisibleToolNames].filter(
        (toolName) => !autoAddedControlNames.has(toolName),
      ),
      ...Array.from({ length: params.catalogToolCount }, (_, index) => `tool-search:${index}`),
      ...explicitClientCallableNames,
    ],
  };
}

/**
 * Builds tool run context passed to embedded-agent tool handlers.
 */

/**
 * Builds the stable tool-run context forwarded into an embedded-attempt execution.
 */
export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  toolsAllow?: string[];
  conversationToolPolicy?: GroupToolPolicyConfig;
  trace?: DiagnosticTraceContext;
}): {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  runtimeToolAllowlist?: string[];
  conversationToolPolicy?: GroupToolPolicyConfig;
  trace?: DiagnosticTraceContext;
} {
  return {
    trigger: params.trigger,
    jobId: params.jobId,
    memoryFlushWritePath: params.memoryFlushWritePath,
    ...(params.toolsAllow ? { runtimeToolAllowlist: params.toolsAllow } : {}),
    ...(params.conversationToolPolicy
      ? { conversationToolPolicy: params.conversationToolPolicy }
      : {}),
    // Freeze trace metadata at the attempt boundary so later mutable diagnostic updates do not
    // rewrite the facts attached to tool calls already in flight.
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}
