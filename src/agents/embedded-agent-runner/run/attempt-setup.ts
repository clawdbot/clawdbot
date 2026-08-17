/**
 * Resolves workspace, runtime setup, context guards, and startup for an embedded attempt.
 * It may assume dispatch inputs and provider metadata are ready.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorMessage,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import { isPluginMetadataSnapshotCompatible } from "../../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../../plugins/provider-hook-runtime.js";
import { resolveSkillsPrompt } from "../../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../../skills/runtime/embedded-run-entries.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../../skills/runtime/env-overrides.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveSessionAgentIds } from "../../agent-scope.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import { resolveCodeModeSkills, type CodeModeSkillReader } from "../../code-mode-skills.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { resolveSandboxContext } from "../../sandbox.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairingForModel } from "../../session-transcript-repair.js";
import type { AgentSession } from "../../sessions/index.js";
import { invalidateComputerFrameIfMissing } from "../../tools/computer-tool.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { log } from "../logger.js";
import {
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "../sandbox-skills.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "../tool-result-context-guard.js";
import {
  pruneExpiredCacheTtlToolResults,
  resolveCacheTtlPruningSettings,
  resolveLiveToolResultMaxChars,
} from "../tool-result-truncation.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "../utils.js";
import { buildLoopPromptCacheInfo } from "./attempt-context-engine-helpers.js";
import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";
import {
  buildAfterTurnRuntimeContext,
  resolveAttemptFsWorkspaceOnly,
} from "./attempt-prompt-helpers.js";
import {
  createEmbeddedRunStageSummaryEmitter,
  createEmbeddedRunStageTracker,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

/**
 * Resolves workspace, sandbox, provider runtime, and phase reporting for an embedded attempt.
 */

type PreparedProviderRuntimePluginHandle = ProviderRuntimePluginHandle & {
  modelId: string;
  prepared: true;
};

type AttemptWorkspaceParams = Pick<
  EmbeddedRunAttemptParams,
  | "agentId"
  | "config"
  | "cwd"
  | "execOverrides"
  | "permissionMode"
  | "sandboxSessionKey"
  | "sessionId"
  | "sessionKey"
  | "sessionRoot"
  | "skillWorkshopCollectionReconcile"
  | "skillsSnapshot"
  | "workspaceDir"
>;

/** Resolves the shared workspace and sandbox policy used by native and plugin harnesses. */
export async function resolveAttemptWorkspaceSandbox(params: AttemptWorkspaceParams) {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey =
    params.sandboxSessionKey?.trim() || params.sessionKey?.trim() || params.sessionId;
  // Collection review is a host-owned maintenance run with one restricted tool.
  // Sandboxing would hide that tool or redirect it to a disposable workspace.
  const sandbox = params.skillWorkshopCollectionReconcile
    ? null
    : await resolveSandboxContext({
        config: params.config,
        execOverrides: params.execOverrides,
        sessionKey: sandboxSessionKey,
        skillsSnapshot: params.skillsSnapshot,
        workspaceDir: resolvedWorkspace,
      });
  const effectiveWorkspace =
    sandbox?.enabled && sandbox.workspaceAccess !== "rw" ? sandbox.workspaceDir : resolvedWorkspace;
  const requestedCwd = params.cwd ? resolveUserPath(params.cwd) : undefined;
  if (params.permissionMode && !params.sessionRoot) {
    throw new Error("session permission mode requires a recorded session root");
  }
  const sessionPermissionPolicy =
    params.permissionMode && params.sessionRoot
      ? { root: params.sessionRoot, mode: params.permissionMode }
      : undefined;
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspace) {
    throw new Error(
      "cwd override is not supported for sandboxed embedded agent runs; omit cwd or use the agent workspace as cwd",
    );
  }
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  return {
    defaultAgentId,
    effectiveCwd: sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace),
    effectiveFsWorkspaceOnly: resolveAttemptFsWorkspaceOnly({
      config: params.config,
      sessionAgentId,
    }),
    effectiveWorkspace,
    resolvedWorkspace,
    sessionPermissionPolicy,
    sandbox,
    sandboxSessionKey,
    sessionAgentId,
  };
}

