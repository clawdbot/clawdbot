import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveInlineAgentImageAttachments } from "../auto-reply/reply/agent-turn-attachments.js";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  resolveSupportedThinkingLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveAgentDeliveryPlan,
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
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveEffectiveAgentSkillFilter } from "../skills/discovery/agent-filter.js";
import type { getRemoteSkillEligibility } from "../skills/runtime/remote.js";
import type { resolveReusableWorkspaceSkillSnapshot } from "../skills/runtime/session-snapshot.js";
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
import { createAgentAttemptLifecycleCallbacks } from "./command/attempt-callbacks.js";
import {
  persistSessionEntry as persistSessionEntryBase,
  prependInternalEventContext,
  resolveAcpPromptBody,
  resolveInternalEventTranscriptBody,
} from "./command/attempt-execution.shared.js";
import { resolveAgentRunContext } from "./command/run-context.js";
import { resolveSession } from "./command/session.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./embedded-agent-runner/result-fallback-classifier.js";
import { resolveFastModeState } from "./fast-mode.js";
import { ensureSelectedAgentHarnessPlugin } from "./harness/runtime-plugin.js";
import { resolveAvailableAgentHarnessPolicy } from "./harness/selection.js";
import { prepareInternalSessionEffectsTranscript } from "./internal-session-effects.js";
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
import { normalizeSpawnedRunMetadata } from "./spawned-context.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
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
  entry: SessionEntry;
};

type OverrideFieldClearedByDelete =
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "modelOverrideFallbackOriginProvider"
  | "modelOverrideFallbackOriginModel"
  | "authProfileOverride"
  | "authProfileOverrideSource"
  | "authProfileOverrideCompactionCount"
  | "fallbackNoticeSelectedModel"
  | "fallbackNoticeActiveModel"
  | "fallbackNoticeReason"
  | "claudeCliSessionId";

const OVERRIDE_FIELDS_CLEARED_BY_DELETE: OverrideFieldClearedByDelete[] = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
];

const OVERRIDE_VALUE_MAX_LENGTH = 256;

