/** Session identity and context preparation for isolated cron runs. */
import { isDeepStrictEqual } from "node:util";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  PreparedModelRuntimeOwnerNotPublishedError,
  type PreparedModelRuntimeLease,
} from "../../agents/prepared-model-runtime.js";
import { preparedModelRuntimeConfigsMatch } from "../../agents/prepared-model-runtime.owner.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCreatorSandbox } from "../../gateway/operator-role-policy.js";
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
import { resolveCronCommandPromptPreflight } from "./run-command-preflight.js";
import { resolveCronActiveRuntimeConfig, resolveCronAgentConfig } from "./run-config.js";
import { buildCurrentConversationContextBlock } from "./run-current-context.js";
import {
  createCronToolsAllowPreflightDiagnostics,
  type ResolvedCronDeliveryTarget,
  resolveCronDeliveryContext,
} from "./run-delivery-trace.js";
import { resolveCronPreflight } from "./run-fallback-policy.js";
import {
  appendCronUnattendedRunPreamble,
  resolveCronAuthSelection,
  loadCronExternalContentRuntime,
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
  sourceSessionGeneration?: { sessionId: string; lifecycleRevision: string | undefined };
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
  preparedModelRuntimeLease: PreparedModelRuntimeLease;
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
  const commandPromptPreflight = resolveCronCommandPromptPreflight(input.job);
  if (commandPromptPreflight) {
    return { ok: false, result: commandPromptPreflight };
  }
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
  const { agentId, agentDir } = modelOwner;
  const publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({
    agentId,
    abortSignal: input.abortSignal ?? input.signal,
  });
  if (
    publishedRuntime &&
    (publishedRuntime.pluginGeneration.pluginMetadataSnapshot !== modelOwner.metadataSnapshot ||
      !preparedModelRuntimeConfigsMatch(publishedRuntime.config, modelOwner.config))
  ) {
    throw new PreparedModelRuntimeOwnerNotPublishedError(
      "cron model runtime generation was superseded during preparation",
    );
  }
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
    provisioning: await (
      await import("../../agents/acp-workspace-provisioning.js")
    ).resolveAcpAgentWorkspaceProvisioningForTurn({ cfg: runtimeCfg, agentId }),
  });
  const workspaceDir = workspace.dir;

  const isGmailHook = hookExternalContentSource === "gmail";
  const now = Date.now();
  const sandbox = resolveCreatorSandbox(runtimeCfg, { actor: input.job.createdActor });
  const cronSession = resolveCronSession({
    cfg: runtimeCfg,
    sessionKey: agentSessionKey,
    sourceSessionKey,
    agentId,
    nowMs: now,
    forceNew: usesDetachedRunSession,
    hookExternalContentSource,
  });
  const sourceEntry = sourceSessionKey ? cronSession.store[sourceSessionKey] : undefined;
  const sourceSessionGeneration = sourceEntry
    ? { sessionId: sourceEntry.sessionId, lifecycleRevision: sourceEntry.lifecycleRevision }
    : undefined;
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

  let preparedModelRuntimeLease: PreparedModelRuntimeLease | undefined;
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
              resetBoundary: { context: "preserve-tail", reason: resetBoundaryReason },
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
      sandbox,
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
    const useSubagentFallbacks = resolvedModelSelection.modelSource === "subagent";
    const inheritDefaultFallbacksForAgentStringModel =
      matchesDefaultFallbackAgentStringModel &&
      (resolvedModelSelection.modelSource === "default" ||
        resolvedModelSelection.modelSource === "agent");

    const preflight = await resolveCronPreflight({
      cfg: cfgWithAgentDefaults,
      job: input.job,
      agentId: modelOwner.agentId,
      provider: resolvedModelSelection.provider,
      model: resolvedModelSelection.model,
      useSubagentFallbacks,
      inheritDefaultFallbacksForAgentStringModel,
    });
    if (!preflight.ok) {
      logWarn(`[cron:${input.job.id}] ${preflight.reason}`);
      sessionWorkAdmission.release();
      return {
        ok: false,
        result: withRunSession({
          status: "skipped",
          error: preflight.reason,
          diagnostics: createCronRunDiagnosticsFromError("model-preflight", preflight.reason, {
            severity: "warn",
          }),
          provider: resolvedModelSelection.provider,
          model: resolvedModelSelection.model,
        }),
      };
    }
    const { provider, model, modelFallbacksOverride, runtimePluginCandidates } = preflight;
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
    // Current jobs stay detached; a bounded tail preserves context without transcript continuation.
    const currentConversationContext =
      input.job.sessionTarget === "current" && agentPayload && sourceSessionKey && sourceEntry
        ? await buildCurrentConversationContextBlock({
            agentId,
            sourceSessionEntry: sourceEntry,
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
      if (sandbox === "required" || cronSession.sessionEntry.sandbox === "required") {
        throw err;
      }
    }
    await retireRolledCronSessionMcpRuntime({
      job: input.job,
      cronSession,
    });
    const authSelection = await resolveCronAuthSelection({
      cfg: cfgWithAgentDefaults,
      provider,
      modelId: model,
      ...(provider === resolvedModelSelection.provider && resolvedModelSelection.configuredProfileId
        ? { configuredProfileId: resolvedModelSelection.configuredProfileId }
        : {}),
      harnessRuntime: effectiveAgentRuntime,
      agentDir,
      cronSession,
      sessionKey: agentSessionKey,
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
    preparedModelRuntimeLease = await acquireAgentRunPreparedModelRuntime(
      {
        // Embedded execution borrows this exact per-agent config projection.
        // Keep the published generation pinned without dropping cron's defaults.
        config: cfgWithAgentDefaults,
        agentId,
        agentDir,
        workspaceDir,
        allowGatewaySubagentBinding: true,
        runtimePluginSelections: runtimePluginCandidates.map((candidate) => {
          const runtime = resolveSessionRuntimeOverrideForProvider({
            provider: candidate.provider,
            entry: cronSession.sessionEntry,
            cfg: cfgWithAgentDefaults,
          });
          return runtime
            ? { provider: candidate.provider, modelId: candidate.model, runtime, agentId }
            : { provider: candidate.provider, modelId: candidate.model, agentId };
        }),
      },
      {
        catalogMode: "static",
        ...(publishedRuntime
          ? { pluginGeneration: publishedRuntime.pluginGeneration }
          : { pluginMetadataSnapshot: modelOwner.metadataSnapshot }),
        abortSignal: input.abortSignal ?? input.signal,
      },
    );
    const runContinuationSession = usesExactRunSession
      ? createCronRunContinuationSession({
          cronSession,
          runSessionKey,
          createdActor: input.job.createdActor,
          sandbox,
          thinkingLevel: requestedThinkLevel,
          toolsAllow: agentPayload?.toolsAllow,
          toolsAllowIsDefault: agentPayload?.toolsAllowIsDefault,
          scheduledToolPolicy: resolveCronScheduledToolPolicy({
            toolsAllow: agentPayload?.toolsAllow,
            scheduledToolPolicy: input.job.scheduledToolPolicy,
            owner: input.job.owner,
          }),
          scheduledToolCallerOrigin: input.job.toolsAllowProvenance?.callerOrigin,
          toolsAllowExecTarget: input.job.toolsAllowExecTarget,
          toolsAllowExecTargetRequirement: input.job.toolsAllowExecTargetRequirement,
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
        sourceSessionGeneration,
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
        pluginRegistry: preparedModelRuntimeLease.snapshot.pluginRegistry,
        preparedModelRuntimeLease,
      },
    };
  } catch (error) {
    preparedModelRuntimeLease?.release();
    sessionWorkAdmission.release();
    throw error;
  }
}