export async function prepareEmbeddedAttemptSetup(params: EmbeddedRunAttemptParams) {
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

  const workspace = await resolveAttemptWorkspaceSandbox(params);
  const { effectiveWorkspace } = workspace;

  const getCurrentAttemptPluginMetadataSnapshot = (): PluginMetadataSnapshot | undefined =>
    params.preparedModelRuntime?.metadataSnapshot;
  let providerRuntimeHandle = params.runtimePlan?.providerRuntimeHandle as
    | PreparedProviderRuntimePluginHandle
    | undefined;
  const getProviderRuntimeHandle = (): PreparedProviderRuntimePluginHandle => {
    if (
      providerRuntimeHandle &&
      providerRuntimeHandle.prepared &&
      providerRuntimeHandle.provider === params.provider &&
      providerRuntimeHandle.modelId === params.modelId &&
      providerRuntimeHandle.workspaceDir === effectiveWorkspace
    ) {
      return providerRuntimeHandle;
    }
    const pluginMetadataSnapshot = getCurrentAttemptPluginMetadataSnapshot();
    const compatibleMetadataSnapshot =
      pluginMetadataSnapshot &&
      pluginMetadataSnapshot.pluginIds === undefined &&
      isPluginMetadataSnapshotCompatible({
        snapshot: pluginMetadataSnapshot,
        config: params.config,
        env: process.env,
        workspaceDir: effectiveWorkspace,
      })
        ? pluginMetadataSnapshot
        : undefined;
    providerRuntimeHandle = {
      ...resolveProviderRuntimePluginHandle({
        provider: params.provider,
        modelId: params.modelId,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        env: process.env,
        ...(compatibleMetadataSnapshot
          ? { pluginMetadataSnapshot: compatibleMetadataSnapshot }
          : {}),
      }),
      provider: params.provider,
      modelId: params.modelId,
      prepared: true,
      workspaceDir: effectiveWorkspace,
    };
    return providerRuntimeHandle;
  };
  prepStages.mark("workspace-sandbox");

  return {
    agentCoreThinkingLevel,
    ...workspace,
    emitCorePluginToolStageSummary,
    emitPrepStageSummary,
    getCurrentAttemptPluginMetadataSnapshot,
    getProviderRuntimeHandle,
    prepStages,
    proactiveSubagentOrchestration,
    providerThinkingLevel,
  };
}

/** Installs attempt-local context engine, tool-result, image, and frame guards. */

type PromptCacheRetention = Parameters<typeof buildLoopPromptCacheInfo>[0]["retention"];

