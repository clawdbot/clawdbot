import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  resolveSupportedThinkingLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { createTrajectoryRuntimeRecorder } from "../trajectory/runtime.js";
import { resolveMessageChannel } from "../utils/message-channel.js";
import { resolveAgentRuntimeConfig } from "./agent-runtime-config.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveEffectiveModelFallbacks,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { clearSessionAuthProfileOverride } from "./auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
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
import { resolveFastModeState } from "./fast-mode.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { LiveSessionModelSwitchError } from "./live-model-switch.js";
import { loadManifestModelCatalog } from "./model-catalog.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  modelKey,
  normalizeModelRef,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveThinkingDefault,
} from "./model-selection.js";
import { classifyEmbeddedPiRunResultForModelFallback } from "./pi-embedded-runner/result-fallback-classifier.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import { hydrateResolvedSkillsAsync } from "./skills/snapshot-hydration.js";
import { normalizeSpawnedRunMetadata } from "./spawned-context.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import { ensureAgentWorkspace } from "./workspace.js";

const log = createSubsystemLogger("agents/agent-command");
type AttemptExecutionRuntime = typeof import("./command/attempt-execution.runtime.js");
type AgentAttemptResult = Awaited<ReturnType<AttemptExecutionRuntime["runAgentAttempt"]>>;
type AcpManagerRuntime = typeof import("../acp/control-plane/manager.js");
type AcpPolicyRuntime = typeof import("../acp/policy.js");
type AcpRuntimeErrorsRuntime = typeof import("../acp/runtime/errors.js");
type AcpSessionIdentifiersRuntime = typeof import("../acp/runtime/session-identifiers.js");
type DeliveryRuntime = typeof import("./command/delivery.runtime.js");
type SessionStoreRuntime = typeof import("./command/session-store.runtime.js");
type CliCompactionRuntime = typeof import("./command/cli-compaction.js");
type TranscriptResolveRuntime = typeof import("../config/sessions/transcript-resolve.runtime.js");
type CliDepsRuntime = typeof import("../cli/deps.js");
type ExecDefaultsRuntime = typeof import("./exec-defaults.js");
type SkillsRuntime = typeof import("./skills.js");
type SkillsFilterRuntime = typeof import("./skills/filter.js");
type SkillsRefreshStateRuntime = typeof import("./skills/refresh-state.js");
type SkillsRemoteRuntime = typeof import("../infra/skills-remote.js");

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
  () => import("../acp/runtime/session-identifiers.js"),
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
const skillsRuntimeLoader = createLazyImportLoader<SkillsRuntime>(() => import("./skills.js"));
const skillsFilterRuntimeLoader = createLazyImportLoader<SkillsFilterRuntime>(
  () => import("./skills/filter.js"),
);
const skillsRefreshStateRuntimeLoader = createLazyImportLoader<SkillsRefreshStateRuntime>(
  () => import("./skills/refresh-state.js"),
);
const skillsRemoteRuntimeLoader = createLazyImportLoader<SkillsRemoteRuntime>(
  () => import("../infra/skills-remote.js"),
);

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

function loadSkillsFilterRuntime(): Promise<SkillsFilterRuntime> {
  return skillsFilterRuntimeLoader.load();
}

function loadSkillsRefreshStateRuntime(): Promise<SkillsRefreshStateRuntime> {
  return skillsRefreshStateRuntimeLoader.load();
}

function loadSkillsRemoteRuntime(): Promise<SkillsRemoteRuntime> {
  return skillsRemoteRuntimeLoader.load();
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
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
  "claudeCliSessionId",
];

const OVERRIDE_VALUE_MAX_LENGTH = 256;