async function persistSessionEntry(
  params: PersistSessionEntryParams & {
    shouldPersist?: (entry: SessionEntry | undefined) => boolean;
  },
): Promise<SessionEntry | undefined> {
  return await persistSessionEntryBase({
    ...params,
    clearedFields: OVERRIDE_FIELDS_CLEARED_BY_DELETE,
  });
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
  if (!opts.to && !opts.sessionId && !rawExplicitSessionKey && !opts.agentId) {
    throw new Error(
      "Pass --to <E.164>, --session-key, --session-id, or --agent to choose a session",
    );
  }

  const { cfg } = await resolveAgentRuntimeConfig(runtime, {
    runtimeTargetsChannelSecrets: opts.deliver === true,
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
  const explicitSessionKey = resolveExplicitAgentCommandSessionKey({
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
  const timeoutSecondsRaw =
    opts.timeout !== undefined
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

  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
    sessionKey: explicitSessionKey,
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
  const thinkingLevelsHint = formatThinkingLevels(
    configuredModel.provider,
    configuredModel.model,
    ", ",
    configuredThinkingCatalog.length > 0 ? configuredThinkingCatalog : undefined,
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
    acpManager,
    acpResolution,
  };
}

async function agentCommandInternal(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
  const suppressVisibleSessionEffects = opts.sessionEffects === "internal";
  const preserveUserFacingSessionModelState = opts.preserveUserFacingSessionModelState === true;
  const prepared = await prepareAgentCommandExecution(opts, runtime);
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
    acpManager,
    acpResolution,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
  } = prepared;
  const effectiveCwd = cwd ? resolveUserPath(cwd) : workspaceDir;
  let sessionEntry = prepared.sessionEntry;
  let trackedRestartRecoveryDeliveryContext = false;
  let currentRunDeliveryContext: DeliveryContext | undefined;

  try {
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
      const entry = currentStoreEntry ??
        sessionEntry ?? { sessionId, updatedAt: now, sessionStartedAt: now };
      currentRunDeliveryContext = await resolveCurrentRunDeliveryContext({
        cfg,
        opts,
        sessionEntry: entry,
      });
      const next: SessionEntry = {
        ...entry,
        sessionId,
        updatedAt: now,
        restartRecoveryDeliveryContext: currentRunDeliveryContext,
        restartRecoveryDeliveryRunId: currentRunDeliveryContext ? runId : undefined,
      };
      const persisted = await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
        shouldPersist: (current) =>
          shouldPersistRestartRecoveryContextClaim(
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
      const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
      const startedAt = Date.now();
      registerAgentRunContext(
        runId,
        suppressVisibleSessionEffects
          ? { isControlUiVisible: false }
          : {
              sessionKey,
              sessionId,
            },
      );
      attemptExecutionRuntime.emitAcpLifecycleStart({ runId, startedAt });

      const visibleTextAccumulator = attemptExecutionRuntime.createAcpVisibleTextAccumulator();
      let stopReason: string | undefined;
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
          throw turnPolicyError;
        }
        const acpAgent = normalizeAgentId(
          acpResolution.meta.agent || resolveAgentIdFromSessionKey(sessionKey),
        );
        const agentPolicyError = resolveAcpAgentPolicyError(cfg, acpAgent);
        if (agentPolicyError) {
          throw agentPolicyError;
        }

        const acpImageAttachments = resolveInlineAgentImageAttachments(opts.images);
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
                sessionKey,
                event,
              });
            }
            if (event.type === "done") {
              stopReason = event.stopReason;
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
      } catch (error) {
        const { toAcpRuntimeError } = await loadAcpRuntimeErrorsRuntime();
        const acpError = toAcpRuntimeError({
          error,
          fallbackCode: "ACP_TURN_FAILED",
          fallbackMessage: "ACP turn failed before completion.",
        });
        attemptExecutionRuntime.emitAcpLifecycleError({
          runId,
          error: acpError,
          sessionKey,
        });
        throw acpError;
      }

      attemptExecutionRuntime.emitAcpLifecycleEnd({ runId });

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
        const transcriptSessionEntry: SessionEntry | undefined = internalSessionFile
          ? {
              ...(sessionEntry ?? {
                sessionId,
                updatedAt: Date.now(),
                sessionStartedAt: Date.now(),
              }),
              sessionId,
              sessionFile: internalSessionFile,
            }
          : sessionEntry;
        sessionEntry = await attemptExecutionRuntime.persistAcpTurnTranscript({
          body,
          transcriptBody,
          finalText: finalTextRaw,
          sessionId,
          sessionKey,
          sessionEntry: transcriptSessionEntry,
          sessionStore: suppressVisibleSessionEffects ? undefined : sessionStore,
          storePath: suppressVisibleSessionEffects ? undefined : storePath,
          sessionAgentId,
          threadId: opts.threadId,
          sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
          config: cfg,
        });
        if (internalSessionFile) {
          sessionEntry = prepared.sessionEntry;
        }
      } catch (error) {
        log.warn(
          `ACP transcript persistence failed for ${sessionKey}: ${formatErrorMessage(error)}`,
        );
      }

      const result = attemptExecutionRuntime.buildAcpResult({
        payloadText: finalText,
        startedAt,
        stopReason,
        abortSignal: opts.abortSignal,
      });
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
      });
    }

    let resolvedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;
    const resolvedVerboseLevel =
      verboseOverride ?? persistedVerbose ?? (agentCfg?.verboseDefault as VerboseLevel | undefined);

    if (sessionKey || suppressVisibleSessionEffects) {
      registerAgentRunContext(runId, {
        ...(sessionKey && !suppressVisibleSessionEffects ? { sessionKey, sessionId } : {}),
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
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    // Persist explicit /command overrides to the session store when we have a key.
    const hasInitialSessionOverrides = Boolean(thinkOverride || verboseOverride);
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
      if (thinkOverride) {
        next.thinkingLevel = thinkOverride;
      }
      applyVerboseOverride(next, verboseOverride);
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    const configuredDefaultRef = resolveDefaultModelForAgent({
      cfg,
      agentId: sessionAgentId,
      allowPluginNormalization: pluginsEnabled,
      ...modelManifestContext,
    });
    const runContext = resolveAgentRunContext(opts);
    const { provider: defaultProvider, model: defaultModel } = normalizeAgentCommandDefaultModelRef(
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
    const hasStoredAutoFallbackProvenance =
      hasStoredOverride && hasSessionAutoModelFallbackProvenance(sessionEntry);
    const hasLegacyAutoFallbackOverrideWithoutOrigin =
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
      modelCatalog = pluginsEnabled ? loadManifestModelCatalog({ config: cfg, workspaceDir }) : [];
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
      const entry = sessionEntry;
      if (hasLegacyAutoFallbackOverrideWithoutOrigin) {
        const { updated } = applyModelOverrideToSessionEntry({
          entry,
          selection: { provider: defaultProvider, model: defaultModel, isDefault: true },
        });
        if (updated) {
          storedModelOverrideSource = undefined;
          await persistSessionEntry({
            sessionStore,
            sessionKey,
            storePath,
            entry,
          });
        }
      }
      const repaired = repairProviderWrappedModelOverride({
        entry,
        defaultProvider,
        defaultModel,
      });
      if (repaired.updated) {
        await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          entry,
        });
      }
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
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
            await persistSessionEntry({
              sessionStore,
              sessionKey,
              storePath,
              entry,
            });
          }
        }
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
                ...(manifestMetadataSnapshot ? { metadataSnapshot: manifestMetadataSnapshot } : {}),
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
    if (!resolvedThinkLevel) {
      resolvedThinkLevel =
        normalizeThinkLevel(resolveAgentConfig(cfg, sessionAgentId)?.thinkingDefault) ??
        resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog: thinkingCatalog,
        });
    }
    if (
      !isThinkingLevelSupported({
        provider,
        model,
        level: resolvedThinkLevel,
        catalog: thinkingCatalog,
      })
    ) {
      const explicitThink = Boolean(thinkOnce || thinkOverride);
      if (explicitThink) {
        throw new Error(
          `Thinking level "${resolvedThinkLevel}" is not supported for ${provider}/${model}. Use one of: ${formatThinkingLevels(provider, model, ", ", thinkingCatalog)}.`,
        );
      }
      const fallbackThinkLevel = resolveSupportedThinkingLevel({
        provider,
        model,
        level: resolvedThinkLevel,
        catalog: thinkingCatalog,
      });
      if (fallbackThinkLevel !== resolvedThinkLevel) {
        // Execution fallbacks are turn-local; directive/model persistence owns
        // durable thinking remaps so explicit session overrides survive runs.
        resolvedThinkLevel = fallbackThinkLevel;
      }
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

    const startedAt = Date.now();
    const attemptLifecycleState = {
      currentTurnUserMessagePersisted: false,
      lifecycleFinishing: false,
      lifecycleEnded: false,
    };
    const attemptLifecycleCallbacks = createAgentAttemptLifecycleCallbacks(attemptLifecycleState);
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
        stream: "lifecycle",
        data: {
          phase: "finishing",
          startedAt,
          endedAt: Date.now(),
          aborted: runResult.meta.aborted ?? false,
          stopReason: runResult.meta.stopReason,
        },
      });
    };
    const emitLifecycleEnd = (runResult: AgentAttemptResult) => {
      if (attemptLifecycleState.lifecycleEnded) {
        return;
      }
      attemptLifecycleState.lifecycleEnded = true;
      const stopReason = runResult.meta.stopReason;
      if (stopReason && stopReason !== "end_turn") {
        console.error(`[agent] run ${runId} ended with stopReason=${stopReason}`);
      }
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
          aborted: runResult.meta.aborted ?? false,
          stopReason,
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
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: error instanceof Error ? error.message : "Agent run failed",
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
    const MAX_LIVE_SWITCH_RETRIES = 5;
    let liveSwitchRetries = 0;
    let autoFallbackPrimaryProbeInterruptedByLiveSwitch = false;
    const fallbackTrajectoryRecorder = createTrajectoryRuntimeRecorder({
      cfg,
      runId,
      sessionId,
      sessionKey,
      sessionFile,
      provider,
      modelId: model,
      workspaceDir,
    });
    for (;;) {
      try {
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
        attemptLifecycleState.currentTurnUserMessagePersisted = false;
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
          classifyResult: ({ provider: providerLocal, model: modelLocal, result: resultLocal }) =>
            classifyEmbeddedAgentRunResultForModelFallback({
              provider: providerLocal,
              model: modelLocal,
              result: resultLocal,
            }),
          abortSignal: opts.abortSignal,
          run: async (providerOverride, modelOverride, runOptions) => {
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
            opts.onActiveModelSelected?.({
              provider: providerOverride,
              model: modelOverride,
            });
            return attemptExecutionRuntime.runAgentAttempt({
              providerOverride,
              modelOverride,
              modelFallbacksOverride: effectiveFallbacksOverride,
              originalProvider: provider,
              cfg,
              sessionEntry: attemptSessionEntry,
              sessionId,
              sessionKey,
              sessionAgentId,
              sessionFile: attemptSessionFile,
              workspaceDir,
              cwd,
              body,
              isFallbackRetry,
              resolvedThinkLevel,
              fastMode: resolveFastModeState({
                cfg,
                provider: providerOverride,
                model: modelOverride,
                agentId: sessionAgentId,
                sessionEntry,
              }).enabled,
              timeoutMs,
              runId,
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
              suppressPromptPersistenceOnRetry:
                opts.suppressPromptPersistence === true ||
                (isFallbackRetry && attemptLifecycleState.currentTurnUserMessagePersisted),
              onUserMessagePersisted: attemptLifecycleCallbacks.onUserMessagePersisted,
              onAgentEvent: attemptLifecycleCallbacks.onAgentEvent,
              deferTerminalLifecycleEnd: true,
            });
          },
        });
        result = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
        if (
          autoFallbackPrimaryProbe &&
          !autoFallbackPrimaryProbeInterruptedByLiveSwitch &&
          sessionEntry &&
          sessionStore &&
          sessionKey &&
          !suppressVisibleSessionEffects &&
          !preserveUserFacingSessionModelState &&
          entryMatchesAutoFallbackPrimaryProbe(sessionEntry, autoFallbackPrimaryProbe)
        ) {
          const nextSessionEntry = { ...sessionEntry };
          if (
            fallbackProvider === autoFallbackPrimaryProbe.provider &&
            fallbackModel === autoFallbackPrimaryProbe.model
          ) {
            clearAutoFallbackPrimaryProbeSelection(nextSessionEntry);
          } else {
            nextSessionEntry.providerOverride = fallbackProvider;
            nextSessionEntry.modelOverride = fallbackModel;
            nextSessionEntry.modelOverrideSource = "auto";
            nextSessionEntry.modelOverrideFallbackOriginProvider =
              autoFallbackPrimaryProbe.provider;
            nextSessionEntry.modelOverrideFallbackOriginModel = autoFallbackPrimaryProbe.model;
            if (
              nextSessionEntry.authProfileOverrideSource === "auto" &&
              fallbackProvider !== autoFallbackPrimaryProbe.fallbackProvider
            ) {
              delete nextSessionEntry.authProfileOverride;
              delete nextSessionEntry.authProfileOverrideSource;
              delete nextSessionEntry.authProfileOverrideCompactionCount;
            }
            nextSessionEntry.updatedAt = Date.now();
          }
          const persistedEntry = await persistSessionEntry({
            sessionStore,
            sessionKey,
            storePath,
            entry: nextSessionEntry,
            shouldPersist: (current) =>
              Boolean(
                current && entryMatchesAutoFallbackPrimaryProbe(current, autoFallbackPrimaryProbe),
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
        emitLifecycleFinishing(result);
        break;
      } catch (err) {
        if (err instanceof LiveSessionModelSwitchError) {
          liveSwitchRetries++;
          if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
            log.error(
              `Live session model switch in subagent run ${runId}: exceeded maximum retries (${MAX_LIVE_SWITCH_RETRIES})`,
            );
            if (!attemptLifecycleState.lifecycleEnded) {
              emitAgentEvent({
                runId,
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
            sessionEntry.authProfileOverride = err.authProfileId;
            sessionEntry.authProfileOverrideSource = err.authProfileId
              ? err.authProfileIdSource
              : undefined;
            sessionEntry.authProfileOverrideCompactionCount = undefined;
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
          emitAgentEvent({
            runId,
            stream: "lifecycle",
            data: {
              phase: "error",
              startedAt,
              endedAt: Date.now(),
              error: err instanceof Error ? err.message : "Agent run failed",
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

      // Update token+model fields in the session store.
      if (sessionStore && sessionKey && !suppressVisibleSessionEffects) {
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
            opts.bootstrapContextRunKind !== "heartbeat" &&
            !opts.internalEvents?.length,
          preserveRuntimeModel:
            opts.bootstrapContextRunKind === "heartbeat" || preserveUserFacingSessionModelState,
          preserveUserFacingSessionModelState,
        });
        sessionEntry = sessionStore[sessionKey] ?? sessionEntry;
      }

      const transcriptPersistenceRunner = result.meta.executionTrace?.runner;
      const embeddedAssistantGapFill =
        transcriptPersistenceRunner === "embedded" ||
        (transcriptPersistenceRunner === undefined &&
          Boolean(result.meta.finalAssistantVisibleText?.trim()));
      if (transcriptPersistenceRunner === "cli" || embeddedAssistantGapFill) {
        let persistedCliTurnTranscript = false;
        try {
          const transcriptSessionEntry: SessionEntry | undefined = suppressVisibleSessionEffects
            ? {
                ...(sessionEntry ?? {
                  sessionId: effectiveSessionId,
                  updatedAt: Date.now(),
                  sessionStartedAt: Date.now(),
                }),
                sessionId: effectiveSessionId,
                sessionFile: effectiveSessionFile,
              }
            : sessionEntry;
          sessionEntry = await attemptExecutionRuntime.persistCliTurnTranscript({
            body,
            transcriptBody,
            result,
            sessionId: effectiveSessionId,
            sessionKey: sessionKey ?? effectiveSessionId,
            sessionEntry: transcriptSessionEntry,
            sessionStore: suppressVisibleSessionEffects ? undefined : sessionStore,
            storePath: suppressVisibleSessionEffects ? undefined : storePath,
            sessionAgentId,
            threadId: opts.threadId,
            sessionCwd: effectiveCwd,
            config: cfg,
            embeddedAssistantGapFill,
          });
          if (suppressVisibleSessionEffects) {
            sessionEntry = prepared.sessionEntry;
          }
          persistedCliTurnTranscript = true;
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
            thinkLevel: resolvedThinkLevel,
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
        !suppressVisibleSessionEffects
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
            entry: next,
            shouldPersist: (current) => shouldPersistCurrentRunSessionCleanup(current, sessionId),
          });
          sessionEntry = persisted ?? sessionEntry;
        }
      }

      emitLifecycleEnd(result);
      return deliveryResult;
    } catch (error) {
      emitLifecyclePostTurnError(error);
      throw error;
    }
  } finally {
    if (trackedRestartRecoveryDeliveryContext && sessionStore && sessionKey) {
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
    clearAgentRunContext(runId);
  }
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  return await withLocalGatewayRequestScope(
    {
      deps: resolvedDeps,
      getRuntimeConfig,
    },
    async () =>
      await agentCommandInternal(
        {
          ...opts,
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
  );
}

export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    { ...opts, senderIsOwner: opts.senderIsOwner === true },
    runtime,
    deps,
  );
}

export const testing = {
  resolveAgentRuntimeConfig,
  prepareAgentCommandExecution,
  resolveExplicitAgentCommandSessionKey,
};

/** @deprecated Use `testing`. */
export { testing as __testing };
