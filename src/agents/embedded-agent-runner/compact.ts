/**
 * Implements embedded-agent transcript compaction and runtime handoff.
 */
import fs from "node:fs/promises";
import os from "node:os";
import type { ApiRegistry } from "@openclaw/ai";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import { acquireOwnedSessionTranscriptWriteLock } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CapturedCompactionCheckpointSnapshot } from "../../gateway/session-compaction-checkpoints.js";
import {
  formatActiveNodeContextLabel,
  getCurrentActiveNodeContext,
} from "../../infra/active-node-context.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../../infra/os-summary.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../plugins/command-registry-state.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { extractModelCompat } from "../../plugins/provider-model-compat.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  prepareProviderRuntimeAuth,
  transformProviderSystemPrompt,
} from "../../plugins/provider-runtime.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveSkillsPromptForRun } from "../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../skills/runtime/env-overrides.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { createBundleLspToolRuntime } from "../agent-bundle-lsp-runtime.js";
import { createBundleMcpToolRuntime } from "../agent-bundle-mcp-tools.js";
import {
  consumeCompactionSafeguardCancelReason,
  setCompactionSafeguardCancelReason,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveRunModelFallbacksOverride,
  resolveSessionAgentIds,
} from "../agent-scope.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
} from "../agent-settings.js";
import { createOpenClawCodingTools, resolveProcessToolScopeKey } from "../agent-tools.js";
import { listActiveProcessSessionReferences } from "../bash-process-references.js";
import {
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveContextInjectionMode,
} from "../bootstrap-files.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../channel-tools.js";
import {
  hasMeaningfulConversationContent,
  isRealConversationMessage,
} from "../compaction-real-conversation.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveOpenClawReferencePaths } from "../docs-path.js";
import { ensureSessionHeader } from "../embedded-agent-helpers.js";
import { pickFallbackThinkingLevel } from "../embedded-agent-helpers.js";
import { coerceToFailoverError, describeFailoverError } from "../failover-error.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import { prepareAgentMemoryPrompt } from "../memory-prompt-prepare.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  MissingProviderAuthError,
  resolveModelAuthMode,
} from "../model-auth.js";
import {
  isFallbackSummaryError,
  resolveModelCandidateChain,
  runWithModelFallback,
} from "../model-fallback.js";
import { supportsModelTools } from "../model-tool-support.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../prepared-model-runtime.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../prompt-surface.js";
import { applyPreparedRuntimeAuthToModel } from "../provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { registerProviderStreamForModel } from "../provider-stream.js";
import {
  applyAgentRunSessionTargetIdentity,
  resolveAgentRunSessionTarget,
} from "../run-session-target.js";
import { collectRuntimeChannelCapabilities } from "../runtime-capabilities.js";
import { buildAgentRuntimePlan } from "../runtime-plan/build.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
} from "../runtime-plan/resolve-auth.js";
import type { AgentRuntimeAuthPlan, AgentRuntimePlan } from "../runtime-plan/types.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import type { AgentMessage } from "../runtime/index.js";
import { resolveSandboxContext } from "../sandbox.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockOptions,
} from "../session-write-lock.js";
import { createAgentSession, estimateTokens, SessionManager } from "../sessions/index.js";
import { getModelRegistryRuntime } from "../sessions/model-registry-runtime.js";
import { detectRuntimeShell } from "../shell-utils.js";
import {
  filterProviderNormalizableTools,
  filterRuntimeCompatibleTools,
} from "../tool-schema-projection.js";
import { logRuntimeToolSchemaQuarantine } from "../tool-schema-quarantine.js";
import {
  classifyCompactionReason,
  formatUnknownCompactionReasonDetail,
  resolveCompactionFailureReason,
} from "./compact-reasons.js";
import type {
  CompactEmbeddedAgentSessionParams,
  CompactEmbeddedAgentSessionRuntimeParams,
  CompactionMessageMetrics,
} from "./compact.types.js";
import { compactionCheckpointStore, persistCompactionCheckpoint } from "./compaction-checkpoint.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import {
  asCompactionHookRunner,
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
import {
  resolveCompactionContextTokenBudget,
  resolveEmbeddedCompactionThinkingLevel,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import {
  prepareCompactionHarnessAuth,
  resolveCompactionRuntimeSelection,
} from "./compaction-runtime-preparation.js";
import {
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { prepareCompactionSessionAgent } from "./compaction-session-agent.js";
import {
  type CompactionTranscriptRotation,
  rotateTranscriptAfterCompaction,
  shouldRotateCompactionTranscript,
} from "./compaction-successor-transcript.js";
import { applyFinalEffectiveToolPolicy } from "./effective-tool-policy.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { log } from "./logger.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "./message-action-discovery-input.js";
import { resolveModelAsync } from "./model.js";
import { sanitizeSessionHistory, validateReplayTurns } from "./replay-history.js";
import { createEmbeddedAgentResourceLoader } from "./resource-loader.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";
import { resolveAttemptSpawnWorkspaceDir } from "./run/attempt.thread-helpers.js";
import { buildEmbeddedSandboxInfo, resolveEmbeddedSandboxInfoExecPolicy } from "./sandbox-info.js";
import {
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "./session-manager-cache.js";
import { applySystemPromptToSession, buildEmbeddedSystemPrompt } from "./system-prompt.js";
import {
  collectAllowedToolNames,
  collectRegisteredToolNames,
  toSessionToolAllowlist,
} from "./tool-name-allowlist.js";
import { splitSdkTools } from "./tool-split.js";
import { readTranscriptFileState } from "./transcript-file-state.js";
import type { EmbeddedAgentCompactResult } from "./types.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "./utils.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";
export type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";

type CompactEmbeddedAgentSessionParamsWithSessionFile = CompactEmbeddedAgentSessionRuntimeParams & {
  sessionFile: string;
};
type PreparedCompactEmbeddedAgentSessionParams =
  CompactEmbeddedAgentSessionParamsWithSessionFile & {
    preparedModelRuntime: PreparedModelRuntimeSnapshot;
  };

const hasRealConversationContent = isRealConversationMessage;

function createCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

function resolveCompactionProviderStream(params: {
  effectiveModel: ProviderRuntimeModel;
  config?: OpenClawConfig;
  agentDir: string;
  effectiveWorkspace: string;
  apiRegistry: ApiRegistry;
}) {
  return registerProviderStreamForModel({
    model: params.effectiveModel,
    cfg: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.effectiveWorkspace,
    apiRegistry: params.apiRegistry,
  });
}

function normalizeObservedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function getMessageTextChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  return Array.isArray(content)
    ? content.reduce((total, block) => {
        const text =
          block && typeof block === "object" ? (block as { text?: unknown }).text : undefined;
        return total + (typeof text === "string" ? text.length : 0);
      }, 0)
    : 0;
}

function resolveMessageToolLabel(msg: AgentMessage): string | undefined {
  const candidate =
    (msg as { toolName?: unknown }).toolName ??
    (msg as { name?: unknown }).name ??
    (msg as { tool?: unknown }).tool;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function summarizeCompactionMessages(messages: AgentMessage[]): CompactionMessageMetrics {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: Array<{ role: string; chars: number; tool?: string }> = [];
  let estTokens = 0;
  let tokenEstimationFailed = false;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const chars = getMessageTextChars(msg);
    historyTextChars += chars;
    if (role === "toolResult") {
      toolResultChars += chars;
    }
    contributors.push({ role, chars, tool: resolveMessageToolLabel(msg) });
    if (!tokenEstimationFailed) {
      try {
        estTokens += estimateTokens(msg);
      } catch {
        tokenEstimationFailed = true;
      }
    }
  }

  return {
    messages: messages.length,
    historyTextChars,
    toolResultChars,
    estTokens: tokenEstimationFailed ? undefined : estTokens,
    contributors: selectTopContributors(contributors),
  };
}

function selectTopContributors(
  contributors: CompactionMessageMetrics["contributors"],
): CompactionMessageMetrics["contributors"] {
  return contributors.toSorted((left, right) => right.chars - left.chars).slice(0, 3);
}

function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    hasRealConversationContent(message, allMessages, index),
  );
}

