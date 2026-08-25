/** Session identity and context preparation for isolated cron runs. */
import { isDeepStrictEqual } from "node:util";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import { hasAnyAuthProfileStoreSource } from "../../agents/auth-profiles/source-check.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../agents/runtime-plugins.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { isCronSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
} from "../../sessions/agent-harness-session-key.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { resolveCronSkillsSnapshot } from "../../skills/runtime/cron-snapshot.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveCronJobEffectiveAgentId } from "../agent-id.js";
import type { CronDeliveryPlan } from "../delivery-plan.js";
import { createCronRunDiagnosticsFromError } from "../run-diagnostics.js";
import { resolveCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { isDetachedCronSessionTarget } from "../session-target.js";
import type { CronJob, CronRunDiagnostics } from "../types.js";
import {
  resolveCronModelSelection,
  resolveCronModelSelectionOwner,
  resolveCronThinkingSelection,
} from "./model-selection.js";
import { resolveCronActiveRuntimeConfig, resolveCronAgentConfig } from "./run-config.js";
import { buildCurrentConversationContextBlock } from "./run-current-context.js";
import {
  createCronToolsAllowPreflightDiagnostics,
  type ResolvedCronDeliveryTarget,
  resolveCronDeliveryContext,
} from "./run-delivery-trace.js";
import { resolveCronPreflightCandidates } from "./run-fallback-policy.js";
import {
  appendCronUnattendedRunPreamble,
  hasConfiguredAuthProfiles,
  loadCronAuthProfileRuntime,
  loadCronExternalContentRuntime,
  loadCronModelPreflightRuntime,
  loadSessionAccessorRuntime,
  resolveCronAgentTurnMessage,
  retireRolledCronSessionMcpRuntime,
  type RunCronAgentTurnParams,
  type WithRunSession,
} from "./run-prepare-runtime.js";
import {
  CronSessionLifecycleClaimError,
  createCronRunContinuationSession,
  createPersistCronSessionEntry,
  markCronSessionPreRun,
  persistCronSkillsSnapshotIfChanged,
  projectCronOwnershipFields,
  resolveCronLifecycleRevisionIdentity,
  type CronLiveSelection,
  type CronRunContinuationSession,
  type MutableCronSession,
  type PersistCronSessionEntry,
} from "./run-session-state.js";
import { resolveCronRunTimeoutOverrideMs } from "./run-timeout.js";
import {
  ensureAgentWorkspace,
  isExternalHookSession,
  logWarn,
  mapHookExternalContentSource,
  normalizeAgentId,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentTimeoutMs,
  resolveAgentWorkspaceDir,
  resolveCronStyleNow,
  resolveHookExternalContentSource,
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
  resolveEffectiveAgentRuntime,
  resolveSessionRuntimeOverrideForProvider,
  resolveThinkingDefault,
} from "./run.runtime.js";
import type { RunCronAgentTurnResult } from "./run.types.js";
import { resolveCronAgentSessionKey } from "./session-key.js";
import { loadCronSessionEntryLatest, resolveCronSession } from "./session.js";

export type PreparedCronRunContext = {
  input: RunCronAgentTurnParams;
  cfgWithAgentDefaults: OpenClawConfig;
  agentId: string;
  agentCfg: AgentDefaultsConfig;
  agentDir: string;
  agentSessionKey: string;
  sourceSessionKey?: string;
  runSessionId: string;
  currentRunSessionId: () => string;
  runSessionKey: string;
  usesDetachedRunSession: boolean;
  workspaceDir: string;
  commandBody: string;
  cronSession: MutableCronSession;
  sessionWorkAdmission: SessionWorkAdmissionLease;
  persistSessionEntry: PersistCronSessionEntry;
  runContinuationSession?: CronRunContinuationSession;
  withRunSession: WithRunSession;
  agentPayload: Extract<CronJob["payload"], { kind: "agentTurn" }> | null;
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: ResolvedCronDeliveryTarget;
  deliveryRequested: boolean;
  sourceDelivery: SourceDeliveryPlan;
  suppressExecNotifyOnExit: boolean;
  skillsSnapshot: SkillSnapshot;
  liveSelection: CronLiveSelection;
  useSubagentFallbacks: boolean;
  inheritDefaultFallbacksForAgentStringModel: boolean;
  modelFallbacksOverride?: string[];
  thinkingSelection: Awaited<ReturnType<typeof resolveCronThinkingSelection>>;
  timeoutMs: number;
  preflightDiagnostics?: CronRunDiagnostics;
  /**
   * Set when the cron payload's `timeoutSeconds` was explicitly configured
   * for this run (independent of whether its numeric value happens to equal
   * `agents.defaults.timeoutSeconds`). Forwarded to the embedded runner so
   * the LLM idle watchdog can honor the cron's per-run choice.
   */
  runTimeoutOverrideMs?: number;
  pluginRegistry?: PluginRegistry;
};

type CronPreparationResult =
  | { ok: true; context: PreparedCronRunContext }
  | { ok: false; result: RunCronAgentTurnResult };

export async function prepareCronRunContext(params: {
  input: RunCronAgentTurnParams;
  isFastTestEnv: boolean;
  onLifecycleInterrupt: () => void;
}): Promise<CronPreparationResult> {
  const { input } = params;
  const requestedRuntimeCfg = resolveCronActiveRuntimeConfig(input.cfg);
  const requestedAgentId = input.agentId?.trim() || input.job.agentId?.trim();
  const normalizedRequested = requestedAgentId ? normalizeAgentId(requestedAgentId) : undefined;
  const requiredAgentId =
    normalizedRequested ?? parseAgentSessionKey(input.job.sessionKey ?? input.sessionKey)?.agentId;
  const initialAgentId = resolveCronJobEffectiveAgentId(
    { agentId: requiredAgentId },
    tryResolveAmbientOwnerAgentId(requestedRuntimeCfg),
  );
  const modelOwner = await resolveCronModelSelectionOwner({
    cfg: requestedRuntimeCfg,
    ...(requiredAgentId
      ? {
          agentId: initialAgentId,
          requiredAgentId,
          agentDir: resolveAgentDir(requestedRuntimeCfg, initialAgentId),
          workspaceDir: resolveAgentWorkspaceDir(requestedRuntimeCfg, initialAgentId),
        }
      : {}),
  });
  const agentId = modelOwner.agentId;
  const agentDir = modelOwner.agentDir;
  const agentConfigOverride = requiredAgentId
    ? resolveAgentConfig(modelOwner.config, agentId)
    : undefined;
  const { runtimeConfig: runtimeCfg, agentDefaults: agentCfg } = resolveCronAgentConfig({
    config: modelOwner.config,
    agentConfigOverride,
  });
  const baseSessionKey = (input.sessionKey?.trim() || `cron:${input.job.id}`).trim();
  const currentBoundSourceKey =
    input.job.sessionTarget === "current" ? input.job.sessionKey?.trim() : undefined;
  const usesDetachedRunSession =
    isDetachedCronSessionTarget(input.job.sessionTarget) || Boolean(currentBoundSourceKey);
  const baseSessionKeyIsCron =
    baseSessionKey.startsWith("cron:") || isCronSessionKey(baseSessionKey);
  const cronExecutionSessionKey =
    usesDetachedRunSession && !baseSessionKeyIsCron ? `cron:${input.job.id}` : baseSessionKey;
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: cronExecutionSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const resolvedBaseSessionKey = resolveCronAgentSessionKey({
    sessionKey: currentBoundSourceKey ?? baseSessionKey,
    agentId,
    mainKey: runtimeCfg.session?.mainKey,
    cfg: runtimeCfg,
  });
  const sourceSessionKey =
    currentBoundSourceKey && resolvedBaseSessionKey !== agentSessionKey
      ? resolvedBaseSessionKey
      : undefined;
  const payloadHookExternalContentSource =
    input.job.payload.kind === "agentTurn" ? input.job.payload.externalContentSource : undefined;
  const hookExternalContentSource =
    payloadHookExternalContentSource ?? resolveHookExternalContentSource(baseSessionKey);

  const workspace = await ensureAgentWorkspace({
    dir: modelOwner.workspaceDir,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !params.isFastTestEnv,
    skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
  });
  const workspaceDir = workspace.dir;

  const isGmailHook = hookExternalContentSource === "gmail";
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: runtimeCfg,
    sessionKey: agentSessionKey,
    sourceSessionKey,
    agentId,
    nowMs: now,
    forceNew: usesDetachedRunSession,
    hookExternalContentSource,
  });
  const reservedKey = isAgentHarnessSessionKey(agentSessionKey);
  if (cronSession.initialSessionEntry?.modelSelectionLocked === true) {
    throw new Error(
      reservedKey
        ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
        : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
    );
  }
  if (reservedKey && !cronSession.initialSessionEntry) {
    throw new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
  }
  const runSessionId = cronSession.sessionEntry.sessionId;
  const currentRunSessionId = () => cronSession.sessionEntry.sessionId ?? runSessionId;
  const usesExactRunSession = usesDetachedRunSession || baseSessionKey.startsWith("cron:");
  const runSessionKey = usesExactRunSession
    ? `${agentSessionKey}:run:${runSessionId}`
    : agentSessionKey;
  const initialSessionEntry = cronSession.initialSessionEntry;
  // Claim before async model prep so maintenance cannot delete this session generation.
  const sessionWorkAdmission = await beginSessionWorkAdmission({
    scope: cronSession.storePath,
    identities: [
      agentSessionKey,
      initialSessionEntry?.sessionId,
      cronSession.sessionEntry.sessionId,
      resolveCronLifecycleRevisionIdentity(cronSession.lifecycleRevision),
      runSessionKey,
    ],
    signal: input.abortSignal ?? input.signal,
    onInterrupt: params.onLifecycleInterrupt,
    assertAllowed: () => {
      const currentEntry = loadCronSessionEntryLatest(cronSession.storePath, agentSessionKey);
      const changed = initialSessionEntry
        ? !currentEntry ||
          !isDeepStrictEqual(
            projectCronOwnershipFields(currentEntry),
            projectCronOwnershipFields(initialSessionEntry),
          )
        : Boolean(currentEntry);
      if (changed) {
        throw new CronSessionLifecycleClaimError(agentSessionKey);
      }
      const archivedSessionError = resolveSessionWorkStartError(agentSessionKey, currentEntry);
      if (archivedSessionError) {
        throw new CronSessionLifecycleClaimError(agentSessionKey, archivedSessionError);
      }
    },
  });

  try {
    const persistCronSessionRow = async ({
      storePath,
      sessionKey,
      fallbackEntry,
      resetBoundaryReason,
      update,
    }: {
      storePath: string;
      sessionKey: string;
      fallbackEntry: SessionEntry;
      resetBoundaryReason?: "cron-stale";
      update: (entry: SessionEntry | undefined) => SessionEntry;
    }) => {
      const { applySessionEntryLifecycleMutation, patchSessionEntryCore } =
        await loadSessionAccessorRuntime();
      if (resetBoundaryReason) {
        await applySessionEntryLifecycleMutation({
          activeSessionKey: sessionKey,
          agentId,
          storePath,
          upserts: [
            {
              sessionKey,
              resetBoundaryReason,
              buildEntry: ({ currentEntry }) => update(currentEntry),
            },
          ],
          skipMaintenance: true,
        });
        return;
      }
      // Guarded replace reads the freshest row so lifecycle claims reject stale owners.
      await patchSessionEntryCore(
        { storePath, sessionKey, agentId },
        (_entry, context) => update(context.existingEntry),
        { fallbackEntry, replaceEntry: true },
      );
    };
    const persistSessionEntry = createPersistCronSessionEntry({
      cronSession,
      agentSessionKey,
      createdActor: input.job.createdActor,
      persistSessionEntry: persistCronSessionRow,
    });
    const withRunSession: WithRunSession = (result) => ({
      ...result,
      sessionId: currentRunSessionId(),
      sessionKey: runSessionKey,
    });
    if (!cronSession.sessionEntry.label?.trim() && baseSessionKey.startsWith("cron:")) {
      const labelSuffix =
        typeof input.job.name === "string" && input.job.name.trim()
          ? input.job.name.trim()
          : input.job.id;
      cronSession.sessionEntry.label = `Automation: ${labelSuffix}`;
    }

    const resolvedModelSelection = await resolveCronModelSelection({
      cfg: runtimeCfg,
      owner: modelOwner,
      agentConfigOverride,
      sessionEntry: cronSession.sessionEntry,
      payload: input.job.payload,
      isGmailHook,
      agentId,
      agentDir,
      workspaceDir,
    });
    if (!resolvedModelSelection.ok) {
      sessionWorkAdmission.release();
      return {
        ok: false,
        result: withRunSession({
          status: "error",
          error: resolvedModelSelection.error,
          diagnostics: createCronRunDiagnosticsFromError(
            "cron-preflight",
            resolvedModelSelection.error,
          ),
        }),
      };
    }
    const cfgWithAgentDefaults = resolvedModelSelection.cfgWithAgentDefaults;
    const ownerAgentConfig = resolveAgentConfig(modelOwner.config, modelOwner.agentId);
    const matchesDefaultFallbackAgentStringModel =
      typeof ownerAgentConfig?.model === "string" &&
      resolveAgentModelPrimaryValue(ownerAgentConfig.model) ===
        resolveAgentModelPrimaryValue(modelOwner.config.agents?.defaults?.model);
    let provider = resolvedModelSelection.provider;
    let model = resolvedModelSelection.model;
    const useSubagentFallbacks = resolvedModelSelection.modelSource === "subagent";
    const inheritDefaultFallbacksForAgentStringModel =
      matchesDefaultFallbackAgentStringModel &&
      (resolvedModelSelection.modelSource === "default" ||
        resolvedModelSelection.modelSource === "agent");

    const modelPreflightRuntime = await loadCronModelPreflightRuntime();
    const preflightCandidates = resolveCronPreflightCandidates({
      cfg: cfgWithAgentDefaults,
      job: input.job,
      agentId: modelOwner.agentId,
      provider,
      model,
      useSubagentFallbacks,
      inheritDefaultFallbacksForAgentStringModel,
    });
    let selectedPreflightCandidate: { provider: string; model: string } | undefined;
    let selectedPreflightCandidateIndex = -1;
    let firstUnavailablePreflight:
      | Awaited<ReturnType<typeof modelPreflightRuntime.preflightCronModelProvider>>
      | undefined;
    for (const [index, candidate] of preflightCandidates.entries()) {
      const candidatePreflight = await modelPreflightRuntime.preflightCronModelProvider({
        cfg: cfgWithAgentDefaults,
        provider: candidate.provider,
        model: candidate.model,
      });
      if (candidatePreflight.status === "available") {
        selectedPreflightCandidate = candidate;
        selectedPreflightCandidateIndex = index;
        break;
      }
      firstUnavailablePreflight ??= candidatePreflight;
    }
    if (!selectedPreflightCandidate && firstUnavailablePreflight?.status === "unavailable") {
      logWarn(`[cron:${input.job.id}] ${firstUnavailablePreflight.reason}`);
      sessionWorkAdmission.release();
      return {
        ok: false,
        result: withRunSession({
          status: "skipped",
          error: firstUnavailablePreflight.reason,
          diagnostics: createCronRunDiagnosticsFromError(
            "model-preflight",
            firstUnavailablePreflight.reason,
            {
              severity: "warn",
            },
          ),
          provider,
          model,
        }),
      };
    }
    const modelFallbacksOverride =
      selectedPreflightCandidate &&
      (selectedPreflightCandidate.provider !== provider ||
        selectedPreflightCandidate.model !== model)
        ? preflightCandidates
            .slice(selectedPreflightCandidateIndex + 1)
            .map((candidate) => `${candidate.provider}/${candidate.model}`)
        : undefined;
    // When preflight skips the first local candidate, start at the reachable provider.
    if (selectedPreflightCandidate && modelFallbacksOverride) {
      if (firstUnavailablePreflight?.status === "unavailable") {
        logWarn(
          `[cron:${input.job.id}] ${firstUnavailablePreflight.reason}; continuing with fallback ${selectedPreflightCandidate.provider}/${selectedPreflightCandidate.model}.`,
        );
      }
      provider = selectedPreflightCandidate.provider;
      model = selectedPreflightCandidate.model;
    }
    const thinkingSelection = await resolveCronThinkingSelection({
      cfg: cfgWithAgentDefaults,
      owner: modelOwner,
      provider,
      model,
      jobThinking: input.job.payload.kind === "agentTurn" ? input.job.payload.thinking : undefined,
      hookThinking: isGmailHook ? runtimeCfg.hooks?.gmail?.thinking : undefined,
      sessionThinking: cronSession.sessionEntry.thinkingLevel,
    });
    const effectiveAgentRuntime = resolveEffectiveAgentRuntime({
      cfg: cfgWithAgentDefaults,
      provider,
      modelId: model,
      agentId: modelOwner.agentId,
      sessionKey: agentSessionKey,
      sessionEntry: cronSession.sessionEntry,
    });
    let requestedThinkLevel = thinkingSelection.requestedThinkLevel;
    if (!requestedThinkLevel) {
      requestedThinkLevel = resolveThinkingDefault({
        cfg: cfgWithAgentDefaults,
        provider,
        model,
        catalog: thinkingSelection.catalog,
        agentRuntime: effectiveAgentRuntime,
      });
    }
    if (
      !isThinkingLevelSupported({
        provider,
        model,
        level: requestedThinkLevel,
        catalog: thinkingSelection.catalog,
        agentRuntime: effectiveAgentRuntime,
      })
    ) {
      const fallbackThinkLevel = resolveSupportedThinkingLevel({
        provider,
        model,
        level: requestedThinkLevel,
        catalog: thinkingSelection.catalog,
        agentRuntime: effectiveAgentRuntime,
      });
      if (fallbackThinkLevel !== requestedThinkLevel) {
        logWarn(
          `[cron:${input.job.id}] Thinking level "${requestedThinkLevel}" is not supported for ${provider}/${model}; using "${fallbackThinkLevel}" for this candidate.`,
        );
      }
    }

    const explicitTimeoutSeconds =
      input.job.payload.kind === "agentTurn" ? input.job.payload.timeoutSeconds : undefined;
    const timeoutMs = resolveAgentTimeoutMs({
      cfg: cfgWithAgentDefaults,
      overrideSeconds: explicitTimeoutSeconds,
    });
    // Preserve explicit timeout provenance so the idle watchdog does not reapply 120s when defaults match.
    const runTimeoutOverrideMs = resolveCronRunTimeoutOverrideMs(explicitTimeoutSeconds);
    const agentPayload = input.job.payload.kind === "agentTurn" ? input.job.payload : null;
    const configuredProvider = cfgWithAgentDefaults.models?.providers?.[provider];
    const modelApi =
      findModelInCatalog(thinkingSelection.catalog, provider, model)?.api ??
      configuredProvider?.models?.find((candidate) => candidate.id === model)?.api ??
      configuredProvider?.api;
    const preflightDiagnostics = await createCronToolsAllowPreflightDiagnostics({
      cfg: cfgWithAgentDefaults,
      jobId: input.job.id,
      provider,
      model,
      modelApi,
      agentId: modelOwner.agentId,
      agentDir: modelOwner.agentDir,
      workspaceDir,
      sessionKey: agentSessionKey,
      agentPayload,
      agentRuntime: effectiveAgentRuntime,
      toolsAllowProvenance: input.job.toolsAllowProvenance,
    });
    const { deliveryPlan, deliveryRequested, resolvedDelivery, sourceDelivery } =
      await resolveCronDeliveryContext({
        cfg: cfgWithAgentDefaults,
        job: input.job,
        agentId,
      });

    const { formattedTime, timeLine } = resolveCronStyleNow(runtimeCfg, now);
    const originalMessage = resolveCronAgentTurnMessage(input);
    const sourceSessionEntry = sourceSessionKey ? cronSession.store[sourceSessionKey] : undefined;
    // Current jobs stay detached; a bounded tail preserves context without transcript continuation.
    const currentConversationContext =
      input.job.sessionTarget === "current" &&
      agentPayload &&
      sourceSessionKey &&
      sourceSessionEntry
        ? await buildCurrentConversationContextBlock({
            agentId,
            sourceSessionEntry,
            sourceSessionKey,
            storePath: cronSession.storePath,
          })
        : undefined;
    const message = currentConversationContext
      ? `${currentConversationContext}\n\n${originalMessage}`
      : originalMessage;
    const base = `[cron:${input.job.id} ${input.job.name}] ${message}`.trim();
    const isExternalHook =
      hookExternalContentSource !== undefined || isExternalHookSession(baseSessionKey);
    const allowUnsafeExternalContent =
      agentPayload?.allowUnsafeExternalContent === true ||
      (isGmailHook && input.cfg.hooks?.gmail?.allowUnsafeExternalContent === true);
    const shouldWrapExternal = isExternalHook && !allowUnsafeExternalContent;
    let commandBody: string;

    if (isExternalHook) {
      const { detectSuspiciousPatterns } = await loadCronExternalContentRuntime();
      const suspiciousPatterns = detectSuspiciousPatterns(message);
      if (suspiciousPatterns.length > 0) {
        logWarn(
          `[security] Suspicious patterns detected in external hook content ` +
            `(session=${baseSessionKey}, patterns=${suspiciousPatterns.length}): ${suspiciousPatterns.slice(0, 3).join(", ")}`,
        );
      }
    }

    if (shouldWrapExternal) {
      const { buildSafeExternalPrompt } = await loadCronExternalContentRuntime();
      const hookType = mapHookExternalContentSource(hookExternalContentSource ?? "webhook");
      const safeContent = buildSafeExternalPrompt({
        content: message,
        source: hookType,
        jobName: input.job.name,
        jobId: input.job.id,
        timestamp: formattedTime,
      });
      commandBody = `${safeContent}\n\n${timeLine}`.trim();
    } else {
      commandBody = `${base}\n${timeLine}`.trim();
    }
    commandBody = appendCronUnattendedRunPreamble(commandBody, { externalHook: isExternalHook });

    const skillsSnapshot = await resolveCronSkillsSnapshot({
      workspaceDir,
      config: cfgWithAgentDefaults,
      agentId,
      existingSnapshot: cronSession.sessionEntry.skillsSnapshot,
      isFastTestEnv: params.isFastTestEnv,
    });
    await persistCronSkillsSnapshotIfChanged({
      isFastTestEnv: params.isFastTestEnv,
      cronSession,
      skillsSnapshot,
      nowMs: Date.now(),
      persistSessionEntry,
    });

    markCronSessionPreRun({ entry: cronSession.sessionEntry, provider, model });
    try {
      await persistSessionEntry();
    } catch (err) {
      if (err instanceof CronSessionLifecycleClaimError) {
        throw err;
      }
      logWarn(`[cron:${input.job.id}] Failed to persist pre-run session entry: ${String(err)}`);
    }
    await retireRolledCronSessionMcpRuntime({
      job: input.job,
      cronSession,
    });
    const storedAuthProfileId = cronSession.sessionEntry.authProfileOverride?.trim();
    const hasSessionAuthProfileOverride = Boolean(storedAuthProfileId);
    const authSelection =
      !hasSessionAuthProfileOverride &&
      !hasConfiguredAuthProfiles(cfgWithAgentDefaults) &&
      !hasAnyAuthProfileStoreSource(agentDir)
        ? undefined
        : await (
            await loadCronAuthProfileRuntime()
          ).resolveSessionAuthSelection({
            // Auth resolution may mutate session state; use the store/key persistence will write.
            cfg: cfgWithAgentDefaults,
            provider,
            modelId: model,
            harnessRuntime: effectiveAgentRuntime,
            agentDir,
            sessionEntry: cronSession.sessionEntry,
            sessionStore: cronSession.store,
            sessionKey: agentSessionKey,
            storePath: cronSession.storePath,
            isNewSession: cronSession.isNewSession && input.job.sessionTarget !== "isolated",
          });
    const authProfileId = authSelection?.profileId;
    const liveSelection: CronLiveSelection = {
      provider,
      model,
      agentRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
        provider,
        entry: cronSession.sessionEntry,
        cfg: cfgWithAgentDefaults,
      }),
      authProfileId,
      authProfileIdSource: authSelection?.source,
    };
    const runtimePluginCandidates =
      selectedPreflightCandidateIndex >= 0
        ? preflightCandidates.slice(selectedPreflightCandidateIndex)
        : preflightCandidates;
    const pluginRegistry = loadAgentRuntimePluginRegistryHandle({
      config: cfgWithAgentDefaults,
      workspaceDir,
      allowGatewaySubagentBinding: true,
      selections: runtimePluginCandidates.map((candidate) => {
        const runtime = resolveSessionRuntimeOverrideForProvider({
          provider: candidate.provider,
          entry: cronSession.sessionEntry,
          cfg: cfgWithAgentDefaults,
        });
        return runtime
          ? { provider: candidate.provider, modelId: candidate.model, runtime, agentId }
          : { provider: candidate.provider, modelId: candidate.model, agentId };
      }),
    });
    const runContinuationSession = usesExactRunSession
      ? createCronRunContinuationSession({
          cronSession,
          runSessionKey,
          createdActor: input.job.createdActor,
          thinkingLevel: requestedThinkLevel,
          toolsAllow: agentPayload?.toolsAllow,
          toolsAllowIsDefault: agentPayload?.toolsAllowIsDefault,
          scheduledToolPolicy: resolveCronScheduledToolPolicy({
            toolsAllow: agentPayload?.toolsAllow,
            scheduledToolPolicy: input.job.scheduledToolPolicy,
            owner: input.job.owner,
          }),
          scheduledToolCallerOrigin: input.job.toolsAllowProvenance?.callerOrigin,
          cliSessionBindingFacts: {
            sourceReplyDeliveryMode: sourceDelivery.sourceReplyDeliveryMode,
            requireExplicitMessageTarget: sourceDelivery.messageTool.requireExplicitTarget,
          },
          persistSessionEntry: persistCronSessionRow,
        })
      : undefined;
    await runContinuationSession?.initialize();

    return {
      ok: true,
      context: {
        input,
        cfgWithAgentDefaults,
        agentId,
        agentCfg,
        agentDir,
        agentSessionKey,
        sourceSessionKey,
        runSessionId,
        currentRunSessionId,
        runSessionKey,
        usesDetachedRunSession,
        workspaceDir,
        commandBody,
        cronSession,
        sessionWorkAdmission,
        persistSessionEntry,
        runContinuationSession,
        withRunSession,
        agentPayload,
        deliveryPlan,
        resolvedDelivery,
        deliveryRequested,
        sourceDelivery,
        suppressExecNotifyOnExit: deliveryPlan.mode === "none",
        skillsSnapshot,
        liveSelection,
        useSubagentFallbacks,
        inheritDefaultFallbacksForAgentStringModel,
        modelFallbacksOverride,
        thinkingSelection,
        timeoutMs,
        preflightDiagnostics,
        runTimeoutOverrideMs,
        ...(pluginRegistry ? { pluginRegistry } : {}),
      },
    };
  } catch (error) {
    sessionWorkAdmission.release();
    throw error;
  }
}