export function installEmbeddedAttemptContextGuards(input: {
  activeContextEngine?: ContextEngine;
  activeSession: AgentSession;
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  computerContextEpoch: { value: number };
  dropThinkingBlocksForEstimate: boolean;
  effectiveCwd: string;
  effectiveFsWorkspaceOnly: boolean;
  effectiveWorkspace: string;
  getPrePromptMessageCount: () => number;
  getPromptCache: () => EmbeddedRunAttemptResult["promptCache"];
  getPromptCacheRetention: () => PromptCacheRetention;
  getSystemPrompt: () => string;
  isOpenAIResponsesApi: boolean;
  repairToolUseResultPairing: boolean;
  sessionAgentId: string;
  sessionManager: ReturnType<typeof guardSessionManager>;
  settingsManager: AgentSession["settingsManager"];
  sandbox?: SandboxContext | null;
}): {
  getAfterTurnCheckpoint: () => number | null;
  remove: () => void;
  takePendingMidTurnPrecheckRequest: () => MidTurnPrecheckRequest | null;
} {
  const { activeContextEngine, activeSession, attempt, settingsManager } = input;
  const contextTokenBudget = Math.max(
    1,
    Math.floor(
      attempt.contextTokenBudget ??
        attempt.model.contextWindow ??
        attempt.model.maxTokens ??
        DEFAULT_CONTEXT_TOKENS,
    ),
  );
  const toolResultMaxChars = resolveLiveToolResultMaxChars({
    contextWindowTokens: contextTokenBudget,
  });
  let pendingMidTurnPrecheckRequest: MidTurnPrecheckRequest | null = null;
  let afterTurnCheckpoint: number | null = null;
  const midTurnPrecheckOptions =
    attempt.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true
      ? {
          midTurnPrecheck: {
            enabled: true,
            contextTokenBudget,
            reserveTokens: () => settingsManager.getCompactionReserveTokens(),
            toolResultMaxChars,
            getSystemPrompt: input.getSystemPrompt,
            getPrePromptMessageCount: input.getPrePromptMessageCount,
            onMidTurnPrecheck: (request: MidTurnPrecheckRequest) => {
              pendingMidTurnPrecheckRequest = request;
            },
          },
        }
      : {};

  const contextPruning = attempt.config?.agents?.defaults?.contextPruning;
  // Disabled pruning must not resolve provider hooks and cold-load plugin metadata.
  const cacheTtlSettings =
    contextPruning?.mode === "cache-ttl" &&
    isCacheTtlEligibleProvider(attempt.provider, attempt.modelId, attempt.model.api)
      ? resolveCacheTtlPruningSettings(contextPruning)
      : undefined;
  const previousCacheTtlTransform = activeSession.agent.transformContext;
  let lastCacheTouchAt = cacheTtlSettings
    ? readLastCacheTtlTimestamp(input.sessionManager, {
        provider: attempt.provider,
        modelId: attempt.modelId,
      })
    : null;
  if (cacheTtlSettings) {
    activeSession.agent.transformContext = async (messages, signal) => {
      const transformed = previousCacheTtlTransform
        ? await previousCacheTtlTransform.call(activeSession.agent, messages, signal)
        : messages;
      const sourceMessages = Array.isArray(transformed) ? transformed : messages;
      const projected = pruneExpiredCacheTtlToolResults({
        messages: sourceMessages,
        settings: cacheTtlSettings,
        contextWindowTokens: contextTokenBudget,
        lastCacheTouchAt,
        dropThinkingBlocksForEstimate: input.dropThinkingBlocksForEstimate,
        now: Date.now(),
      });
      if (projected !== sourceMessages) {
        lastCacheTouchAt = Date.now();
      }
      return projected;
    };
  }

  let removeLoopGuard: () => void;
  if (activeContextEngine?.info.ownsCompaction === true) {
    const selectedContextEngineId = activeContextEngine.info.id;
    const runtimeSettings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      provider: attempt.provider,
      requestedModel: attempt.requestedModelId,
      resolvedModel: attempt.modelId,
      selectedContextEngineId,
      contextEngineSelectionSource: selectedContextEngineId === "legacy" ? "default" : "configured",
      promptTokenBudget: attempt.contextTokenBudget,
      fallbackReason: attempt.fallbackReason,
      degradedReason: attempt.degradedReason,
    });
    const removeContextEngineLoopHook = installContextEngineLoopHook({
      agent: activeSession.agent,
      contextEngine: activeContextEngine,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
      sessionFile: attempt.sessionFile,
      tokenBudget: attempt.contextTokenBudget,
      modelId: attempt.modelId,
      ...(input.repairToolUseResultPairing
        ? {
            repairAssembledMessages: (messages) =>
              sanitizeToolUseResultPairingForModel(messages, input.isOpenAIResponsesApi),
          }
        : {}),
      getPrePromptMessageCount: input.getPrePromptMessageCount,
      onAfterTurnCheckpoint: (messageCount) => {
        afterTurnCheckpoint = messageCount;
      },
      getRuntimeContext: ({ messages, prePromptMessageCount }) =>
        buildAfterTurnRuntimeContext({
          attempt,
          workspaceDir: input.effectiveWorkspace,
          cwd: input.effectiveCwd,
          agentDir: input.agentDir,
          tokenBudget: attempt.contextTokenBudget,
          promptCache:
            input.getPromptCache() ??
            buildLoopPromptCacheInfo({
              messagesSnapshot: messages,
              prePromptMessageCount,
              retention: input.getPromptCacheRetention(),
              fallbackLastCacheTouchAt: readLastCacheTtlTimestamp(input.sessionManager, {
                provider: attempt.provider,
                modelId: attempt.modelId,
              }),
            }),
        }),
      runtimeSettings,
      isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
    });
    const removeToolResultGuard = installToolResultContextGuard({
      agent: activeSession.agent,
      contextWindowTokens: contextTokenBudget,
      ...midTurnPrecheckOptions,
    });
    removeLoopGuard = () => {
      removeToolResultGuard();
      removeContextEngineLoopHook();
    };
  } else {
    removeLoopGuard = installToolResultContextGuard({
      agent: activeSession.agent,
      contextWindowTokens: contextTokenBudget,
      ...midTurnPrecheckOptions,
    });
  }

  const removeHistoryImagePruneContextTransform = installHistoryImagePruneContextTransform(
    activeSession.agent,
    {
      workspaceDir: input.effectiveWorkspace,
      model: attempt.model,
      maxBytes: MAX_IMAGE_BYTES,
      maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
      workspaceOnly: input.effectiveFsWorkspaceOnly,
      localRoots: input.effectiveFsWorkspaceOnly
        ? undefined
        : getAgentScopedMediaLocalRoots(attempt.config ?? {}, input.sessionAgentId),
      sandbox:
        input.sandbox?.enabled && input.sandbox.fsBridge
          ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
          : undefined,
    },
  );
  const previousComputerFrameTransform = activeSession.agent.transformContext;
  activeSession.agent.transformContext = async (messages, signal) => {
    const transformed = previousComputerFrameTransform
      ? await previousComputerFrameTransform.call(activeSession.agent, messages, signal)
      : messages;
    const modelContext = Array.isArray(transformed) ? transformed : messages;
    invalidateComputerFrameIfMissing({
      contextEpoch: input.computerContextEpoch,
      messages: modelContext,
      imagesBlocked: settingsManager.getBlockImages(),
    });
    return modelContext;
  };

  return {
    getAfterTurnCheckpoint: () => afterTurnCheckpoint,
    remove: () => {
      activeSession.agent.transformContext = previousComputerFrameTransform;
      removeHistoryImagePruneContextTransform();
      removeLoopGuard();
      activeSession.agent.transformContext = previousCacheTtlTransform;
    },
    takePendingMidTurnPrecheckRequest: () => {
      const request = pendingMidTurnPrecheckRequest;
      pendingMidTurnPrecheckRequest = null;
      return request;
    },
  };
}

