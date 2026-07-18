/**
 * Resolves workspace, sandbox, provider runtime, and phase reporting for an embedded attempt.
 */
import fs from "node:fs/promises";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { getCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../../plugins/provider-hook-runtime.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { resolveSandboxContext } from "../../sandbox.js";
import { log } from "../logger.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "../utils.js";
import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";
import {
  createEmbeddedRunStageSummaryEmitter,
  createEmbeddedRunStageTracker,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";
import { resolveAttemptFsWorkspaceOnly } from "./attempt.prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

function pluginMetadataSnapshotCoversProvider(
  snapshot: PluginMetadataSnapshot | undefined,
  provider: string,
): snapshot is PluginMetadataSnapshot {
  const normalizedProvider = normalizeProviderId(provider);
  if (!snapshot || !normalizedProvider) {
    return false;
  }
  return snapshot.manifestRegistry.plugins.some((plugin) => {
    const ownsProvider = plugin.providers.some(
      (providerId) => normalizeProviderId(providerId) === normalizedProvider,
    );
    if (ownsProvider) {
      return true;
    }
    const modelCatalogProviderIds = [
      ...Object.keys(plugin.modelCatalog?.providers ?? {}),
      ...Object.keys(plugin.modelCatalog?.aliases ?? {}),
    ];
    return modelCatalogProviderIds.some(
      (providerId) => normalizeProviderId(providerId) === normalizedProvider,
    );
  });
}

export async function prepareEmbeddedAttemptSetup(params: EmbeddedRunAttemptParams) {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  // Ultra is a logical orchestration mode, not a provider effort. Preserve it for
  // prompt/status surfaces, then lower only at agent-core and provider boundaries.
  const agentCoreThinkingLevel = mapThinkingLevel(params.thinkLevel);
  const providerThinkingLevel = mapThinkingLevelForProvider(params.thinkLevel);
  const proactiveSubagentOrchestration = params.thinkLevel === "ultra";
  configureEmbeddedAttemptHttpRuntime({ timeoutMs: params.timeoutMs });

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );
  const prepStages = createEmbeddedRunStageTracker();
  const emitPrepStageSummary = createEmbeddedRunStageSummaryEmitter({
    label: "prep stages",
    log,
    runId: params.runId,
    sessionId: params.sessionId,
    tracker: prepStages,
  });
  const emitCorePluginToolStageSummary = (
    phase: string,
    summary: ReturnType<typeof prepStages.snapshot>,
  ) => {
    if (summary.stages.length === 0) {
      return;
    }
    const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary, {
      totalThresholdMs: 5_000,
      stageThresholdMs: 2_000,
    });
    if (!shouldWarn && !log.isEnabled("trace")) {
      return;
    }
    const message = formatEmbeddedRunStageSummary(
      `[trace:embedded-run] core-plugin-tool stages: runId=${params.runId} sessionId=${params.sessionId} phase=${phase}`,
      summary,
    );
    if (shouldWarn) {
      log.warn(message);
    } else {
      log.trace(message);
    }
  };

  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    execOverrides: params.execOverrides,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    );
  }
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace);
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  let currentPluginMetadataSnapshotResolved = false;
  let currentPluginMetadataSnapshot: PluginMetadataSnapshot | undefined;
  const getCurrentAttemptPluginMetadataSnapshot = () => {
    if (!currentPluginMetadataSnapshotResolved) {
      currentPluginMetadataSnapshot = getCurrentPluginMetadataSnapshot({
        allowScopedSnapshot: true,
        config: params.config,
        env: process.env,
        workspaceDir: effectiveWorkspace,
      });
      currentPluginMetadataSnapshotResolved = true;
    }
    return currentPluginMetadataSnapshot;
  };
  let providerRuntimeHandle: ProviderRuntimePluginHandle | undefined;
  const getProviderRuntimeHandle = () => {
    if (providerRuntimeHandle?.plugin) {
      return providerRuntimeHandle;
    }
    const pluginMetadataSnapshot = getCurrentAttemptPluginMetadataSnapshot();
    const resolvedHandle = resolveProviderRuntimePluginHandle({
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      ...(pluginMetadataSnapshotCoversProvider(pluginMetadataSnapshot, params.provider)
        ? { pluginMetadataSnapshot }
        : {}),
    });
    if (resolvedHandle.plugin) {
      providerRuntimeHandle = resolvedHandle;
    }
    return resolvedHandle;
  };
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const effectiveFsWorkspaceOnly = resolveAttemptFsWorkspaceOnly({
    config: params.config,
    sessionAgentId,
  });
  prepStages.mark("workspace-sandbox");

  return {
    agentCoreThinkingLevel,
    effectiveCwd,
    effectiveFsWorkspaceOnly,
    effectiveWorkspace,
    emitCorePluginToolStageSummary,
    emitPrepStageSummary,
    getCurrentAttemptPluginMetadataSnapshot,
    getProviderRuntimeHandle,
    prepStages,
    proactiveSubagentOrchestration,
    providerThinkingLevel,
    resolvedWorkspace,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  };
}
