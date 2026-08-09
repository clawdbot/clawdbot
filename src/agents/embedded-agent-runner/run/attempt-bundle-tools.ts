import { getPluginToolMeta } from "../../../plugins/tools.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "../../agent-bundle-mcp-tools.js";
import { filterLocalModelLeanTools } from "../../local-model-lean.js";
import { normalizeAgentRuntimeTools } from "../../runtime-plan/tools.js";
import { isRuntimeToolAllowed } from "../../tool-policy-match.js";
import { replaceWithEffectiveToolAllowlist } from "../../tool-policy.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import { captureFinalEffectiveCronCreatorToolAllowlist } from "../../tools/cron-tool.js";
import { applyFinalEffectiveToolPolicy } from "../effective-tool-policy.js";
import { log } from "../logger.js";
import type { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-base-prepare.js";
import {
  applyEmbeddedAttemptToolsAllow,
  shouldCreateBundleLspRuntimeForAttempt,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./attempt-tool-construction-plan.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSetup = Awaited<ReturnType<typeof prepareEmbeddedAttemptSetup>>;
type PreparedToolBase = ReturnType<typeof prepareEmbeddedAttemptToolBase>;

export async function prepareEmbeddedAttemptBundleTools(params: {
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  effectiveWorkspace: string;
  getCurrentAttemptPluginMetadataSnapshot: AttemptSetup["getCurrentAttemptPluginMetadataSnapshot"];
  getProviderRuntimeHandle: AttemptSetup["getProviderRuntimeHandle"];
  isRawModelRun: boolean;
  preparedToolBase: PreparedToolBase;
  sessionAgentId: string;
}) {
  const {
    cronCreatorToolAllowlist,
    cronCreatorToolAllowlistCaptureRef,
    effectiveToolsAllow,
    inheritedToolAllowlist,
    localModelLeanPreserveToolNames,
    runtimeCapabilityProfile,
    toolsEnabled,
    toolsRaw,
  } = params.preparedToolBase;
  const tools = normalizeAgentRuntimeTools({
    runtimePlan: params.attempt.runtimePlan,
    tools: toolsEnabled ? toolsRaw : [],
    provider: params.attempt.provider,
    config: params.attempt.config,
    workspaceDir: params.effectiveWorkspace,
    env: process.env,
    modelId: params.attempt.modelId,
    modelApi: params.attempt.model.api,
    model: params.attempt.model,
    runtimeHandle: params.getProviderRuntimeHandle(),
    onPreNormalizationSchemaDiagnostics: (diagnostics, sourceTools) =>
      logRuntimeToolSchemaQuarantine({
        diagnostics,
        tools: sourceTools,
        runId: params.attempt.runId,
        agentId: params.sessionAgentId,
        sessionKey: params.attempt.sessionKey,
        sessionId: params.attempt.sessionId,
      }),
  });
  const providedClientTools =
    toolsEnabled &&
    !params.attempt.disableTools &&
    !params.isRawModelRun &&
    !params.attempt.forceRestartSafeTools
      ? params.attempt.clientTools
      : undefined;
  // Client functions share the attempt's authority; filter before their names
  // can reserve bundled tools or enter deferred catalogs and provider requests.
  const clientTools =
    providedClientTools && effectiveToolsAllow
      ? providedClientTools.filter((definition) =>
          isRuntimeToolAllowed(definition.function.name, effectiveToolsAllow),
        )
      : providedClientTools;
  const bundleMcpEnabled =
    !params.attempt.forceRestartSafeTools &&
    shouldCreateBundleMcpRuntimeForAttempt({
      toolsEnabled,
      disableTools: params.attempt.disableTools || params.isRawModelRun,
      toolsAllow: params.attempt.toolsAllow,
    });
  const bundleMetadataSnapshot = params.getCurrentAttemptPluginMetadataSnapshot();
  // Scoped registries are partial views; only complete snapshots can bypass bundle discovery.
  const bundleManifestRegistry =
    bundleMetadataSnapshot?.pluginIds === undefined
      ? bundleMetadataSnapshot?.manifestRegistry
      : undefined;
  const bundleMcpSessionRuntime = bundleMcpEnabled
    ? await getOrCreateSessionMcpRuntime({
        sessionId: params.attempt.sessionId,
        sessionKey: params.attempt.sessionKey,
        workspaceDir: params.effectiveWorkspace,
        agentDir: params.agentDir,
        cfg: params.attempt.config,
        manifestRegistry: bundleManifestRegistry,
        // senderId is only set from the verified inbound sender (sessionCtx.SenderId
        // or the triggering run's sender on follow-ups). Cron/subagent/heartbeat runs
        // leave it unset, so requester-scoped MCP stays fail-closed for those paths.
        requesterSenderId: params.attempt.senderId,
        agentAccountId: params.attempt.agentAccountId,
        messageChannel: params.attempt.messageChannel ?? params.attempt.messageProvider,
        toolOverrides: params.attempt.toolOverrides,
      })
    : undefined;
  const bundleMcpRuntime = bundleMcpSessionRuntime
    ? await materializeBundleMcpToolsForRun({
        runtime: bundleMcpSessionRuntime,
        reservedToolNames: [
          ...tools.map((tool) => tool.name),
          ...(clientTools?.map((tool) => tool.function.name) ?? []),
        ],
      })
    : undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  try {
    const bundleLspEnabled =
      !params.attempt.forceRestartSafeTools &&
      shouldCreateBundleLspRuntimeForAttempt({
        toolsEnabled,
        disableTools: params.attempt.disableTools || params.isRawModelRun,
        toolsAllow: params.attempt.toolsAllow,
      });
    bundleLspRuntime = bundleLspEnabled
      ? await createBundleLspToolRuntime({
          workspaceDir: params.effectiveWorkspace,
          cfg: params.attempt.config,
          manifestRegistry: bundleManifestRegistry,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(clientTools?.map((tool) => tool.function.name) ?? []),
            ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
        })
      : undefined;
    const allowedBundleMcpTools = applyEmbeddedAttemptToolsAllow(
      bundleMcpRuntime?.tools ?? [],
      effectiveToolsAllow,
      { toolMeta: (tool) => getPluginToolMeta(tool) },
    );
    const allowedBundleLspTools = applyEmbeddedAttemptToolsAllow(
      bundleLspRuntime?.tools ?? [],
      effectiveToolsAllow,
      { toolMeta: (tool) => getPluginToolMeta(tool) },
    );
    const filteredBundledTools = applyFinalEffectiveToolPolicy({
      bundledTools: [...allowedBundleMcpTools, ...allowedBundleLspTools],
      config: params.attempt.config,
      workspaceDir: params.effectiveWorkspace,
      metadataSnapshot: bundleMetadataSnapshot,
      conversationCapabilityProfile: runtimeCapabilityProfile,
      warn: (message) => log.warn(message),
    });
    if (bundleMcpRuntime?.restrictAppTools) {
      const runtimeAllowedAppTools = applyEmbeddedAttemptToolsAllow(
        bundleMcpRuntime.appTools ?? bundleMcpRuntime.tools,
        effectiveToolsAllow,
        { toolMeta: (tool) => getPluginToolMeta(tool) },
      );
      const allowedAppTools = applyFinalEffectiveToolPolicy({
        bundledTools: runtimeAllowedAppTools,
        config: params.attempt.config,
        workspaceDir: params.effectiveWorkspace,
        metadataSnapshot: bundleMetadataSnapshot,
        conversationCapabilityProfile: runtimeCapabilityProfile,
        warn: (message) => log.warn(message),
      });
      // The view outlives this attempt; capture policy against the complete MCP catalog now.
      bundleMcpRuntime.restrictAppTools(allowedAppTools);
    }
    const normalizedBundledTools =
      filteredBundledTools.length > 0
        ? normalizeAgentRuntimeTools({
            runtimePlan: params.attempt.runtimePlan,
            tools: filteredBundledTools,
            provider: params.attempt.provider,
            config: params.attempt.config,
            workspaceDir: params.effectiveWorkspace,
            env: process.env,
            modelId: params.attempt.modelId,
            modelApi: params.attempt.model.api,
            model: params.attempt.model,
            runtimeHandle: params.getProviderRuntimeHandle(),
            onPreNormalizationSchemaDiagnostics: (diagnostics, sourceTools) =>
              logRuntimeToolSchemaQuarantine({
                diagnostics,
                tools: sourceTools,
                runId: params.attempt.runId,
                agentId: params.sessionAgentId,
                sessionKey: params.attempt.sessionKey,
                sessionId: params.attempt.sessionId,
              }),
          })
        : filteredBundledTools;
    const projectedTools = filterLocalModelLeanTools({
      tools: [...tools, ...normalizedBundledTools],
      config: params.attempt.config,
      agentId: params.sessionAgentId,
      preserveToolNames: localModelLeanPreserveToolNames,
    });
    const schemaProjection = filterRuntimeCompatibleTools(projectedTools);
    if (cronCreatorToolAllowlistCaptureRef) {
      // Cron is constructed before bundled tools; capture only the executable
      // surface that survived provider normalization and schema quarantine.
      captureFinalEffectiveCronCreatorToolAllowlist(
        cronCreatorToolAllowlist,
        cronCreatorToolAllowlistCaptureRef,
        schemaProjection.tools,
        (tool) => getPluginToolMeta(tool),
      );
    }
    if (inheritedToolAllowlist?.length) {
      // Spawn tools close over this ref before MCP/LSP materialize. Refresh it
      // only after final policy and schema projection so children inherit the
      // parent's complete authorized surface, never denied bundled tools.
      replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, schemaProjection.tools);
    }
    logRuntimeToolSchemaQuarantine({
      diagnostics: schemaProjection.diagnostics,
      tools: projectedTools,
      runId: params.attempt.runId,
      agentId: params.sessionAgentId,
      sessionKey: params.attempt.sessionKey,
      sessionId: params.attempt.sessionId,
    });
    return {
      bundleLspRuntime,
      bundleMcpRuntime,
      clientTools,
      tools,
      uncompactedEffectiveTools: [...schemaProjection.tools],
    };
  } catch (error) {
    try {
      await bundleMcpRuntime?.dispose();
    } catch {
      // Preserve the preparation error; cleanup is best-effort.
    }
    try {
      await bundleLspRuntime?.dispose();
    } catch {
      // Preserve the preparation error; cleanup is best-effort.
    }
    throw error;
  }
}
