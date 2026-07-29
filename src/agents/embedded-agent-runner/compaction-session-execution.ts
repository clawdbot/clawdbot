import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { acquireOwnedSessionTranscriptWriteLock } from "../../config/sessions/transcript-write-context.js";
/**
 * Executes compaction while owning the transcript lock, session lifecycle,
 * hooks, checkpoint, and optional successor transcript rotation.
 */
import type { CapturedCompactionCheckpointSnapshot } from "../../gateway/session-compaction-checkpoints.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  consumeCompactionSafeguardCancelReason,
  setCompactionSafeguardCancelReason,
} from "../agent-hooks/compaction-safeguard-runtime.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel,
} from "../agent-settings.js";
import { pickFallbackThinkingLevel } from "../embedded-agent-helpers.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
  resolveSessionWriteLockTargetKey,
  resolveSessionWriteLockOptions,
} from "../session-write-lock.js";
import { createAgentSession, estimateTokens, SessionManager } from "../sessions/index.js";
import { getModelRegistryRuntime } from "../sessions/model-registry-runtime.js";
import { resolveCompactionFailureReason } from "./compact-reasons.js";
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
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
    });
    const sessionLock =
      (await acquireOwnedSessionTranscriptWriteLock({
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        sessionTarget,
      })) ??
      (await acquireSessionWriteLock({
        sessionFile: resolveSessionWriteLockTargetKey(sessionTarget),
        targetKind: "session-key",
        ...resolveSessionWriteLockOptions(params.config, {
          maxHoldMsFallback: resolveSessionLockMaxHoldFromTimeout({
            timeoutMs: compactionTimeoutMs,
          }),
        }),
      }));
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
        // Rebuild the compaction session on retry so provider wrappers, payload
        // shaping, and the embedded system prompt all reflect the fallback level.
        attemptedThinking.add(thinkLevel);
        const systemPromptText = buildSystemPromptText(thinkLevel);
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const createdSession = await createAgentSession({
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
          });
          session = createdSession.session;
          session.setActiveToolsByName(sessionToolAllowlist);
          applySystemPromptToSession(session, systemPromptText);
          // Compaction builds the same embedded system prompt, so it must flow
          // through the same transport/payload shaping stack as normal turns.
          await prepareCompactionSessionAgent({
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
              contextTokenBudget,
              trace: compactionModelCallTrace,
              contentCapture: resolveDiagnosticModelContentCapturePolicy(params.config),
              nextCallId: nextDiagnosticModelCallId,
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
          const truncated = limitHistoryTurns(
            session.messages,
            getHistoryLimitFromSessionKey(params.sessionKey, params.config),
          );
          // Re-run tool_use/tool_result pairing repair after truncation, since
          // limitHistoryTurns can orphan tool_result blocks by removing the
          // assistant message that contained the matching tool_use.
          const limited = transcriptPolicy.repairToolUseResultPairing
            ? sanitizeToolUseResultPairing(truncated, {
                erroredAssistantResultPolicy: "drop",
                ...(effectiveModel.api === "openai-responses" ||
                effectiveModel.api === "azure-openai-responses" ||
                effectiveModel.api === "openai-chatgpt-responses"
                  ? { missingToolResultText: "aborted" }
                  : {}),
              })
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
            sessionKey: params.sessionKey,
            sessionAgentId,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            metrics: beforeHookMetrics,
            onHookMessages: params.onCompactionHookMessages,
          });
          const { messageCountOriginal } = beforeHookMetrics;
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
          // Measure compactedCount from the original pre-limiting transcript so compaction
          // lifecycle metrics represent total reduction through the compaction pipeline.
          const messageCountCompactionInput = messageCountOriginal;
          // Estimate all limited transcript messages before compaction. This is the
          // same token domain as messagesAfter; result.tokensBefore can cover only the
          // summarizable subset.
          let limitedTranscriptTokensBefore = 0;
          try {
            limitedTranscriptTokensBefore = limited.reduce(
              (sum, msg) => sum + estimateTokens(msg),
              0,
            );
          } catch {
            // If token estimation throws on a malformed message, fall back to 0 so
            // the sanity check below becomes a no-op instead of crashing compaction.
          }
          const activeSession = session;
          const result = await compactWithSafetyTimeout(
            () => {
              setCompactionSafeguardCancelReason(compactionSessionManager, undefined);
              return activeSession.compact(params.customInstructions);
            },
            compactionTimeoutMs,
            {
              abortSignal: params.abortSignal,
              onCancel: () => {
                activeSession.abortCompaction();
              },
            },
          );
          const effectiveFirstKeptEntryId = result.firstKeptEntryId;
          const postCompactionLeafId =
            typeof sessionManager.getLeafId === "function"
              ? (sessionManager.getLeafId() ?? undefined)
              : undefined;
          // Estimate tokens after compaction by summing token estimates for remaining messages
          const tokensAfter = estimateTokensAfterCompaction({
            messagesAfter: session.messages,
            observedTokenCount,
            fullSessionTokensBefore: limitedTranscriptTokensBefore,
            estimateTokensFn: estimateTokens,
          });
          const messageCountAfter = session.messages.length;
          const compactedCount = Math.max(0, messageCountCompactionInput - messageCountAfter);
          const activeSessionId = params.sessionId;
          const activeSessionFile = formatSqliteSessionFileMarker({
            ...sessionTarget,
            sessionId: activeSessionId,
          });
          const activePostLeafId = postCompactionLeafId;
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: activeSessionId,
            agentId: sessionAgentId,
            sessionFile: activeSessionFile,
          });
          checkpointSnapshotRetained = await persistCompactionCheckpoint({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionId: activeSessionId,
            trigger: params.trigger,
            snapshot: checkpointSnapshot,
            summary: result.summary,
            firstKeptEntryId: effectiveFirstKeptEntryId,
            tokensBefore: observedTokenCount ?? result.tokensBefore,
            tokensAfter,
            sessionFile: activeSessionFile,
            leafId: activePostLeafId,
            createdAt: compactStartedAt,
          });
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
            sessionId: activeSessionId,
            sessionAgentId,
            hookSessionKey,
            missingSessionKey,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            messageCountAfter,
            tokensAfter,
            compactedCount,
            sessionFile: activeSessionFile,
            ...(activeSessionId !== params.sessionId
              ? { previousSessionId: params.sessionId }
              : {}),
            summaryLength: typeof result.summary === "string" ? result.summary.length : undefined,
            tokensBefore: result.tokensBefore,
            firstKeptEntryId: effectiveFirstKeptEntryId,
            onHookMessages: params.onCompactionHookMessages,
          });
          return {
            ok: true,
            compacted: true,
            result: {
              summary: result.summary,
              firstKeptEntryId: effectiveFirstKeptEntryId,
              tokensBefore: observedTokenCount ?? result.tokensBefore,
              tokensAfter,
              details: result.details,
              sessionId: undefined,
              sessionFile: undefined,
            },
          };
        } catch (err) {
          const fallbackThinking = pickFallbackThinkingLevel({
            message: formatErrorMessage(err),
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
            continue;
          }
          throw err;
        } finally {
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
      await sessionLock.release();
    }
  } catch (err) {
    const reason = resolveCompactionFailureReason({
      reason: formatErrorMessage(err),
      safeguardCancelReason: consumeCompactionSafeguardCancelReason(compactionSessionManager),
    });
    return fail(reason, err);
  } finally {
    if (!checkpointSnapshotRetained) {
      await compactionCheckpointStore.cleanupSnapshot(checkpointSnapshot);
    }
  }
}
