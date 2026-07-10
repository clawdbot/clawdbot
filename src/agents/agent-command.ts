/** Main agent command orchestration for sessions, model selection, delivery, and attempts. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveInlineAgentImageAttachments } from "../auto-reply/reply/agent-turn-attachments.js";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { isDiagnosticsEnabled, emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentExplicitRecipientSession,
  resolveAgentOutboundTarget,
} from "../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { loadManifestMetadataSnapshot } from "../plugins/manifest-contract-eligibility.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import {
  applyModelOverrideToSessionEntry,
  repairProviderWrappedModelOverride,
} from "../sessions/model-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveEffectiveAgentSkillFilter } from "../skills/discovery/agent-filter.js";
import type { getRemoteSkillEligibility } from "../skills/runtime/remote.js";
import type { resolveReusableWorkspaceSkillSnapshot } from "../skills/runtime/session-snapshot.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../tasks/task-status-access.js";
import { removeSessionTrajectoryArtifacts } from "../trajectory/cleanup.js";
import { createTrajectoryRuntimeRecorder } from "../trajectory/runtime.js";
import { resolveUserPath } from "../utils.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  resolveMessageChannel,
} from "../utils/message-channel.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
import { buildAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import { resolveAgentRuntimeConfig } from "./agent-runtime-config.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  hasLegacyAutoFallbackWithoutOrigin,
  hasSessionAutoModelFallbackProvenance,
  listAgentIds,
  markAutoFallbackPrimaryProbe,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentDir,
  resolveAgentConfig,
  resolveDefaultAgentId,
  resolveEffectiveModelFallbacks,
  resolveSessionAgentId,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "./auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { isHeartbeatLifecycleRunKind } from "./bootstrap-mode.js";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./command/attempt-callbacks.js";
import {
  persistSessionEntry as persistSessionEntryBase,
  prependInternalEventContext,
  resolveAcpPromptBody,
  resolveInternalEventTranscriptBody,
} from "./command/attempt-execution.shared.js";
import { resolveAgentRunContext } from "./command/run-context.js";
import { clearRotatedSessionMetadata, resolveSession } from "./command/session.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./embedded-agent-runner/result-fallback-classifier.js";
import { resolveFastModeState } from "./fast-mode.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import { resolveAvailableAgentHarnessPolicy } from "./harness/selection.js";
import {
  isInternalSessionEffectsTranscriptPath,
  prepareInternalSessionEffectsTranscript,
  removeInternalSessionEffectsTranscript,
  resolveInternalSessionEffectsTranscriptPath,
} from "./internal-session-effects.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { LiveSessionModelSwitchError } from "./live-model-switch.js";
import { loadManifestModelCatalog } from "./model-catalog.js";
import { runWithModelFallback } from "./model-fallback.js";
import { normalizeConfiguredProviderCatalogModelId } from "./model-ref-shared.js";
import type { ModelManifestNormalizationContext } from "./model-selection-normalize.js";
import {
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  resolveThinkingDefault,
} from "./model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "./model-visibility-policy.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "./openai-routing.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
  resolveAgentRunAbortLifecycleFields,
  resolveAgentRunErrorLifecycleFields,
} from "./run-termination.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";
import { normalizeSpawnedRunMetadata } from "./spawned-context.js";
import { resolveCandidateThinkingLevel, resolveEffectiveAgentRuntime } from "./thinking-runtime.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { hasNonzeroUsage } from "./usage.js";
import { ensureAgentWorkspace } from "./workspace.js";

const log = createSubsystemLogger("agents/agent-command");

function hasExactConfiguredProviderModel(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  const model = params.model.trim();
  if (!normalizedProvider || !model) {
    return false;
  }
  for (const [providerId, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== normalizedProvider) {
      continue;
    }
    return (providerConfig.models ?? []).some((entry) => entry.id.trim() === model);
  }
  return false;
}

function hasConfiguredProvider(params: { cfg: OpenClawConfig; provider: string }): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (!normalizedProvider) {
    return false;
  }
  return Object.keys(params.cfg.models?.providers ?? {}).some(
    (providerId) => normalizeProviderId(providerId) === normalizedProvider,
  );
}

function allowPluginModelNormalizationForRef(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): boolean {
  if (!normalizePluginsConfig(params.cfg.plugins).enabled && hasConfiguredProvider(params)) {
    return false;
  }
  return !hasExactConfiguredProviderModel(params);
}

function normalizeAgentCommandModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  return normalizeModelRef(provider, model, {
    ...modelManifestContext,
    allowPluginNormalization: allowPluginModelNormalizationForRef({ cfg, provider, model }),
  });
}

function normalizeAgentCommandDefaultModelRef(
  cfg: OpenClawConfig,
  provider: string,
  model: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  const normalizedProvider = normalizeProviderId(provider);
  if (hasConfiguredProvider({ cfg, provider: normalizedProvider })) {
    return {
      provider: normalizedProvider,
      model: normalizeConfiguredProviderCatalogModelId(normalizedProvider, model, {
        manifestPlugins: modelManifestContext.manifestPlugins,
      }),
    };
  }
  return normalizeAgentCommandModelRef(cfg, provider, model, modelManifestContext);
}

function parseAgentCommandModelRef(
  cfg: OpenClawConfig,
  raw: string,
  defaultProvider: string,
  modelManifestContext: ModelManifestNormalizationContext,
) {
  const parsed = resolveModelRefFromString({
    cfg,
    raw,
    defaultProvider,
    aliasIndex: buildModelAliasIndex({
      cfg,
      defaultProvider,
      ...modelManifestContext,
      allowPluginNormalization: false,
    }),
    ...modelManifestContext,
    allowPluginNormalization: false,
  })?.ref;
  return parsed
    ? normalizeAgentCommandModelRef(cfg, parsed.provider, parsed.model, modelManifestContext)
    : null;
}

type AttemptExecutionRuntime = typeof import("./command/attempt-execution.runtime.js");
type AgentAttemptResult = Awaited<ReturnType<AttemptExecutionRuntime["runAgentAttempt"]>>;

function resolveAgentRunLifecycleEndLogLevel(meta: {
  aborted?: unknown;
  error?: unknown;
  stopReason?: unknown;
  livenessState?: unknown;
  timeoutPhase?: unknown;
  providerStarted?: unknown;
}): "info" | "warn" | "error" | undefined {
  const status =
    meta.stopReason === "timeout" || meta.timeoutPhase
      ? "timeout"
      : meta.aborted === true || meta.error || meta.stopReason === "error"
        ? "error"
        : "ok";
  const outcome = buildAgentRunTerminalOutcome({
    status,
    error: meta.error,
    stopReason: meta.stopReason,
    livenessState: meta.livenessState,
    timeoutPhase: meta.timeoutPhase,
    providerStarted: meta.providerStarted,
  });
  if (!outcome.stopReason || outcome.stopReason === "end_turn") {
    return undefined;
  }
  if (outcome.reason === "completed") {
    return "info";
  }
  return outcome.status === "timeout" ? "warn" : "error";
}

function applyAgentRunAbortMetadata<T extends { meta: object }>(
  result: T,
  signal: AbortSignal | undefined,
): T {
  const abortFields = resolveAgentRunAbortLifecycleFields(signal);
  if (abortFields.aborted !== true) {
    return result;
  }
  return {
    ...result,
    meta: {
      ...result.meta,
      ...abortFields,
    },
  };
}
type AcpManagerRuntime = typeof import("../acp/control-plane/manager.js");
type AcpPolicyRuntime = typeof import("../acp/policy.js");
type AcpRuntimeErrorsRuntime = typeof import("../acp/runtime/errors.js");
type AcpSessionIdentifiersRuntime = typeof import("@openclaw/acp-core/runtime/session-identifiers");
type DeliveryRuntime = typeof import("./command/delivery.runtime.js");
type SessionStoreRuntime = typeof import("./command/session-store.runtime.js");
type CliCompactionRuntime = typeof import("./command/cli-compaction.js");
type TranscriptResolveRuntime = typeof import("../config/sessions/transcript-resolve.runtime.js");
type CliDepsRuntime = typeof import("../cli/deps.js");
type ExecDefaultsRuntime = typeof import("./exec-defaults.js");
type SkillsRuntime = {
  getRemoteSkillEligibility: typeof getRemoteSkillEligibility;
  resolveReusableWorkspaceSkillSnapshot: typeof resolveReusableWorkspaceSkillSnapshot;
};

const attemptExecutionRuntimeLoader = createLazyImportLoader<AttemptExecutionRuntime>(
  () => import("./command/attempt-execution.runtime.js"),
);
const acpManagerRuntimeLoader = createLazyImportLoader<AcpManagerRuntime>(
  () => import("../acp/control-plane/manager.js"),
);
const acpPolicyRuntimeLoader = createLazyImportLoader<AcpPolicyRuntime>(
  () => import("../acp/policy.js"),
);
const acpRuntimeErrorsRuntimeLoader = createLazyImportLoader<AcpRuntimeErrorsRuntime>(
  () => import("../acp/runtime/errors.js"),
);
const acpSessionIdentifiersRuntimeLoader = createLazyImportLoader<AcpSessionIdentifiersRuntime>(
  () => import("@openclaw/acp-core/runtime/session-identifiers"),
);
const deliveryRuntimeLoader = createLazyImportLoader<DeliveryRuntime>(
  () => import("./command/delivery.runtime.js"),
);
const sessionStoreRuntimeLoader = createLazyImportLoader<SessionStoreRuntime>(
  () => import("./command/session-store.runtime.js"),
);
const cliCompactionRuntimeLoader = createLazyImportLoader<CliCompactionRuntime>(
  () => import("./command/cli-compaction.js"),
);
const transcriptResolveRuntimeLoader = createLazyImportLoader<TranscriptResolveRuntime>(
  () => import("../config/sessions/transcript-resolve.runtime.js"),
);
const cliDepsRuntimeLoader = createLazyImportLoader<CliDepsRuntime>(() => import("../cli/deps.js"));
const execDefaultsRuntimeLoader = createLazyImportLoader<ExecDefaultsRuntime>(
  () => import("./exec-defaults.js"),
);
const skillsRuntimeLoader = createLazyImportLoader<SkillsRuntime>(async () => {
  const [remote, sessionSnapshot] = await Promise.all([
    import("../skills/runtime/remote.js"),
    import("../skills/runtime/session-snapshot.js"),
  ]);
  return {
    getRemoteSkillEligibility: remote.getRemoteSkillEligibility,
    resolveReusableWorkspaceSkillSnapshot: sessionSnapshot.resolveReusableWorkspaceSkillSnapshot,
  };
});

function loadAttemptExecutionRuntime(): Promise<AttemptExecutionRuntime> {
  return attemptExecutionRuntimeLoader.load();
}

function loadAcpManagerRuntime(): Promise<AcpManagerRuntime> {
  return acpManagerRuntimeLoader.load();
}

function loadAcpPolicyRuntime(): Promise<AcpPolicyRuntime> {
  return acpPolicyRuntimeLoader.load();
}

function loadAcpRuntimeErrorsRuntime(): Promise<AcpRuntimeErrorsRuntime> {
  return acpRuntimeErrorsRuntimeLoader.load();
}

function loadAcpSessionIdentifiersRuntime(): Promise<AcpSessionIdentifiersRuntime> {
  return acpSessionIdentifiersRuntimeLoader.load();
}

function loadDeliveryRuntime(): Promise<DeliveryRuntime> {
  return deliveryRuntimeLoader.load();
}

function loadSessionStoreRuntime(): Promise<SessionStoreRuntime> {
  return sessionStoreRuntimeLoader.load();
}

function loadCliCompactionRuntime(): Promise<CliCompactionRuntime> {
  return cliCompactionRuntimeLoader.load();
}

function loadTranscriptResolveRuntime(): Promise<TranscriptResolveRuntime> {
  return transcriptResolveRuntimeLoader.load();
}

function loadCliDepsRuntime(): Promise<CliDepsRuntime> {
  return cliDepsRuntimeLoader.load();
}

function loadExecDefaultsRuntime(): Promise<ExecDefaultsRuntime> {
  return execDefaultsRuntimeLoader.load();
}

function loadSkillsRuntime(): Promise<SkillsRuntime> {
  return skillsRuntimeLoader.load();
}

async function resolveAgentCommandDeps(deps: CliDeps | undefined): Promise<CliDeps> {
  if (deps) {
    return deps;
  }
  const { createDefaultDeps } = await loadCliDepsRuntime();
  return createDefaultDeps();
}

type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  initialEntry: SessionEntry;
  entry: SessionEntry;
};

const OVERRIDE_VALUE_MAX_LENGTH = 256;

async function persistSessionEntry(
  params: PersistSessionEntryParams & {
    shouldPersist?: (entry: SessionEntry | undefined) => boolean;
  },
): Promise<SessionEntry | undefined> {
  return await persistSessionEntryBase(params);
}

function clearPendingFinalDeliveryFields(entry: SessionEntry, updatedAt: number): SessionEntry {
  return {
    ...entry,
    pendingFinalDelivery: undefined,
    pendingFinalDeliveryText: undefined,
    pendingFinalDeliveryCreatedAt: undefined,
    pendingFinalDeliveryLastAttemptAt: undefined,
    pendingFinalDeliveryAttemptCount: undefined,
    pendingFinalDeliveryLastError: undefined,
    pendingFinalDeliveryContext: undefined,
    pendingFinalDeliveryIntentId: undefined,
    updatedAt,
  };
}

async function resolveCurrentRunDeliveryContext(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
}): Promise<DeliveryContext | undefined> {
  const { cfg, opts, sessionEntry } = params;
  if (opts.deliver !== true) {
    return undefined;
  }
  // Restart recovery only needs durable route fields; final delivery resolves plugin-specific routes.
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: true,
    turnSourceChannel: opts.runContext?.messageChannel ?? opts.messageChannel,
    turnSourceTo: opts.runContext?.currentChannelId ?? opts.to,
    turnSourceAccountId: opts.runContext?.accountId ?? opts.accountId,
    turnSourceThreadId: opts.runContext?.currentThreadTs ?? opts.threadId,
  });
  const explicitChannelHint = normalizeOptionalString(opts.replyChannel ?? opts.channel);
  const explicitThreadId =
    opts.threadId != null && opts.threadId !== "" ? opts.threadId : undefined;
  let effectivePlan = deliveryPlan;
  if (deliveryPlan.resolvedChannel === INTERNAL_MESSAGE_CHANNEL && !explicitChannelHint) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      effectivePlan = {
        ...deliveryPlan,
        resolvedChannel: selection.channel,
        deliveryTargetMode: deliveryPlan.deliveryTargetMode ?? "implicit",
      };
    } catch {
      return undefined;
    }
  }
  if (!isDeliverableMessageChannel(effectivePlan.resolvedChannel)) {
    return undefined;
  }
  const targetMode =
    opts.deliveryTargetMode ??
    effectivePlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedTo =
    effectivePlan.resolvedTo ??
    resolveAgentOutboundTarget({
      cfg,
      plan: effectivePlan,
      targetMode,
      validateExplicitTarget: false,
    }).resolvedTo;
  if (!resolvedTo) {
    return undefined;
  }
  const threadId =
    targetMode === "explicit"
      ? (explicitThreadId ??
        (effectivePlan.baseDelivery.threadIdSource === "explicit"
          ? effectivePlan.resolvedThreadId
          : undefined))
      : effectivePlan.resolvedThreadId;
  return normalizeDeliveryContext({
    channel: effectivePlan.resolvedChannel,
    to: resolvedTo,
    accountId: effectivePlan.resolvedAccountId,
    threadId,
  });
}

function shouldPersistCurrentRunSessionCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
): boolean {
  return (
    current !== undefined && current.sessionId === sessionId && current.abortedLastRun !== true
  );
}

function shouldPersistRestartRecoveryContextClaim(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
  allowCreate: boolean,
): boolean {
  if (!current) {
    return allowCreate;
  }
  if (!shouldPersistCurrentRunSessionCleanup(current, sessionId)) {
    return false;
  }
  return (
    current.restartRecoveryDeliveryRunId === undefined ||
    current.restartRecoveryDeliveryRunId === runId
  );
}

function shouldPersistRestartRecoveryCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
): boolean {
  return (
    shouldPersistCurrentRunSessionCleanup(current, sessionId) &&
    current?.restartRecoveryDeliveryRunId === runId
  );
}

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  if (containsControlCharacters(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  return trimmed;
}

function createAgentCommandSessionWorkingCopy(params: {
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}): {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
} {
  const result: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
  } = {};
  if (params.sessionEntry) {
    result.sessionEntry = { ...params.sessionEntry };
  }
  if (params.sessionStore || params.sessionKey) {
    result.sessionStore = {};
  }
  if (params.sessionKey && result.sessionEntry && result.sessionStore) {
    result.sessionStore[params.sessionKey] = result.sessionEntry;
  }
  return result;
}

function resolveExplicitAgentCommandSessionKey(params: {
  rawExplicitSessionKey?: string;
  agentIdOverride?: string;
  shouldScopeDefaultAgentKey?: boolean;
  cfg: OpenClawConfig;
}): string | undefined {
  if (
    isUnscopedSessionKeySentinel(params.rawExplicitSessionKey) &&
    !params.agentIdOverride &&
    !params.shouldScopeDefaultAgentKey
  ) {
    return params.rawExplicitSessionKey;
  }
  return scopeLegacySessionKeyToAgent({
    agentId:
      params.agentIdOverride ??
      (params.shouldScopeDefaultAgentKey ? resolveDefaultAgentId(params.cfg) : undefined),
    sessionKey: params.rawExplicitSessionKey,
    mainKey: params.cfg.session?.mainKey,
  });
}

async function prepareAgentCommandExecution(opts: AgentCommandOpts, runtime: RuntimeEnv) {
  const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  const rawExplicitSessionKey = opts.sessionKey?.trim();
  const requestedSessionId = opts.sessionId?.trim() || undefined;
  const rawTo = opts.to?.trim();
  const toSessionKey =
    !rawExplicitSessionKey && !requestedSessionId && classifySessionKeyShape(rawTo) === "agent"
      ? rawTo
      : undefined;
  const recipientChannel = resolveMessageChannel(opts.channel);
  const shouldResolveExplicitRecipientSession = Boolean(
    !rawExplicitSessionKey &&
    !requestedSessionId &&
    !toSessionKey &&
    opts.agentId?.trim() &&
    recipientChannel &&
    isDeliverableMessageChannel(recipientChannel) &&
    rawTo,
  );
  if (!opts.to && !requestedSessionId && !rawExplicitSessionKey && !opts.agentId) {
    throw new Error(
      "Pass --to <E.164>, --session-key, --session-id, or --agent to choose a session",
    );
  }

  const { cfg } = await resolveAgentRuntimeConfig(runtime, {
    runtimeTargetsChannelSecrets: opts.deliver === true,
    runtimeChannelSecretScope:
      opts.deliver !== true && shouldResolveExplicitRecipientSession && recipientChannel
        ? { channel: recipientChannel, accountId: opts.accountId }
        : undefined,
  });
  const normalizedSpawned = normalizeSpawnedRunMetadata({
    spawnedBy: opts.spawnedBy,
    groupId: opts.groupId,
    groupChannel: opts.groupChannel,
    groupSpace: opts.groupSpace,
    workspaceDir: opts.workspaceDir,
  });
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  if (agentIdOverride) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const shouldScopeDefaultAgentKey = Boolean(
    rawExplicitSessionKey &&
    !agentIdOverride &&
    classifySessionKeyShape(rawExplicitSessionKey) === "legacy_or_alias" &&
    !isUnscopedSessionKeySentinel(rawExplicitSessionKey),
  );
  const explicitSessionKey =
    toSessionKey ??
    resolveExplicitAgentCommandSessionKey({
      rawExplicitSessionKey,
      agentIdOverride,
      shouldScopeDefaultAgentKey,
      cfg,
    });
  if (explicitSessionKey && classifySessionKeyShape(explicitSessionKey) === "malformed_agent") {
    throw new Error(
      `Invalid --session-key "${explicitSessionKey}". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.`,
    );
  }
  if (
    agentIdOverride &&
    explicitSessionKey &&
    classifySessionKeyShape(explicitSessionKey) === "agent"
  ) {
    const sessionAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  const agentCfg = cfg.agents?.defaults;

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const laneRaw = normalizeOptionalString(opts.lane) ?? "";
  const subagentLane: string = AGENT_LANE_SUBAGENT;
  const isSubagentLane = laneRaw === subagentLane;
  const hasExplicitTimeoutOption = opts.timeout !== undefined;
  const timeoutSecondsRaw = hasExplicitTimeoutOption
    ? (parseStrictNonNegativeInteger(opts.timeout) ?? Number.NaN)
    : isSubagentLane
      ? 0
      : undefined;
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)
  ) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: timeoutSecondsRaw,
  });
  const runTimeoutOverrideMs = hasExplicitTimeoutOption ? timeoutMs : undefined;

  const selectedCommandOpts = toSessionKey
    ? { ...opts, to: undefined, sessionKey: explicitSessionKey }
    : opts;
  const explicitRecipientSession =
    shouldResolveExplicitRecipientSession && agentIdOverride && recipientChannel && rawTo
      ? await resolveAgentExplicitRecipientSession({
          cfg,
          agentId: agentIdOverride,
          channel: recipientChannel,
          to: rawTo,
          accountId: selectedCommandOpts.accountId,
          threadId: selectedCommandOpts.threadId,
        })
      : undefined;
  if (explicitRecipientSession?.error) {
    throw explicitRecipientSession.error;
  }
  const commandOpts = explicitRecipientSession?.sessionKey
    ? {
        ...selectedCommandOpts,
        channel: explicitRecipientSession.channel,
        to: explicitRecipientSession.to,
        accountId: explicitRecipientSession.accountId,
        threadId: explicitRecipientSession.threadId,
      }
    : selectedCommandOpts;
  const sessionResolution = resolveSession({
    cfg,
    to: commandOpts.to,
    sessionId: commandOpts.sessionId,
    sessionKey: explicitSessionKey ?? explicitRecipientSession?.sessionKey,
    agentId: agentIdOverride,
    clone: false,
  });

  const { sessionId, sessionKey, storePath, isNewSession, persistedThinking, persistedVerbose } =
    sessionResolution;
  const { sessionEntry: sessionEntryRaw, sessionStore } = createAgentCommandSessionWorkingCopy({
    sessionKey,
    sessionEntry: sessionResolution.sessionEntry,
    sessionStore: sessionResolution.sessionStore,
  });
  const sessionAgentId =
    agentIdOverride ??
    resolveSessionAgentId({
      sessionKey: sessionKey ?? explicitSessionKey,
      config: cfg,
    });
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId: sessionAgentId,
    sessionKey,
  });
  // Internal callers (for example subagent spawns) may pin workspace inheritance.
  const workspaceDirRaw =
    normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const workspaceDir = resolveUserPath(workspaceDirRaw);
  const cwd =
    normalizeOptionalString(opts.cwd) ?? normalizeOptionalString(sessionEntryRaw?.spawnedCwd);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const pluginsEnabled = normalizePluginsConfig(cfg.plugins).enabled;
  const manifestMetadataSnapshot = pluginsEnabled
    ? loadManifestMetadataSnapshot({
        config: cfg,
        workspaceDir,
        env: process.env,
      })
    : undefined;
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot?.plugins ?? [],
  } satisfies ModelManifestNormalizationContext;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: pluginsEnabled,
    ...modelManifestContext,
  });
  const configuredThinkingCatalog = buildConfiguredModelCatalog({
    cfg,
    workspaceDir,
    ...modelManifestContext,
  });
  const configuredThinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider: configuredModel.provider,
    modelId: configuredModel.model,
    agentId: sessionAgentId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
  });
  const thinkingLevelsHint = formatThinkingLevels(
    configuredModel.provider,
    configuredModel.model,
    ", ",
    configuredThinkingCatalog.length > 0 ? configuredThinkingCatalog : undefined,
    configuredThinkingRuntime,
  );
  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
    skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
  });
  const runId = opts.runId?.trim() || sessionId;
  const { getAcpSessionManager } = await loadAcpManagerRuntime();
  const acpManager = getAcpSessionManager();
  const acpResolution = sessionKey
    ? acpManager.resolveSession({
        cfg,
        sessionKey,
      })
    : null;
  const body =
    !isRawModelRun && acpResolution?.kind === "ready"
      ? resolveAcpPromptBody(message, opts.internalEvents)
      : prependInternalEventContext(message, opts.internalEvents);
  const transcriptBody =
    opts.transcriptMessage ?? resolveInternalEventTranscriptBody(message, opts.internalEvents);

  return {
    opts: commandOpts,
    body,
    transcriptBody,
    cfg,
    configuredThinkingCatalog,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    runTimeoutOverrideMs,
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    cwd: cwd ? resolveUserPath(cwd) : undefined,
    agentDir,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
    runId,
    isSubagentLane,
    acpManager,
    acpResolution,
  };
}

async function agentCommandInternal(
  initialOpts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  const isRawModelRun = initialOpts.modelRun === true || initialOpts.promptMode === "none";
  const suppressVisibleSessionEffects = initialOpts.sessionEffects === "internal";
  const preserveUserFacingSessionModelState =
    initialOpts.preserveUserFacingSessionModelState === true;
  const prepared = await prepareAgentCommandExecution(initialOpts, runtime);
  const lifecycleAbortController = new AbortController();
  const opts = {
    ...prepared.opts,
    abortSignal: prepared.opts.abortSignal
      ? AbortSignal.any([prepared.opts.abortSignal, lifecycleAbortController.signal])
      : lifecycleAbortController.signal,
  };
  const {
    body,
    transcriptBody,
    cfg,
    configuredThinkingCatalog,
    normalizedSpawned,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    timeoutMs,
    runTimeoutOverrideMs,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    cwd,
    agentDir,
    runId,
    isSubagentLane,
    acpManager,
    acpResolution,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
  } = prepared;
  let lifecycleGeneration = opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(runId);
  assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
  const effectiveCwd = cwd ? resolveUserPath(cwd) : workspaceDir;
  let sessionEntry = prepared.sessionEntry;
  let sessionReboundDuringRun = false;
  let trackedRestartRecoveryDeliveryContext = false;
  let currentRunDeliveryContext: DeliveryContext | undefined;
  const preparedSessionId = sessionEntry?.sessionId;
  const sessionStoreRuntime = storePath && sessionKey ? await loadSessionStoreRuntime() : undefined;
  const internalModelRunArtifacts =
    initialOpts.modelRun === true && suppressVisibleSessionEffects
      ? new Map<string, { sessionFile: string; sessionId: string }>()
      : undefined;
  const trackInternalModelRunArtifact = (
    sessionFile: string | undefined,
    artifactSessionId: string,
  ) => {
    if (!internalModelRunArtifacts || !isInternalSessionEffectsTranscriptPath(sessionFile)) {
      return;
    }
    internalModelRunArtifacts.set(`${artifactSessionId}\n${sessionFile}`, {
      sessionFile,
      sessionId: artifactSessionId,
    });
  };
  // Precompute the owned path so even a partially failed prepare can be cleaned.
  trackInternalModelRunArtifact(resolveInternalSessionEffectsTranscriptPath(runId), sessionId);

  // Reset marks its mutation before interrupting work. An aborted run must not
  // queue behind that mutation or reset would wait on the run holding the queue.
  const sessionWorkAdmission = await beginSessionWorkAdmission({
    scope: storePath ?? `agent:${sessionAgentId}`,
    identities: [sessionKey, sessionId],
    signal: opts.abortSignal,
    onInterrupt: () => lifecycleAbortController.abort(createAgentRunRestartAbortError()),
    assertAllowed: () => {
      const currentEntry =
        sessionStoreRuntime && storePath && sessionKey
          ? sessionStoreRuntime.loadSessionEntry({
              storePath,
              sessionKey,
              readConsistency: "latest",
            })
          : sessionEntry;
      if (!currentEntry && preparedSessionId) {
        throw new Error(`Session "${sessionKey ?? sessionId}" changed while starting work. Retry.`);
      }
      const matchesIntentionalRollover =
        isNewSession && currentEntry?.sessionId === preparedSessionId;
      if (currentEntry && currentEntry.sessionId !== sessionId && !matchesIntentionalRollover) {
        throw new Error(`Session "${sessionKey ?? sessionId}" changed while starting work. Retry.`);
      }
      const archivedSessionError = resolveSessionWorkStartError(
        sessionKey ?? sessionId,
        currentEntry,
      );
      if (archivedSessionError) {
        throw new Error(archivedSessionError);
      }
      sessionEntry = currentEntry;
      if (sessionStore && sessionKey) {
        if (currentEntry) {
          sessionStore[sessionKey] = currentEntry;
        } else {
          delete sessionStore[sessionKey];
        }
      }
    },
  });

  try {
    return await sessionWorkAdmission.run(async () => {
      if (opts.deliver === true) {
        const sendPolicy = resolveSendPolicy({
          cfg,
          entry: sessionEntry,
          sessionKey,
          channel: sessionEntry?.channel,
          chatType: sessionEntry?.chatType,
        });
        if (sendPolicy === "deny") {
          throw new Error("send blocked by session policy");
        }
      }

      if (!isRawModelRun && acpResolution?.kind === "stale") {
        throw acpResolution.error;
      }

      if (
        sessionStore &&
        sessionKey &&
        !suppressVisibleSessionEffects &&
        !isSubagentSessionKey(sessionKey)
      ) {
        const now = Date.now();
        const currentStoreEntry = sessionStore[sessionKey];
        const allowCreateRestartRecoveryEntry =
          currentStoreEntry === undefined && sessionEntry === undefined;
        const initialEntry = currentStoreEntry ??
          sessionEntry ?? { sessionId, updatedAt: now, sessionStartedAt: now };
        const isSessionRollover = isNewSession && initialEntry.sessionId !== sessionId;
        const entry = isSessionRollover ? clearRotatedSessionMetadata(initialEntry) : initialEntry;
        currentRunDeliveryContext = await resolveCurrentRunDeliveryContext({
          cfg,
          opts,
          sessionEntry: entry,
        });
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        const next: SessionEntry = {
          ...entry,
          sessionId,
          updatedAt: now,
          sessionStartedAt: isSessionRollover ? now : entry.sessionStartedAt,
          lastInteractionAt: isSessionRollover ? now : entry.lastInteractionAt,
          restartRecoveryDeliveryContext: currentRunDeliveryContext,
          restartRecoveryDeliveryRunId: currentRunDeliveryContext ? runId : undefined,
        };
        const persisted = await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry,
          entry: next,
          shouldPersist: (current) =>
            isSessionRollover
              ? current?.sessionId === initialEntry.sessionId
              : shouldPersistRestartRecoveryContextClaim(
                  current,
                  sessionId,
                  runId,
                  allowCreateRestartRecoveryEntry,
                ),
        });
        sessionEntry = persisted ?? sessionEntry;
        trackedRestartRecoveryDeliveryContext =
          Boolean(persisted?.restartRecoveryDeliveryContext) &&
          persisted?.restartRecoveryDeliveryRunId === runId;
      }

      if (!isRawModelRun && acpResolution?.kind === "ready" && sessionKey) {
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
        const acpToolTracker = attemptExecutionRuntime.createAcpToolLifecycleTracker();
        const startedAt = Date.now();
        registerAgentRunContext(runId, {
          sessionKey,
          sessionId,
          agentId: sessionAgentId,
          lifecycleGeneration,
          ...(suppressVisibleSessionEffects ? { isControlUiVisible: false } : {}),
        });
        attemptExecutionRuntime.emitAcpLifecycleStart({
          runId,
          startedAt,
          agentId: sessionAgentId,
          lifecycleGeneration,
        });

        const visibleTextAccumulator = attemptExecutionRuntime.createAcpVisibleTextAccumulator();
        let stopReason: string | undefined;
        let resultStatus: "completed" | "cancelled" | undefined;
        let terminalOutcome: "blocked" | undefined;
        try {
          const {
            resolveAcpAgentPolicyError,
            resolveAcpDispatchPolicyError,
            resolveAcpExplicitTurnPolicyError,
          } = await loadAcpPolicyRuntime();
          const turnPolicyError =
            opts.acpTurnSource === "manual_spawn"
              ? resolveAcpExplicitTurnPolicyError(cfg)
              : resolveAcpDispatchPolicyError(cfg);
          if (turnPolicyError) {
            terminalOutcome = "blocked";
            throw turnPolicyError;
          }
          const acpAgent = normalizeAgentId(
            acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey),
          );
          const agentPolicyError = resolveAcpAgentPolicyError(cfg, acpAgent);
          if (agentPolicyError) {
            terminalOutcome = "blocked";
            throw agentPolicyError;
          }

          const acpImageAttachments = resolveInlineAgentImageAttachments(opts.images);
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
          await acpManager.runTurn({
            cfg,
            sessionKey,
            text: body,
            attachments: acpImageAttachments.length > 0 ? acpImageAttachments : undefined,
            mode: "prompt",
            requestId: runId,
            signal: opts.abortSignal,
            onLifecycle: (event) => {
              if (event.type === "prompt_submitted") {
                attemptExecutionRuntime.emitAcpPromptSubmitted({
                  runId,
                  sessionKey,
                  at: event.at,
                });
              }
            },
            onEvent: (event) => {
              if (event.type !== "text_delta") {
                attemptExecutionRuntime.emitAcpRuntimeEvent({
                  runId,
                  toolTracker: acpToolTracker,
                  sessionKey,
                  agentId: sessionAgentId,
                  abortSignal: opts.abortSignal,
                  event,
                });
              }
              if (event.type === "done") {
                stopReason = event.stopReason;
                resultStatus = event.status;
                return;
              }
              if (event.type !== "text_delta") {
                return;
              }
              if (event.stream && event.stream !== "output") {
                return;
              }
              if (!event.text) {
                return;
              }
              const visibleUpdate = visibleTextAccumulator.consume(event.text);
              if (!visibleUpdate) {
                return;
              }
              attemptExecutionRuntime.emitAcpAssistantDelta({
                runId,
                text: visibleUpdate.text,
                delta: visibleUpdate.delta,
              });
            },
          });
          if (isAgentRunRestartAbortReason(opts.abortSignal?.reason)) {
            throw opts.abortSignal?.reason;
          }
        } catch (error) {
          const { toAcpRuntimeError } = await loadAcpRuntimeErrorsRuntime();
          const acpError = toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP turn failed before completion.",
          });
          attemptExecutionRuntime.emitAcpLifecycleError({
            runId,
            toolTracker: acpToolTracker,
            error: acpError,
            sessionKey,
            agentId: sessionAgentId,
            lifecycleGeneration,
            abortSignal: opts.abortSignal,
            ...(terminalOutcome ? { terminalOutcome } : {}),
          });
          throw acpError;
        }

        const finalTextRaw = visibleTextAccumulator.finalizeRaw();
        const finalText = visibleTextAccumulator.finalize();
        try {
          const [{ resolveAcpSessionCwd }, { resolveSessionTranscriptFile }] = await Promise.all([
            loadAcpSessionIdentifiersRuntime(),
            loadTranscriptResolveRuntime(),
          ]);
          const internalSource = suppressVisibleSessionEffects
            ? await resolveSessionTranscriptFile({
                sessionId,
                sessionKey,
                sessionEntry,
                agentId: sessionAgentId,
                threadId: opts.threadId,
              })
            : undefined;
          const internalSessionFile = suppressVisibleSessionEffects
            ? await prepareInternalSessionEffectsTranscript({
                sessionFile: internalSource?.sessionFile,
                runId,
              })
            : undefined;
          const transcriptResult = await attemptExecutionRuntime.persistAcpTurnTranscript({
            body,
            transcriptBody,
            ...(opts.suppressPromptPersistence !== true && opts.transcriptMedia?.length
              ? {
                  userInput: {
                    text: transcriptBody,
                    media: opts.transcriptMedia,
                    mediaOnlyText: "[User sent media without caption]",
                  },
                }
              : {}),
            finalText: finalTextRaw,
            sessionId,
            sessionKey,
            sessionFile: internalSessionFile,
            sessionEntry,
            sessionStore: suppressVisibleSessionEffects ? undefined : sessionStore,
            storePath: suppressVisibleSessionEffects ? undefined : storePath,
            sessionAgentId,
            threadId: opts.threadId,
            sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
            config: cfg,
          });
          sessionEntry = transcriptResult.sessionEntry;
          if (internalSessionFile) {
            sessionEntry = prepared.sessionEntry;
          }
        } catch (error) {
          log.warn(
            `ACP transcript persistence failed for ${sessionKey}: ${formatErrorMessage(error)}`,
          );
        }
        const restartAbortReason = opts.abortSignal?.reason;
        if (isAgentRunRestartAbortReason(restartAbortReason)) {
          attemptExecutionRuntime.emitAcpLifecycleError({
            runId,
            toolTracker: acpToolTracker,
            error: restartAbortReason,
            sessionKey,
            agentId: sessionAgentId,
            lifecycleGeneration,
            abortSignal: opts.abortSignal,
          });
          throw restartAbortReason;
        }
        attemptExecutionRuntime.emitAcpLifecycleEnd({
          runId,
          toolTracker: acpToolTracker,
          agentId: sessionAgentId,
          lifecycleGeneration,
          abortSignal: opts.abortSignal,
          stopReason,
          resultStatus,
        });

        const result = applyAgentRunAbortMetadata(
          attemptExecutionRuntime.buildAcpResult({
            payloadText: finalText,
            startedAt,
            stopReason,
            resultStatus,
            abortSignal: opts.abortSignal,
          }),
          opts.abortSignal,
        );
        const payloads = result.payloads;
        const { deliverAgentCommandResult } = await loadDeliveryRuntime();

        return await deliverAgentCommandResult({
          cfg,
          deps: resolvedDeps,
          runtime,
          opts,
          outboundSession,
          sessionEntry,
          result,
          payloads,
          assertDeliveryCurrent: () =>
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
        });
      }

      const requestedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
      const resolvedVerboseLevel =
        verboseOverride ??
        persistedVerbose ??
        (agentCfg?.verboseDefault as VerboseLevel | undefined);

      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      if (sessionKey || suppressVisibleSessionEffects) {
        registerAgentRunContext(runId, {
          ...(sessionKey ? { sessionKey, sessionId } : {}),
          agentId: sessionAgentId,
          lifecycleGeneration,
          verboseLevel: resolvedVerboseLevel,
          isControlUiVisible: !suppressVisibleSessionEffects,
        });
      }

      const skillFilter = resolveEffectiveAgentSkillFilter(cfg, sessionAgentId);
      const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
      const [
        { getRemoteSkillEligibility, resolveReusableWorkspaceSkillSnapshot },
        { canExecRequestNode },
      ] = await Promise.all([loadSkillsRuntime(), loadExecDefaultsRuntime()]);
      const skillSnapshotState = resolveReusableWorkspaceSkillSnapshot({
        workspaceDir,
        config: cfg,
        agentId: sessionAgentId,
        existingSnapshot: isNewSession ? undefined : currentSkillsSnapshot,
        skillFilter,
        eligibility: {
          remote: getRemoteSkillEligibility({
            advertiseExecNode: canExecRequestNode({
              cfg,
              sessionEntry,
              sessionKey,
              agentId: sessionAgentId,
            }),
          }),
        },
        watch: false,
      });
      const needsSkillsSnapshot =
        isNewSession || !currentSkillsSnapshot || skillSnapshotState.shouldRefresh;
      const skillsSnapshot = skillSnapshotState.snapshot;

      if (
        skillsSnapshot &&
        sessionStore &&
        sessionKey &&
        needsSkillsSnapshot &&
        !suppressVisibleSessionEffects
      ) {
        const now = Date.now();
        const current = sessionEntry ?? {
          sessionId,
          updatedAt: now,
          sessionStartedAt: now,
        };
        const next: SessionEntry = {
          ...current,
          sessionId,
          updatedAt: now,
          sessionStartedAt: current.sessionStartedAt ?? now,
          skillsSnapshot,
        };
        const persisted = await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry: current,
          entry: next,
        });
        sessionEntry = persisted ?? sessionEntry;
      }

      // Persist non-model-dependent command state before provider/model resolution.
      // Thinking is written only after the selected runtime validates it below.
      const hasInitialSessionOverrides = Boolean(verboseOverride);
      const shouldPersistInitialSessionTouch =
        opts.skipInitialSessionTouch !== true || hasInitialSessionOverrides;
      if (
        sessionStore &&
        sessionKey &&
        !suppressVisibleSessionEffects &&
        shouldPersistInitialSessionTouch
      ) {
        const now = Date.now();
        const entry = sessionStore[sessionKey] ??
          sessionEntry ?? { sessionId, updatedAt: now, sessionStartedAt: now };
        const next: SessionEntry = {
          ...entry,
          sessionId,
          updatedAt: now,
          sessionStartedAt: entry.sessionStartedAt ?? now,
          lastInteractionAt: now,
        };
        applyVerboseOverride(next, verboseOverride);
        const persisted = await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry: entry,
          entry: next,
        });
        sessionEntry = persisted ?? sessionEntry;
      }

      const configuredDefaultRef = resolveDefaultModelForAgent({
        cfg,
        agentId: sessionAgentId,
        allowPluginNormalization: pluginsEnabled,
        ...modelManifestContext,
      });
      const runContext = resolveAgentRunContext(opts);
      const { provider: defaultProvider, model: defaultModel } =
        normalizeAgentCommandDefaultModelRef(
          cfg,
          configuredDefaultRef.provider,
          configuredDefaultRef.model,
          modelManifestContext,
        );
      let provider = defaultProvider;
      let model = defaultModel;
      const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
      const hasStoredOverride = Boolean(
        sessionEntry?.modelOverride || sessionEntry?.providerOverride,
      );
      let storedModelOverrideSource = hasStoredOverride
        ? sessionEntry?.modelOverrideSource
        : undefined;
      let hasStoredAutoFallbackProvenance =
        hasStoredOverride && hasSessionAutoModelFallbackProvenance(sessionEntry);
      let hasLegacyAutoFallbackOverrideWithoutOrigin =
        hasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
      const explicitProviderOverride =
        typeof opts.provider === "string"
          ? normalizeExplicitOverrideInput(opts.provider, "provider")
          : undefined;
      const explicitModelOverride =
        typeof opts.model === "string"
          ? normalizeExplicitOverrideInput(opts.model, "model")
          : undefined;
      const hasExplicitRunOverride = Boolean(explicitProviderOverride || explicitModelOverride);
      if (hasExplicitRunOverride && opts.allowModelOverride !== true) {
        throw new Error("Model override is not authorized for this caller.");
      }
      const needsModelCatalog = Boolean(hasAllowlist);
      let allowedModelCatalog: ReturnType<typeof loadManifestModelCatalog> = [];
      let modelCatalog: ReturnType<typeof loadManifestModelCatalog> | null = null;
      let visibilityPolicy: ModelVisibilityPolicy = createModelVisibilityPolicy({
        cfg,
        catalog: [],
        defaultProvider,
        defaultModel,
        allowManifestNormalization: true,
        allowPluginNormalization: pluginsEnabled,
        ...modelManifestContext,
      });

      if (needsModelCatalog) {
        modelCatalog = pluginsEnabled
          ? loadManifestModelCatalog({ config: cfg, workspaceDir })
          : [];
        visibilityPolicy = createModelVisibilityPolicy({
          cfg,
          catalog: modelCatalog,
          defaultProvider,
          defaultModel,
          agentId: sessionAgentId,
          allowManifestNormalization: true,
          allowPluginNormalization: pluginsEnabled,
          ...modelManifestContext,
        });
        allowedModelCatalog = visibilityPolicy.allowedCatalog;
      }

      if (
        sessionEntry &&
        sessionStore &&
        sessionKey &&
        hasStoredOverride &&
        !suppressVisibleSessionEffects
      ) {
        const initialEntry = sessionEntry;
        const entry = { ...sessionEntry };
        let entryUpdated = false;
        if (hasLegacyAutoFallbackOverrideWithoutOrigin) {
          const { updated } = applyModelOverrideToSessionEntry({
            entry,
            selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
          });
          if (updated) {
            storedModelOverrideSource = undefined;
            entryUpdated = true;
          }
        }
        const repaired = repairProviderWrappedModelOverride({
          entry,
          defaultProvider,
          defaultModel,
        });
        if (repaired.updated) {
          entryUpdated = true;
        }
        const overrideProvider = entry.providerOverride?.trim() || defaultProvider;
        const overrideModel = entry.modelOverride?.trim();
        if (overrideModel) {
          const normalizedOverride = normalizeAgentCommandModelRef(
            cfg,
            overrideProvider,
            overrideModel,
            modelManifestContext,
          );
          const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
          if (!visibilityPolicy.allowsKey(key)) {
            const { updated } = applyModelOverrideToSessionEntry({
              entry,
              selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
            });
            if (updated) {
              entryUpdated = true;
            }
          }
        }
        if (entryUpdated) {
          const persisted = await persistSessionEntry({
            sessionStore,
            sessionKey,
            storePath,
            initialEntry,
            entry,
          });
          sessionEntry = persisted ?? sessionEntry;
          const adoptedHasStoredOverride = Boolean(
            sessionEntry.modelOverride || sessionEntry.providerOverride,
          );
          storedModelOverrideSource = adoptedHasStoredOverride
            ? sessionEntry.modelOverrideSource
            : undefined;
          hasStoredAutoFallbackProvenance =
            adoptedHasStoredOverride && hasSessionAutoModelFallbackProvenance(sessionEntry);
          hasLegacyAutoFallbackOverrideWithoutOrigin =
            adoptedHasStoredOverride && hasLegacyAutoFallbackWithoutOrigin(sessionEntry);
        }
      }

      const storedProviderOverride = hasLegacyAutoFallbackOverrideWithoutOrigin
        ? undefined
        : sessionEntry?.providerOverride?.trim();
      let storedModelOverride = hasLegacyAutoFallbackOverrideWithoutOrigin
        ? undefined
        : sessionEntry?.modelOverride?.trim();
      const currentRunModelChannel = [
        runContext.messageChannel,
        opts.replyChannel,
        opts.channel,
      ].find((channel): channel is string =>
        Boolean(channel && isDeliverableMessageChannel(channel)),
      );
      const channelOverrideGroupId = currentRunModelChannel
        ? (runContext.groupId ?? sessionEntry?.groupId ?? runContext.currentChannelId)
        : (sessionEntry?.groupId ?? runContext.groupId ?? runContext.currentChannelId);
      const channelModelOverride =
        cfg.channels?.modelByChannel && !hasExplicitRunOverride
          ? resolveChannelModelOverride({
              cfg,
              channel:
                currentRunModelChannel ??
                sessionEntry?.channel ??
                sessionEntry?.lastChannel ??
                sessionEntry?.origin?.provider,
              groupId: channelOverrideGroupId,
              groupChatType: sessionEntry?.chatType ?? sessionEntry?.origin?.chatType,
              groupChannel: runContext.groupChannel ?? sessionEntry?.groupChannel,
              groupSubject: sessionEntry?.subject,
              parentSessionKey: sessionEntry?.parentSessionKey ?? sessionKey,
              directUserIds: [
                sessionEntry?.origin?.nativeDirectUserId,
                sessionEntry?.origin?.from,
                sessionEntry?.origin?.to,
              ],
            })
          : null;
      const normalizedChannelOverride = channelModelOverride
        ? parseAgentCommandModelRef(
            cfg,
            channelModelOverride.model,
            defaultProvider,
            modelManifestContext,
          )
        : null;
      const primaryProvider = normalizedChannelOverride?.provider ?? defaultProvider;
      const primaryModel = normalizedChannelOverride?.model ?? defaultModel;
      const hasEffectiveStoredOverride = Boolean(storedProviderOverride || storedModelOverride);
      if (normalizedChannelOverride && !hasEffectiveStoredOverride) {
        provider = normalizedChannelOverride.provider;
        model = normalizedChannelOverride.model;
      }
      if (storedModelOverride) {
        const candidateProvider = storedProviderOverride || defaultProvider;
        const normalizedStored = normalizeAgentCommandModelRef(
          cfg,
          candidateProvider,
          storedModelOverride,
          modelManifestContext,
        );
        const key = modelKey(normalizedStored.provider, normalizedStored.model);
        if (visibilityPolicy.allowsKey(key)) {
          provider = normalizedStored.provider;
          model = normalizedStored.model;
        }
      }
      const autoFallbackPrimaryProbe = !hasExplicitRunOverride
        ? resolveAutoFallbackPrimaryProbe({
            entry: sessionEntry,
            sessionKey,
            primaryProvider,
            primaryModel,
          })
        : undefined;
      let autoFallbackPrimaryProbeSessionEntry: SessionEntry | undefined;
      if (autoFallbackPrimaryProbe && sessionEntry) {
        provider = autoFallbackPrimaryProbe.provider;
        model = autoFallbackPrimaryProbe.model;
        autoFallbackPrimaryProbeSessionEntry = { ...sessionEntry };
        clearAutoFallbackPrimaryProbeSelection(autoFallbackPrimaryProbeSessionEntry);
      }
      let providerForAuthProfileValidation = provider;
      if (hasExplicitRunOverride) {
        const explicitRef = explicitModelOverride
          ? explicitProviderOverride
            ? normalizeAgentCommandModelRef(
                cfg,
                explicitProviderOverride,
                explicitModelOverride,
                modelManifestContext,
              )
            : parseAgentCommandModelRef(cfg, explicitModelOverride, provider, modelManifestContext)
          : explicitProviderOverride
            ? normalizeAgentCommandModelRef(
                cfg,
                explicitProviderOverride,
                model,
                modelManifestContext,
              )
            : null;
        if (!explicitRef) {
          throw new Error("Invalid model override.");
        }
        const explicitKey = modelKey(explicitRef.provider, explicitRef.model);
        if (!visibilityPolicy.allowsKey(explicitKey)) {
          throw new Error(
            `Model override "${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}" is not allowed for agent "${sessionAgentId}".`,
          );
        }
        provider = explicitRef.provider;
        model = explicitRef.model;
      }
      const allowedInitialSelection = visibilityPolicy.resolveSelection({
        provider,
        model,
      });
      if (!allowedInitialSelection) {
        throw new Error(
          `Configured default model "${modelKey(provider, model)}" is not allowed by agents.defaults.models, and no allowed model is available.`,
        );
      }
      provider = allowedInitialSelection.provider;
      model = allowedInitialSelection.model;
      providerForAuthProfileValidation = provider;

      await ensureSelectedAgentHarnessPlugin({
        config: cfg,
        provider,
        modelId: model,
        agentId: sessionAgentId,
        sessionKey,
        agentHarnessRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
          provider,
          entry: sessionEntry,
          cfg,
        }),
        workspaceDir,
      });

      let sessionEntryForAttempt = autoFallbackPrimaryProbeSessionEntry ?? sessionEntry;
      if (sessionEntryForAttempt) {
        const authProfileId = sessionEntryForAttempt.authProfileOverride;
        if (authProfileId) {
          const entry = sessionEntryForAttempt;
          const store = ensureAuthProfileStore();
          const profile = store.profiles[authProfileId];
          const validationHarnessPolicy = resolveAvailableAgentHarnessPolicy({
            provider: providerForAuthProfileValidation,
            modelId: model,
            config: cfg,
            agentId: sessionAgentId,
            sessionKey,
          });
          const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
            provider: providerForAuthProfileValidation,
            harnessRuntime: validationHarnessPolicy.runtime,
            config: cfg,
          }).map((candidateProvider) =>
            pluginsEnabled
              ? resolveProviderIdForAuth(candidateProvider, {
                  config: cfg,
                  workspaceDir,
                  ...(manifestMetadataSnapshot
                    ? { metadataSnapshot: manifestMetadataSnapshot }
                    : {}),
                })
              : candidateProvider,
          );
          const authAliasLookupParams = pluginsEnabled
            ? {
                config: cfg,
                workspaceDir,
                ...(manifestMetadataSnapshot ? { metadataSnapshot: manifestMetadataSnapshot } : {}),
              }
            : {
                config: cfg,
                workspaceDir,
                metadataSnapshot: { plugins: [] },
              };
          const profileMatchesRuntime =
            profile &&
            acceptedAuthProviders.some((candidateProvider) =>
              isStoredCredentialCompatibleWithAuthProvider({
                cfg,
                authAliasLookupParams,
                provider: candidateProvider,
                credential: profile,
              }),
            );
          if (!profileMatchesRuntime) {
            if (hasExplicitRunOverride || autoFallbackPrimaryProbe) {
              sessionEntryForAttempt = {
                ...entry,
                authProfileOverride: undefined,
                authProfileOverrideSource: undefined,
                authProfileOverrideCompactionCount: undefined,
              };
            } else if (sessionStore && sessionKey && !suppressVisibleSessionEffects) {
              await clearSessionAuthProfileOverride({
                sessionEntry: entry,
                sessionStore,
                sessionKey,
                storePath,
              });
            }
          }
        }
      }

      const catalogForThinking =
        allowedModelCatalog.length > 0
          ? allowedModelCatalog
          : modelCatalog && modelCatalog.length > 0
            ? modelCatalog
            : configuredThinkingCatalog;
      const thinkingCatalog = catalogForThinking.length > 0 ? catalogForThinking : undefined;
      const thinkingRuntime = resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId: sessionAgentId,
        sessionKey,
        sessionEntry: sessionEntryForAttempt,
      });
      const configuredThinkLevel = normalizeThinkLevel(
        resolveAgentConfig(cfg, sessionAgentId)?.thinkingDefault,
      );
      // User/session/config choices remain stable across candidates. A model's
      // own default is resolved again for every fallback or live switch.
      const immutableThinkLevel = requestedThinkLevel ?? configuredThinkLevel;
      const primaryThinkLevel =
        immutableThinkLevel ??
        resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog: thinkingCatalog,
          agentRuntime: thinkingRuntime,
        });
      let effectiveTurnThinkLevel = primaryThinkLevel;
      if (
        !isThinkingLevelSupported({
          provider,
          model,
          level: primaryThinkLevel,
          catalog: thinkingCatalog,
          agentRuntime: thinkingRuntime,
        })
      ) {
        const explicitThink = Boolean(thinkOnce || thinkOverride);
        const isSubagentSpawnRun = isSubagentLane && isSubagentSessionKey(sessionKey);
        // Spawn-lane subagents are fire-and-forget; the orchestrator already got
        // an "accepted" ack, so throwing here strands the run and half-fails fan-outs.
        // Clamp like the embedded runner; interactive --thinking keeps the throw.
        if (explicitThink && !isSubagentSpawnRun) {
          throw new Error(
            `Thinking level "${primaryThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog, thinkingRuntime)}.`,
          );
        }
        // Candidate resolution below owns the turn-local clamp. Keep the
        // requested value immutable so a later fallback can restore it.
      }
      if (thinkOverride && sessionStore && sessionKey && !suppressVisibleSessionEffects) {
        const now = Date.now();
        const entry = sessionStore[sessionKey] ??
          sessionEntry ?? { sessionId, updatedAt: now, sessionStartedAt: now };
        const next: SessionEntry = {
          ...entry,
          sessionId,
          updatedAt: now,
          sessionStartedAt: entry.sessionStartedAt ?? now,
          lastInteractionAt: now,
          thinkingLevel: thinkOverride,
        };
        const persisted = await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry: entry,
          entry: next,
        });
        sessionEntry = persisted ?? sessionEntry;
        sessionEntryForAttempt = {
          ...(sessionEntryForAttempt ?? next),
          thinkingLevel: thinkOverride,
        };
      }
      const { resolveSessionTranscriptFile } = await loadTranscriptResolveRuntime();
      let sessionFile: string | undefined;
      if (sessionStore && sessionKey) {
        const resolvedSessionFile = await resolveSessionTranscriptFile({
          sessionId,
          sessionKey,
          sessionStore: suppressVisibleSessionEffects ? undefined : sessionStore,
          storePath: suppressVisibleSessionEffects ? undefined : storePath,
          sessionEntry,
          agentId: sessionAgentId,
          threadId: opts.threadId,
        });
        sessionFile = resolvedSessionFile.sessionFile;
        sessionEntry = resolvedSessionFile.sessionEntry;
      }
      if (!sessionFile) {
        const resolvedSessionFile = await resolveSessionTranscriptFile({
          sessionId,
          sessionKey: sessionKey ?? sessionId,
          storePath,
          sessionEntry,
          agentId: sessionAgentId,
          threadId: opts.threadId,
        });
        sessionFile = resolvedSessionFile.sessionFile;
        sessionEntry = resolvedSessionFile.sessionEntry;
      }
      const attemptSessionFile = suppressVisibleSessionEffects
        ? await prepareInternalSessionEffectsTranscript({ sessionFile, runId })
        : sessionFile;
      trackInternalModelRunArtifact(attemptSessionFile, sessionId);

      const startedAt = Date.now();
      const attemptLifecycleState: AgentAttemptLifecycleState = {
        currentTurnUserMessagePersisted: false,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      };
      const attemptLifecycleCallbacks = createAgentAttemptLifecycleCallbacks(attemptLifecycleState);
      const transcriptMedia = opts.transcriptMedia ?? [];
      const hasTranscriptMedia = transcriptMedia.length > 0;
      const suppressUserTurnPersistence =
        opts.suppressPromptPersistence === true ||
        (opts.transcriptMessage === "" && !hasTranscriptMedia);
      const recorderTranscriptText = transcriptBody || undefined;
      const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
        ...(!suppressUserTurnPersistence && (recorderTranscriptText || hasTranscriptMedia)
          ? {
              input: {
                text: recorderTranscriptText,
                ...(hasTranscriptMedia
                  ? {
                      media: transcriptMedia,
                      mediaOnlyText: "[User sent media without caption]",
                    }
                  : {}),
              },
            }
          : {}),
        target: {
          transcriptPath: attemptSessionFile,
          sessionId,
          agentId: sessionAgentId,
          ...(sessionKey ? { sessionKey } : {}),
          cwd: cwd ?? workspaceDir,
          config: cfg,
        },
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        errorContext: "agent command user turn transcript",
      });
      if (suppressUserTurnPersistence) {
        userTurnTranscriptRecorder.markBlocked();
      }
      let lifecycleFinishingEmitted = false;
      const emitLifecycleFinishing = (runResult: AgentAttemptResult) => {
        if (
          attemptLifecycleState.lifecycleEnded ||
          attemptLifecycleState.lifecycleFinishing ||
          lifecycleFinishingEmitted
        ) {
          return;
        }
        lifecycleFinishingEmitted = true;
        attemptLifecycleState.lifecycleFinishing = true;
        emitAgentEvent({
          runId,
          lifecycleGeneration,
          stream: "lifecycle",
          data: {
            phase: "finishing",
            startedAt,
            endedAt: Date.now(),
            aborted: runResult.meta.aborted ?? false,
            stopReason: runResult.meta.stopReason,
            ...resolveAgentRunAbortLifecycleFields(opts.abortSignal),
          },
        });
      };
      const emitLifecycleEnd = (runResult: AgentAttemptResult) => {
        if (attemptLifecycleState.lifecycleEnded) {
          return;
        }
        attemptLifecycleState.lifecycleEnded = true;
        const stopReason = runResult.meta.stopReason;
        const logLevel = resolveAgentRunLifecycleEndLogLevel(runResult.meta);
        if (logLevel) {
          log[logLevel](`[agent] run ${runId} ended with stopReason=${stopReason}`);
        }
        emitAgentEvent({
          runId,
          lifecycleGeneration,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            aborted: runResult.meta.aborted ?? false,
            stopReason,
            ...resolveAgentRunAbortLifecycleFields(opts.abortSignal),
          },
        });
      };
      const resolveLifecycleResultError = (
        runResult: AgentAttemptResult,
        includeErrorPayload: boolean,
      ) =>
        attemptLifecycleState.lifecycleError ??
        (includeErrorPayload
          ? runResult.payloads?.find(
              (payload) => payload.isError === true && typeof payload.text === "string",
            )?.text
          : undefined) ??
        (runResult.meta.error ? "Agent run failed" : undefined);
      const emitLifecycleResultError = (
        runResult: AgentAttemptResult,
        fallbackExhausted: boolean,
      ) => {
        if (attemptLifecycleState.lifecycleEnded) {
          return;
        }
        attemptLifecycleState.lifecycleEnded = true;
        const error =
          resolveLifecycleResultError(runResult, fallbackExhausted) ??
          (fallbackExhausted ? "All model fallback candidates failed" : "Agent run failed");
        emitAgentEvent({
          runId,
          lifecycleGeneration,
          stream: "lifecycle",
          data: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error,
            ...(runResult.meta.stopReason ? { stopReason: runResult.meta.stopReason } : {}),
            ...(runResult.meta.livenessState
              ? { livenessState: runResult.meta.livenessState }
              : {}),
            ...(runResult.meta.timeoutPhase ? { timeoutPhase: runResult.meta.timeoutPhase } : {}),
            ...(typeof runResult.meta.providerStarted === "boolean"
              ? { providerStarted: runResult.meta.providerStarted }
              : {}),
            ...(typeof runResult.meta.aborted === "boolean"
              ? { aborted: runResult.meta.aborted }
              : {}),
            ...(runResult.meta.replayInvalid === true ? { replayInvalid: true } : {}),
            ...(runResult.meta.yielded === true ? { yielded: true } : {}),
            ...(fallbackExhausted ? { fallbackExhaustedFailure: true } : {}),
          },
        });
      };
      const emitLifecyclePostTurnError = (error: unknown) => {
        if (attemptLifecycleState.lifecycleEnded) {
          return;
        }
        attemptLifecycleState.lifecycleEnded = true;
        emitAgentEvent({
          runId,
          lifecycleGeneration,
          stream: "lifecycle",
          data: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: error instanceof Error ? error.message : "Agent run failed",
            ...resolveAgentRunErrorLifecycleFields(error, opts.abortSignal),
          },
        });
      };
      const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
      const messageChannel = resolveMessageChannel(
        runContext.messageChannel,
        opts.replyChannel ?? opts.channel,
      );

      let result: AgentAttemptResult;
      let fallbackProvider = provider;
      let fallbackModel = model;
      let fallbackExhausted = false;
      const MAX_LIVE_SWITCH_RETRIES = 5;
      let liveSwitchRetries = 0;
      let autoFallbackPrimaryProbeInterruptedByLiveSwitch = false;
      const fastModeStartedAtMs = Date.now();
      const fallbackTrajectoryRecorder = createTrajectoryRuntimeRecorder({
        cfg,
        runId,
        sessionId,
        sessionKey,
        sessionFile: attemptSessionFile,
        provider,
        modelId: model,
        workspaceDir,
      });
      let liveSwitchMediaTaskIds: ReadonlySet<string> = new Set();
      for (;;) {
        try {
          liveSwitchMediaTaskIds = sessionKey
            ? getGeneratedMediaTaskIdsForSessionKey(sessionKey)
            : new Set<string>();
          const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
          const effectiveFallbacksOverride = resolveEffectiveModelFallbacks({
            cfg,
            agentId: sessionAgentId,
            sessionKey,
            hasSessionModelOverride:
              hasExplicitRunOverride || Boolean(storedProviderOverride || storedModelOverride),
            modelOverrideSource: hasExplicitRunOverride ? "user" : storedModelOverrideSource,
            hasAutoFallbackProvenance: hasExplicitRunOverride
              ? false
              : hasStoredAutoFallbackProvenance,
          });

          let fallbackAttemptIndex = 0;
          const fallbackRuntimeState: { originRuntime?: "cli" | "embedded" } = {};
          attemptLifecycleState.currentTurnUserMessagePersisted = false;
          let attemptMediaTaskIds = liveSwitchMediaTaskIds;
          const currentAttemptCommittedCronMedia = () =>
            Boolean(
              sessionKey && hasNewGeneratedMediaTaskForSessionKey(sessionKey, attemptMediaTaskIds),
            );
          const fallbackResult = await runWithModelFallback<AgentAttemptResult>({
            cfg,
            provider,
            model,
            ...modelManifestContext,
            runId,
            agentDir,
            agentId: sessionAgentId,
            sessionId,
            sessionKey: sessionKey ?? sessionId,
            resolveAgentHarnessRuntimeOverride: (candidateProvider) =>
              resolveSessionRuntimeOverrideForProvider({
                provider: candidateProvider,
                entry: sessionEntryForAttempt,
                cfg,
              }),
            prepareAgentHarnessRuntime: async ({
              provider: providerValue,
              model: modelValue,
              agentHarnessRuntimeOverride,
            }) => {
              await ensureSelectedAgentHarnessPlugin({
                config: cfg,
                provider: providerValue,
                modelId: modelValue,
                agentId: sessionAgentId,
                sessionKey,
                agentHarnessRuntimeOverride,
                workspaceDir,
              });
            },
            fallbacksOverride: effectiveFallbacksOverride,
            onFallbackStep: (step) => {
              fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step);
            },
            classifyResult: ({
              provider: providerLocal,
              model: modelLocal,
              result: resultLocal,
            }) => {
              const classification = classifyEmbeddedAgentRunResultForModelFallback({
                provider: providerLocal,
                model: modelLocal,
                result: resultLocal,
              });
              return classification && currentAttemptCommittedCronMedia()
                ? undefined
                : classification;
            },
            canFallbackAfterError: () => !currentAttemptCommittedCronMedia(),
            mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
            abortSignal: opts.abortSignal,
            run: async (providerOverride, modelOverride, runOptions) => {
              attemptMediaTaskIds = sessionKey
                ? getGeneratedMediaTaskIdsForSessionKey(sessionKey)
                : new Set<string>();
              attemptLifecycleState.lifecycleError = undefined;
              attemptLifecycleState.lifecycleFinishing = false;
              attemptLifecycleState.lifecycleEnded = false;
              const isAutoFallbackPrimaryProbeCandidate =
                autoFallbackPrimaryProbe &&
                providerOverride === autoFallbackPrimaryProbe.provider &&
                modelOverride === autoFallbackPrimaryProbe.model;
              const attemptSessionEntry =
                autoFallbackPrimaryProbe &&
                providerOverride === autoFallbackPrimaryProbe.fallbackProvider &&
                !isAutoFallbackPrimaryProbeCandidate
                  ? sessionEntry
                  : sessionEntryForAttempt;
              if (isAutoFallbackPrimaryProbeCandidate) {
                markAutoFallbackPrimaryProbe({
                  probe: autoFallbackPrimaryProbe,
                  sessionKey,
                });
              }
              const isFallbackRetry = fallbackAttemptIndex > 0;
              fallbackAttemptIndex += 1;
              await opts.onActiveModelSelected?.({
                provider: providerOverride,
                model: modelOverride,
              });
              const fastModeState = resolveFastModeState({
                cfg,
                provider: providerOverride,
                model: modelOverride,
                agentId: sessionAgentId,
                sessionEntry,
              });
              const fastMode = opts.fastMode ?? fastModeState.mode;
              const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
                provider: providerOverride,
                entry: attemptSessionEntry,
                cfg,
              });
              const candidateRuntime = resolveEffectiveAgentRuntime({
                cfg,
                provider: providerOverride,
                modelId: modelOverride,
                agentId: sessionAgentId,
                sessionKey,
                sessionEntry: attemptSessionEntry,
              });
              const candidateRequestedThinkLevel =
                immutableThinkLevel ??
                resolveThinkingDefault({
                  cfg,
                  provider: providerOverride,
                  model: modelOverride,
                  catalog: thinkingCatalog,
                  agentRuntime: candidateRuntime,
                });
              const candidateThinkLevel =
                resolveCandidateThinkingLevel({
                  cfg,
                  provider: providerOverride,
                  modelId: modelOverride,
                  level: candidateRequestedThinkLevel,
                  catalog: thinkingCatalog,
                  agentId: sessionAgentId,
                  sessionKey,
                  sessionEntry: attemptSessionEntry,
                  agentRuntime: candidateRuntime,
                }) ?? candidateRequestedThinkLevel;
              effectiveTurnThinkLevel = candidateThinkLevel;
              return attemptExecutionRuntime.runAgentAttempt({
                providerOverride,
                modelOverride,
                modelFallbacksOverride: effectiveFallbacksOverride,
                originalProvider: provider,
                cfg,
                sessionEntry: attemptSessionEntry,
                agentHarnessRuntimeOverride,
                sessionId,
                sessionKey,
                sessionAgentId,
                sessionFile: attemptSessionFile,
                workspaceDir,
                cwd,
                body,
                transcriptBody,
                isFallbackRetry,
                // Fallback selection is turn-local. Revalidate the stored or
                // requested level without rewriting the durable preference.
                resolvedThinkLevel: candidateThinkLevel,
                fastMode,
                fastModeStartedAtMs,
                fastModeAutoOnSeconds:
                  fastMode === "auto"
                    ? (opts.fastModeAutoOnSeconds ?? fastModeState.fastAutoOnSeconds)
                    : fastModeState.fastAutoOnSeconds,
                isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
                timeoutMs,
                runTimeoutOverrideMs,
                runId,
                lifecycleGeneration,
                opts,
                runContext,
                spawnedBy,
                messageChannel,
                skillsSnapshot,
                resolvedVerboseLevel,
                agentDir,
                authProfileProvider: providerForAuthProfileValidation,
                sessionStore: suppressVisibleSessionEffects ? undefined : sessionStore,
                storePath: suppressVisibleSessionEffects ? undefined : storePath,
                pluginsEnabled,
                ...(manifestMetadataSnapshot ? { metadataSnapshot: manifestMetadataSnapshot } : {}),
                allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
                sessionHasHistory:
                  !isNewSession ||
                  (await attemptExecutionRuntime.sessionFileHasContent(attemptSessionFile)),
                fallbackRuntimeState,
                suppressPromptPersistenceOnRetry:
                  suppressUserTurnPersistence ||
                  userTurnTranscriptRecorder.hasPersisted() ||
                  userTurnTranscriptRecorder.isBlocked() ||
                  (isFallbackRetry && attemptLifecycleState.currentTurnUserMessagePersisted),
                userTurnTranscriptRecorder,
                onUserMessagePersisted: attemptLifecycleCallbacks.onUserMessagePersisted,
                onLifecycleGenerationChanged: (nextLifecycleGeneration) => {
                  lifecycleGeneration = nextLifecycleGeneration;
                },
                onAgentEvent: attemptLifecycleCallbacks.onAgentEvent,
                deferTerminalLifecycle: true,
              });
            },
          });
          result = applyAgentRunAbortMetadata(fallbackResult.result, opts.abortSignal);
          if (isAgentRunRestartAbortReason(opts.abortSignal?.reason)) {
            throw opts.abortSignal?.reason;
          }
          fallbackProvider = fallbackResult.provider;
          fallbackModel = fallbackResult.model;
          fallbackExhausted = fallbackResult.outcome === "exhausted";
          if (
            !fallbackExhausted &&
            autoFallbackPrimaryProbe &&
            !autoFallbackPrimaryProbeInterruptedByLiveSwitch &&
            sessionEntry &&
            sessionStore &&
            sessionKey &&
            !suppressVisibleSessionEffects &&
            !preserveUserFacingSessionModelState &&
            entryMatchesAutoFallbackPrimaryProbe(sessionEntry, autoFallbackPrimaryProbe) &&
            fallbackProvider === autoFallbackPrimaryProbe.provider &&
            fallbackModel === autoFallbackPrimaryProbe.model
          ) {
            const nextSessionEntry = { ...sessionEntry };
            clearAutoFallbackPrimaryProbeSelection(nextSessionEntry);
            const persistedEntry = await persistSessionEntry({
              sessionStore,
              sessionKey,
              storePath,
              initialEntry: sessionEntry,
              entry: nextSessionEntry,
              shouldPersist: (current) =>
                Boolean(
                  current &&
                  entryMatchesAutoFallbackPrimaryProbe(current, autoFallbackPrimaryProbe),
                ),
            });
            sessionEntry = persistedEntry ?? sessionEntry;
          }
          if (fallbackResult.attempts.length > 0 && result.meta.agentMeta) {
            result = {
              ...result,
              meta: {
                ...result.meta,
                agentMeta: {
                  ...result.meta.agentMeta,
                  fallbackAttempts: fallbackResult.attempts,
                },
              },
            };
          }
          if (!fallbackExhausted) {
            emitLifecycleFinishing(result);
          }
          break;
        } catch (err) {
          if (err instanceof LiveSessionModelSwitchError) {
            if (
              sessionKey &&
              hasNewGeneratedMediaTaskForSessionKey(sessionKey, liveSwitchMediaTaskIds)
            ) {
              throw err;
            }
            liveSwitchRetries++;
            if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
              log.error(
                `Live session model switch in subagent run ${runId}: exceeded maximum retries (${MAX_LIVE_SWITCH_RETRIES})`,
              );
              if (!attemptLifecycleState.lifecycleEnded) {
                emitAgentEvent({
                  runId,
                  lifecycleGeneration,
                  stream: "lifecycle",
                  data: {
                    phase: "error",
                    startedAt,
                    endedAt: Date.now(),
                    error: "Agent run failed",
                  },
                });
              }
              await fallbackTrajectoryRecorder?.flush();
              throw new Error(
                `Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`,
                { cause: err },
              );
            }
            const switchRef = normalizeAgentCommandModelRef(
              cfg,
              err.provider,
              err.model,
              modelManifestContext,
            );
            const switchKey = modelKey(switchRef.provider, switchRef.model);
            if (!visibilityPolicy.allowsKey(switchKey)) {
              log.info(
                `Live session model switch in subagent run ${runId}: ` +
                  `rejected ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)} (not in allowlist)`,
              );
              if (!attemptLifecycleState.lifecycleEnded) {
                emitAgentEvent({
                  runId,
                  lifecycleGeneration,
                  stream: "lifecycle",
                  data: {
                    phase: "error",
                    startedAt,
                    endedAt: Date.now(),
                    error: "Agent run failed",
                  },
                });
              }
              await fallbackTrajectoryRecorder?.flush();
              throw new Error(
                `Live model switch rejected: ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)} is not in the agent allowlist`,
                { cause: err },
              );
            }
            const previousProvider = provider;
            const previousModel = model;
            if (autoFallbackPrimaryProbe) {
              autoFallbackPrimaryProbeInterruptedByLiveSwitch = true;
            }
            provider = err.provider;
            model = err.model;
            fallbackProvider = err.provider;
            fallbackModel = err.model;
            providerForAuthProfileValidation = err.provider;
            if (sessionEntry) {
              sessionEntry = { ...sessionEntry };
              if (err.agentRuntimeOverride) {
                sessionEntry.agentRuntimeOverride = err.agentRuntimeOverride;
              } else {
                delete sessionEntry.agentRuntimeOverride;
              }
              sessionEntry.authProfileOverride = err.authProfileId;
              sessionEntry.authProfileOverrideSource = err.authProfileId
                ? err.authProfileIdSource
                : undefined;
              sessionEntry.authProfileOverrideCompactionCount = undefined;
              // The live switch supersedes any transient auto-fallback probe
              // snapshot. Retry from the same atomic model/runtime winner.
              sessionEntryForAttempt = sessionEntry;
            }
            if (
              storedModelOverride ||
              err.model !== previousModel ||
              err.provider !== previousProvider
            ) {
              storedModelOverride = err.model;
              storedModelOverrideSource = "user";
            }
            attemptLifecycleState.lifecycleEnded = false;
            log.info(
              `Live session model switch in subagent run ${runId}: switching to ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}`,
            );
            continue;
          }
          if (!attemptLifecycleState.lifecycleEnded) {
            const errorLifecycleFields = isAgentRunDirectAbortReason(err)
              ? { aborted: true as const, stopReason: "aborted" as const }
              : resolveAgentRunErrorLifecycleFields(err, opts.abortSignal);
            emitAgentEvent({
              runId,
              lifecycleGeneration,
              stream: "lifecycle",
              data: {
                phase: "error",
                startedAt,
                endedAt: Date.now(),
                error: err instanceof Error ? err.message : "Agent run failed",
                ...errorLifecycleFields,
              },
            });
          }
          await fallbackTrajectoryRecorder?.flush();
          throw err;
        }
      }
      try {
        await fallbackTrajectoryRecorder?.flush();

        const rotatedSessionFile = result.meta.agentMeta?.sessionFile;
        const effectiveSessionId = rotatedSessionFile
          ? (result.meta.agentMeta?.sessionId ?? sessionId)
          : sessionId;
        const effectiveSessionFile = rotatedSessionFile ?? attemptSessionFile;
        trackInternalModelRunArtifact(effectiveSessionFile, effectiveSessionId);

        // Update token+model fields in the session store.
        if (sessionStore && sessionKey && !suppressVisibleSessionEffects) {
          const isHeartbeatLifecycleRun = isHeartbeatLifecycleRunKind(opts.bootstrapContextRunKind);
          const { updateSessionStoreAfterAgentRun } = await loadSessionStoreRuntime();
          await updateSessionStoreAfterAgentRun({
            cfg,
            contextTokensOverride: agentCfg?.contextTokens,
            sessionId: effectiveSessionId,
            sessionKey,
            storePath,
            sessionStore,
            defaultProvider: provider,
            defaultModel: model,
            fallbackProvider,
            fallbackModel,
            result,
            touchInteraction:
              opts.bootstrapContextRunKind !== "cron" &&
              !isHeartbeatLifecycleRun &&
              !opts.internalEvents?.length,
            // Cron output counts as unread-worthy activity; heartbeat and
            // internal-event turns must not re-flag the session unread.
            touchActivity: !isHeartbeatLifecycleRun && !opts.internalEvents?.length,
            preserveRuntimeModel:
              fallbackExhausted || isHeartbeatLifecycleRun || preserveUserFacingSessionModelState,
            preserveUserFacingSessionModelState,
          });
          sessionEntry = sessionStore[sessionKey] ?? sessionEntry;
        }

        const transcriptPersistenceRunner = result.meta.executionTrace?.runner;
        const embeddedAssistantGapFill =
          transcriptPersistenceRunner === "embedded" ||
          (transcriptPersistenceRunner === undefined &&
            Boolean(result.meta.finalAssistantVisibleText?.trim()));
        if (
          !sessionReboundDuringRun &&
          (transcriptPersistenceRunner === "cli" || embeddedAssistantGapFill)
        ) {
          let persistedCliTurnTranscript = false;
          try {
            const transcriptResult = await attemptExecutionRuntime.persistCliTurnTranscript({
              body,
              transcriptBody,
              result,
              sessionId: effectiveSessionId,
              sessionKey: sessionKey ?? effectiveSessionId,
              sessionFile: suppressVisibleSessionEffects ? effectiveSessionFile : undefined,
              sessionEntry,
              sessionStore: suppressVisibleSessionEffects ? undefined : sessionStore,
              storePath: suppressVisibleSessionEffects ? undefined : storePath,
              sessionAgentId,
              threadId: opts.threadId,
              sessionCwd: effectiveCwd,
              config: cfg,
              embeddedAssistantGapFill,
              skipUserTurn:
                suppressUserTurnPersistence ||
                userTurnTranscriptRecorder.hasPersisted() ||
                userTurnTranscriptRecorder.isBlocked(),
            });
            sessionEntry = transcriptResult.sessionEntry;
            sessionReboundDuringRun = transcriptResult.kind === "session-rebound";
            if (suppressVisibleSessionEffects) {
              sessionEntry = prepared.sessionEntry;
            }
            persistedCliTurnTranscript = transcriptResult.kind === "persisted";
          } catch (error) {
            log.warn(
              `Turn transcript persistence failed for ${sessionKey ?? sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (persistedCliTurnTranscript && !suppressVisibleSessionEffects) {
            sessionEntry = await (
              await loadCliCompactionRuntime()
            ).runCliTurnCompactionLifecycle({
              cfg,
              sessionId: effectiveSessionId,
              sessionKey: sessionKey ?? effectiveSessionId,
              sessionEntry,
              sessionStore,
              storePath,
              sessionAgentId,
              workspaceDir,
              cwd: effectiveCwd,
              agentDir,
              provider: result.meta.agentMeta?.provider ?? provider,
              model: result.meta.agentMeta?.model ?? model,
              skillsSnapshot,
              messageChannel,
              agentAccountId: runContext.accountId,
              senderIsOwner: opts.senderIsOwner,
              thinkLevel: effectiveTurnThinkLevel,
              extraSystemPrompt: opts.extraSystemPrompt,
            });
          }
        }

        const payloads = result.payloads ?? [];
        let pendingFinalDeliveryTextForThisRun: string | undefined;

        // Phase 2: Persist pending final delivery for main sessions before attempting delivery.
        // This ensures that if the process restarts during delivery, the payload is durable.
        if (
          opts.deliver === true &&
          sessionStore &&
          sessionKey &&
          !suppressVisibleSessionEffects &&
          !sessionReboundDuringRun &&
          payloads.length > 0 &&
          !isSubagentSessionKey(sessionKey)
        ) {
          const now = Date.now();
          const combinedPayload = sanitizePendingFinalDeliveryText(
            payloads
              .map((p) => (typeof p.text === "string" ? p.text : ""))
              .filter(Boolean)
              .join("\n\n"),
          );
          pendingFinalDeliveryTextForThisRun = combinedPayload || undefined;

          if (combinedPayload) {
            const entry = sessionStore[sessionKey] ?? sessionEntry;
            const next: SessionEntry = {
              ...entry,
              pendingFinalDelivery: true,
              pendingFinalDeliveryText: combinedPayload,
              pendingFinalDeliveryContext: currentRunDeliveryContext,
              pendingFinalDeliveryCreatedAt: now,
              updatedAt: now,
            };
            const persisted = await persistSessionEntry({
              sessionStore,
              sessionKey,
              storePath,
              initialEntry: entry,
              entry: next,
              shouldPersist: (current) => shouldPersistCurrentRunSessionCleanup(current, sessionId),
            });
            sessionEntry = persisted ?? sessionEntry;
          }
        }

        const { deliverAgentCommandResult } = await loadDeliveryRuntime();
        const resolveFreshSessionEntryForDelivery =
          sessionStore && sessionKey && !suppressVisibleSessionEffects
            ? async (): Promise<SessionEntry | undefined> => {
                const { loadSessionStore } = await loadSessionStoreRuntime();
                const freshStore = loadSessionStore(storePath, {
                  skipCache: true,
                  clone: false,
                });
                const freshEntry = freshStore[sessionKey];
                if (!freshEntry || freshEntry.sessionId !== effectiveSessionId) {
                  return undefined;
                }
                sessionStore[sessionKey] = freshEntry;
                return freshEntry;
              }
            : undefined;
        const deliveryParams = {
          cfg,
          deps: resolvedDeps,
          runtime,
          opts,
          outboundSession,
          sessionEntry,
          result,
          payloads,
          assertDeliveryCurrent: () =>
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
        };
        const deliveryResult = await deliverAgentCommandResult(
          resolveFreshSessionEntryForDelivery
            ? {
                ...deliveryParams,
                expectedSessionIdForFreshDelivery: effectiveSessionId,
                resolveFreshSessionEntryForDelivery,
              }
            : deliveryParams,
        );

        // Phase 2: Clear pending delivery payload after successful delivery.
        if (
          sessionStore &&
          sessionKey &&
          !isSubagentSessionKey(sessionKey) &&
          !suppressVisibleSessionEffects &&
          !sessionReboundDuringRun
        ) {
          const entry = sessionStore[sessionKey] ?? sessionEntry;
          const noPendingTextForThisRun =
            opts.deliver === true &&
            pendingFinalDeliveryTextForThisRun === undefined &&
            entry.pendingFinalDelivery === true &&
            !entry.pendingFinalDeliveryText;
          if (deliveryResult?.deliverySucceeded === true || noPendingTextForThisRun) {
            const next = clearPendingFinalDeliveryFields(entry, Date.now());
            const persisted = await persistSessionEntry({
              sessionStore,
              sessionKey,
              storePath,
              initialEntry: entry,
              entry: next,
              shouldPersist: (current) => shouldPersistCurrentRunSessionCleanup(current, sessionId),
            });
            sessionEntry = persisted ?? sessionEntry;
          }
        }

        if (fallbackExhausted || resolveLifecycleResultError(result, false)) {
          emitLifecycleResultError(result, fallbackExhausted);
        } else {
          emitLifecycleEnd(result);
        }
        return deliveryResult;
      } catch (error) {
        emitLifecyclePostTurnError(error);
        throw error;
      }
    });
  } finally {
    sessionWorkAdmission.release();
    if (internalModelRunArtifacts) {
      // Compaction may rotate a private transcript. Clean every owned identity
      // only after delivery, then remove each transcript after its sidecars.
      for (const artifact of internalModelRunArtifacts.values()) {
        try {
          await removeSessionTrajectoryArtifacts({
            sessionId: artifact.sessionId,
            sessionFile: artifact.sessionFile,
            storePath: artifact.sessionFile,
          });
        } catch (error) {
          log.warn(
            `failed to remove model-run trajectory artifacts: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      for (const sessionFile of new Set(
        Array.from(internalModelRunArtifacts.values(), (artifact) => artifact.sessionFile),
      )) {
        await removeInternalSessionEffectsTranscript(sessionFile);
      }
    }
    if (
      !sessionReboundDuringRun &&
      trackedRestartRecoveryDeliveryContext &&
      sessionStore &&
      sessionKey
    ) {
      try {
        const entry = sessionStore[sessionKey] ?? sessionEntry;
        if (entry?.restartRecoveryDeliveryContext && entry.restartRecoveryDeliveryRunId === runId) {
          const next: SessionEntry = {
            ...entry,
            restartRecoveryDeliveryContext: undefined,
            restartRecoveryDeliveryRunId: undefined,
            updatedAt: Date.now(),
          };
          const persisted = await persistSessionEntry({
            sessionStore,
            sessionKey,
            storePath,
            initialEntry: entry,
            entry: next,
            shouldPersist: (current) =>
              shouldPersistRestartRecoveryCleanup(current, sessionId, runId),
          });
          sessionEntry = persisted ?? sessionEntry;
        }
      } catch (error) {
        log.warn(
          `failed to clear restart recovery delivery context for ${sessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    clearAgentRunContext(runId, lifecycleGeneration);
  }
}

/** Runs an agent turn from CLI/runtime options against the resolved session and model policy. */
export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  const lifecycleGeneration =
    opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(opts.runId ?? "");
  return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    withLocalGatewayRequestScope(
      {
        deps: resolvedDeps,
        getRuntimeConfig,
      },
      async () =>
        await agentCommandInternal(
          {
            ...opts,
            lifecycleGeneration,
            // agentCommand is the trusted-operator entrypoint used by CLI/local flows.
            // Ingress callers must opt into owner identity explicitly via
            // agentCommandFromIngress so network-facing paths cannot inherit this default by accident.
            senderIsOwner: opts.senderIsOwner ?? true,
            // Local/CLI callers are trusted by default for per-run model overrides.
            allowModelOverride: opts.allowModelOverride ?? true,
          },
          runtime,
          resolvedDeps,
        ),
    ),
  );
}

