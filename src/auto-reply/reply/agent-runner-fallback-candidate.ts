import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { markAutoFallbackPrimaryProbe } from "../../agents/agent-scope.js";
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
import { buildGenericCliContextEngineHostSupport } from "../../context-engine/host-compat.js";
import { prepareGitHubPublicationAvailability } from "../../gateway/github-publication-availability.js";
import { CommandLane } from "../../process/lanes.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveFallbackCandidateRun, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import { runCliFallbackCandidate } from "./agent-runner-cli-candidate.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";
import type { MessageToolDeliveryState } from "./agent-runner-event-handler.js";
import type { EmbeddedAgentRunResult } from "./agent-runner-execution.types.js";
import type {
  AgentFallbackCandidateCommonParams,
  AgentFallbackCycleParams,
} from "./agent-runner-fallback-cycle.types.js";
import { emitModelFallbackStepLifecycle } from "./agent-runner-model-fallback-lifecycle.js";
import {
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
} from "./agent-runner-utils.js";
import {
  bindSourceReplyDeliveryRuntime,
  createSourceReplyDeliveryRuntime,
  readSourceReplyDeliveryRuntime,
  type SourceReplyDeliveryRuntimeOptions,
} from "./source-reply-delivery-runtime.js";

/** Runs the provider/model fallback candidates while preserving cross-candidate delivery state. */
export async function runAgentFallbackCandidates(params: AgentFallbackCycleParams) {
  const turn = params.turn;
  const sourceReplyDeliveryRuntimeOptions = turn.opts as
    | SourceReplyDeliveryRuntimeOptions
    | undefined;
  const sourceReplyDeliveryRuntime =
    readSourceReplyDeliveryRuntime(turn.followupRun.run) ??
    createSourceReplyDeliveryRuntime({
      origin: sourceReplyDeliveryRuntimeOptions?.sourceReplyDeliveryModeOrigin ?? "stable_policy",
      initialMode: turn.followupRun.run.sourceReplyDeliveryMode ?? "automatic",
      projections: [turn.followupRun.run, ...(turn.opts ? [turn.opts] : [])],
      promptComponentByMode: { automatic: "", message_tool_only: "" },
      promptComponentOffset: undefined,
      onModeResolved: sourceReplyDeliveryRuntimeOptions?.onSourceReplyDeliveryModeResolved,
    });
  sourceReplyDeliveryRuntime.track(turn.followupRun.run);
  if (turn.opts) {
    sourceReplyDeliveryRuntime.track(turn.opts);
  }
  bindSourceReplyDeliveryRuntime(turn.followupRun.run, sourceReplyDeliveryRuntime);
  const sourceReplyDeliveryModeOrigin = sourceReplyDeliveryRuntime.origin;
  const preserveProgressCallbackStartOrder = turn.opts?.preserveProgressCallbackStartOrder === true;
  const runLane = turn.isHeartbeat ? CommandLane.CronNested : CommandLane.Main;
  let queuedUserMessagePersistedAcrossFallback = false;
  let assistantErrorPersistedAcrossFallback = false;
  const messageToolDeliveryState: MessageToolDeliveryState = {
    toolCallIds: new Set(),
    completed: false,
  };
  const userTurnTranscriptRecorder =
    turn.followupRun.userTurnTranscriptRecorder ?? turn.opts?.userTurnTranscriptRecorder;
  const fastModeStartedAtMs = Date.now();
  const fastModeAutoProgressState: FastModeAutoProgressState = {
    offAnnounced: false,
    resetAnnounced: false,
  };
  const bootstrapContextRunKind = turn.opts?.isHeartbeat
    ? ("heartbeat" as const)
    : ("default" as const);
  let githubPublicationAvailability: Promise<boolean> | undefined;

  params.timing.logMilestoneIfSlow({
    runId: params.runId,
    sessionId: turn.followupRun.run.sessionId,
    sessionKey: turn.sessionKey,
    milestone: "before_model_fallback",
  });
  const selection = resolveModelFallbackOptions(params.effectiveRun, params.runtimeConfig);
  const resolveCandidateRuntime = (provider: string, model: string) => {
    const candidateRun = resolveFallbackCandidateRun(params.effectiveRun, provider, model);
    const activeEntry = params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry();
    const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
      provider,
      entry: activeEntry,
      cfg: params.runtimeConfig,
    });
    const locksPersistedHarness =
      activeEntry?.modelSelectionLocked === true &&
      normalizeLowercaseStringOrEmpty(activeEntry.agentHarnessId) === sessionRuntimeOverride;
    const selectedAuthProfile = resolveRunAuthProfile(candidateRun, provider, {
      config: params.runtimeConfig,
    });
    const pinnedCliRuntime =
      !locksPersistedHarness &&
      sessionRuntimeOverride &&
      isCliProvider(sessionRuntimeOverride, params.runtimeConfig)
        ? sessionRuntimeOverride
        : undefined;
    const cliExecutionProvider =
      pinnedCliRuntime ??
      (sessionRuntimeOverride
        ? provider
        : (resolveCliRuntimeExecutionProvider({
            provider,
            cfg: params.runtimeConfig,
            agentId: turn.followupRun.run.agentId,
            modelId: model,
            authProfileId: selectedAuthProfile.authProfileId,
          }) ?? provider));
    const useCliExecution =
      pinnedCliRuntime !== undefined ||
      (!sessionRuntimeOverride && isCliProvider(cliExecutionProvider, params.runtimeConfig));
    return {
      candidateRun,
      sessionRuntimeOverride,
      cliExecutionProvider,
      useCliExecution,
    };
  };
  return params.timing.measure("model_fallback", () =>
    runEmbeddedAgentEntry<EmbeddedAgentRunResult>({
      selection: {
        cfg: selection.cfg,
        provider: selection.provider,
        model: selection.model,
        requestedRouteResolution: selection.requestedRouteResolution,
        agentDir: selection.agentDir,
        fallbacksOverride: selection.fallbacksOverride,
        userLockedAuthProfileId:
          turn.followupRun.run.authProfileIdSource === "user"
            ? turn.followupRun.run.authProfileId
            : undefined,
      },
      identity: {
        runId: params.runId,
        agentId: turn.followupRun.run.agentId,
        sessionId: turn.followupRun.run.sessionId,
        sessionKey: selection.sessionKey,
        lane: runLane,
      },
      harness: {
        workspaceDir: turn.followupRun.run.workspaceDir,
        sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
        preparation: {
          kind: "measured",
          run: (prepare) => params.timing.measure("fallback_prepare_harness", prepare),
        },
        resolveRuntimeOverride: (provider) =>
          resolveSessionRuntimeOverrideForProvider({
            provider,
            entry: params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry(),
            cfg: params.runtimeConfig,
          }),
        resolveContextEngineHost: (provider, model) => {
          const runtime = resolveCandidateRuntime(provider, model);
          if (!runtime.useCliExecution) {
            return undefined;
          }
          const backend = resolveCliBackendConfig(
            runtime.cliExecutionProvider,
            params.runtimeConfig,
            { agentId: turn.followupRun.run.agentId },
          );
          return buildGenericCliContextEngineHostSupport({
            backendId: backend?.id ?? runtime.cliExecutionProvider,
            ...(backend?.contextEngineHostCapabilities
              ? { capabilities: backend.contextEngineHostCapabilities }
              : {}),
          });
        },
      },
      behavior: {
        kind: "channel-delivery",
        readDeliveryEvidence: () => ({
          hasDirectlySentBlockReply: params.directlySentBlockKeys.size > 0,
          hasBlockReplyPipelineOutput: Boolean(
            turn.blockReplyPipeline?.hasBuffered() || turn.blockReplyPipeline?.didStream(),
          ),
        }),
      },
      sessionOverride: {
        kind: "reconcile-completed",
        reconcile: params.clearRecoveredAutoFallbackPrimaryProbe,
      },
      abortSignal: params.runAbortSignal,
      onFallbackStep: (step) => {
        emitModelFallbackStepLifecycle({ runId: params.runId, sessionKey: turn.sessionKey, step });
      },
      runCandidate: async (provider, model, runOptions) => {
        params.state.attemptedRuntimeProvider = provider;
        params.state.attemptedRuntimeModel = model;
        const runtime = params.timing.measureSync("fallback_resolve_runtime", () =>
          resolveCandidateRuntime(provider, model),
        );
        const candidateRun = runtime.candidateRun;
        bindSourceReplyDeliveryRuntime(candidateRun, sourceReplyDeliveryRuntime);
        // CLI prompts are fixed to their session binding, so dispatch must publish that
        // same stable mode or a valid assistant reply can be silently suppressed.
        const candidateSourceReplyDeliveryMode =
          sourceReplyDeliveryModeOrigin === "runtime_default" && runtime.useCliExecution
            ? (candidateRun.cliSessionBindingFacts?.sourceReplyDeliveryMode ?? "automatic")
            : sourceReplyDeliveryRuntime.currentMode;
        const applySourceReplyDeliveryModeBeforeInvocation =
          sourceReplyDeliveryModeOrigin !== "runtime_default" || runtime.useCliExecution;
        if (candidateSourceReplyDeliveryMode && applySourceReplyDeliveryModeBeforeInvocation) {
          sourceReplyDeliveryRuntime.applyMode(candidateRun, candidateSourceReplyDeliveryMode);
        }
        const candidateThinkLevel = resolveCandidateThinkingLevel({
          cfg: params.runtimeConfig,
          provider,
          modelId: model,
          level: turn.followupRun.run.thinkLevel,
          catalog: turn.followupRun.run.thinkingCatalog,
          agentId: turn.followupRun.run.agentId,
          sessionKey: turn.followupRun.run.runtimePolicySessionKey ?? turn.sessionKey,
          sessionEntry: turn.getActiveSessionEntry(),
        });
        const candidateFastMode = resolveRunFastModeForFallbackCandidate({
          run: candidateRun,
          config: params.runtimeConfig,
          provider,
          model,
          sessionEntry: turn.getActiveSessionEntry(),
        });
        const activeProbe = params.effectiveRun.autoFallbackPrimaryProbe;
        if (activeProbe && provider === activeProbe.provider && model === activeProbe.model) {
          markAutoFallbackPrimaryProbe({ probe: activeProbe, sessionKey: turn.sessionKey });
        }
        turn.opts?.onModelSelected?.({ provider, model, thinkLevel: candidateThinkLevel });
        const common = {
          preparedRunAdmission: params.preparedRunAdmission,
          turn,
          candidateRun,
          runtimeConfig: params.runtimeConfig,
          provider,
          model,
          candidateThinkLevel,
          candidateFastMode,
          runId: params.runId,
          runAbortSignal: params.runAbortSignal,
          runLane,
          isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
          suppressQueuedUserPersistenceForCandidate:
            (turn.followupRun.run.suppressNextUserMessagePersistence ?? false) ||
            queuedUserMessagePersistedAcrossFallback,
          userTurnTranscriptRecorder,
          contextEngineLogicalTurnLease: runOptions.contextEngineLogicalTurnLease,
          onContextEngineTurnCandidate: runOptions.onContextEngineTurnCandidate,
          notifyUserMessagePersisted: () => {
            queuedUserMessagePersistedAcrossFallback = true;
          },
          fastModeStartedAtMs,
          fastModeAutoProgressState,
          bootstrapContextRunKind,
          bootstrapPromptWarningSignaturesSeen: params.state.bootstrapPromptWarningSignaturesSeen,
          currentTurnImages: params.currentTurnImages,
          signalExecutionPhaseForTyping: params.signalExecutionPhaseForTyping,
          notifyAgentRunStart: params.notifyAgentRunStart,
          preserveProgressCallbackStartOrder,
          presentation: params.presentation,
          timing: params.timing,
          onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => {
            params.state.pendingLifecycleTerminal = { provider, model, backstop };
          },
        } satisfies AgentFallbackCandidateCommonParams;
        if (runtime.useCliExecution) {
          const candidate = await runCliFallbackCandidate({
            ...common,
            cliExecutionProvider: runtime.cliExecutionProvider,
            lifecycleGeneration: params.state.lifecycleGeneration,
          });
          params.state.bootstrapPromptWarningSignaturesSeen =
            candidate.bootstrapPromptWarningSignaturesSeen;
          return candidate.result;
        }
        const candidate = await runEmbeddedFallbackCandidate({
          ...common,
          githubPublicationAvailable: await (githubPublicationAvailability ??=
            turn.sessionKey && params.effectiveRun.agentId
              ? prepareGitHubPublicationAvailability({
                  sessionId: turn.followupRun.run.sessionId,
                  sessionKey: turn.sessionKey,
                  agentId: params.effectiveRun.agentId,
                })
              : Promise.resolve(false)),
          effectiveRun: params.effectiveRun,
          sessionRuntimeOverride: runtime.sessionRuntimeOverride,
          getLifecycleGeneration: () => params.state.lifecycleGeneration,
          onLifecycleGeneration: (generation) => {
            params.state.lifecycleGeneration = generation;
          },
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          suppressAssistantErrorPersistenceForCandidate: assistantErrorPersistedAcrossFallback,
          onAssistantErrorMessagePersisted: () => {
            assistantErrorPersistedAcrossFallback = true;
          },
          notifyUserAboutCompaction: params.notifyUserAboutCompaction,
          messageToolDeliveryState,
          onCompactionCount: (count) => {
            params.state.autoCompactionCount += count;
          },
        });
        params.state.bootstrapPromptWarningSignaturesSeen =
          candidate.bootstrapPromptWarningSignaturesSeen;
        return candidate.result;
      },
    }),
  );
}

export type AgentFallbackCandidatesResult = Awaited<ReturnType<typeof runAgentFallbackCandidates>>;