function hasExplicitCompactionModel(params: CompactEmbeddedAgentSessionParams): boolean {
  return Boolean(params.config?.agents?.defaults?.compaction?.model?.trim());
}

function resolveCompactionFallbacksOverride(
  params: CompactEmbeddedAgentSessionParams,
): string[] | undefined {
  if (params.modelSelectionLocked) {
    return [];
  }
  return (
    params.modelFallbacksOverride ??
    resolveRunModelFallbacksOverride({
      cfg: params.config,
      sessionKey: params.sessionKey,
    })
  );
}

function hasCompactionModelFallbackCandidates(params: CompactEmbeddedAgentSessionParams): boolean {
  const fallbacksOverride = resolveCompactionFallbacksOverride(params);
  const defaultFallbacks = resolveAgentModelFallbackValues(params.config?.agents?.defaults?.model);
  return (fallbacksOverride ?? defaultFallbacks).length > 0;
}

function classifyCompactionFallbackResult(
  result: EmbeddedAgentCompactResult,
  provider: string,
  model: string,
) {
  if (result.ok) {
    return null;
  }
  const reason = result.reason?.trim();
  if (!reason) {
    return null;
  }
  const failureError = Object.assign(new Error(result.failure?.rawError ?? reason), {
    status: result.failure?.status,
    code: result.failure?.code,
  });
  const failoverError = coerceToFailoverError(failureError, { provider, model });
  return failoverError ? { error: failoverError } : null;
}

function fallbackFailureToCompactionResult(err: unknown): EmbeddedAgentCompactResult {
  const reason = isFallbackSummaryError(err) ? err.message : formatErrorMessage(err);
  return {
    ok: false,
    compacted: false,
    reason,
  };
}

/**
 * Core compaction logic without lane queueing.
 * Use this when already inside a session/global lane to avoid deadlocks.
 */
export async function compactEmbeddedAgentSessionDirect(
  paramsInput: CompactEmbeddedAgentSessionRuntimeParams,
): Promise<EmbeddedAgentCompactResult> {
  const paramsBase = applyAgentRunSessionTargetIdentity(paramsInput);
  const lockedHarnessRuntime = normalizeOptionalAgentRuntimeId(paramsBase.agentHarnessId);
  if (paramsBase.modelSelectionLocked === true && lockedHarnessRuntime !== "openclaw") {
    return {
      ok: false,
      compacted: false,
      reason: lockedHarnessRuntime
        ? `Model selection is locked to native agent harness "${lockedHarnessRuntime}"; generic compaction is unavailable.`
        : "Model selection is locked but the persisted agent harness is unavailable.",
      failure: { reason: "model_selection_locked" },
    };
  }
  const runSessionTarget = await resolveAgentRunSessionTarget(paramsBase);
  const requestedParams: CompactEmbeddedAgentSessionParamsWithSessionFile = {
    ...paramsBase,
    agentId: paramsBase.agentId ?? runSessionTarget.agentId,
    sessionId: runSessionTarget.sessionId,
    sessionKey: paramsBase.sessionKey ?? runSessionTarget.sessionKey,
    sessionFile: runSessionTarget.sessionFile,
  };
  const requestedAgentIds = resolveSessionAgentIds({
    sessionKey: requestedParams.sessionKey,
    config: requestedParams.config,
    agentId: requestedParams.agentId,
  });
  const requestedAgentDir =
    requestedParams.agentDir ??
    resolveAgentDir(requestedParams.config ?? {}, requestedAgentIds.sessionAgentId);
  const requestedWorkspaceDir = resolveUserPath(requestedParams.workspaceDir);
  const canonicalWorkspaceDir = resolveUserPath(
    resolveAgentWorkspaceDir(requestedParams.config ?? {}, requestedAgentIds.sessionAgentId),
  );
  const preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime({
    config: requestedParams.config ?? {},
    agentId: requestedAgentIds.sessionAgentId,
    agentDir: requestedAgentDir,
    inheritedAuthDir: resolveDefaultAgentDir(requestedParams.config ?? {}),
    workspaceDir: requestedWorkspaceDir,
    preserveWorkspaceDirOnRefresh: requestedWorkspaceDir !== canonicalWorkspaceDir,
  });
  try {
    const preparedModelRuntime = preparedModelRuntimeLease.snapshot;
    // Fallback policy and every attempt consume the same generation as model/auth discovery.
    // A reload may have committed while session targeting was resolved above.
    const params: PreparedCompactEmbeddedAgentSessionParams = {
      ...requestedParams,
      config: preparedModelRuntime.config,
      agentId: preparedModelRuntime.agentId ?? requestedAgentIds.sessionAgentId,
      agentDir: preparedModelRuntime.agentDir,
      workspaceDir: preparedModelRuntime.workspaceDir ?? requestedWorkspaceDir,
      preparedModelRuntime,
    };
    if (hasExplicitCompactionModel(params) || !hasCompactionModelFallbackCandidates(params)) {
      return await compactEmbeddedAgentSessionDirectOnce(params);
    }
    const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
      config: params.config,
      provider: params.provider,
      modelId: params.model,
      authProfileId: params.authProfileId,
      modelSelectionLocked: params.modelSelectionLocked,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const primaryProvider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
    const primaryModel = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
    const requestedPrimaryProvider = params.provider?.trim() || DEFAULT_PROVIDER;
    const fallbacksOverride = resolveCompactionFallbacksOverride(params);
    const resolvedPrimaryCandidate = resolveModelCandidateChain({
      cfg: params.config,
      provider: primaryProvider,
      model: primaryModel,
      fallbacksOverride,
    })[0];
    const fallbackAgentId = resolveSessionAgentIds({
      sessionKey: params.sandboxSessionKey ?? params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    }).sessionAgentId;
    const fallbackSessionKey = params.sandboxSessionKey ?? params.sessionKey ?? params.sessionId;
    const fallbackResult = await runWithModelFallback<EmbeddedAgentCompactResult>({
      cfg: params.config,
      provider: primaryProvider,
      model: primaryModel,
      runId: params.runId ?? params.sessionId,
      agentDir: params.agentDir,
      agentId: fallbackAgentId,
      sessionId: params.sessionId,
      sessionKey: fallbackSessionKey,
      abortSignal: params.abortSignal,
      prepareAgentHarnessRuntime: async ({ provider, model, agentHarnessRuntimeOverride }) => {
        await ensureSelectedAgentHarnessPlugin({
          config: params.config,
          provider,
          modelId: model,
          agentId: fallbackAgentId,
          sessionKey: fallbackSessionKey,
          agentHarnessRuntimeOverride,
          workspaceDir: params.workspaceDir,
        });
      },
      fallbacksOverride,
      classifyResult: ({ result, provider, model }) =>
        classifyCompactionFallbackResult(result, provider, model),
      run: async (provider, model) => {
        const isPrimaryCandidate =
          provider === resolvedPrimaryCandidate?.provider &&
          model === resolvedPrimaryCandidate.model;
        const preservesPrimaryAuth =
          isPrimaryCandidate ||
          provider === primaryProvider ||
          provider === requestedPrimaryProvider;
        const authProfileId = preservesPrimaryAuth ? params.authProfileId : undefined;
        return await compactEmbeddedAgentSessionDirectOnce({
          ...params,
          provider,
          model,
          authProfileId,
          authProfileIdSource: preservesPrimaryAuth ? params.authProfileIdSource : undefined,
          // The primary attempt retains its already prepared atomic plan. An
          // actual fallback may change route/auth class and must rebuild it.
          runtimeAuthPlan: isPrimaryCandidate ? params.runtimeAuthPlan : undefined,
          runtimePlan: isPrimaryCandidate ? params.runtimePlan : undefined,
        });
      },
    });
    return fallbackResult.result;
  } catch (err) {
    return fallbackFailureToCompactionResult(err);
  } finally {
    preparedModelRuntimeLease.release();
  }
}

