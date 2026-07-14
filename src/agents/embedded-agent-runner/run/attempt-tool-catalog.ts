/**
 * Prepares the attempt-local tool catalog, schema projection, and diagnostics.
 */
import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { resolveToolLoopDetectionConfig } from "../../agent-tools.js";
import {
  applyCodeModeCatalog,
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeTools,
} from "../../code-mode.js";
import {
  filterLocalModelLeanTools,
  shouldCatalogToolForLocalModelLean,
} from "../../local-model-lean.js";
import { logAgentRuntimeToolDiagnostics } from "../../runtime-plan/tools.js";
import { buildEmptyExplicitToolAllowlistError } from "../../tool-allowlist-guard.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import {
  applyToolSchemaDirectoryCatalog,
  applyToolSearchCatalog,
  estimateToolSchemaDirectoryToolNames,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogToolExecutor,
} from "../../tool-search.js";
import { log } from "../logger.js";
import type { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { collectAttemptExplicitToolAllowlistSources } from "./attempt-tool-allowlist.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-base-prepare.js";
import { buildToolSearchRunPlan } from "./attempt.tool-search-run-plan.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

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
    localModelLeanEnabled,
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
      })
    : [];
  const directoryRequiredToolNames =
    attempt.forceMessageTool === true || attempt.sourceReplyDeliveryMode === "message_tool_only"
      ? ["message"]
      : [];
  const directoryHydratedToolNames =
    toolSearchControlsEnabledForRun && toolSearchConfig.mode === "directory"
      ? (() => {
          try {
            return estimateToolSchemaDirectoryToolNames({
              tools: effectiveTools,
              query: attempt.prompt,
              maxTools: 4,
              requiredToolNames: directoryRequiredToolNames,
            });
          } catch (err) {
            log.warn(
              `tool-search: directory schema estimation failed; continuing with deferred schemas only (${String(err)})`,
            );
            return directoryRequiredToolNames;
          }
        })()
      : [];
  const toolSearch = codeModeControlsEnabledForRun
    ? applyCodeModeCatalog({
        tools: [...codeModeTools, ...effectiveTools],
        config: attempt.config,
        sessionId: attempt.sessionId,
        sessionKey: input.sandboxSessionKey,
        agentId: input.sessionAgentId,
        runId: attempt.runId,
        catalogRef: preparedToolBase.toolSearchCatalogRef,
        toolHookContext: catalogToolHookContext,
      })
    : toolSearchConfig.mode === "directory"
      ? applyToolSchemaDirectoryCatalog({
          tools: effectiveTools,
          config: toolSearchRuntimeConfig,
          sessionId: attempt.sessionId,
          sessionKey: input.sandboxSessionKey,
          agentId: input.sessionAgentId,
          runId: attempt.runId,
          catalogRef: preparedToolBase.toolSearchCatalogRef,
          toolHookContext: catalogToolHookContext,
          hydrateToolNames: directoryHydratedToolNames,
        })
      : applyToolSearchCatalog({
          tools: effectiveTools,
          config: toolSearchRuntimeConfig,
          sessionId: attempt.sessionId,
          sessionKey: input.sandboxSessionKey,
          agentId: input.sessionAgentId,
          runId: attempt.runId,
          catalogRef: preparedToolBase.toolSearchCatalogRef,
          toolHookContext: catalogToolHookContext,
          shouldCatalogTool:
            localModelLeanEnabled && toolSearchConfig.mode === "tools"
              ? shouldCatalogToolForLocalModelLean
              : undefined,
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
