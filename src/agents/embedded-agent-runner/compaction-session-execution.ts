/**
 * Executes compaction while owning the transcript lock, session lifecycle,
 * hooks, checkpoint, and optional successor transcript rotation.
 */
import {
  preserveCompactionReplayWindow,
  resolveCompactionReplayEligibility,
} from "@openclaw/ai/transports";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import type { CapturedCompactionCheckpointSnapshot } from "../../gateway/session-compaction-checkpoints.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  type DiagnosticEmbeddedRunOwner,
  markDiagnosticEmbeddedRunStarted,
} from "../../logging/diagnostic-run-activity.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  consumeCompactionSafeguardCancellation,
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "../agent-settings.js";
import { pickFallbackThinkingLevel } from "../embedded-agent-helpers.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import { agentSessionAutomaticCompaction } from "../sessions/agent-session-compaction.js";
import { type AgentSession, estimateTokens, SessionManager } from "../sessions/index.js";
import { getModelRegistryRuntime } from "../sessions/model-registry-runtime.js";
import { createAgentSessionForEmbeddedRunner } from "../sessions/sdk.js";
import { setSessionModelUsageSink } from "../sessions/session-model-usage.js";
import { normalizeUsage, type UsageLike } from "../usage.js";
import { resolveCompactionFailure } from "./compact-reasons.js";
import { compactionCheckpointStore, persistCompactionCheckpoint } from "./compaction-checkpoint.js";
import {
  containsRealConversationMessages,
  normalizeObservedTokenCount,
  resolveCompactionProviderStream,
  summarizeCompactionMessages,
} from "./compaction-diagnostics.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import {
  asCompactionHookRunner,
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
import {
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { prepareCompactionSessionAgent } from "./compaction-session-agent.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { log } from "./logger.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { sanitizeSessionHistory, validateReplayTurns } from "./replay-history.js";
import { createEmbeddedAgentResourceLoader } from "./resource-loader.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./run/attempt.model-diagnostic-events.js";
import { readCompactionUsageRecorder } from "./run/compaction-usage-bridge.js";
import { estimateLlmBoundaryTokenPressure } from "./run/preemptive-compaction.js";
import { attemptServerEndpointCompaction } from "./server-endpoint-compaction.js";
import { applySystemPromptToSession } from "./system-prompt.js";
import { collectRegisteredToolNames, toSessionToolAllowlist } from "./tool-name-allowlist.js";
import { splitSdkTools } from "./tool-split.js";
import { mapThinkingLevel } from "./utils.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";

export async function executePreparedCompactionSession(runtime: PreparedCompactionRuntime) {
  const {
    params,
    diagId,
    trigger,
    attempt,
    maxAttempts,
    runId,
    compactionModelCallTrace,
    diagnosticCompactionRunId,
    nextDiagnosticModelCallId,
    agentDir,
    provider,
    modelId,
    attemptedThinking,
    fail,
    authStorage,
    modelRegistry,
    apiKeyInfo,
    hasRuntimeAuthExchange,
    sandboxSessionKey,
    sandbox,
    effectiveWorkspace,
    effectiveCwd,
    contextTokenBudget,
    effectiveModel,
    runtimePlan,
    runtimePlanModelContext,
    runAbortController,
    effectiveTools,
    allowedToolNames,
    buildSystemPromptText,
    resolvedMessageProvider,
    sessionAgentId,
  } = runtime;
  let thinkLevel = runtime.thinkLevel;
  let compactionSessionManager: unknown = null;
  let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null = null;
  let checkpointSnapshotRetained = false;

  try {
    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionTarget = await resolveAgentRunSessionTarget({
      agentId: sessionAgentId,
      config: params.config,
      missingSessionKey: "resolve-existing",
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
    });
    try {
      const transcriptPolicy = runtimePlan.transcript.resolvePolicy(runtimePlanModelContext);
      const sessionManager = guardSessionManager(SessionManager.open(sessionTarget), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        config: params.config,
        contextWindowTokens: contextTokenBudget,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        missingToolResultText:
          effectiveModel.api === "openai-responses" ||
          effectiveModel.api === "azure-openai-responses" ||
          effectiveModel.api === "openai-chatgpt-responses"
            ? "aborted"
            : undefined,
        allowedToolNames,
      });
      checkpointSnapshot = await compactionCheckpointStore.captureSnapshot({
        sessionManager,
        sessionFile: params.sessionFile,
        sessionTarget,
      });
      compactionSessionManager = sessionManager;
      const usageRecorder = readCompactionUsageRecorder(params.contextEngineRuntimeContext);
      const recordUsage = usageRecorder
        ? (usage: UsageLike) => {
            const normalized = normalizeUsage(usage);
            if (normalized) {
              usageRecorder(normalized);
            }
          }
        : undefined;
      if (recordUsage) {
        setSessionModelUsageSink(sessionManager, recordUsage);
      }
      const settingsManager = createPreparedEmbeddedAgentSettingsManager({
        cwd: effectiveCwd,
        agentDir,
        cfg: params.config,
        pluginMetadataSnapshot: getCurrentPluginMetadataSnapshot({
          config: params.config,
          env: process.env,
          workspaceDir: effectiveWorkspace,
        }),
        contextTokenBudget,
      });
      // Sets compaction/pruning runtime state and returns extension factories
      // that must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider,
        modelId,
        model: effectiveModel,
        contextTokenBudget,
        agentId: sessionAgentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey ?? sandboxSessionKey,
        runId,
      });
      const resourceLoader = createEmbeddedAgentResourceLoader({
        cwd: effectiveCwd,
        agentDir,
        settingsManager,
        extensionFactories,
      });
      await resourceLoader.reload();
      // DefaultResourceLoader.reload() rehydrates settings from disk and can drop OpenClaw
      // compaction overrides applied in createPreparedEmbeddedAgentSettingsManager — same
      // rehydration also restores OpenClaw runtime's auto-compaction (openclaw#75799), so re-apply
      // both guards. effectiveModel.baseUrl matches the surrounding scope so
      // auth-profile-injected baseUrls reach the endpoint-class detector.
      applyAgentCompactionSettingsFromConfig({
        settingsManager,
        cfg: params.config,
        contextTokenBudget,
      });
      // contextEngineInfo is intentionally omitted: this guard runs inside the
      // compaction LLM session, which is not the user-facing agent session and
      // has no associated context engine.
      applyAgentAutoCompactionGuard({
        settingsManager,
        silentOverflowProneProvider: isSilentOverflowProneModel({
          provider,
          modelId,
          baseUrl: effectiveModel.baseUrl ?? undefined,
        }),
      });

      const { customTools } = splitSdkTools({
        tools: effectiveTools,
        sandboxEnabled: Boolean(sandbox?.enabled),
        toolHookContext: {
          agentId: sessionAgentId,
          config: params.config,
          cwd: effectiveCwd,
          sessionKey: sandboxSessionKey,
          sessionId: params.sessionId,
          runId: params.runId,
          channelId: params.currentChannelId,
        },
      });
      // The session runtime treats `tools` as a name allowlist during session creation. Pass the
      // exact OpenClaw-managed registrations so custom tools survive startup.
      const sessionToolAllowlist = toSessionToolAllowlist(collectRegisteredToolNames(customTools));

      const providerStreamFn = resolveCompactionProviderStream({
        effectiveModel,
        config: params.config,
        agentDir,
        effectiveWorkspace,
        apiRegistry: getModelRegistryRuntime(modelRegistry).apiRegistry,
      });
      while (true) {
        // A thinking retry starts a new attempt; setup/endpoint failures must not reuse its predecessor's cause.
        setCompactionSafeguardCancellation(sessionManager, undefined);
        // Rebuild the compaction session on retry so provider wrappers, payload
        // shaping, and the embedded system prompt all reflect the fallback level.
        attemptedThinking.add(thinkLevel);
        const systemPromptText = buildSystemPromptText(thinkLevel);
        let session: AgentSession | undefined;
        let diagnosticOwner: DiagnosticEmbeddedRunOwner | undefined;
        let resetCompactionTimeout: (() => void) | undefined;
        try {
          const createdSession = await createAgentSessionForEmbeddedRunner(
            {
              cwd: effectiveCwd,
              agentDir,
              authStorage,
              modelRegistry,
              model: effectiveModel,
              thinkingLevel: mapThinkingLevel(thinkLevel),
              tools: sessionToolAllowlist,
              customTools,
              sessionManager,
              settingsManager,
              resourceLoader,
            },
            {},
          );
          session = createdSession.session;
          session.setActiveToolsByName(sessionToolAllowlist);
          applySystemPromptToSession(session, systemPromptText);
          // Compaction builds the same embedded system prompt, so it must flow
          // through the same transport/payload shaping stack as normal turns.
          const { effectiveExtraParams, transportApiKey } = await prepareCompactionSessionAgent({
            session,
            llmRuntime: getModelRegistryRuntime(modelRegistry).llmRuntime,
            providerStreamFn,
            sessionId: params.sessionId,
            signal: runAbortController.signal,
            effectiveModel,
            resolvedApiKey: hasRuntimeAuthExchange ? undefined : apiKeyInfo?.apiKey,
            authStorage,
            config: params.config,
            provider,
            modelId,
            thinkLevel,
            sessionAgentId,
            effectiveWorkspace,
            agentDir,
            runtimePlan,
            sessionKey: sandboxSessionKey,
            sandboxToolPolicy: sandbox?.tools,
            messageProvider: resolvedMessageProvider,
            agentAccountId: params.agentAccountId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
          });
          const compactionReplayEnabled = resolveCompactionReplayEligibility(effectiveModel, {
            extraParams: effectiveExtraParams,
            apiKey: transportApiKey,
          });
          diagnosticOwner = createDiagnosticEmbeddedRunOwner({
            sessionId: params.sessionId,
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            runId: diagnosticCompactionRunId,
            workKey: diagnosticCompactionRunId,
          });
          markDiagnosticEmbeddedRunStarted({
            sessionId: params.sessionId,
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            runId: diagnosticCompactionRunId,
            workKey: diagnosticCompactionRunId,
            owner: diagnosticOwner,
          });
          session.agent.streamFn = wrapStreamFnWithDiagnosticModelCallEvents(
            session.agent.streamFn,
            {
              runId: diagnosticCompactionRunId,
              ...(params.sessionKey && { sessionKey: params.sessionKey }),
              sessionId: params.sessionId,
              provider,
              model: modelId,
              api: effectiveModel.api,
              transport: session.agent.transport,
              requestTimeoutMs: compactionTimeoutMs,
              contextTokenBudget,
              trace: compactionModelCallTrace,
              contentCapture: resolveDiagnosticModelContentCapturePolicy(params.config),
              nextCallId: nextDiagnosticModelCallId,
              ownerGeneration: diagnosticOwner.generation,
              // Multi-stage compaction intentionally serializes provider calls. Each new
              // request is progress, so both native and delegated watchdogs get a fresh window.
              onStarted: () => {
                resetCompactionTimeout?.();
                params.compactionTimeoutReset?.();
              },
            },
          );

          const prior = await sanitizeSessionHistory({
            messages: session.messages,
            modelApi: effectiveModel.api,
            modelId,
            provider,
            allowedToolNames,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model: effectiveModel,
            sessionManager,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
            preserveLatestAssistantThinking: false,
          });
          const validated = await validateReplayTurns({
            messages: prior,
            modelApi: effectiveModel.api,
            modelId,
            provider,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model: effectiveModel,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
          });
          const dedupedValidated = dedupeDuplicateUserMessagesForCompaction(validated);
          // Apply validated transcript to the live session even when no history limit is configured,
          // so compaction and hook metrics are based on the same message set.
          session.agent.state.messages = dedupedValidated;
          // "Original" compaction metrics should describe the validated transcript that enters
          // limiting/compaction, not the raw on-disk session snapshot.
          const originalMessages = session.messages.slice();
          const truncated = preserveCompactionReplayWindow(
            originalMessages,
            limitHistoryTurns(
              session.messages,
              getHistoryLimitFromSessionKey(params.sessionKey, params.config, {
                accountId: params.agentAccountId,
                peerId: params.conversationRoutePeerId,
                chatType: params.chatType,
              }),
            ),
            effectiveModel,
            {
              sessionId: params.sessionId,
              authProfileId: runtimePlan.auth.forwardedAuthProfileId,
              enabled: compactionReplayEnabled,
            },
          );
          // Re-run tool_use/tool_result pairing repair after truncation, since
          // limitHistoryTurns can orphan tool_result blocks by removing the
          // assistant message that contained the matching tool_use.
          const limited = transcriptPolicy.repairToolUseResultPairing
            ? sanitizeToolUseResultPairingForModel(
                truncated,
                effectiveModel.api === "openai-responses" ||
                  effectiveModel.api === "azure-openai-responses" ||
                  effectiveModel.api === "openai-chatgpt-responses",
              )
            : truncated;
          if (limited.length > 0) {
            session.agent.state.messages = limited;
          }
          const hookRunner = asCompactionHookRunner(getGlobalHookRunner());
          const observedTokenCount = normalizeObservedTokenCount(params.currentTokenCount);
          const beforeHookMetrics = buildBeforeCompactionHookMetrics({
            originalMessages,
            currentMessages: session.messages,
            observedTokenCount,
            estimateTokensFn: estimateTokens,
          });
          const { hookSessionKey, missingSessionKey } = await runBeforeCompactionHooks({
            hookRunner,
            sessionId: params.sessionId,
            sessionKey: sessionTarget.sessionKey,
            sessionAgentId,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            metrics: beforeHookMetrics,
            onHookMessages: params.onCompactionHookMessages,
          });
          const { messageCountOriginal, tokenCountBefore: limitedTranscriptTokensBefore } =
            beforeHookMetrics;
          const diagEnabled = log.isEnabled("debug");
          const preMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics) {
            log.debug(
              `[compaction-diag] start runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} ` +
                `pre.messages=${preMetrics.messages} pre.historyTextChars=${preMetrics.historyTextChars} ` +
                `pre.toolResultChars=${preMetrics.toolResultChars} pre.estTokens=${preMetrics.estTokens ?? "unknown"}`,
            );
            log.debug(
              `[compaction-diag] contributors diagId=${diagId} top=${JSON.stringify(preMetrics.contributors)}`,
            );
          }

          if (!containsRealConversationMessages(session.messages)) {
            log.info(
              `[compaction] skipping — no real conversation messages (sessionKey=${params.sessionKey ?? params.sessionId})`,
            );
            return {
              ok: true,
              compacted: false,
              reason: "no real conversation messages",
            };
          }

          const compactStartedAt = Date.now();
          // Setup completed: give the first provider request a full safety window.
          params.compactionTimeoutReset?.();
          const serverResult = await attemptServerEndpointCompaction({
            trigger,
            streamFn: session.agent.streamFn,
            model: effectiveModel,
            context: { systemPrompt: systemPromptText, messages: session.messages },
            sessionManager,
            extraParams: effectiveExtraParams,
            customInstructions: params.customInstructions,
            config: params.config,
            onUsage: recordUsage,
            requestOptions: {
              apiKey: transportApiKey,
              sessionId: params.sessionId,
              authProfileId: runtimePlan.auth.forwardedAuthProfileId,
              timeoutMs: compactionTimeoutMs,
              signal: params.abortSignal,
            },
          });
          const activeSession = session;
          let clientResult: Awaited<ReturnType<typeof activeSession.compact>> | undefined;
          if (!serverResult) {
            try {
              // The client watchdog starts here; refresh the delegated host watchdog with it.
              params.compactionTimeoutReset?.();
              clientResult = await compactWithSafetyTimeout(
                (_signal, resetTimeout) => {
                  resetCompactionTimeout = resetTimeout;
                  setCompactionSafeguardCancellation(compactionSessionManager, undefined);
                  return resolveEffectiveCompactionMode(params.config) === "default" &&
                    trigger !== "manual"
                    ? activeSession[agentSessionAutomaticCompaction](params.customInstructions)
                    : activeSession.compact(params.customInstructions);
                },
                compactionTimeoutMs,
                {
                  abortSignal: params.abortSignal,
                  onCancel: () => {
                    activeSession.abortCompaction();
                  },
                },
              );
            } finally {
              resetCompactionTimeout = undefined;
            }
          }
          // Compaction succeeded: post-processing gets its own full watchdog window.
          params.compactionTimeoutReset?.();
          const effectiveFirstKeptEntryId = clientResult?.firstKeptEntryId;
          const tokensBefore = serverResult?.usage.input_tokens ?? clientResult!.tokensBefore;
          // Endpoint output_tokens excludes retained inputs. Count the actual
          // committed replacement window, not the owner's pre-compaction usage.
          const tokensAfter = serverResult
            ? estimateLlmBoundaryTokenPressure({
                messages: sessionManager.buildSessionContext().messages,
                systemPrompt: systemPromptText,
                prompt: "",
                replay: {
                  model: effectiveModel,
                  sessionId: params.sessionId,
                  authProfileId: runtimePlan.auth.forwardedAuthProfileId,
                  enabled: compactionReplayEnabled,
                },
              })
            : estimateTokensAfterCompaction({
                messagesAfter: session.messages,
                observedTokenCount,
                fullSessionTokensBefore: limitedTranscriptTokensBefore ?? 0,
                estimateTokensFn: estimateTokens,
              });
          const messageCountAfter = session.messages.length;
          const compactedCount = Math.max(0, messageCountOriginal - messageCountAfter);
          const activeSessionFile = formatSqliteSessionFileMarker({
            ...sessionTarget,
            sessionId: params.sessionId,
          });
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            sessionFile: activeSessionFile,
          });
          if (clientResult) {
            checkpointSnapshotRetained = await persistCompactionCheckpoint({
              config: params.config,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              trigger: params.trigger,
              snapshot: checkpointSnapshot,
              summary: clientResult.summary,
              firstKeptEntryId: effectiveFirstKeptEntryId,
              tokensBefore: observedTokenCount ?? clientResult.tokensBefore,
              tokensAfter,
              sessionFile: activeSessionFile,
              leafId: sessionManager.getLeafId?.() ?? undefined,
              createdAt: compactStartedAt,
            });
          }
          const postMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics && postMetrics) {
            log.debug(
              `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} outcome=compacted reason=none ` +
                `durationMs=${Date.now() - compactStartedAt} retrying=false ` +
                `post.messages=${postMetrics.messages} post.historyTextChars=${postMetrics.historyTextChars} ` +
                `post.toolResultChars=${postMetrics.toolResultChars} post.estTokens=${postMetrics.estTokens ?? "unknown"} ` +
                `delta.messages=${postMetrics.messages - preMetrics.messages} ` +
                `delta.historyTextChars=${postMetrics.historyTextChars - preMetrics.historyTextChars} ` +
                `delta.toolResultChars=${postMetrics.toolResultChars - preMetrics.toolResultChars} ` +
                `delta.estTokens=${typeof preMetrics.estTokens === "number" && typeof postMetrics.estTokens === "number" ? postMetrics.estTokens - preMetrics.estTokens : "unknown"}`,
            );
          }
          await runAfterCompactionHooks({
            hookRunner,
            sessionId: params.sessionId,
            sessionAgentId,
            hookSessionKey,
            missingSessionKey,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            messageCountAfter,
            tokensAfter,
            compactedCount,
            sessionFile: activeSessionFile,
            summaryLength: clientResult?.summary.length,
            tokensBefore,
            firstKeptEntryId: effectiveFirstKeptEntryId,
            onHookMessages: params.onCompactionHookMessages,
          });
          return {
            ok: true,
            compacted: true,
            ...(serverResult ? { compactionKind: "server-endpoint" as const } : {}),
            result: {
              ...(clientResult
                ? {
                    summary: clientResult.summary,
                    firstKeptEntryId: clientResult.firstKeptEntryId,
                  }
                : { kind: "server-endpoint" as const }),
              tokensBefore: serverResult
                ? tokensBefore
                : (observedTokenCount ?? clientResult!.tokensBefore),
              tokensAfter,
              details: serverResult
                ? {
                    compactionKind: "server-endpoint" as const,
                    droppedMessageCount: serverResult.usage.dropped_message_count,
                  }
                : clientResult!.details,
            },
          };
        } catch (err) {
          const failure = resolveCompactionFailure({
            error: err,
            safeguardCancellation: getCompactionSafeguardRuntime(sessionManager)?.cancellation,
            abortSignal: params.abortSignal,
          });
          const fallbackThinking = pickFallbackThinkingLevel({
            message: formatErrorMessage(failure.error),
            attempted: attemptedThinking,
          });
          if (fallbackThinking) {
            // Near-term provider fix: when compaction hits a reasoning-mandatory
            // endpoint with `off`, retry once with `minimal` instead of surfacing
            // a user-visible failure.
            log.warn(
              `[compaction] request rejected for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            // The rejected request may have consumed nearly its full window. Rearm the
            // delegated watchdog before rebuilding the session for the fallback attempt.
            params.compactionTimeoutReset?.();
            continue;
          }
          throw err;
        } finally {
          // Retire exact recovery authority before asynchronous session cleanup can yield.
          if (diagnosticOwner) {
            closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
          }
          try {
            await flushPendingToolResultsAfterIdle({
              agent: session?.agent,
              sessionManager,
            });
          } catch {
            /* best-effort */
          }
          try {
            session?.dispose();
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      await runtime.disposeToolRuntimes();
    }
  } catch (err) {
    const failure = resolveCompactionFailure({
      error: err,
      safeguardCancellation: consumeCompactionSafeguardCancellation(compactionSessionManager),
      abortSignal: params.abortSignal,
    });
    return fail(failure.reason, failure.error);
  } finally {
    setSessionModelUsageSink(compactionSessionManager, null);
    if (!checkpointSnapshotRetained) {
      await compactionCheckpointStore.cleanupSnapshot(checkpointSnapshot);
    }
  }
}