async function compactEmbeddedAgentSessionDirectOnce(
  params: PreparedCompactEmbeddedAgentSessionParams,
): Promise<EmbeddedAgentCompactResult> {
  const startedAt = Date.now();
  const diagId = params.diagId?.trim() || createCompactionDiagId();
  const trigger = params.trigger ?? "manual";
  const attempt = params.attempt ?? 1;
  const maxAttempts = params.maxAttempts ?? 1;
  const runId = params.runId ?? params.sessionId;
  // Parent compaction model-call spans to the active run/harness trace when one
  // exists, otherwise start a fresh root. Compaction emits no intermediate span
  // of its own (unlike the run lifecycle, which backs its run trace with a
  // run.started span), so a child trace here would orphan the model call under a
  // phantom parent. The :compaction: runId/callId already distinguishes the span.
  const compactionModelCallTrace = freezeDiagnosticTraceContext(
    getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
  );
  const diagnosticCompactionRunId = `${runId}:compaction:${diagId}`;
  let diagnosticModelCallSeq = 0;
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  ensureRuntimePluginsLoaded({
    config: params.config,
    workspaceDir: resolvedWorkspace,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  const earlyAgentIds = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const agentDir =
    params.agentDir ?? resolveAgentDir(params.config ?? {}, earlyAgentIds.sessionAgentId);
  const {
    runtimePolicySessionKey,
    runtimePolicyAgentId,
    boundHarnessRuntime,
    selectedHarnessRuntime,
    selectedHarnessRuntimeOverride,
    runtimeModelAuth: { plan: reusableRuntimeAuthPlan, authProfileId, modelAuth: initialModelAuth },
    provider,
    runtimeProvider,
    contextConfigProvider,
    modelId,
  } = resolveCompactionRuntimeSelection({
    ...params,
    modelId: params.model,
    boundHarnessRuntime: params.agentHarnessId,
    preparedRuntimePlan: params.runtimePlan,
  });
  // Keep the configured provider for harness policy, while auth/model loading below can
  // route OpenAI compaction through Codex OAuth when that runtime owns the session credentials.
  // Ensure the policy-selected harness plugin so selection can pick implicit codex.
  await ensureSelectedAgentHarnessPlugin({
    config: params.config,
    provider,
    modelId,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
    agentHarnessId: boundHarnessRuntime,
    agentHarnessRuntimeOverride: selectedHarnessRuntimeOverride,
    workspaceDir: resolvedWorkspace,
  });
  let thinkLevel = resolveEmbeddedCompactionThinkingLevel({
    config: params.config,
    provider,
    modelId,
    inheritedLevel: params.thinkLevel,
    agentId: runtimePolicyAgentId,
    sessionKey: runtimePolicySessionKey,
    agentRuntime: selectedHarnessRuntime,
  });
  const attemptedThinking = new Set<ThinkLevel>();
  const fail = (reason: string, err?: unknown): EmbeddedAgentCompactResult => {
    const failureReason = classifyCompactionReason(reason);
    const failure = err ? describeFailoverError(err) : undefined;
    const detail =
      failureReason === "unknown" ? formatUnknownCompactionReasonDetail(reason) : undefined;
    const detailSuffix = detail ? ` detail=${detail}` : "";
    log.warn(
      `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
        `attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${failureReason}${detailSuffix} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return {
      ok: false,
      compacted: false,
      reason,
      failure: failure
        ? {
            reason: failure.reason,
            status: failure.status,
            code: failure.code,
            rawError: failure.rawError ?? failure.message,
          }
        : undefined,
    };
  };
  const preparedModelRuntime = params.preparedModelRuntime;
  const preparedStores = preparedModelRuntime.createStores();
  const { model, error, authStorage, modelRegistry } = await resolveModelAsync(
    runtimeProvider,
    modelId,
    agentDir,
    params.config,
    {
      ...initialModelAuth,
      authStorage: preparedStores.authStorage,
      modelRegistry: preparedStores.modelRegistry,
      workspaceDir: resolvedWorkspace,
    },
  );
  if (!model) {
    const reason = error ?? `Unknown model: ${runtimeProvider}/${modelId}`;
    return fail(reason);
  }
  // Overrides stay unset when no bound/planned/explicit harness resolved so auth-aware
  // selection can pick the credential-owning harness (codex for ChatGPT OAuth); native
  // transcript compaction stays gated on selectedHarnessRuntime.
  const {
    runtimeAuthProfileStore,
    runtimeAuthPreparation,
    selectedPreparedHarness,
    providerUsesProfileScopedModelMetadata,
  } = await prepareCompactionHarnessAuth({
    ...params,
    provider,
    metadataProvider: runtimeProvider,
    modelId,
    model,
    reusableRuntimeAuthPlan,
    agentDir,
    workspaceDir: resolvedWorkspace,
    authProfileId,
    runtimePolicyAgentId,
    runtimePolicySessionKey,
    agentHarnessId: boundHarnessRuntime,
    agentHarnessRuntimeOverride: selectedHarnessRuntimeOverride,
  });
  const preparedHarnessRuntime = selectedPreparedHarness.id;
  const resolvePreparedModel = ({
    config,
    authProfileId: profileId,
    authProfileMode: resolvedAuthProfileMode,
  }: Parameters<
    Parameters<typeof materializePreparedRuntimeModel<ProviderRuntimeModel>>[0]["resolveModel"]
  >[0]) =>
    resolveModelAsync(runtimeProvider, modelId, agentDir, config, {
      authStorage,
      modelRegistry,
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: true,
      preferBundledStaticCatalogTransport: true,
      workspaceDir: resolvedWorkspace,
      authProfileId: profileId,
      authProfileMode: resolvedAuthProfileMode,
    });
  const materializeAuthAttemptModel = async (materializeParams: {
    plan: AgentRuntimeAuthPlan;
    model: ProviderRuntimeModel;
    forceResolve?: boolean;
  }): Promise<ProviderRuntimeModel> =>
    (await materializePreparedRuntimeModel<ProviderRuntimeModel>({
      plan: materializeParams.plan,
      provider,
      modelId,
      config: params.config,
      model: materializeParams.model,
      forceResolve: materializeParams.forceResolve,
      resolveModel: resolvePreparedModel,
    })) ?? materializeParams.model;
  const resolveRuntimeAuthAttempt = () =>
    resolvePreparedRuntimeAuthAttempts({
      attempts: runtimeAuthPreparation.attempts,
      store: runtimeAuthProfileStore,
      modelId,
      model,
      materializeModel: materializeAuthAttemptModel,
      forceCredentialScopedDirectModelResolve: providerUsesProfileScopedModelMetadata,
      resolveAuth: async ({ attempt: preparedAttempt, model: attemptModel }) =>
        await resolvePreparedRuntimeModelAuth({
          plan: preparedAttempt.plan,
          model: attemptModel,
          cfg: params.config,
          store: runtimeAuthProfileStore,
          agentDir,
          workspaceDir: resolvedWorkspace,
          ...(preparedAttempt.allowAuthProfileFallback !== undefined
            ? { allowAuthProfileFallback: preparedAttempt.allowAuthProfileFallback }
            : {}),
          secretSentinels: true,
        }),
      errorMessage: `Prepared compaction auth attempts could not be resolved for ${provider}/${modelId}.`,
    });
  let resolvedAuthAttempt: Awaited<ReturnType<typeof resolveRuntimeAuthAttempt>>;
  try {
    resolvedAuthAttempt = await resolveRuntimeAuthAttempt();
  } catch (err) {
    return fail(formatErrorMessage(err), err);
  }
  let runtimeModel = resolvedAuthAttempt.model;
  const apiKeyInfo = resolvedAuthAttempt.auth;
  const resolvedRuntimeAuthPlan = resolvedAuthAttempt.plan;
  let hasRuntimeAuthExchange = false;
  try {
    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        throw new MissingProviderAuthError(runtimeModel.provider, apiKeyInfo);
      }
    } else {
      const preparedAuth = protectPreparedProviderRuntimeAuth({
        provider: runtimeModel.provider,
        preparedAuth: await prepareProviderRuntimeAuth({
          provider: runtimeModel.provider,
          config: params.config,
          workspaceDir: resolvedWorkspace,
          env: process.env,
          context: {
            config: params.config,
            agentDir,
            workspaceDir: resolvedWorkspace,
            env: process.env,
            provider: runtimeModel.provider,
            modelId,
            model: runtimeModel,
            apiKey: unwrapSecretSentinelsForProviderEgress(
              apiKeyInfo.apiKey,
              "provider runtime auth exchange",
            ),
            authMode: apiKeyInfo.mode,
            profileId: apiKeyInfo.profileId,
          },
        }),
      });
      runtimeModel = applyPreparedRuntimeAuthToModel(runtimeModel, preparedAuth);
      const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
      hasRuntimeAuthExchange = Boolean(preparedAuth?.apiKey);
      if (!runtimeApiKey) {
        throw new Error(`Provider "${runtimeModel.provider}" runtime auth returned no apiKey.`);
      }
      authStorage.setRuntimeApiKey(runtimeModel.provider, runtimeApiKey);
    }
  } catch (err) {
    const reason = formatErrorMessage(err);
    return fail(reason, err);
  }

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
      "cwd override is not supported for sandboxed embedded compaction runs; omit cwd or use the agent workspace as cwd",
    );
  }
  const effectiveCwd = sandbox?.enabled ? effectiveWorkspace : (requestedCwd ?? effectiveWorkspace);
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  const isSqliteSessionTranscript = Boolean(parseSqliteSessionFileMarker(params.sessionFile));
  if (!isSqliteSessionTranscript) {
    await ensureSessionHeader({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      cwd: effectiveCwd,
    });
  }
  const { sessionAgentId: effectiveSkillAgentId } = earlyAgentIds;

  let restoreSkillEnv: (() => void) | undefined;
  let compactionSessionManager: unknown = null;
  let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null = null;
  let checkpointSnapshotRetained = false;
  try {
    const {
      skillsEligibility,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
      skillsSnapshot: skillsSnapshotForRun,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      workspaceOnly: loadSkillsWorkspaceOnly,
    } = resolveSandboxSkillRuntimeInputs({
      sandbox,
      effectiveWorkspace,
      skillsSnapshot: params.skillsSnapshot,
    });
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveSkillsWorkspace,
      config: params.config,
      agentId: effectiveSkillAgentId,
      eligibility: skillsEligibility,
      skillsSnapshot: skillsSnapshotForRun,
      workspaceOnly: loadSkillsWorkspaceOnly,
    });
    restoreSkillEnv = skillsSnapshotForRun
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: skillsSnapshotForRun,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });
    const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
    });
    const skillUsagePaths = mapSandboxSkillUsagePaths({
      paths: sandbox?.skillUsagePaths,
      skillsWorkspaceDir: effectiveSkillsWorkspace,
      skillsPromptWorkspaceDir: effectiveSkillsPromptWorkspace,
    });
    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: skillsSnapshotForRun,
      entries: promptSkillEntries,
      config: params.config,
      workspaceDir: effectiveSkillsPromptWorkspace,
      agentId: effectiveSkillAgentId,
      eligibility: skillsEligibility,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
    const contextInjectionMode = resolveContextInjectionMode(params.config, effectiveSkillAgentId);
    const { contextFiles } =
      contextInjectionMode === "never"
        ? { contextFiles: [] }
        : await resolveBootstrapContextForRun({
            workspaceDir: effectiveWorkspace,
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: effectiveSkillAgentId,
            warn: makeBootstrapWarn({
              sessionLabel,
              warn: (message) => log.warn(message),
            }),
          });
    // Apply contextTokens cap to model so session runtime's auto-compaction
    // threshold uses the effective limit, not the native context window.
    const runtimeModelWithContext = runtimeModel as ProviderRuntimeModel;
    const contextTokenBudget = resolveCompactionContextTokenBudget({
      config: params.config,
      provider: contextConfigProvider,
      modelId,
      model: runtimeModelWithContext,
      requestedTokenBudget: params.contextTokenBudget,
      fallbackTokenBudget: params.tokenBudget,
    });
    const effectiveModel = applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(
        contextTokenBudget < (runtimeModelWithContext.contextWindow ?? Infinity)
          ? { ...runtimeModelWithContext, contextWindow: contextTokenBudget }
          : runtimeModelWithContext,
        apiKeyInfo,
      ),
      // Skip header injection when runtime auth exchange produced a
      // different credential — the SDK reads the exchanged token from
      // authStorage automatically.
      hasRuntimeAuthExchange ? null : apiKeyInfo,
      params.config,
    );
    const reuseFullRuntimePlan = params.runtimePlan?.auth === resolvedRuntimeAuthPlan;
    const preparedRuntimePlan =
      (reuseFullRuntimePlan ? params.runtimePlan : undefined) ??
      buildAgentRuntimePlan({
        provider,
        modelId,
        model: effectiveModel,
        modelApi: effectiveModel.api,
        harnessId: preparedHarnessRuntime,
        harnessRuntime: preparedHarnessRuntime,
        authProfileMode: resolvedRuntimeAuthPlan.selectedAuthMode,
        sessionAuthProfileId: resolvedRuntimeAuthPlan.forwardedAuthProfileId,
        sessionAuthProfileSource: resolvedRuntimeAuthPlan.forwardedAuthProfileSource,
        sessionAuthProfileCandidateIds: resolvedRuntimeAuthPlan.forwardedAuthProfileCandidateIds,
        modelRoute: resolvedRuntimeAuthPlan.modelRoute,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        agentDir,
        agentId: effectiveSkillAgentId,
        thinkingLevel: mapThinkingLevelForProvider(thinkLevel),
      });
    const runtimePlan = reuseFullRuntimePlan
      ? preparedRuntimePlan
      : { ...preparedRuntimePlan, auth: resolvedRuntimeAuthPlan };

    const runAbortController = new AbortController();
    const spawnWorkspaceDir =
      effectiveCwd !== effectiveWorkspace
        ? resolvedWorkspace
        : resolveAttemptSpawnWorkspaceDir({
            sandbox,
            resolvedWorkspace,
          });
    const runtimeCapabilityProfile = resolveConversationCapabilityProfile({
      config: params.config,
      sessionKey: sandboxSessionKey,
      runSessionKey:
        params.sessionKey && params.sessionKey !== sandboxSessionKey
          ? params.sessionKey
          : undefined,
      sessionId: params.sessionId,
      runId: params.runId,
      agentDir,
      agentAccountId: params.agentAccountId,
      messageProvider: resolvedMessageProvider,
      chatType: params.chatType,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      senderIsOwner: params.senderIsOwner,
      modelProvider: effectiveModel.provider,
      modelId,
      modelApi: effectiveModel.api,
      modelContextWindowTokens: contextTokenBudget,
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      spawnWorkspaceDir,
      skillsSnapshot: skillsSnapshotForRun,
      sandboxToolPolicy: sandbox?.tools,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
    });
    const toolsEnabled = supportsModelTools(effectiveModel);
    const toolsRaw = toolsEnabled
      ? createOpenClawCodingTools({
          exec: {
            ...params.execOverrides,
            config: params.config,
            elevated: params.bashElevated,
          },
          sandbox,
          messageProvider: resolvedMessageProvider,
          clientCaps: params.clientCaps,
          chatType: params.chatType,
          agentAccountId: params.agentAccountId,
          sessionKey: sandboxSessionKey,
          runSessionKey:
            params.sessionKey && params.sessionKey !== sandboxSessionKey
              ? params.sessionKey
              : undefined,
          sessionId: params.sessionId,
          runId: params.runId,
          oneShotCliRun: params.oneShotCliRun,
          groupId: params.groupId,
          groupChannel: params.groupChannel,
          groupSpace: params.groupSpace,
          spawnedBy: params.spawnedBy,
          senderId: params.senderId,
          senderName: params.senderName,
          senderUsername: params.senderUsername,
          senderE164: params.senderE164,
          allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
          agentDir,
          cwd: effectiveCwd,
          workspaceDir: effectiveWorkspace,
          spawnWorkspaceDir,
          config: params.config,
          abortSignal: runAbortController.signal,
          sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          modelProvider: effectiveModel.provider,
          modelId,
          modelHasVision: effectiveModel.input?.includes("image") ?? false,
          modelCompat: extractModelCompat(effectiveModel),
          modelApi: effectiveModel.api,
          modelContextWindowTokens: contextTokenBudget,
          skillsSnapshot: skillsSnapshotForRun,
          skillUsagePaths,
          conversationCapabilityProfile: runtimeCapabilityProfile,
          modelAuthMode: resolveModelAuthMode(effectiveModel.provider, params.config, undefined, {
            workspaceDir: effectiveWorkspace,
          }),
        })
      : [];
    const runtimePlanModelContext = {
      workspaceDir: effectiveWorkspace,
      modelApi: effectiveModel.api,
      model: effectiveModel,
    };
    const normalizableToolProjection = filterProviderNormalizableTools(
      toolsEnabled ? toolsRaw : [],
    );
    logRuntimeToolSchemaQuarantine({
      diagnostics: normalizableToolProjection.diagnostics,
      tools: toolsEnabled ? toolsRaw : [],
      runId,
      agentId: effectiveSkillAgentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    const tools = runtimePlan.tools.normalize(
      [...normalizableToolProjection.tools],
      runtimePlanModelContext,
    );
    const bundleMcpRuntime = toolsEnabled
      ? await createBundleMcpToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: tools.map((tool) => tool.name),
        })
      : undefined;
    const bundleLspRuntime = toolsEnabled
      ? await createBundleLspToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
        })
      : undefined;
    const filteredBundledTools = applyFinalEffectiveToolPolicy({
      bundledTools: [...(bundleMcpRuntime?.tools ?? []), ...(bundleLspRuntime?.tools ?? [])],
      config: params.config,
      // The same profile constructed the core tool set above, so core and
      // bundled tools cannot disagree about policy inputs (agentId included:
      // both resolve it from the session key inside the profile).
      conversationCapabilityProfile: runtimeCapabilityProfile,
      warn: (message) => log.warn(message),
    });
    const normalizableBundledToolProjection = filterProviderNormalizableTools(filteredBundledTools);
    if (normalizableBundledToolProjection.diagnostics.length > 0) {
      logRuntimeToolSchemaQuarantine({
        diagnostics: normalizableBundledToolProjection.diagnostics,
        tools: filteredBundledTools,
        runId,
        agentId: effectiveSkillAgentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
      });
    }
    const normalizedBundledTools =
      filteredBundledTools.length > 0
        ? runtimePlan.tools.normalize(
            [...normalizableBundledToolProjection.tools],
            runtimePlanModelContext,
          )
        : filteredBundledTools;
    const projectedEffectiveTools = [...tools, ...normalizedBundledTools];
    const toolSchemaProjection = filterRuntimeCompatibleTools(projectedEffectiveTools);
    logRuntimeToolSchemaQuarantine({
      diagnostics: toolSchemaProjection.diagnostics,
      tools: projectedEffectiveTools,
      runId,
      agentId: effectiveSkillAgentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
    });
    const effectiveTools = [...toolSchemaProjection.tools];
    const allowedToolNames = collectAllowedToolNames({ tools: effectiveTools });
    runtimePlan.tools.logDiagnostics(effectiveTools, runtimePlanModelContext);
    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    const runtimeCapabilities = collectRuntimeChannelCapabilities({
      cfg: params.config,
      channel: runtimeChannel,
      accountId: params.agentAccountId,
    });
    const reactionGuidance =
      runtimeChannel && params.config
        ? resolveChannelReactionGuidance({
            cfg: params.config,
            channel: runtimeChannel,
            accountId: params.agentAccountId,
          })
        : undefined;
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
      agentId: params.agentId,
    });
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions(
          buildEmbeddedMessageActionDiscoveryInput({
            cfg: params.config,
            channel: runtimeChannel,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            accountId: params.agentAccountId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            senderId: params.senderId,
          }),
        )
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const runtimeInfo = {
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      host: machineName,
      os: resolveRuntimeOsLabel(),
      arch: os.arch(),
      node: process.version,
      model: `${provider}/${modelId}`,
      shell: detectRuntimeShell(),
      channel: runtimeChannel,
      chatType: params.chatType,
      capabilities: runtimeCapabilities,
      channelActions,
      activeProcessSessions: listActiveProcessSessionReferences({
        scopeKey: resolveProcessToolScopeKey({
          sessionKey: sandboxSessionKey,
          agentId: sessionAgentId,
        }),
      }),
      activeNode: formatActiveNodeContextLabel(getCurrentActiveNodeContext()),
    };
    const sandboxInfoExecPolicy = resolveEmbeddedSandboxInfoExecPolicy({
      config: params.config,
      agentId: sessionAgentId,
      sessionKey: params.sessionKey,
      sandboxAvailable: sandbox?.enabled === true,
      execOverrides: params.execOverrides,
    });
    const sandboxInfo = buildEmbeddedSandboxInfo(
      sandbox,
      params.bashElevated,
      sandboxInfoExecPolicy,
    );
    const reasoningTagHint = isReasoningTagProvider(provider, {
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId,
      modelApi: effectiveModel.api,
      model: effectiveModel,
    });
    const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
    const userTimeFormat = resolveUserTimeFormat(undefined);
    const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
    const promptSurface = resolveAgentPromptSurfaceForSessionKey(params.sessionKey);
    const promptMode =
      isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
        ? "minimal"
        : "full";
    const nativeCommandGuidanceLines = listRegisteredPluginAgentPromptGuidance({
      surface: promptSurface,
    });
    const openClawReferences = await resolveOpenClawReferencePaths({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: effectiveCwd,
      moduleUrl: import.meta.url,
    });
    const promptContributionContext: Parameters<
      AgentRuntimePlan["prompt"]["resolveSystemPromptContribution"]
    >[0] = {
      config: params.config,
      agentDir,
      workspaceDir: effectiveWorkspace,
      provider,
      modelId,
      promptMode,
      runtimeChannel,
      runtimeCapabilities,
      agentId: sessionAgentId,
    };
    const promptContribution =
      runtimePlan.prompt.resolveSystemPromptContribution(promptContributionContext);
    const preparedMemoryPrompt = await prepareAgentMemoryPrompt({
      enabled: promptMode === "full",
      toolNames: effectiveTools.map((tool) => tool.name),
      citationsMode: params.config?.memory?.citations,
      agentId: runtimeInfo.agentId,
      agentSessionKey: runtimeInfo.sessionKey,
      sandboxed: sandboxInfo?.enabled === true,
    });
    const buildSystemPromptText = (defaultThinkLevel: ThinkLevel) => {
      const builtSystemPrompt = buildEmbeddedSystemPrompt({
        config: params.config,
        agentId: sessionAgentId,
        workspaceDir: effectiveWorkspace,
        defaultThinkLevel,
        reasoningLevel: params.reasoningLevel ?? "off",
        extraSystemPrompt: params.extraSystemPrompt,
        ownerNumbers: params.ownerNumbers,
        reasoningTagHint,
        heartbeatPrompt: resolveHeartbeatPromptForSystemPrompt({
          config: params.config,
          agentId: sessionAgentId,
          defaultAgentId,
        }),
        skillsPrompt,
        docsPath: openClawReferences.docsPath ?? undefined,
        sourcePath: openClawReferences.sourcePath ?? undefined,
        promptMode,
        promptSurface,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        acpEnabled: isAcpRuntimeSpawnAvailable({
          config: params.config,
          sandboxed: sandboxInfo?.enabled === true,
        }),
        runtimeInfo,
        reactionGuidance,
        messageToolHints,
        sandboxInfo,
        tools: effectiveTools,
        userTimezone,
        userTime,
        userTimeFormat,
        contextFiles,
        preparedMemoryPrompt,
        promptContribution,
        nativeCommandGuidanceLines,
      });
      return transformProviderSystemPrompt({
        provider,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        context: {
          config: params.config,
          agentDir,
          workspaceDir: effectiveWorkspace,
          provider,
          modelId,
          promptMode,
          runtimeChannel,
          runtimeCapabilities,
          agentId: sessionAgentId,
          systemPrompt: builtSystemPrompt,
        },
      });
    };

    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionLock =
      (await acquireOwnedSessionTranscriptWriteLock({
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
      })) ??
      (await acquireSessionWriteLock({
        sessionFile: params.sessionFile,
        ...resolveSessionWriteLockOptions(params.config, {
          maxHoldMsFallback: resolveSessionLockMaxHoldFromTimeout({
            timeoutMs: compactionTimeoutMs,
          }),
        }),
      }));
    try {
      if (!isSqliteSessionTranscript) {
        await repairSessionFileIfNeeded({
          sessionFile: params.sessionFile,
          debug: (message) => log.debug(message),
          warn: (message) => log.warn(message),
        });
        await prewarmSessionFile(params.sessionFile);
      }
      const transcriptPolicy = runtimePlan.transcript.resolvePolicy(runtimePlanModelContext);
      const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        config: params.config,
        contextWindowTokens: contextTokenBudget,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        missingToolResultText:
          effectiveModel.api === "openai-responses" ||
          effectiveModel.api === "azure-openai-responses" ||
          effectiveModel.api === "openai-chatgpt-responses"
            ? "aborted"
            : undefined,
        allowedToolNames,
      });
      checkpointSnapshot = await compactionCheckpointStore.captureSnapshot({
        sessionManager,
        sessionFile: params.sessionFile,
      });
      compactionSessionManager = sessionManager;
      trackSessionManagerAccess(params.sessionFile);
      const settingsManager = createPreparedEmbeddedAgentSettingsManager({
        cwd: effectiveCwd,
        agentDir,
        cfg: params.config,
        pluginMetadataSnapshot: getCurrentPluginMetadataSnapshot({
          config: params.config,
          env: process.env,
          workspaceDir: effectiveWorkspace,
        }),
        contextTokenBudget,
      });
      // Sets compaction/pruning runtime state and returns extension factories
      // that must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider,
        modelId,
        model: effectiveModel,
      });
      const resourceLoader = createEmbeddedAgentResourceLoader({
        cwd: effectiveCwd,
        agentDir,
        settingsManager,
        extensionFactories,
      });
      await resourceLoader.reload();
      // DefaultResourceLoader.reload() rehydrates settings from disk and can drop OpenClaw
      // compaction overrides applied in createPreparedEmbeddedAgentSettingsManager — same
      // rehydration also restores OpenClaw runtime's auto-compaction (openclaw#75799), so re-apply
      // both guards. effectiveModel.baseUrl matches the surrounding scope so
      // auth-profile-injected baseUrls reach the endpoint-class detector.
      applyAgentCompactionSettingsFromConfig({
        settingsManager,
        cfg: params.config,
        contextTokenBudget,
      });
      // contextEngineInfo is intentionally omitted: this guard runs inside the
      // compaction LLM session, which is not the user-facing agent session and
      // has no associated context engine.
      applyAgentAutoCompactionGuard({
        settingsManager,
        silentOverflowProneProvider: isSilentOverflowProneModel({
          provider,
          modelId,
          baseUrl: effectiveModel.baseUrl ?? undefined,
        }),
      });

      const { customTools } = splitSdkTools({
        tools: effectiveTools,
        sandboxEnabled: Boolean(sandbox?.enabled),
        toolHookContext: {
          agentId: sessionAgentId,
          config: params.config,
          cwd: effectiveCwd,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          channelId: params.currentChannelId,
        },
      });
      // The session runtime treats `tools` as a name allowlist during session creation. Pass the
      // exact OpenClaw-managed registrations so custom tools survive startup.
      const sessionToolAllowlist = toSessionToolAllowlist(collectRegisteredToolNames(customTools));

      const providerStreamFn = resolveCompactionProviderStream({
        effectiveModel,
        config: params.config,
        agentDir,
        effectiveWorkspace,
        apiRegistry: getModelRegistryRuntime(modelRegistry).apiRegistry,
      });
      while (true) {
        // Rebuild the compaction session on retry so provider wrappers, payload
        // shaping, and the embedded system prompt all reflect the fallback level.
        attemptedThinking.add(thinkLevel);
        const systemPromptText = buildSystemPromptText(thinkLevel);
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const createdSession = await createAgentSession({
            cwd: effectiveCwd,
            agentDir,
            authStorage,
            modelRegistry,
            model: effectiveModel,
            thinkingLevel: mapThinkingLevel(thinkLevel),
            tools: sessionToolAllowlist,
            customTools,
            sessionManager,
            settingsManager,
            resourceLoader,
          });
          session = createdSession.session;
          session.setActiveToolsByName(sessionToolAllowlist);
          applySystemPromptToSession(session, systemPromptText);
          // Compaction builds the same embedded system prompt, so it must flow
          // through the same transport/payload shaping stack as normal turns.
          await prepareCompactionSessionAgent({
            session,
            llmRuntime: getModelRegistryRuntime(modelRegistry).llmRuntime,
            providerStreamFn,
            sessionId: params.sessionId,
            signal: runAbortController.signal,
            effectiveModel,
            resolvedApiKey: hasRuntimeAuthExchange ? undefined : apiKeyInfo?.apiKey,
            authStorage,
            config: params.config,
            provider,
            modelId,
            thinkLevel,
            sessionAgentId,
            effectiveWorkspace,
            agentDir,
            runtimePlan,
            sessionKey: sandboxSessionKey,
            sandboxToolPolicy: sandbox?.tools,
            messageProvider: resolvedMessageProvider,
            agentAccountId: params.agentAccountId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
          });
          session.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(
            session.agent.streamFn,
            {
              runId: diagnosticCompactionRunId,
              ...(params.sessionKey && { sessionKey: params.sessionKey }),
              sessionId: params.sessionId,
              provider,
              model: modelId,
              api: effectiveModel.api,
              transport: session.agent.transport,
              contextTokenBudget,
              trace: compactionModelCallTrace,
              contentCapture: resolveDiagnosticModelContentCapturePolicy(params.config),
              nextCallId: () =>
                `${diagnosticCompactionRunId}:model:${(diagnosticModelCallSeq += 1)}`,
            },
          );

          const prior = await sanitizeSessionHistory({
            messages: session.messages,
            modelApi: effectiveModel.api,
            modelId,
            provider,
            allowedToolNames,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model: effectiveModel,
            sessionManager,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
            preserveLatestAssistantThinking: false,
          });
          const validated = await validateReplayTurns({
            messages: prior,
            modelApi: effectiveModel.api,
            modelId,
            provider,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model: effectiveModel,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
          });
          const dedupedValidated = dedupeDuplicateUserMessagesForCompaction(validated);
          // Apply validated transcript to the live session even when no history limit is configured,
          // so compaction and hook metrics are based on the same message set.
          session.agent.state.messages = dedupedValidated;
          // "Original" compaction metrics should describe the validated transcript that enters
          // limiting/compaction, not the raw on-disk session snapshot.
          const originalMessages = session.messages.slice();
          const truncated = limitHistoryTurns(
            session.messages,
            getHistoryLimitFromSessionKey(params.sessionKey, params.config),
          );
          // Re-run tool_use/tool_result pairing repair after truncation, since
          // limitHistoryTurns can orphan tool_result blocks by removing the
          // assistant message that contained the matching tool_use.
          const limited = transcriptPolicy.repairToolUseResultPairing
            ? sanitizeToolUseResultPairing(truncated, {
                erroredAssistantResultPolicy: "drop",
                ...(effectiveModel.api === "openai-responses" ||
                effectiveModel.api === "azure-openai-responses" ||
                effectiveModel.api === "openai-chatgpt-responses"
                  ? { missingToolResultText: "aborted" }
                  : {}),
              })
            : truncated;
          if (limited.length > 0) {
            session.agent.state.messages = limited;
          }
          const hookRunner = asCompactionHookRunner(getGlobalHookRunner());
          const observedTokenCount = normalizeObservedTokenCount(params.currentTokenCount);
          const beforeHookMetrics = buildBeforeCompactionHookMetrics({
            originalMessages,
            currentMessages: session.messages,
            observedTokenCount,
            estimateTokensFn: estimateTokens,
          });
          const { hookSessionKey, missingSessionKey } = await runBeforeCompactionHooks({
            hookRunner,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionAgentId,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            metrics: beforeHookMetrics,
            onHookMessages: params.onCompactionHookMessages,
          });
          const { messageCountOriginal } = beforeHookMetrics;
          const diagEnabled = log.isEnabled("debug");
          const preMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics) {
            log.debug(
              `[compaction-diag] start runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} ` +
                `pre.messages=${preMetrics.messages} pre.historyTextChars=${preMetrics.historyTextChars} ` +
                `pre.toolResultChars=${preMetrics.toolResultChars} pre.estTokens=${preMetrics.estTokens ?? "unknown"}`,
            );
            log.debug(
              `[compaction-diag] contributors diagId=${diagId} top=${JSON.stringify(preMetrics.contributors)}`,
            );
          }

          if (!containsRealConversationMessages(session.messages)) {
            log.info(
              `[compaction] skipping — no real conversation messages (sessionKey=${params.sessionKey ?? params.sessionId})`,
            );
            return {
              ok: true,
              compacted: false,
              reason: "no real conversation messages",
            };
          }

          const compactStartedAt = Date.now();
          // Measure compactedCount from the original pre-limiting transcript so compaction
          // lifecycle metrics represent total reduction through the compaction pipeline.
          const messageCountCompactionInput = messageCountOriginal;
          // Estimate full session tokens BEFORE compaction (including system prompt,
          // bootstrap context, workspace files, and all history). This is needed for
          // a correct sanity check — result.tokensBefore only covers the summarizable
          // history subset, not the full session.
          let fullSessionTokensBefore = 0;
          try {
            fullSessionTokensBefore = limited.reduce((sum, msg) => sum + estimateTokens(msg), 0);
          } catch {
            // If token estimation throws on a malformed message, fall back to 0 so
            // the sanity check below becomes a no-op instead of crashing compaction.
          }
          const activeSession = session;
          const result = await compactWithSafetyTimeout(
            () => {
              setCompactionSafeguardCancelReason(compactionSessionManager, undefined);
              return activeSession.compact(params.customInstructions);
            },
            compactionTimeoutMs,
            {
              abortSignal: params.abortSignal,
              onCancel: () => {
                activeSession.abortCompaction();
              },
            },
          );
          let effectiveFirstKeptEntryId = result.firstKeptEntryId;
          let postCompactionLeafId =
            typeof sessionManager.getLeafId === "function"
              ? (sessionManager.getLeafId() ?? undefined)
              : undefined;
          let transcriptRotationSessionManager: Parameters<
            typeof rotateTranscriptAfterCompaction
          >[0]["sessionManager"] = sessionManager;
          if (params.trigger === "manual" && !isSqliteSessionTranscript) {
            try {
              const hardenedBoundary = await hardenManualCompactionBoundary({
                sessionFile: params.sessionFile,
                preserveRecentTail:
                  typeof params.config?.agents?.defaults?.compaction?.keepRecentTokens === "number",
              });
              if (hardenedBoundary.applied) {
                effectiveFirstKeptEntryId =
                  hardenedBoundary.firstKeptEntryId ?? effectiveFirstKeptEntryId;
                postCompactionLeafId = hardenedBoundary.leafId ?? postCompactionLeafId;
                session.agent.state.messages = hardenedBoundary.messages;
                transcriptRotationSessionManager = await readTranscriptFileState(
                  params.sessionFile,
                );
              }
            } catch (err) {
              log.warn("[compaction] failed to harden manual compaction boundary", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          // Estimate tokens after compaction by summing token estimates for remaining messages
          const tokensAfter = estimateTokensAfterCompaction({
            messagesAfter: session.messages,
            observedTokenCount,
            fullSessionTokensBefore,
            estimateTokensFn: estimateTokens,
          });
          const messageCountAfter = session.messages.length;
          const compactedCount = Math.max(0, messageCountCompactionInput - messageCountAfter);
          let transcriptRotation: CompactionTranscriptRotation = { rotated: false };
          if (shouldRotateCompactionTranscript(params.config) && !isSqliteSessionTranscript) {
            try {
              transcriptRotation = await rotateTranscriptAfterCompaction({
                sessionManager: transcriptRotationSessionManager,
                sessionFile: params.sessionFile,
              });
            } catch (err) {
              log.warn("[compaction] post-compaction transcript rotation failed", {
                errorMessage: formatErrorMessage(err),
                errorStack: err instanceof Error ? err.stack : undefined,
              });
            }
          }
          const activeSessionId = transcriptRotation.sessionId ?? params.sessionId;
          const activeSessionFile = transcriptRotation.sessionFile ?? params.sessionFile;
          const activePostLeafId = transcriptRotation.leafId ?? postCompactionLeafId;
          if (transcriptRotation.rotated) {
            log.info(
              `[compaction] rotated active transcript after compaction ` +
                `(sessionKey=${params.sessionKey ?? params.sessionId})`,
            );
          }
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: activeSessionId,
            agentId: sessionAgentId,
            sessionFile: activeSessionFile,
          });
          checkpointSnapshotRetained = await persistCompactionCheckpoint({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: activeSessionId,
            trigger: params.trigger,
            snapshot: checkpointSnapshot,
            summary: result.summary,
            firstKeptEntryId: effectiveFirstKeptEntryId,
            tokensBefore: observedTokenCount ?? result.tokensBefore,
            tokensAfter,
            sessionFile: activeSessionFile,
            leafId: activePostLeafId,
            createdAt: compactStartedAt,
          });
          const postMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics && postMetrics) {
            log.debug(
              `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} outcome=compacted reason=none ` +
                `durationMs=${Date.now() - compactStartedAt} retrying=false ` +
                `post.messages=${postMetrics.messages} post.historyTextChars=${postMetrics.historyTextChars} ` +
                `post.toolResultChars=${postMetrics.toolResultChars} post.estTokens=${postMetrics.estTokens ?? "unknown"} ` +
                `delta.messages=${postMetrics.messages - preMetrics.messages} ` +
                `delta.historyTextChars=${postMetrics.historyTextChars - preMetrics.historyTextChars} ` +
                `delta.toolResultChars=${postMetrics.toolResultChars - preMetrics.toolResultChars} ` +
                `delta.estTokens=${typeof preMetrics.estTokens === "number" && typeof postMetrics.estTokens === "number" ? postMetrics.estTokens - preMetrics.estTokens : "unknown"}`,
            );
          }
          await runAfterCompactionHooks({
            hookRunner,
            sessionId: activeSessionId,
            sessionAgentId,
            hookSessionKey,
            missingSessionKey,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            messageCountAfter,
            tokensAfter,
            compactedCount,
            sessionFile: activeSessionFile,
            ...(activeSessionId !== params.sessionId
              ? { previousSessionId: params.sessionId }
              : {}),
            summaryLength: typeof result.summary === "string" ? result.summary.length : undefined,
            tokensBefore: result.tokensBefore,
            firstKeptEntryId: effectiveFirstKeptEntryId,
            onHookMessages: params.onCompactionHookMessages,
          });
          return {
            ok: true,
            compacted: true,
            result: {
              summary: result.summary,
              firstKeptEntryId: effectiveFirstKeptEntryId,
              tokensBefore: observedTokenCount ?? result.tokensBefore,
              tokensAfter,
              details: result.details,
              sessionId: transcriptRotation.sessionId,
              sessionFile: transcriptRotation.sessionFile,
            },
          };
        } catch (err) {
          const fallbackThinking = pickFallbackThinkingLevel({
            message: formatErrorMessage(err),
            attempted: attemptedThinking,
          });
          if (fallbackThinking) {
            // Near-term provider fix: when compaction hits a reasoning-mandatory
            // endpoint with `off`, retry once with `minimal` instead of surfacing
            // a user-visible failure.
            log.warn(
              `[compaction] request rejected for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }
          throw err;
        } finally {
          try {
            await flushPendingToolResultsAfterIdle({
              agent: session?.agent,
              sessionManager,
            });
          } catch {
            /* best-effort */
          }
          try {
            session?.dispose();
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      try {
        await bundleMcpRuntime?.dispose();
      } catch {
        /* best-effort */
      }
      try {
        await bundleLspRuntime?.dispose();
      } catch {
        /* best-effort */
      }
      await sessionLock.release();
    }
  } catch (err) {
    const reason = resolveCompactionFailureReason({
      reason: formatErrorMessage(err),
      safeguardCancelReason: consumeCompactionSafeguardCancelReason(compactionSessionManager),
    });
    return fail(reason, err);
  } finally {
    if (!checkpointSnapshotRetained) {
      await compactionCheckpointStore.cleanupSnapshot(checkpointSnapshot);
    }
    restoreSkillEnv?.();
  }
}

export const testing = {
  hasRealConversationContent,
  hasMeaningfulConversationContent,
  containsRealConversationMessages,
  estimateTokensAfterCompaction,
  buildBeforeCompactionHookMetrics,
  hardenManualCompactionBoundary,
  resolveCompactionProviderStream,
  prepareCompactionSessionAgent,
  runBeforeCompactionHooks,
  runAfterCompactionHooks,
  runPostCompactionSideEffects,
} as const;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