type AttemptSetup = Awaited<ReturnType<typeof prepareEmbeddedAttemptSetup>>;

export function prepareEmbeddedAttemptSkills(params: {
  attempt: EmbeddedRunAttemptParams;
  effectiveWorkspace: string;
  sandbox: AttemptSetup["sandbox"];
  sessionAgentId: string;
}) {
  if (params.attempt.operation === "settled-tool-finalization") {
    return {
      restoreSkillEnv: () => {},
      skillUsagePaths: undefined,
      skillsPrompt: "",
      skillsSnapshotForRun: undefined,
      codeModeSkills: [],
    };
  }
  const {
    skillsEligibility,
    skillsPromptWorkspaceDir,
    skillsSnapshot,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: params.sandbox,
    effectiveWorkspace: params.effectiveWorkspace,
    skillsSnapshot: params.attempt.skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
    workspaceDir: skillsWorkspaceDir,
    config: params.attempt.config,
    agentId: params.sessionAgentId,
    eligibility: skillsEligibility,
    skillsSnapshot,
    workspaceOnly,
  });
  const restoreSkillEnv = skillsSnapshot
    ? applySkillEnvOverridesFromSnapshot({
        snapshot: skillsSnapshot,
        config: params.attempt.config,
      })
    : applySkillEnvOverrides({
        skills: skillEntries ?? [],
        config: params.attempt.config,
      });
  try {
    const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsWorkspaceDir,
      skillsPromptWorkspaceDir,
    });
    const skillUsagePaths = mapSandboxSkillUsagePaths({
      paths: params.sandbox?.skillUsagePaths,
      skillsWorkspaceDir,
      skillsPromptWorkspaceDir,
    });
    const skillsPrompt = resolveSkillsPrompt({
      skillsSnapshot,
      entries: promptSkillEntries,
      config: params.attempt.config,
      workspaceDir: skillsPromptWorkspaceDir,
      agentId: params.sessionAgentId,
      eligibility: skillsEligibility,
    });
    const sandbox = params.sandbox;
    const sandboxSkillReader: CodeModeSkillReader | undefined = sandbox?.enabled
      ? async ({ location, signal }) => {
          const bridge = sandbox.fsBridge;
          if (!bridge) {
            throw new Error("Sandbox filesystem bridge is unavailable for skill reads.");
          }
          return (
            await bridge.readFile({
              filePath: location,
              cwd: sandbox.containerWorkdir,
              signal,
            })
          ).toString("utf8");
        }
      : undefined;
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt,
      candidates: skillsSnapshot?.resolvedSkills ?? skillEntries.map((entry) => entry.skill),
      reader: sandboxSkillReader,
    });
    return {
      restoreSkillEnv,
      skillUsagePaths,
      skillsPrompt,
      skillsSnapshotForRun: skillsSnapshot,
      codeModeSkills,
    };
  } catch (error) {
    restoreSkillEnv();
    throw error;
  }
}