/** Resolve the channel label for model.usage diagnostics from ingress run options. */
function ingressDiagnosticChannel(opts: AgentCommandIngressOpts): string {
  return opts.runContext?.messageChannel ?? opts.messageChannel ?? opts.channel ?? "http";
}

/**
 * Emit a model.usage diagnostic event after an ingress agent run completes.
 *
 * Unlike channel/cron paths which emit model.usage in runReplyAgent /
 * finalizeCronRun, the ingress path has no such existing emission — without
 * this every diagnostics consumer (Langfuse bridge, @openclaw/diagnostics-otel,
 * diagnostics-prometheus) sees usage/cost only for webchat/cli/cron turns
 * and is blind to HTTP API traffic (POST /v1/responses, POST /v1/chat/completions,
 * and node-event dispatch).
 */
function emitIngressModelUsageDiagnostic(
  result: NonNullable<Awaited<ReturnType<typeof agentCommandInternal>>>,
  opts: AgentCommandIngressOpts,
): void {
  const cfg = getRuntimeConfig();
  if (!isDiagnosticsEnabled(cfg)) {
    return;
  }
  const agentMeta = result.meta?.agentMeta;
  const usage = agentMeta?.usage;
  if (!agentMeta || !hasNonzeroUsage(usage)) {
    return;
  }

  const providerUsed = agentMeta.provider ?? "";
  const modelUsed = agentMeta.model ?? "";
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const usagePromptTokens = input + cacheRead + cacheWrite;
  const totalTokens = usage.total ?? usagePromptTokens + output;
  const hasBillableUsageBuckets =
    usage.input !== undefined ||
    usage.output !== undefined ||
    usage.cacheRead !== undefined ||
    usage.cacheWrite !== undefined;
  const costConfig = resolveModelCostConfig({
    provider: providerUsed,
    model: modelUsed,
    config: cfg,
  });
  const costUsd = hasBillableUsageBuckets
    ? estimateUsageCost({ usage, cost: costConfig })
    : undefined;

  emitTrustedDiagnosticEvent({
    type: "model.usage",
    sessionKey: opts.sessionKey,
    sessionId: agentMeta.sessionId,
    channel: ingressDiagnosticChannel(opts),
    agentId: opts.agentId,
    provider: providerUsed,
    model: modelUsed,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens: usagePromptTokens,
      total: totalTokens,
    },
    lastCallUsage: agentMeta.lastCallUsage,
    context: {
      limit: agentMeta.contextTokens,
      ...(agentMeta.promptTokens !== undefined ? { used: agentMeta.promptTokens } : {}),
    },
    costUsd,
    durationMs: result.meta?.durationMs,
  });
}

/** Runs an agent turn from an inbound channel/gateway ingress context. */
export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  const lifecycleGeneration =
    opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(opts.runId ?? "");
  return await withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
    const result = await agentCommandInternal(
      {
        ...opts,
        lifecycleGeneration,
        senderIsOwner: opts.senderIsOwner === true,
      },
      runtime,
      deps,
    );

    if (result) {
      emitIngressModelUsageDiagnostic(result, opts);
    }

    return result;
  });
}

export const testing = {
  resolveAgentRuntimeConfig,
  prepareAgentCommandExecution,
  resolveExplicitAgentCommandSessionKey,
  resolveAgentRunLifecycleEndLogLevel,
  ingressDiagnosticChannel,
  emitIngressModelUsageDiagnostic,
};

/** @deprecated Use `testing`. */
export { testing as __testing };