async function persistSessionEntry(params: PersistSessionEntryParams): Promise<void> {
  await persistSessionEntryBase({
    ...params,
    clearedFields: OVERRIDE_FIELDS_CLEARED_BY_DELETE,
  });
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

async function prepareAgentCommandExecution(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv,
) {
  const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  if (!opts.to && !opts.sessionId && !opts.sessionKey && !opts.agentId) {
    throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
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
  if (agentIdOverride && opts.sessionKey) {
    const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  const agentCfg = cfg.agents?.defaults;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configuredThinkingCatalog = buildConfiguredModelCatalog({ cfg });
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

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const laneRaw = normalizeOptionalString(opts.lane) ?? "";
  const subagentLane: string = AGENT_LANE_SUBAGENT;
  const isSubagentLane = laneRaw === subagentLane;
  const timeoutSecondsRaw =
    opts.timeout !== undefined ? Number.parseInt(opts.timeout, 10) : isSubagentLane ? 0 : undefined;
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
    sessionKey: opts.sessionKey,
    agentId: agentIdOverride,
  });

  const {
    sessionId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  const sessionAgentId =
    agentIdOverride ??
    resolveSessionAgentId({
      sessionKey: sessionKey ?? opts.sessionKey?.trim(),
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
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
    skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
  });
  const workspaceDir = workspace.dir;
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
    agentDir,
    runId,
    acpManager,
    acpResolution,
  };
}

async function agentCommandInternal(
  opts: AgentCommandOpts & { senderIsOwner: boolean },
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
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
    agentDir,
    runId,
    acpManager,
    acpResolution,
  } = prepared;
  let sessionEntry = prepared.sessionEntry;

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

    if (!isRawModelRun && acpResolution?.kind === "ready" && sessionKey) {
      const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
      const startedAt = Date.now();
      registerAgentRunContext(runId, {
        sessionKey,
      });
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

        await acpManager.runTurn({
          cfg,
          sessionKey,
          text: body,
          mode: "prompt",
          requestId: runId,
          signal: opts.abortSignal,
          onEvent: (event) => {
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
          message: acpError.message,
        });
        throw acpError;
      }

      attemptExecutionRuntime.emitAcpLifecycleEnd({ runId });

      const finalTextRaw = visibleTextAccumulator.finalizeRaw();
      const finalText = visibleTextAccumulator.finalize();
      try {
        const { resolveAcpSessionCwd } = await loadAcpSessionIdentifiersRuntime();
        sessionEntry = await attemptExecutionRuntime.persistAcpTurnTranscript({
          body,
          transcriptBody,
          finalText: finalTextRaw,
          sessionId,
          sessionKey,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          threadId: opts.threadId,
          sessionCwd: resolveAcpSessionCwd(acpResolution.meta) ?? workspaceDir,
          config: cfg,
        });
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

    if (sessionKey) {
      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }

    const [{ getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion }, { matchesSkillFilter }] =
      await Promise.all([loadSkillsRefreshStateRuntime(), loadSkillsFilterRuntime()]);
    const skillsSnapshotVersion = getSkillsSnapshotVersion(workspaceDir);
    const skillFilter = resolveAgentSkillsFilter(cfg, sessionAgentId);
    const currentSkillsSnapshot = sessionEntry?.skillsSnapshot;
    const shouldRefreshSkillsSnapshot =
      !currentSkillsSnapshot ||
      shouldRefreshSnapshotForVersion(currentSkillsSnapshot.version, skillsSnapshotVersion) ||
      !matchesSkillFilter(currentSkillsSnapshot.skillFilter, skillFilter);
    const needsSkillsSnapshot = isNewSession || shouldRefreshSkillsSnapshot;
    const buildSkillsSnapshot = async () => {
      const [
        { buildWorkspaceSkillSnapshot },
        { getRemoteSkillEligibility },
        { canExecRequestNode },
      ] = await Promise.all([
        loadSkillsRuntime(),
        loadSkillsRemoteRuntime(),
        loadExecDefaultsRuntime(),
      ]);
      return buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfg,
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
        snapshotVersion: skillsSnapshotVersion,
        skillFilter,
        agentId: sessionAgentId,
      });
    };
    const skillsSnapshot = needsSkillsSnapshot
      ? await buildSkillsSnapshot()
      : !currentSkillsSnapshot
        ? undefined
        : await hydrateResolvedSkillsAsync(currentSkillsSnapshot, buildSkillsSnapshot);

    if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
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
    if (sessionStore && sessionKey) {
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
    });
    const { provider: defaultProvider, model: defaultModel } = normalizeModelRef(
      configuredDefaultRef.provider,
      configuredDefaultRef.model,
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
    let allowedModelKeys = new Set<string>();
    let allowedModelCatalog: ReturnType<typeof loadManifestModelCatalog> = [];
    let modelCatalog: ReturnType<typeof loadManifestModelCatalog> | null = null;
    let allowAnyModel = !hasAllowlist;

    if (needsModelCatalog) {
      modelCatalog = loadManifestModelCatalog({ config: cfg, workspaceDir });
      const allowed = buildAllowedModelSet({
        cfg,
        catalog: modelCatalog,
        defaultProvider,
        defaultModel,
        agentId: sessionAgentId,
      });
      allowedModelKeys = allowed.allowedKeys;
      allowedModelCatalog = allowed.allowedCatalog;
      allowAnyModel = allowed.allowAny ?? false;
    }

    if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
      const entry = sessionEntry;
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
      if (overrideModel) {
        const normalizedOverride = normalizeModelRef(overrideProvider, overrideModel);
        const key = modelKey(normalizedOverride.provider, normalizedOverride.model);
        if (!allowAnyModel && !allowedModelKeys.has(key)) {
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

    const storedProviderOverride = sessionEntry?.providerOverride?.trim();
    let storedModelOverride = sessionEntry?.modelOverride?.trim();
    if (storedModelOverride) {
      const candidateProvider = storedProviderOverride || defaultProvider;
      const normalizedStored = normalizeModelRef(candidateProvider, storedModelOverride);
      const key = modelKey(normalizedStored.provider, normalizedStored.model);
      if (allowAnyModel || allowedModelKeys.has(key)) {
        provider = normalizedStored.provider;
        model = normalizedStored.model;
      }
    }
    let providerForAuthProfileValidation = provider;
    if (hasExplicitRunOverride) {
      const explicitRef = explicitModelOverride
        ? explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, explicitModelOverride)
          : parseModelRef(explicitModelOverride, provider)
        : explicitProviderOverride
          ? normalizeModelRef(explicitProviderOverride, model)
          : null;
      if (!explicitRef) {
        throw new Error("Invalid model override.");
      }
      const explicitKey = modelKey(explicitRef.provider, explicitRef.model);
      if (!allowAnyModel && !allowedModelKeys.has(explicitKey)) {
        throw new Error(
          `Model override "${sanitizeForLog(explicitRef.provider)}/${sanitizeForLog(explicitRef.model)}" is not allowed for agent "${sessionAgentId}".`,
        );
      }
      provider = explicitRef.provider;
      model = explicitRef.model;
    }
    if (sessionEntry) {
      const authProfileId = sessionEntry.authProfileOverride;
      if (authProfileId) {
        const entry = sessionEntry;
        const store = ensureAuthProfileStore();
        const profile = store.profiles[authProfileId];
        const profileAuthProvider = profile
          ? resolveProviderIdForAuth(profile.provider, { config: cfg, workspaceDir })
          : undefined;
        const validationAuthProvider = resolveProviderIdForAuth(providerForAuthProfileValidation, {
          config: cfg,
          workspaceDir,
        });
        if (!profile || profileAuthProvider !== validationAuthProvider) {
          if (sessionStore && sessionKey) {
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
      resolvedThinkLevel = resolveThinkingDefault({
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
        const previousThinkLevel = resolvedThinkLevel;
        resolvedThinkLevel = fallbackThinkLevel;
        if (
          sessionEntry &&
          sessionStore &&
          sessionKey &&
          sessionEntry.thinkingLevel === previousThinkLevel
        ) {
          const entry = sessionEntry;
          entry.thinkingLevel = fallbackThinkLevel;
          entry.updatedAt = Date.now();
          await persistSessionEntry({
            sessionStore,
            sessionKey,
            storePath,
            entry,
          });
        }
      }
    }
    const { resolveSessionTranscriptFile } = await loadTranscriptResolveRuntime();
    let sessionFile: string | undefined;
    if (sessionStore && sessionKey) {
      const resolvedSessionFile = await resolveSessionTranscriptFile({
        sessionId,
        sessionKey,
        sessionStore,
        storePath,
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

    const startedAt = Date.now();
    let lifecycleEnded = false;
    const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
    const runContext = resolveAgentRunContext(opts);
    const messageChannel = resolveMessageChannel(
      runContext.messageChannel,
      opts.replyChannel ?? opts.channel,
    );

    let result: AgentAttemptResult;
    let fallbackProvider = provider;
    let fallbackModel = model;
    const MAX_LIVE_SWITCH_RETRIES = 5;
    let liveSwitchRetries = 0;
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
          hasSessionModelOverride:
            hasExplicitRunOverride || Boolean(storedProviderOverride || storedModelOverride),
          modelOverrideSource: hasExplicitRunOverride ? "user" : storedModelOverrideSource,
        });

        let fallbackAttemptIndex = 0;
        let currentTurnUserMessagePersisted = false;
        const fallbackResult = await runWithModelFallback<AgentAttemptResult>({
          cfg,
          provider,
          model,
          runId,
          agentDir,
          fallbacksOverride: effectiveFallbacksOverride,
          onFallbackStep: (step) => {
            fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step);
          },
          classifyResult: ({ provider, model, result }) =>
            classifyEmbeddedPiRunResultForModelFallback({
              provider,
              model,
              result,
            }),
          run: async (providerOverride, modelOverride, runOptions) => {
            const isFallbackRetry = fallbackAttemptIndex > 0;
            fallbackAttemptIndex += 1;
            return attemptExecutionRuntime.runAgentAttempt({
              providerOverride,
              modelOverride,
              modelFallbacksOverride: effectiveFallbacksOverride,
              originalProvider: provider,
              cfg,
              sessionEntry,
              sessionId,
              sessionKey,
              sessionAgentId,
              sessionFile,
              workspaceDir,
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
              sessionStore,
              storePath,
              allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
              sessionHasHistory:
                !isNewSession || (await attemptExecutionRuntime.sessionFileHasContent(sessionFile)),
              suppressPromptPersistenceOnRetry: isFallbackRetry && currentTurnUserMessagePersisted,
              onUserMessagePersisted: () => {
                currentTurnUserMessagePersisted = true;
              },
              onAgentEvent: (evt) => {
                if (
                  evt.stream === "lifecycle" &&
                  typeof evt.data?.phase === "string" &&
                  (evt.data.phase === "end" || evt.data.phase === "error")
                ) {
                  lifecycleEnded = true;
                }
              },
            });
          },
        });
        result = fallbackResult.result;
        fallbackProvider = fallbackResult.provider;
        fallbackModel = fallbackResult.model;
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
        if (!lifecycleEnded) {
          const stopReason = result.meta.stopReason;
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
              aborted: result.meta.aborted ?? false,
              stopReason,
            },
          });
        }
        break;
      } catch (err) {
        if (err instanceof LiveSessionModelSwitchError) {
          liveSwitchRetries++;
          if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
            log.error(
              `Live session model switch in subagent run ${runId}: exceeded maximum retries (${MAX_LIVE_SWITCH_RETRIES})`,
            );
            if (!lifecycleEnded) {
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
          const switchRef = normalizeModelRef(err.provider, err.model);
          const switchKey = modelKey(switchRef.provider, switchRef.model);
          if (!allowAnyModel && !allowedModelKeys.has(switchKey)) {
            log.info(
              `Live session model switch in subagent run ${runId}: ` +
                `rejected ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)} (not in allowlist)`,
            );
            if (!lifecycleEnded) {
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
          lifecycleEnded = false;
          log.info(
            `Live session model switch in subagent run ${runId}: switching to ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}`,
          );
          continue;
        }
        if (!lifecycleEnded) {
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
    await fallbackTrajectoryRecorder?.flush();

    // Update token+model fields in the session store.
    if (sessionStore && sessionKey) {
      const { updateSessionStoreAfterAgentRun } = await loadSessionStoreRuntime();
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        sessionId,
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
        preserveRuntimeModel: opts.bootstrapContextRunKind === "heartbeat",
      });
      sessionEntry = sessionStore[sessionKey] ?? sessionEntry;
    }

    if (result.meta.executionTrace?.runner === "cli") {
      try {
        sessionEntry = await attemptExecutionRuntime.persistCliTurnTranscript({
          body,
          transcriptBody,
          result,
          sessionId,
          sessionKey: sessionKey ?? sessionId,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          threadId: opts.threadId,
          sessionCwd: workspaceDir,
          config: cfg,
        });
        sessionEntry = await (
          await loadCliCompactionRuntime()
        ).runCliTurnCompactionLifecycle({
          cfg,
          sessionId,
          sessionKey: sessionKey ?? sessionId,
          sessionEntry,
          sessionStore,
          storePath,
          sessionAgentId,
          workspaceDir,
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
      } catch (error) {
        log.warn(
          `CLI transcript persistence failed for ${sessionKey ?? sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const payloads = result.payloads ?? [];

    // Phase 2: Persist pending final delivery for main sessions before attempting delivery.
    // This ensures that if the process restarts during delivery, the payload is durable.
    if (
      opts.deliver === true &&
      sessionStore &&
      sessionKey &&
      payloads.length > 0 &&
      !isSubagentSessionKey(sessionKey)
    ) {
      const now = Date.now();
      const combinedPayload = payloads
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n\n");

      if (combinedPayload) {
        const entry = sessionStore[sessionKey] ?? sessionEntry;
        const next: SessionEntry = {
          ...entry,
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: combinedPayload,
          pendingFinalDeliveryCreatedAt: now,
          updatedAt: now,
        };
        await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          entry: next,
        });
        sessionEntry = next;
      }
    }

    const { deliverAgentCommandResult } = await loadDeliveryRuntime();
    const deliveryResult = await deliverAgentCommandResult({
      cfg,
      deps: resolvedDeps,
      runtime,
      opts,
      outboundSession,
      sessionEntry,
      result,
      payloads,
    });

    // Phase 2: Clear pending delivery payload after successful delivery.
    if (
      deliveryResult?.deliverySucceeded === true &&
      sessionStore &&
      sessionKey &&
      !isSubagentSessionKey(sessionKey)
    ) {
      const entry = sessionStore[sessionKey] ?? sessionEntry;
      const next: SessionEntry = {
        ...entry,
        pendingFinalDelivery: undefined,
        pendingFinalDeliveryText: undefined,
        pendingFinalDeliveryCreatedAt: undefined,
        updatedAt: Date.now(),
      };
      await persistSessionEntry({
        sessionStore,
        sessionKey,
        storePath,
        entry: next,
      });
      sessionEntry = next;
    }

    return deliveryResult;
  } finally {
    clearAgentRunContext(runId);
  }
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  return await agentCommandInternal(
    {
      ...opts,
      // agentCommand is the trusted-operator entrypoint used by CLI/local flows.
      // Ingress callers must opt into owner semantics explicitly via
      // agentCommandFromIngress so network-facing paths cannot inherit this default by accident.
      senderIsOwner: opts.senderIsOwner ?? true,
      // Local/CLI callers are trusted by default for per-run model overrides.
      allowModelOverride: opts.allowModelOverride ?? true,
    },
    runtime,
    deps,
  );
}

export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  if (typeof opts.senderIsOwner !== "boolean") {
    // HTTP/WS ingress must declare the trust level explicitly at the boundary.
    // This keeps network-facing callers from silently picking up the local trusted default.
    throw new Error("senderIsOwner must be explicitly set for ingress agent runs.");
  }
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return await agentCommandInternal(
    {
      ...opts,
      senderIsOwner: opts.senderIsOwner,
      allowModelOverride: opts.allowModelOverride,
    },
    runtime,
    deps,
  );
}

export const __testing = {
  resolveAgentRuntimeConfig,
  prepareAgentCommandExecution,
};
