import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { markAutoFallbackPrimaryProbe } from "../../agents/agent-scope.js";
import {
  isConnectionError,
  isTimeoutErrorMessage,
  isTransientHttpError,
} from "../../agents/embedded-agent-helpers.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import {
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
} from "../../agents/failover-error.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveHeartbeatRunScope } from "../../infra/heartbeat-run-scope.js";
import { CommandLane } from "../../process/lanes.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveFallbackCandidateRun, resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import { runCliFallbackCandidate } from "./agent-runner-cli-candidate.js";
import { runEmbeddedFallbackCandidate } from "./agent-runner-embedded-candidate.js";
import type { MessageToolDeliveryState } from "./agent-runner-event-handler.js";
import type { EmbeddedAgentRunResult } from "./agent-runner-execution.types.js";
import { hasDedicatedNonTransportTimeoutCopy } from "./agent-runner-failure-reply.js";
import type { AgentFallbackCycleParams } from "./agent-runner-fallback-cycle.types.js";
import { emitModelFallbackStepLifecycle } from "./agent-runner-model-fallback-lifecycle.js";
import {
  resolveModelFallbackOptions,
  resolveRunFastModeForFallbackCandidate,
} from "./agent-runner-utils.js";

// Matches the outer transient backoff so a per-candidate retry paces itself the
// same way a whole-cycle retry would (agent-runner-error-handler.ts).
const PROVIDER_CANDIDATE_TRANSIENT_RETRY_DELAY_MS = 2_500;

// A single provider candidate hit a transient transport failure (bad gateway,
// connection drop, request timeout) rather than a terminal/model failure. The
// SDK's in-window retry is pinned to 0 while the prompt lock is released
// (#87180), so the configured provider retry budget is honored at this
// candidate boundary instead. Session-takeover / write-lock coordination
// errors, and timeouts that own dedicated non-transport copy (CLI subprocess
// budget kills, Codex app-server idle timeouts), are never transport retries.
function isRetryableProviderCandidateTransientError(err: unknown): boolean {
  if (isNonProviderRuntimeCoordinationError(err)) {
    return false;
  }
  const message = formatErrorMessage(err);
  // CLI subprocess budget kills / Codex app-server bridge failures own dedicated
  // copy + replay handling. They surface as top-level FailoverError(reason:
  // "timeout"), so this exclusion must run BEFORE the failover-reason branch —
  // otherwise a CLI budget kill re-runs the subprocess for another full budget.
  if (hasDedicatedNonTransportTimeoutCopy(message)) {
    return false;
  }
  if (isFailoverError(err) && (err.reason === "timeout" || err.reason === "server_error")) {
    return true;
  }
  if (isTransientHttpError(message) || isConnectionError(message)) {
    return true;
  }
  return isTimeoutErrorMessage(message);
}

/** Runs the provider/model fallback candidates while preserving cross-candidate delivery state. */
export async function runAgentFallbackCandidates(params: AgentFallbackCycleParams) {
  const turn = params.turn;
  const preserveProgressCallbackStartOrder = turn.opts?.preserveProgressCallbackStartOrder === true;
  const sourceRepliesAreToolOnly =
    turn.followupRun.run.sourceReplyDeliveryMode === "message_tool_only";
  const runLane = CommandLane.Main;
  let queuedUserMessagePersistedAcrossFallback = false;
  let assistantErrorPersistedAcrossFallback = false;
  // Once a candidate emits a tool call or assistant output, re-running it would
  // duplicate that side effect, so the per-candidate transient retry below must
  // stop. Mirrors the outer owner's markOverloadRetryUnsafeToReplay guard
  // (agent-runner-execution.ts / agent-runner-error-handler.ts).
  let candidateReplayUnsafe = false;
  const signalExecutionPhaseForTyping: typeof params.signalExecutionPhaseForTyping = (info) => {
    if (info.phase === "tool_execution_started" || info.phase === "assistant_output_started") {
      candidateReplayUnsafe = true;
    }
    return params.signalExecutionPhaseForTyping(info);
  };
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
        requestedRouteResolution: selection.requestedRouteResolution,
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
        // One full attempt of THIS candidate. Rebuilt per retry so the
        // cross-fallback persistence guards (queued user message, assistant
        // error) reflect whether the preceding attempt already committed them.
        const attemptCandidateOnce = async () => {
          params.state.attemptedRuntimeProvider = provider;
          params.state.attemptedRuntimeModel = model;
          const candidateRun = resolveFallbackCandidateRun(params.effectiveRun, provider, model);
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
          const runtime = params.timing.measureSync("fallback_resolve_runtime", () => {
            const activeEntry = params.liveModelSwitchRuntimeEntry ?? turn.getActiveSessionEntry();
            const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
              provider,
              entry: activeEntry,
              cfg: params.runtimeConfig,
            });
            const locksPersistedHarness =
              activeEntry?.modelSelectionLocked === true &&
              normalizeLowercaseStringOrEmpty(activeEntry.agentHarnessId) ===
                sessionRuntimeOverride;
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
            signalExecutionPhaseForTyping,
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
        };
        // The configured provider retry budget applies per candidate (#87180):
        // a transient transport failure retries THIS candidate — each embedded
        // re-run reacquires the released session lock — before the fallback
        // loop moves on. Scoping the budget here keeps it from re-ordering the
        // primary→fallback chain or re-running already-exhausted candidates the
        // way a whole-cycle retry counter would. Unset budget stays a one-shot
        // whole-cycle retry at the outer owner (agent-runner-execution.ts).
        let providerRetriesRemaining = turn.followupRun.run.providerRetryMaxRetries ?? 0;
        while (true) {
          try {
            return await attemptCandidateOnce();
          } catch (err) {
            if (
              providerRetriesRemaining <= 0 ||
              candidateReplayUnsafe ||
              !isRetryableProviderCandidateTransientError(err)
            ) {
              throw err;
            }
            providerRetriesRemaining -= 1;
            await sleepWithAbort(
              PROVIDER_CANDIDATE_TRANSIENT_RETRY_DELAY_MS,
              params.runAbortSignal,
            );
          }
        }
      },
    }),
  );
}

export type AgentFallbackCandidatesResult = Awaited<ReturnType<typeof runAgentFallbackCandidates>>;
