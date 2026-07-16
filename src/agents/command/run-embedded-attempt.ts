import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
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
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  markAutoFallbackPrimaryProbe,
  resolveEffectiveModelFallbacks,
} from "../agent-scope.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "../embedded-agent-runner/result-fallback-classifier.js";
import { resolveFastModeState } from "../fast-mode.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { prepareInternalSessionEffectsSession } from "../internal-session-effects.js";
import { LiveSessionModelSwitchError } from "../live-model-switch.js";
import { runWithModelFallback } from "../model-fallback.js";
import { modelKey, resolveThinkingDefault } from "../model-selection.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import {
  isAgentRunDirectAbortReason,
  isAgentRunRestartAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import { resolveSessionRuntimeOverrideForProvider } from "../session-runtime-compat.js";
import {
  resolveCandidateThinkingLevel,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";
import { applyAgentRunAbortMetadata, createAgentCommandLifecycle } from "./lifecycle.js";
import { normalizeAgentCommandModelRef } from "./model-ref.js";
import type { EmbeddedModelSelection } from "./model-selection.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import { loadAttemptExecutionRuntime, type AgentAttemptResult } from "./runtime-loaders.js";
import { persistSessionEntry, resolveInternalSessionEffectsSource } from "./session-helpers.js";
import type { EmbeddedSessionState } from "./session-preparation.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");
const MAX_LIVE_SWITCH_RETRIES = 5;

export async function runEmbeddedAgentAttempt(params: {
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  lifecycleGeneration: string;
  onLifecycleGenerationChanged: (lifecycleGeneration: string) => void;
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
    thinkingCatalog,
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
  const attemptSessionFile = internalSessionTarget?.sessionFile ?? sessionFile;

  const startedAt = Date.now();
  const attemptLifecycleState: AgentAttemptLifecycleState = {
    currentTurnUserMessagePersisted: false,
    lifecycleFinishing: false,
    lifecycleEnded: false,
  };
  const attemptLifecycleCallbacks = createAgentAttemptLifecycleCallbacks(attemptLifecycleState);
  const transcriptMedia = params.opts.transcriptMedia ?? [];
  const hasTranscriptMedia = transcriptMedia.length > 0;
  const suppressUserTurnPersistence =
    params.opts.suppressPromptPersistence === true ||
    (params.opts.transcriptMessage === "" && !hasTranscriptMedia);
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
  const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
  const messageChannel = resolveMessageChannel(
    runContext.messageChannel,
    params.opts.replyChannel ?? params.opts.channel,
  );

  let result: AgentAttemptResult;
  let fallbackProvider = provider;
  let fallbackModel = model;
  let fallbackExhausted = false;
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
      const effectiveFallbacksOverride = isModelSelectionLocked(sessionEntry)
        ? []
        : resolveEffectiveModelFallbacks({
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
        classifyResult: ({ provider: providerLocal, model: modelLocal, result: resultLocal }) => {
          const classification = classifyEmbeddedAgentRunResultForModelFallback({
            provider: providerLocal,
            model: modelLocal,
            result: resultLocal,
          });
          return classification && currentAttemptCommittedCronMedia() ? undefined : classification;
        },
        canFallbackAfterError: () => !currentAttemptCommittedCronMedia(),
        mergeExhaustedResult: mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
        abortSignal: params.opts.abortSignal,
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
            markAutoFallbackPrimaryProbe({ probe: autoFallbackPrimaryProbe, sessionKey });
          }
          const isFallbackRetry = fallbackAttemptIndex > 0;
          fallbackAttemptIndex += 1;
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
            configuredAuthProfileId,
            modelFallbacksOverride: effectiveFallbacksOverride,
            originalProvider: provider,
            cfg,
            sessionEntry: attemptSessionEntry,
            agentHarnessRuntimeOverride,
            sessionId,
            sessionKey,
            ...(internalSessionTarget ? { sessionTarget: internalSessionTarget } : {}),
            sessionAgentId,
            sessionFile: attemptSessionFile,
            workspaceDir,
            cwd,
            body,
            transcriptBody,
            isFallbackRetry,
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
            opts: params.opts,
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
              // Outer cleanup owns the run context, so publish before the attempt can reject.
              params.onLifecycleGenerationChanged(nextLifecycleGeneration);
            },
            onAgentEvent: attemptLifecycleCallbacks.onAgentEvent,
            deferTerminalLifecycle: true,
          });
        },
      });
      result = applyAgentRunAbortMetadata(fallbackResult.result, params.opts.abortSignal);
      if (isAgentRunRestartAbortReason(params.opts.abortSignal?.reason)) {
        throw params.opts.abortSignal?.reason;
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
        !isModelSelectionLocked(sessionEntry) &&
        !params.suppressVisibleSessionEffects &&
        !params.preserveUserFacingSessionModelState &&
        entryMatchesAutoFallbackPrimaryProbe(sessionEntry, autoFallbackPrimaryProbe) &&
        fallbackProvider === autoFallbackPrimaryProbe.provider &&
        fallbackModel === autoFallbackPrimaryProbe.model
      ) {
        const nextSessionEntry = { ...sessionEntry };
        clearAutoFallbackPrimaryProbeSelection(nextSessionEntry);
        sessionEntry = await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry: sessionEntry,
          entry: nextSessionEntry,
          shouldPersist: (current) =>
            Boolean(
              current && entryMatchesAutoFallbackPrimaryProbe(current, autoFallbackPrimaryProbe),
            ),
        });
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
        lifecycle.emitFinishing(result);
      }
      break;
    } catch (err) {
      if (err instanceof LiveSessionModelSwitchError) {
        if (isModelSelectionLocked(sessionEntry)) {
          if (!attemptLifecycleState.lifecycleEnded) {
            emitAgentEvent({
              runId,
              lifecycleGeneration,
              stream: "lifecycle",
              data: {
                phase: "error",
                startedAt,
                endedAt: Date.now(),
                error: MODEL_SELECTION_LOCKED_MESSAGE,
              },
            });
          }
          await fallbackTrajectoryRecorder?.flush();
          throw new ModelSelectionLockedError();
        }
        if (
          sessionKey &&
          hasNewGeneratedMediaTaskForSessionKey(sessionKey, liveSwitchMediaTaskIds)
        ) {
          throw err;
        }
        liveSwitchRetries += 1;
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
            {
              cause: err,
            },
          );
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
          : resolveAgentRunErrorLifecycleFields(err, params.opts.abortSignal);
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

  return {
    result,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    provider,
    model,
    sessionEntry,
    lifecycleGeneration,
    effectiveTurnThinkLevel,
    internalSessionTarget,
    attemptExecutionRuntime,
    messageChannel,
    suppressUserTurnPersistence,
    userTurnTranscriptRecorder,
    fallbackTrajectoryRecorder,
    lifecycle,
  };
}

export type EmbeddedAgentAttempt = Awaited<ReturnType<typeof runEmbeddedAgentAttempt>>;
