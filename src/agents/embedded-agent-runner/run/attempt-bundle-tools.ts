import { getPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import { assignSafeServerNames, TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../../agent-bundle-mcp-runtime-config.js";
import {
  acquireSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "../../agent-bundle-mcp-tools.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { filterLocalModelLeanTools } from "../../local-model-lean.js";
import { recordAgentCleanupFailure } from "../../run-cleanup-timeout.js";
import { normalizeAgentRuntimeTools } from "../../runtime-plan/tools.js";
import { createRuntimeToolMatcher } from "../../tool-policy-match.js";
import { replaceWithEffectiveToolAllowlist } from "../../tool-policy.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import { captureFinalEffectiveCronCreatorToolAllowlist } from "../../tools/cron-tool.js";
import { applyFinalEffectiveToolPolicy } from "../effective-tool-policy.js";
import { log } from "../logger.js";
import type { EmbeddedAttemptSetup } from "./attempt-setup.js";
import {
  applyEmbeddedAttemptToolsAllow,
  shouldCreateBundleLspRuntimeForAttempt,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./attempt-tool-construction-plan.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PreparedToolBase = ReturnType<typeof prepareEmbeddedAttemptToolBase>;

export async function prepareEmbeddedAttemptBundleTools(params: {
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  setup: EmbeddedAttemptSetup;
  isRawModelRun: boolean;
  preparedToolBase: PreparedToolBase;
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
  const normalizeTools = (tools: Parameters<typeof normalizeAgentRuntimeTools>[0]["tools"]) =>
    normalizeAgentRuntimeTools({
      runtimePlan: params.attempt.runtimePlan,
      tools,
      provider: params.attempt.provider,
      config: params.attempt.config,
      workspaceDir: params.setup.effectiveWorkspace,
      env: process.env,
      modelId: params.attempt.modelId,
      modelApi: params.attempt.model.api,
      model: params.attempt.model,
      runtimeHandle: params.setup.getProviderRuntimeHandle(),
      onPreNormalizationSchemaDiagnostics: (diagnostics, sourceTools) =>
        logRuntimeToolSchemaQuarantine({
          diagnostics,
          tools: sourceTools,
          runId: params.attempt.runId,
          agentId: params.setup.sessionAgentId,
          sessionKey: params.attempt.sessionKey,
          sessionId: params.attempt.sessionId,
        }),
    });
  const tools = normalizeTools(toolsEnabled ? toolsRaw : []);
  const providedClientTools =
    toolsEnabled &&
    !params.attempt.disableTools &&
    !params.isRawModelRun &&
    !params.attempt.forceRestartSafeTools
      ? params.attempt.clientTools
      : undefined;
  // Client functions share the attempt's authority; filter before their names
  // can reserve bundled tools or enter deferred catalogs and provider requests.
  let clientTools = providedClientTools;
  if (providedClientTools && effectiveToolsAllow) {
    clientTools = [];
    if (providedClientTools.length > 0) {
      const matchesRuntime = createRuntimeToolMatcher(effectiveToolsAllow);
      clientTools = providedClientTools.filter((definition) =>
        matchesRuntime(definition.function.name),
      );
    }
  }
  const bundleMetadataSnapshot = params.setup.getCurrentAttemptPluginMetadataSnapshot();
  // Scoped registries are partial views; only complete snapshots can bypass bundle discovery.
  const bundleManifestRegistry =
    bundleMetadataSnapshot?.pluginIds === undefined
      ? bundleMetadataSnapshot?.manifestRegistry
      : undefined;
  const mcpConfig = {
    workspaceDir: params.setup.effectiveWorkspace,
    cfg: params.attempt.config,
    manifestRegistry: bundleManifestRegistry,
    toolOverrides: params.attempt.toolOverrides,
  };
  const bundleMcpEnabled =
    !params.attempt.forceRestartSafeTools &&
    shouldCreateBundleMcpRuntimeForAttempt({
      toolsEnabled,
      disableTools: params.attempt.disableTools || params.isRawModelRun,
      toolsAllow: params.attempt.toolsAllow,
      resolveConfiguredMcpNamespaces: () => {
        const configuredNames = Object.keys(params.attempt.config?.mcp?.servers ?? {});
        if (configuredNames.length === 0) {
          return [];
        }
        const { loaded } = loadSessionMcpConfig({ ...mcpConfig, logDiagnostics: false });
        // Use the complete merged declaration order: bundled peers can own a
        // collision suffix before a configured server. This does not connect MCP.
        const safeNames = assignSafeServerNames(Object.keys(loaded.mcpServers));
        return configuredNames.flatMap((name) => {
          const safeName = safeNames.get(name);
          return safeName ? [`${safeName}${TOOL_NAME_SEPARATOR}`] : [];
        });
      },
    });
  const bundleMcpAcquisition = bundleMcpEnabled
    ? await acquireSessionMcpRuntime({
        ...mcpConfig,
        sessionId: params.attempt.sessionId,
        sessionKey: params.attempt.sessionKey,
        agentDir: params.agentDir,
        // senderId is only set from the verified inbound sender (sessionCtx.SenderId
        // or the triggering run's sender on follow-ups). Cron/subagent/heartbeat runs
        // leave it unset, so requester-scoped MCP stays fail-closed for those paths.
        requesterSenderId: params.attempt.senderId,
        agentAccountId: params.attempt.agentAccountId,
        messageChannel: params.attempt.messageChannel ?? params.attempt.messageProvider,
      })
    : undefined;
  const bundleMcpRuntime = bundleMcpAcquisition
    ? await materializeBundleMcpToolsForRun({
        ...bundleMcpAcquisition,
        agentId: params.setup.sessionAgentId,
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
          workspaceDir: params.setup.effectiveWorkspace,
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
      workspaceDir: params.setup.effectiveWorkspace,
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
        workspaceDir: params.setup.effectiveWorkspace,
        metadataSnapshot: bundleMetadataSnapshot,
        conversationCapabilityProfile: runtimeCapabilityProfile,
        warn: (message) => log.warn(message),
      });
      // The view outlives this attempt; capture policy against the complete MCP catalog now.
      bundleMcpRuntime.restrictAppTools(allowedAppTools);
    }
    const normalizedBundledTools =
      filteredBundledTools.length > 0 ? normalizeTools(filteredBundledTools) : filteredBundledTools;
    const projectTools = (coreTools: typeof toolsRaw) => {
      const projectedTools = filterLocalModelLeanTools({
        tools: [...coreTools, ...normalizedBundledTools].map((tool) =>
          wrapToolWithAbortSignal(tool, params.preparedToolBase.toolAbortSignal),
        ),
        config: params.attempt.config,
        agentId: params.setup.sessionAgentId,
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
        agentId: params.setup.sessionAgentId,
        sessionKey: params.attempt.sessionKey,
        sessionId: params.attempt.sessionId,
      });
      return schemaProjection.tools;
    };
    const uncompactedEffectiveTools = projectTools(tools);
    return {
      bundleLspRuntime,
      bundleMcpRuntime,
      clientTools,
      tools,
      uncompactedEffectiveTools,
      refreshTools: () => {
        const nextTools = normalizeTools(toolsEnabled ? toolsRaw : []);
        tools.splice(0, tools.length, ...nextTools);
        const nextEffectiveTools = projectTools(tools);
        uncompactedEffectiveTools.splice(
          0,
          uncompactedEffectiveTools.length,
          ...nextEffectiveTools,
        );
      },
    };
  } catch (error) {
    const cleanup = await Promise.allSettled(
      [bundleMcpRuntime, bundleLspRuntime].map(async (runtime) => await runtime?.dispose()),
    );
    if (cleanup.some((result) => result.status === "rejected")) {
      recordAgentCleanupFailure();
    }
    throw error;
  }
}