export type EmitDiagnosticRunCompleted = (
  outcome: "completed" | "aborted" | "blocked" | "error",
  err?: unknown,
  extra?: { blockedBy?: string },
) => void;

export function startEmbeddedAttemptDiagnostics(params: EmbeddedRunAttemptParams): {
  diagnosticTrace: ReturnType<typeof freezeDiagnosticTraceContext>;
  runTrace: ReturnType<typeof freezeDiagnosticTraceContext>;
  emitCompleted: EmitDiagnosticRunCompleted;
} {
  const diagnosticTrace = freezeDiagnosticTraceContext(
    getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
  );
  const runTrace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(diagnosticTrace));
  const diagnosticRunBase = {
    runId: params.runId,
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.sessionId && { sessionId: params.sessionId }),
    provider: params.provider,
    model: params.modelId,
    trigger: params.trigger,
    ...((params.messageChannel ?? params.messageProvider)
      ? { channel: params.messageChannel ?? params.messageProvider }
      : {}),
    trace: runTrace,
  };
  emitTrustedDiagnosticEvent({
    type: "run.started",
    ...diagnosticRunBase,
  });
  const startedAt = Date.now();
  let completed = false;
  const emitCompleted: EmitDiagnosticRunCompleted = (outcome, err, extra) => {
    if (completed) {
      return;
    }
    completed = true;
    const failed = err != null && outcome !== "blocked";
    const errorMessage = failed ? diagnosticErrorMessage(err) : undefined;
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...diagnosticRunBase,
        durationMs: Date.now() - startedAt,
        outcome,
        ...(extra?.blockedBy ? { blockedBy: extra.blockedBy } : {}),
        ...(failed ? { errorCategory: diagnosticErrorCategory(err) } : {}),
      },
      errorMessage ? { errorMessage } : undefined,
    );
  };
  return { diagnosticTrace, runTrace, emitCompleted };
}

/**
 * Maps bootstrap context files into the attempt workspace.
 */

function isRelativePathInsideOrEqual(relativePath: string): boolean {
  // `path.relative` returns "" for the workspace root; reject parent escapes and absolute paths.
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * Rewrites injected context file paths when a bootstrap assembled in one
 * workspace is replayed in another. Files outside the source workspace keep
 * their original absolute path to avoid manufacturing unsafe relative paths.
 */
export function remapInjectedContextFilesToWorkspace(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    // Only files that were inside the source workspace can be safely projected
    // into the target workspace.
    const canRemap = isRelativePathInsideOrEqual(relative);
    return canRemap
      ? {
          ...file,
          path:
            relative === ""
              ? params.targetWorkspaceDir
              : path.join(params.targetWorkspaceDir, relative),
        }
      : file;
  });
}
