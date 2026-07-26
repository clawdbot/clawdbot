import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { markAutoFallbackPrimaryProbe } from "../../agents/agent-scope.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
import { resolveHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import { CommandLane } from "../../process/lanes.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveFallbackCandidateRun, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import { runCliFallbackCandidate } from "./agent-runner-cli-candidate.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";
import type { MessageToolDeliveryState } from "./agent-runner-event-handler.js";
import type { EmbeddedAgentRunResult } from "./agent-runner-execution.types.js";
import type { AgentFallbackCycleParams } from "./agent-runner-fallback-cycle.types.js";
import { emitModelFallbackStepLifecycle } from "./agent-runner-model-fallback-lifecycle.js";
import {
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
} from "./agent-runner-utils.js";

/** Runs the provider/model fallback candidates while preserving cross-candidate delivery state. */
export async function runAgentFallbackCandidates(params: AgentFallbackCycleParams) {
  const turn = params.turn;
  const preserveProgressCallbackStartOrder = turn.opts?.preserveProgressCallbackStartOrder === true;
  const sourceRepliesAreToolOnly =
    turn.followupRun.run.sourceReplyDeliveryMode === "message_tool_only";
  const runLane = CommandLane.Main;
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
  const bootstrapContextRunKind =
    resolveHeartbeatRunScope(turn.opts) === "commitment-only"
      ? ("commitment-only" as const)
      : turn.opts?.isHeartbeat
        ? ("heartbeat" as const)
        : ("default" as const);

  params.timing.logMilestoneIfSlow({
    runId: params.runId,
    sessionId: turn.followupRun.run.sessionId,
    sessionKey: turn.sessionKey,
    milestone: "before_model_fallback",
  });
  const selection = resolveModelFallbackOptions(params.effectiveRun, params.runtimeConfig);
  return params.timing.measure("model_fallback", () =>
    runEmbeddedAgentEntry<EmbeddedAgentRunResult>({
      selection: {
        cfg: selection.cfg,
        provider: selection.provider,
        model: selection.model,
        agentDir: selection.agentDir,
        fallbacksOverride: selection.fallbacksOverride,
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
        const candidateRun = resolveFallbackCandidateRun(params.effectiveRun, provider, model);
        const candidateThinkLevel = resolveCandidateThinkingLevel({
          cfg: params.runtimeConfig,
          provider,
          modelId: model,
          level: turn.followupRun.run.thinkLevel,
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
        const runtime = params.timing.measureSync("fallback_resolve_runtime", () => {
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
          return {
            sessionRuntimeOverride,
            cliExecutionProvider,
            useCliExecution:
              pinnedCliRuntime !== undefined ||
              (!sessionRuntimeOverride &&
                isCliProvider(cliExecutionProvider, params.runtimeConfig)),
          };
        });
        const common = {
          turn,
          candidateRun,
          runtimeConfig: params.runtimeConfig,
          provider,
          model,
          candidateThinkLevel,
          candidateFastMode,
          runId: params.runId,
          runAbortSignal: params.runAbortSignal,
          isFinalFallbackAttempt: runOptions?.isFinalFallbackAttempt,
          suppressQueuedUserPersistenceForCandidate:
            (turn.followupRun.run.suppressNextUserMessagePersistence ?? false) ||
            queuedUserMessagePersistedAcrossFallback,
          userTurnTranscriptRecorder,
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
        };
        if (runtime.useCliExecution) {
          const candidate = await runCliFallbackCandidate({
            ...common,
            cliExecutionProvider: runtime.cliExecutionProvider,
            lifecycleGeneration: params.state.lifecycleGeneration,
            runLane,
          });
          params.state.bootstrapPromptWarningSignaturesSeen =
            candidate.bootstrapPromptWarningSignaturesSeen;
          return candidate.result;
        }
        const candidate = await runEmbeddedFallbackCandidate({
          ...common,
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
          sourceRepliesAreToolOnly,
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
