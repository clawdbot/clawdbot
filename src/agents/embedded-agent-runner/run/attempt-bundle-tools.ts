import { getPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { createBundleLspToolRuntime } from "../../agent-bundle-lsp-runtime.js";
import { assignSafeServerNames, TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../../agent-bundle-mcp-runtime-config.js";
import {
  acquireSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "../../agent-bundle-mcp-tools.js";
import type { BundleMcpToolRuntime } from "../../agent-bundle-mcp-types.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { filterLocalModelLeanTools } from "../../local-model-lean.js";
import { normalizeAgentRuntimeTools } from "../../runtime-plan/tools.js";
import type { SandboxCapabilityRootDiscovery } from "../../sandbox/backend-handle.types.js";
import { createSandboxEnvironmentMcpToolRuntime } from "../../sandbox/environment-mcp.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { createRuntimeToolMatcher } from "../../tool-policy-match.js";
import { replaceWithEffectiveToolAllowlist } from "../../tool-policy.js";
import { filterRuntimeCompatibleTools } from "../../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../../tool-schema-quarantine.js";
import { captureFinalEffectiveCronCreatorToolAllowlist } from "../../tools/cron-tool.js";
import { applyFinalEffectiveToolPolicy } from "../effective-tool-policy.js";
import { log } from "../logger.js";
import type { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import {
  applyEmbeddedAttemptToolsAllow,
  shouldCreateBundleLspRuntimeForAttempt,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./attempt-tool-construction-plan.js";
import type { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSetup = Awaited<ReturnType<typeof prepareEmbeddedAttemptSetup>>;
type PreparedToolBase = ReturnType<typeof prepareEmbeddedAttemptToolBase>;

export async function prepareEmbeddedAttemptBundleTools(params: {
  environmentCapabilities?: readonly SandboxCapabilityRootDiscovery[];
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  effectiveWorkspace: string;
  getCurrentAttemptPluginMetadataSnapshot: AttemptSetup["getCurrentAttemptPluginMetadataSnapshot"];
  getProviderRuntimeHandle: AttemptSetup["getProviderRuntimeHandle"];
  isRawModelRun: boolean;
  preparedToolBase: PreparedToolBase;
  sandbox?: SandboxContext | null;
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
  const normalizeTools = (tools: Parameters<typeof normalizeAgentRuntimeTools>[0]["tools"]) =>
    normalizeAgentRuntimeTools({
      runtimePlan: params.attempt.runtimePlan,
      tools,
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
  const bundleMetadataSnapshot = params.getCurrentAttemptPluginMetadataSnapshot();
  // Scoped registries are partial views; only complete snapshots can bypass bundle discovery.
  const bundleManifestRegistry =
    bundleMetadataSnapshot?.pluginIds === undefined
      ? bundleMetadataSnapshot?.manifestRegistry
      : undefined;
  const mcpConfig = {
    workspaceDir: params.effectiveWorkspace,
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
        agentId: params.sessionAgentId,
        reservedToolNames: [
          ...tools.map((tool) => tool.name),
          ...(clientTools?.map((tool) => tool.function.name) ?? []),
        ],
      })
    : undefined;
  let environmentMcpRuntime: BundleMcpToolRuntime | undefined;
  let bundleLspRuntime: Awaited<ReturnType<typeof createBundleLspToolRuntime>> | undefined;
  try {
    const sandboxBackend = params.sandbox?.backend;
    environmentMcpRuntime =
      bundleMcpEnabled && sandboxBackend && params.environmentCapabilities?.length
        ? await createSandboxEnvironmentMcpToolRuntime({
            backend: sandboxBackend,
            discoveries: params.environmentCapabilities,
            sessionId: params.attempt.sessionId + ":sandbox:" + sandboxBackend.runtimeId,
            sessionKey: params.attempt.sessionKey,
            workspaceDir: params.effectiveWorkspace,
            cfg: params.attempt.config,
            agentId: params.sessionAgentId,
            signal: params.attempt.abortSignal,
            toolOverrides: params.attempt.toolOverrides,
            reservedToolNames: [
              ...tools.map((tool) => tool.name),
              ...(clientTools?.map((tool) => tool.function.name) ?? []),
              ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
            ],
          })
        : undefined;
    const environmentRuntime = environmentMcpRuntime;
    const effectiveMcpRuntime = environmentRuntime
      ? {
          tools: [...(bundleMcpRuntime?.tools ?? []), ...environmentRuntime.tools],
          appTools: [...(bundleMcpRuntime?.appTools ?? []), ...(environmentRuntime.appTools ?? [])],
          diagnostics: [
            ...(bundleMcpRuntime?.diagnostics ?? []),
            ...(environmentRuntime.diagnostics ?? []),
          ],
          restrictAppTools: (
            allowedTools: Parameters<
              NonNullable<NonNullable<typeof bundleMcpRuntime>["restrictAppTools"]>
            >[0],
          ) => {
            bundleMcpRuntime?.restrictAppTools?.(allowedTools);
            environmentRuntime.restrictAppTools?.(allowedTools);
          },
          dispose: async () => {
            try {
              await bundleMcpRuntime?.dispose();
            } finally {
              await environmentRuntime.dispose();
            }
          },
        }
      : bundleMcpRuntime;
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
            ...(effectiveMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
        })
      : undefined;
    const allowedBundleMcpTools = applyEmbeddedAttemptToolsAllow(
      effectiveMcpRuntime?.tools ?? [],
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
    if (effectiveMcpRuntime?.restrictAppTools) {
      const runtimeAllowedAppTools = applyEmbeddedAttemptToolsAllow(
        effectiveMcpRuntime.appTools ?? effectiveMcpRuntime.tools,
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
      effectiveMcpRuntime.restrictAppTools(allowedAppTools);
    }
    const normalizedBundledTools =
      filteredBundledTools.length > 0 ? normalizeTools(filteredBundledTools) : filteredBundledTools;
    const projectTools = (coreTools: typeof toolsRaw) => {
      const projectedTools = filterLocalModelLeanTools({
        tools: [...coreTools, ...normalizedBundledTools].map((tool) =>
          wrapToolWithAbortSignal(tool, params.preparedToolBase.toolAbortSignal),
        ),
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
      return schemaProjection.tools;
    };
    const uncompactedEffectiveTools = projectTools(tools);
    return {
      bundleLspRuntime,
      bundleMcpRuntime: effectiveMcpRuntime,
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
    try {
      await bundleMcpRuntime?.dispose();
    } catch {
      // Preserve the preparation error; cleanup is best-effort.
    }
    try {
      await environmentMcpRuntime?.dispose();
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
