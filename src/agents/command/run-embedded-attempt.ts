import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
  isModelSelectionLocked,
} from "../../sessions/model-overrides.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import type { prepareAgentCommandExecutionIdentity } from "../agent-command-execution-identity.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  markAutoFallbackPrimaryProbe,
  resolveEffectiveModelFallbacks,
} from "../agent-scope.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import {
  runEmbeddedAgentEntry,
  type EmbeddedAgentRunEntryTerminal,
} from "../embedded-agent-runner/run-entry.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { CompactionAccountingFact } from "../embedded-agent-runner/run/internal-params.js";
import { resolveFastModeState } from "../fast-mode.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { prepareInternalSessionEffectsSession } from "../internal-session-effects.js";
import { LiveSessionModelSwitchError } from "../live-model-switch.js";
import { prepareModelRunCapabilities } from "../model-catalog-lookup.js";
import { modelKey, resolveThinkingDefault } from "../model-selection.js";
import { resolveConfiguredThinkingDefault } from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import {
  isAgentRunRestartAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import { resolveSessionRuntimeOverrideForProvider } from "../session-runtime-compat.js";
import { measureAgentStartup } from "../startup-timing.js";
import {
  normalizeThinkingCatalogProviders,
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
  needsThinkHydration,
} from "../thinking-runtime.js";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import { createCommandCompactionAccounting } from "./compaction-accounting.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";
import { normalizeAgentCommandModelRef } from "./model-ref.js";
import type { EmbeddedModelSelection } from "./model-selection.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import { loadAttemptExecutionRuntime, type AgentAttemptResult } from "./runtime-loaders.js";
import { resolveInternalSessionEffectsSource } from "./session-helpers.js";
import type { EmbeddedSessionState } from "./session-preparation.js";
import type { AgentCommandOpts } from "./types.js";
const log = createSubsystemLogger("agents/agent-command");
const MAX_LIVE_SWITCH_RETRIES = 5;

export async function runEmbeddedAgentAttempt(params: {
  preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity>;
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  lifecycleGeneration: string;
  onLifecycleGenerationChanged: (lifecycleGeneration: string) => void;
  onCompactionAccounting?: (fact: CompactionAccountingFact) => void;
  suppressVisibleSessionEffects: boolean;
  preserveUserFacingSessionModelState: boolean;
  modelSelection: EmbeddedModelSelection;
  embeddedSessionState: EmbeddedSessionState;
  trackInternalModelRunTarget: (target: AgentRunSessionTarget | undefined) => void;
}) {
  const {
    cfg,
    body,
    transcriptBody,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionAgentId,
    workspaceDir,
    cwd,
    agentDir,
    runId,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
    normalizedSpawned,
    isNewSession,
    timeoutMs,
    runTimeoutOverrideMs,
  } = params.prepared;
  const { runContext, skillsSnapshot, resolvedVerboseLevel } = params.embeddedSessionState;
  const {
    defaultProvider,
    defaultModel,
    configuredDefaultAuthProfileId,
    visibilityPolicy,
    hasExplicitRunOverride,
    storedProviderOverride,
    hasStoredAutoFallbackProvenance,
    autoFallbackPrimaryProbe,
    immutableThinkLevel,
    sessionFile,
  } = params.modelSelection;
  let {
    provider,
    model,
    providerForAuthProfileValidation,
    sessionEntryForAttempt,
    storedModelOverride,
    storedModelOverrideSource,
    effectiveTurnThinkLevel,
  } = params.modelSelection;
  const thinkingCatalog = params.modelSelection.thinkingCatalog;
  let sessionEntry = params.sessionEntry;
  let lifecycleGeneration = params.lifecycleGeneration;

  const sessionEffectsSource = resolveInternalSessionEffectsSource({
    agentId: sessionAgentId,
    sessionId,
    sessionKey,
    storePath,
  });
  const internalSessionTarget = params.suppressVisibleSessionEffects
    ? await prepareInternalSessionEffectsSession({
        agentId: sessionAgentId,
        cwd: cwd ?? workspaceDir,
        runId,
        source: sessionEffectsSource,
        storePath,
      })
    : undefined;
  params.trackInternalModelRunTarget(internalSessionTarget);
  let attemptSessionTarget =
    internalSessionTarget ??
    (sessionKey && storePath
      ? {
          agentId: sessionAgentId,
          sessionId,
          sessionKey,
          storePath,
        }
      : undefined);
  const attemptSessionFile = internalSessionTarget?.sessionFile ?? sessionFile;

  const startedAt = Date.now();
  const attemptLifecycleState: AgentAttemptLifecycleState = {
    currentTurnUserMessagePersisted: false,
    lifecycleFinishing: false,
    lifecycleEnded: false,
  };
  const attemptLifecycleCallbacks = createAgentAttemptLifecycleCallbacks(
    attemptLifecycleState,
    params.preparedRunAdmission.onRuntimeTurnStarted,
  );
  const transcriptMedia = params.opts.transcriptMedia ?? [];
  const hasTranscriptMedia = transcriptMedia.length > 0;
  const suppressUserTurnPersistence =
    params.opts.suppressPromptPersistence === true ||
    (params.opts.transcriptMessage === "" && !hasTranscriptMedia);
  const recorderTranscriptText = transcriptBody || undefined;
  const userTurnTranscriptRecorder =
    (internalSessionTarget ? undefined : params.opts.userTurnTranscriptRecorder) ??
    createUserTurnTranscriptRecorder({
      ...(!suppressUserTurnPersistence && (recorderTranscriptText || hasTranscriptMedia)
        ? {
            input: {
              text: recorderTranscriptText,
              ...(hasTranscriptMedia ? { media: transcriptMedia } : {}),
              senderIsOwner: params.opts.senderIsOwner,
              ...(params.opts.inputProvenance ? { provenance: params.opts.inputProvenance } : {}),
            },
          }
        : {}),
      target: {
        sessionId: internalSessionTarget?.sessionId ?? sessionId,
        agentId: internalSessionTarget?.agentId ?? sessionAgentId,
        sessionKey: internalSessionTarget?.sessionKey ?? sessionKey ?? sessionId,
        sessionEntry: internalSessionTarget?.sessionEntry ?? sessionEntry,
        sessionStore: params.suppressVisibleSessionEffects ? undefined : sessionStore,
        storePath: internalSessionTarget?.storePath ?? storePath,
        cwd: cwd ?? workspaceDir,
        config: cfg,
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      errorContext: "agent command user turn transcript",
    });
  if (suppressUserTurnPersistence) {
    userTurnTranscriptRecorder.markBlocked();
  }
  const lifecycle = createAgentCommandLifecycle({
    runId,
    lifecycleGeneration: () => lifecycleGeneration,
    startedAt,
    abortSignal: params.opts.abortSignal,
    state: attemptLifecycleState,
  });
  const attemptExecutionRuntime = await measureAgentStartup(
    "attempt-runtime-import",
    () => loadAttemptExecutionRuntime(),
    { config: cfg },
  );
  const messageChannel = resolveMessageChannel(
    runContext.messageChannel,
    params.opts.replyChannel ?? params.opts.channel,
  );

  let result: AgentAttemptResult;
  const compactionAccounting = createCommandCompactionAccounting({
    sessionStore,
    persistCounts:
      !params.suppressVisibleSessionEffects && !params.preserveUserFacingSessionModelState,
    onDurableFact: (fact) => {
      attemptSessionTarget = fact.target;
      params.trackInternalModelRunTarget(fact.target);
      params.onCompactionAccounting?.(fact);
    },
    refreshSessionEntry: (key) => {
      sessionEntry = sessionStore?.[key] ?? sessionEntry;
      sessionEntryForAttempt = sessionEntry;
    },
  });
  let maintenanceAuthProfile:
    | { authProfileId?: string; authProfileIdSource?: "auto" | "user" }
    | undefined;
  let fallbackProvider = provider;
  let fallbackModel = model;
  let fallbackExhausted = false;
  let terminal: EmbeddedAgentRunEntryTerminal;
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
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId,
    agentId: sessionAgentId,
    sessionId,
    sessionKey,
    sessionFile: attemptSessionFile,
    abortSignal: params.opts.abortSignal,
  });
  const logicalTurnOpts = { ...params.opts, abortSignal: deferredLifecycle.signal };
  let liveSwitchMediaTaskIds: ReadonlySet<string> = new Set();
  for (;;) {
    try {
      liveSwitchMediaTaskIds = sessionKey
        ? getGeneratedMediaTaskIdsForSessionKey(sessionKey)
        : new Set<string>();
      const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
      const effectiveFallbacksOverride = isModelSelectionLocked(sessionEntry)
        ? []
        : (params.opts.modelFallbacksOverride ??
          resolveEffectiveModelFallbacks({
            cfg,
            agentId: sessionAgentId,
            sessionKey,
            hasSessionModelOverride:
              hasExplicitRunOverride || Boolean(storedProviderOverride || storedModelOverride),
            modelOverrideSource: hasExplicitRunOverride ? "user" : storedModelOverrideSource,
            hasAutoFallbackProvenance: hasExplicitRunOverride
              ? false
              : hasStoredAutoFallbackProvenance,
          }));

      const fallbackRuntimeState: { originRuntime?: "cli" | "embedded" } = {};
      attemptLifecycleState.currentTurnUserMessagePersisted = false;
      let attemptMediaTaskIds = liveSwitchMediaTaskIds;
      const currentAttemptCommittedCronMedia = () =>
        Boolean(
          sessionKey && hasNewGeneratedMediaTaskForSessionKey(sessionKey, attemptMediaTaskIds),
        );
      const fallbackResult = await runEmbeddedAgentEntry<AgentAttemptResult>({
        selection: {
          cfg,
          provider,
          model,
          requestedRouteResolution: params.modelSelection.requestedRouteResolution,
          agentDir,
          fallbacksOverride: effectiveFallbacksOverride,
          userLockedAuthProfileId:
            resolveSessionAuthProfileOverrideSource(sessionEntryForAttempt) === "user"
              ? sessionEntryForAttempt?.authProfileOverride
              : undefined,
          ...modelManifestContext,
        },
        identity: {
          runId,
          agentId: sessionAgentId,
          sessionId,
          sessionKey: sessionKey ?? sessionId,
        },
        harness: {
          workspaceDir,
          sessionKey,
          preparation: { kind: "direct" },
          resolveRuntimeOverride: (candidateProvider) =>
            resolveSessionRuntimeOverrideForProvider({
              provider: candidateProvider,
              entry: sessionEntryForAttempt,
              cfg,
            }),
        },
        behavior: {
          kind: "command-rpc",
          hasCommittedSideEffect: currentAttemptCommittedCronMedia,
        },
        sessionOverride: {
          kind: "reconcile-completed",
          reconcile: async ({ provider: winnerProvider, model: winnerModel }) => {
            if (
              !autoFallbackPrimaryProbe ||
              autoFallbackPrimaryProbeInterruptedByLiveSwitch ||
              !sessionEntry ||
              !sessionStore ||
              !sessionKey ||
              isModelSelectionLocked(sessionEntry) ||
              params.suppressVisibleSessionEffects ||
              params.preserveUserFacingSessionModelState ||
              !entryMatchesAutoFallbackPrimaryProbe(sessionEntry, autoFallbackPrimaryProbe) ||
              winnerProvider !== autoFallbackPrimaryProbe.provider ||
              winnerModel !== autoFallbackPrimaryProbe.model
            ) {
              return;
            }
            const nextSessionEntry = { ...sessionEntry };
            clearAutoFallbackPrimaryProbeSelection(nextSessionEntry);
            sessionEntry = await persistAgentSession({
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
          },
        },
        abortSignal: deferredLifecycle.signal,
        onFallbackStep: (step) => {
          fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step);
        },
        runCandidate: async (providerOverride, modelOverride, runOptions) => {
          const candidateAccounting = compactionAccounting.beginCandidate();
          maintenanceAuthProfile = undefined;
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
            markAutoFallbackPrimaryProbe({ probe: autoFallbackPrimaryProbe, sessionKey });
          }
          await params.opts.onActiveModelSelected?.({
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
          const fastMode = params.opts.fastMode ?? fastModeState.mode;
          const configuredAuthProfileId =
            providerOverride === defaultProvider && modelOverride === defaultModel
              ? configuredDefaultAuthProfileId
              : undefined;
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
          const candidateConfiguredThinkLevel =
            immutableThinkLevel ??
            resolveConfiguredThinkingDefault({
              cfg,
              provider: providerOverride,
              model: modelOverride,
            });
          let candidateThinkingCatalog = thinkingCatalog;
          if (
            pluginsEnabled &&
            candidateConfiguredThinkLevel !== "off" &&
            needsThinkHydration(thinkingCatalog, providerOverride, modelOverride, candidateRuntime)
          ) {
            const { loadProviderScopedThinkingCatalog } =
              await import("../model-catalog.runtime.js");
            const runtimeCatalog = normalizeThinkingCatalogProviders(
              await loadProviderScopedThinkingCatalog({
                config: cfg,
                provider: providerOverride,
                model: modelOverride,
                agentId: sessionAgentId,
                workspaceDir,
              }),
            );
            const allowedRuntimeCatalog = createModelVisibilityPolicy({
              cfg,
              catalog: runtimeCatalog,
              defaultProvider,
              defaultModel,
              agentId: sessionAgentId,
              allowManifestNormalization: true,
              allowPluginNormalization: true,
              ...modelManifestContext,
            }).allowedCatalog;
            if (allowedRuntimeCatalog.length > 0) {
              candidateThinkingCatalog = allowedRuntimeCatalog;
            }
          }
          const candidateRequestedThinkLevel =
            candidateConfiguredThinkLevel ??
            resolveThinkingDefault({
              cfg,
              provider: providerOverride,
              model: modelOverride,
              catalog: candidateThinkingCatalog,
              agentRuntime: candidateRuntime,
            });
          const candidateThinkLevel =
            resolveCandidateThinkingLevel({
              cfg,
              provider: providerOverride,
              modelId: modelOverride,
              level: candidateRequestedThinkLevel,
              catalog: candidateThinkingCatalog,
              agentId: sessionAgentId,
              sessionKey,
              sessionEntry: attemptSessionEntry,
              agentRuntime: candidateRuntime,
            }) ?? candidateRequestedThinkLevel;
          effectiveTurnThinkLevel = candidateThinkLevel;
          try {
            return await attemptExecutionRuntime.runAgentAttempt({
              preparedRunAdmission: params.preparedRunAdmission,
              providerOverride,
              modelOverride,
              ...prepareModelRunCapabilities(
                [candidateThinkingCatalog, params.prepared.configuredThinkingCatalog],
                [providerOverride, modelOverride, candidateRuntime],
              ),
              configuredAuthProfileId,
              modelFallbacksOverride: effectiveFallbacksOverride,
              originalProvider: provider,
              cfg,
              sessionEntry: attemptSessionEntry,
              agentHarnessRuntimeOverride,
              sessionId: attemptSessionTarget?.sessionId ?? sessionId,
              sessionKey,
              ...(attemptSessionTarget ? { sessionTarget: attemptSessionTarget } : {}),
              sessionAgentId,
              sessionFile: attemptSessionFile,
              workspaceDir,
              cwd,
              body,
              transcriptBody,
              isFallbackRetry: runOptions.isFallbackRetry,
              classifyResult: runOptions.classifyResult,
              preserveCliSessionBinding:
                isHeartbeatLifecycleRunKind(logicalTurnOpts.bootstrapContextRunKind) ||
                params.preserveUserFacingSessionModelState,
              modelRoutingProvenance: runOptions.modelRoutingProvenance,
              resolvedThinkLevel: candidateThinkLevel,
              fastMode,
              fastModeStartedAtMs,
              fastModeAutoOnSeconds:
                fastMode === "auto"
                  ? (params.opts.fastModeAutoOnSeconds ?? fastModeState.fastAutoOnSeconds)
                  : fastModeState.fastAutoOnSeconds,
              isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
              timeoutMs,
              runTimeoutOverrideMs,
              runId,
              lifecycleGeneration,
              opts: logicalTurnOpts,
              runContext,
              spawnedBy,
              messageChannel,
              skillsSnapshot,
              resolvedVerboseLevel,
              agentDir,
              authProfileProvider: providerForAuthProfileValidation,
              sessionStore: params.suppressVisibleSessionEffects ? undefined : sessionStore,
              storePath: params.suppressVisibleSessionEffects ? undefined : storePath,
              pluginsEnabled,
              ...(manifestMetadataSnapshot ? { metadataSnapshot: manifestMetadataSnapshot } : {}),
              pluginGeneration: params.prepared.commandRuntimeContext?.pluginGeneration,
              allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
              sessionHasHistory:
                !isNewSession ||
                (await attemptExecutionRuntime.sessionTranscriptHasContent(
                  attemptSessionTarget,
                  deferredLifecycle.signal,
                )),
              fallbackRuntimeState,
              suppressPromptPersistenceOnRetry:
                suppressUserTurnPersistence ||
                userTurnTranscriptRecorder.hasPersisted() ||
                userTurnTranscriptRecorder.isBlocked() ||
                (runOptions.isFallbackRetry &&
                  attemptLifecycleState.currentTurnUserMessagePersisted),
              userTurnTranscriptRecorder,
              assistantErrorTranscript: runOptions.assistantErrorTranscript,
              contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
              onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
              onUserMessagePersisted: attemptLifecycleCallbacks.onUserMessagePersisted,
              onCompactionAccounting: candidateAccounting.observe,
              onSuccessfulAuthProfile: (selection) => {
                // Absence is a valid ambient-auth result; only an uncalled observer is unknown.
                maintenanceAuthProfile = selection;
              },
              onLifecycleGenerationChanged: (nextLifecycleGeneration) => {
                lifecycleGeneration = nextLifecycleGeneration;
                params.onLifecycleGenerationChanged(nextLifecycleGeneration);
              },
              onAgentEvent: attemptLifecycleCallbacks.onAgentEvent,
              deferTerminalLifecycle: true,
              deferredLifecycle,
            });
          } finally {
            await candidateAccounting.finish(sessionEntry);
          }
        },
      });
      result = fallbackResult.result;
      terminal = fallbackResult.terminal;
      if (isAgentRunRestartAbortReason(params.opts.abortSignal?.reason)) {
        throw params.opts.abortSignal?.reason;
      }
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      fallbackExhausted = fallbackResult.outcome === "exhausted";
      await fallbackResult.settleSessionOverride();
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
        lifecycle.emitFinishing(terminal);
      }
      break;
    } catch (err) {
      if (err instanceof LiveSessionModelSwitchError) {
        if (isModelSelectionLocked(sessionEntry)) {
          lifecycle.emitBasicError(MODEL_SELECTION_LOCKED_MESSAGE);
          await fallbackTrajectoryRecorder?.flush();
          await deferredLifecycle.complete();
          throw new ModelSelectionLockedError();
        }
        if (
          sessionKey &&
          hasNewGeneratedMediaTaskForSessionKey(sessionKey, liveSwitchMediaTaskIds)
        ) {
          await deferredLifecycle.complete();
          throw err;
        }
        liveSwitchRetries += 1;
        if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
          const retryLimitMessage = `Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`;
          log.error(`Live session model switch in subagent run ${runId}: ${retryLimitMessage}`);
          lifecycle.emitBasicError("Agent run failed");
          await fallbackTrajectoryRecorder?.flush();
          await deferredLifecycle.complete();
          throw new Error(retryLimitMessage, { cause: err });
        }
        const switchRef = normalizeAgentCommandModelRef(
          cfg,
          err.provider,
          err.model,
          modelManifestContext,
        );
        if (!visibilityPolicy.allowsKey(modelKey(switchRef.provider, switchRef.model))) {
          log.info(
            `Live session model switch in subagent run ${runId}: ` +
              `rejected ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)} (not in allowlist)`,
          );
          lifecycle.emitBasicError("Agent run failed");
          await fallbackTrajectoryRecorder?.flush();
          await deferredLifecycle.complete();
          throw new Error(
            `Live model switch rejected: ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)} is not in the agent allowlist`,
            { cause: err },
          );
        }
        if (storedModelOverride || err.model !== model || err.provider !== provider) {
          storedModelOverride = err.model;
          storedModelOverrideSource = "user";
        }
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
          sessionEntryForAttempt = sessionEntry;
        }
        attemptLifecycleState.lifecycleEnded = false;
        log.info(
          `Live session model switch in subagent run ${runId}: switching to ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}`,
        );
        continue;
      }
      const errorLifecycleFields = resolveAgentRunErrorLifecycleFields(
        err,
        params.opts.abortSignal,
      );
      lifecycle.emitBasicError(
        err instanceof Error ? err : new Error("Agent run failed"),
        errorLifecycleFields,
      );
      await fallbackTrajectoryRecorder?.flush();
      await deferredLifecycle.complete();
      throw err;
    }
  }

  return {
    startedAt,
    result,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    provider,
    model,
    sessionEntry,
    lifecycleGeneration,
    effectiveTurnThinkLevel,
    maintenanceAuthProfile,
    compactionAccounting: compactionAccounting.fact,
    internalSessionTarget,
    attemptExecutionRuntime,
    messageChannel,
    suppressUserTurnPersistence,
    userTurnTranscriptRecorder,
    fallbackTrajectoryRecorder,
    deferredLifecycle,
    lifecycle,
    terminal,
  };
}
