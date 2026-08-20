/**
 * Top-level CLI-backed agent runner orchestration.
 */
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { buildGenericCliContextEngineHostSupport } from "../context-engine/host-compat.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../plugins/hook-agent-context.js";
import { resolveBlockMessage } from "../plugins/hook-decision-types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  loadAuthProfileStoreForRuntime,
  markAuthProfileFailure,
  markAuthProfileSuccess,
} from "./auth-profiles.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { acceptsClaudeLive } from "./cli-runner/claude-live-session-policy.js";
import {
  resolveCliSessionId,
  runCliRecovery,
  type CliRecoveryOptions,
} from "./cli-runner/cli-run-recovery.js";
import {
  assertCliRuntimeBinding,
  buildBlockedCliRunResult,
  buildCliDeliveredFailure,
  buildCliRunResult,
  cliRunSettlementDeps,
  isClaudeCliBackend,
  resolveCliSourceReplyMirror,
  settleCliBackendOutcome,
  settleCliPreparationError,
  settlePreparedCliRun,
} from "./cli-runner/cli-run-settlement.js";
import {
  buildCliHookAssistantMessage,
  buildCliHookUserMessage,
  finalizeCliContextEngineTurn,
  persistApprovedCliUserTurnTranscript,
  persistCliAssistantTranscript,
  persistCliRunBlock,
  runCliAgentEndHook,
} from "./cli-runner/cli-run-transcript.js";
import {
  attachCliMessagingDeliveryEvidence,
  getCliMessagingDeliveryEvidence,
} from "./cli-runner/delivery-evidence.js";
import { createCliFailoverError } from "./cli-runner/exit-error.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./cli-runner/log.js";
import {
  runClaudeCliAgentTurnWithDiagnostics,
  type ClaudeCliRunDiagnosticLifecycle,
} from "./cli-runner/run-diagnostics.js";
import {
  loadCliSessionContextEngineMessages,
  loadCliSessionHistoryMessages,
} from "./cli-runner/session-history.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { claudeCliSessionTranscriptHasContent as claudeCliSessionTranscriptHasContentImpl } from "./command/attempt-execution.helpers.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner.js";
import { waitForDeferredTurnMaintenanceForSession } from "./embedded-agent-runner/context-engine-maintenance.js";
import { bootstrapHarnessContextEngine } from "./harness/context-engine-lifecycle.js";
import { buildAgentHookContext } from "./harness/hook-context.js";
import { buildAgentHookConversationMessages } from "./harness/hook-history.js";
import {
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./harness/lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/cli-runner");
const cliRunnerDeps = cliRunSettlementDeps;

/** Overrides top-level CLI runner dependencies for tests. */
export function setCliRunnerTestDeps(overrides: Partial<typeof cliRunnerDeps>): void {
  Object.assign(cliRunnerDeps, overrides);
}

/** Restores default top-level CLI runner dependencies after tests. */
export function restoreCliRunnerTestDeps(): void {
  cliRunnerDeps.claudeCliSessionTranscriptHasContent = claudeCliSessionTranscriptHasContentImpl;
  cliRunnerDeps.delay = async (delayMs: number) => {
    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  };
  cliRunnerDeps.loadAuthProfileStoreForRuntime = loadAuthProfileStoreForRuntime;
  cliRunnerDeps.markAuthProfileFailure = markAuthProfileFailure;
  cliRunnerDeps.markAuthProfileSuccess = markAuthProfileSuccess;
}

/** Checks whether a Claude CLI session binding has reached its transcript file. */
export async function isCliBindingFlushed(
  sessionId: string | undefined,
  provider: string | undefined,
  workspaceDir?: string,
  options?: { skipTranscriptProbe?: boolean },
): Promise<boolean> {
  if (!provider || !isClaudeCliBackend(provider)) {
    return true;
  }
  if (!sessionId) {
    return false;
  }
  // Warm-stdin sessions keep continuity in the managed stdio child and do not
  // write native transcripts. Probing them would always clear a valid binding.
  if (options?.skipTranscriptProbe) {
    return true;
  }
  for (const delayMs of [0, 50, 150]) {
    if (delayMs > 0) {
      await cliRunnerDeps.delay(delayMs);
    }
    if (await cliRunnerDeps.claudeCliSessionTranscriptHasContent({ sessionId, workspaceDir })) {
      return true;
    }
  }
  return false;
}

/** Prepares and runs one CLI-backed agent turn. */
export function runCliAgent(paramsInput: RunCliAgentParams): Promise<EmbeddedAgentRunResult> {
  const lifecycleGeneration =
    paramsInput.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(paramsInput.runId);
  const params = {
    ...paramsInput,
    lifecycleGeneration,
  };
  // Observability services register before turns and keep subscriptions process-stable.
  // Snapshot listener presence here so disabled installs pay no synthetic trace cost.
  return withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    isClaudeCliBackend(params.provider) &&
    areDiagnosticsEnabledForProcess() &&
    hasInternalDiagnosticEventListeners()
      ? runClaudeCliAgentTurnWithDiagnostics(params, (diagnosticLifecycle) =>
          runCliAgentInternal(params, diagnosticLifecycle),
        )
      : runCliAgentInternal(params),
  );
}

async function runCliAgentInternal(
  params: RunCliAgentParams,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration!);
  // The hook gate must fire before prepareCliRunContext — that call allocates
  // backend resources released only by runPreparedCliAgent's try…finally.
  params.onExecutionStarted?.();
  const hookStartedAt = Date.now();
  // Prompt-only inference cannot enter agent hooks: they may replace the turn
  // or add side effects before the exact zero-tool process even starts.
  const hookResult =
    params.isolatedCompletion || params.controlOperation
      ? undefined
      : await runBeforeAgentReplyForTurn({
          runId: params.runId,
          trigger: params.trigger,
          event: { cleanedBody: params.prompt },
          context: {
            runId: params.runId,
            jobId: params.jobId,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            workspaceDir: params.workspaceDir,
            trigger: params.trigger,
            ...buildAgentHookContextChannelFields(params),
            ...buildAgentHookContextIdentityFields({
              trigger: params.trigger,
              senderId: params.senderId,
              chatId: params.chatId,
              channelContext: params.channelContext,
            }),
          },
          onDispatch: () =>
            params.onExecutionPhase?.({
              phase: "before_agent_reply",
              provider: params.provider,
              model: params.model ?? "",
            }),
          onDeclined: () =>
            params.onExecutionPhase?.({
              phase: "runtime_plugins",
              provider: params.provider,
              model: params.model ?? "",
            }),
        });
  if (hookResult?.handled) {
    const finalText = hookResult.reply?.text ?? SILENT_REPLY_TOKEN;
    const syntheticBackend = resolveCliBackendConfig(params.provider, params.config, {
      agentId: params.agentId,
    });
    const sessionBindingDisabled = syntheticBackend?.config.sessionMode === "none";
    cliBackendLog.info(
      `cli synthetic turn: provider=${params.provider} model=<synthetic> requestedModel=${params.model ?? ""} durationMs=${Date.now() - hookStartedAt} ${formatCliBackendOutputDigest(finalText)}`,
    );
    return {
      payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
      meta: {
        durationMs: Date.now() - hookStartedAt,
        agentMeta: {
          sessionId: "",
          provider: params.provider,
          model: params.model ?? "",
          ...(sessionBindingDisabled ? { clearCliSessionBinding: true } : {}),
        },
        finalAssistantVisibleText: finalText,
        finalAssistantRawText: finalText,
      },
    };
  }
  const { prepareCliRunContext } = await import("./cli-runner/prepare.runtime.js");
  let context: PreparedCliRunContext;
  try {
    context = await prepareCliRunContext(params);
  } catch (error) {
    await settleCliPreparationError(error, params);
    throw error;
  }
  return await settlePreparedCliRun({
    context,
    diagnosticLifecycle,
    run: async () => await runPreparedCliAgent(context, diagnosticLifecycle),
  });
}

/** Runs an already-prepared CLI agent context through hooks and execution. */
export async function runPreparedCliAgent(
  context: PreparedCliRunContext,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  const { executePreparedCliRun } = await import("./cli-runner/execute.runtime.js");
  const { params } = context;
  const cliFailoverContext = {
    provider: params.provider,
    model: context.modelId,
    sessionId: params.sessionId,
    lane: params.lane,
  };
  const sessionBindingDisabled = context.preparedBackend.backend.sessionMode === "none";
  const preparedContextAgentMeta =
    isClaudeCliBackend(params.provider) && context.contextWindowInfo
      ? {
          contextTokens: context.contextWindowInfo.tokens,
          contextTokensSource: "resolved" as const,
        }
      : {};
  const isolatedCompletion = params.isolatedCompletion === true;
  const controlOperation = params.controlOperation !== undefined;
  const turnSideEffectsDisabled = isolatedCompletion || controlOperation;
  const hookRunner = turnSideEffectsDisabled ? undefined : getGlobalHookRunner();
  const hasLlmInputHooks = hookRunner?.hasHooks("llm_input") === true;
  const hasLlmOutputHooks = hookRunner?.hasHooks("llm_output") === true;
  const hasAgentEndHooks = hookRunner?.hasHooks("agent_end") === true;
  const hasBeforeAgentRunHooks = hookRunner?.hasHooks("before_agent_run") === true;
  const needsHookHistory = hasLlmInputHooks || hasAgentEndHooks || hasBeforeAgentRunHooks;
  // Prior turn maintenance can rewrite transcript entries after finalization.
  // Reads for the next same-session inference must observe that rewrite.
  if (!turnSideEffectsDisabled) {
    await waitForDeferredTurnMaintenanceForSession(params.sessionKey ?? params.sessionId);
  }
  const historyMessages = needsHookHistory
    ? await loadCliSessionHistoryMessages({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      })
    : [];
  const llmInputEvent = {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: context.modelId,
    systemPrompt: context.systemPrompt,
    prompt: params.prompt,
    historyMessages,
    imagesCount: params.images?.length ?? 0,
  } as const;
  const hookContext = {
    runId: params.runId,
    jobId: params.jobId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    trigger: params.trigger,
    ...(params.config ? { config: params.config } : {}),
    ...(context.contextWindowInfo?.tokens
      ? { contextTokenBudget: context.contextWindowInfo.tokens }
      : {}),
    ...(context.contextWindowInfo?.source
      ? { contextWindowSource: context.contextWindowInfo.source }
      : {}),
    ...(context.contextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: context.contextWindowInfo.referenceTokens }
      : {}),
    ...buildAgentHookContextChannelFields(params),
    ...buildAgentHookContextIdentityFields({
      trigger: params.trigger,
      senderId: params.senderId,
      chatId: params.chatId,
      channelContext: params.channelContext,
    }),
  } as const;

  const buildAgentEndMessages = (lastAssistant?: unknown): unknown[] => [
    ...buildAgentHookConversationMessages({
      historyMessages,
      currentTurnMessages: [
        buildCliHookUserMessage(params.prompt),
        ...(lastAssistant ? [lastAssistant] : []),
      ],
    }),
  ];

  const buildFailedAgentEndEvent = (error: string) => ({
    messages: buildAgentEndMessages(),
    success: false,
    error,
    durationMs: Date.now() - context.started,
  });

  const buildBlockedAgentEndEvent = (message: string) => ({
    messages: buildAgentHookConversationMessages({
      historyMessages,
      currentTurnMessages: [buildCliHookUserMessage(message)],
    }),
    success: false,
    error: message,
    durationMs: Date.now() - context.started,
  });

  let deliveredMessagingSideEffect = false;
  let userTurnHandled = false;
  const executeCliAttempt = async (cliSessionIdToUse?: string, options?: CliRecoveryOptions) => {
    const timeoutMs = options?.timeoutMs ?? params.timeoutMs;
    const forkCliSessionOnResume =
      options?.forkCliSessionOnResume ?? context.params.forkCliSessionOnResume;
    const cliSessionResumeAt =
      cliSessionIdToUse && forkCliSessionOnResume
        ? (options?.resumeAt ??
          context.params.cliSessionResumeAt ??
          context.params.cliSessionBinding?.resumeCheckpointId)
        : undefined;
    const persistCliSessionForkSuccessor =
      options?.onForkSuccessorPersisted && context.params.persistCliSessionForkSuccessor
        ? async (sessionId: string) => {
            await context.params.persistCliSessionForkSuccessor?.(sessionId);
            options.onForkSuccessorPersisted?.(sessionId);
          }
        : context.params.persistCliSessionForkSuccessor;
    const attemptContext =
      timeoutMs === params.timeoutMs &&
      forkCliSessionOnResume === context.params.forkCliSessionOnResume &&
      cliSessionResumeAt === context.params.cliSessionResumeAt &&
      persistCliSessionForkSuccessor === context.params.persistCliSessionForkSuccessor
        ? context
        : {
            ...context,
            params: {
              ...context.params,
              timeoutMs,
              forkCliSessionOnResume,
              cliSessionResumeAt,
              persistCliSessionForkSuccessor,
            },
          };
    diagnosticLifecycle?.setPhase("send");
    const output = await executePreparedCliRun(
      attemptContext,
      cliSessionIdToUse,
      diagnosticLifecycle ? { onPhase: diagnosticLifecycle.setPhase } : undefined,
    );
    // Test facades and non-instrumented executors may not signal the boundary.
    diagnosticLifecycle?.setPhase("resolve");
    const sourceReplyMirror = resolveCliSourceReplyMirror({
      evidence: output,
      runParams: params,
      modelId: context.modelId,
    });
    const assistantText = sourceReplyMirror.delivered
      ? (sourceReplyMirror.visibleText ?? "")
      : output.text.trim();
    if (
      !assistantText &&
      !output.didSendViaMessagingTool &&
      params.allowEmptyAssistantReplyAsSilent !== true
    ) {
      const process = output.diagnostics?.process;
      if (process) {
        const diagnostics = [
          `backend=${process.backendId}`,
          `reason=${process.processReason}`,
          `exitCode=${process.exitCode ?? "null"}`,
          `exitSignal=${process.exitSignal ?? "null"}`,
          `durationMs=${process.durationMs}`,
          `stdoutBytes=${process.stdoutBytes}`,
          `stdoutHash=${process.stdoutHash}`,
          `stderrBytes=${process.stderrBytes}`,
          `stderrHash=${process.stderrHash}`,
          `useResume=${process.useResume ? "true" : "false"}`,
        ].join(" ");
        cliBackendLog.warn(`cli empty response diagnostics: ${diagnostics}`);
      }
      throw attachCliMessagingDeliveryEvidence(
        createCliFailoverError(
          "CLI backend returned an empty response.",
          "empty_response",
          cliFailoverContext,
        ),
        output,
      );
    }
    const assistantTexts = assistantText ? [assistantText] : [];
    const lastAssistant =
      assistantText.length > 0
        ? buildCliHookAssistantMessage({
            text: assistantText,
            provider: params.provider,
            model: context.modelId,
            usage: output.usage,
          })
        : undefined;
    if (assistantText.length > 0 && hasLlmOutputHooks) {
      runAgentHarnessLlmOutputHook({
        event: {
          runId: params.runId,
          sessionId: params.sessionId,
          provider: params.provider,
          model: context.modelId,
          ...(context.contextWindowInfo?.tokens
            ? { contextTokenBudget: context.contextWindowInfo.tokens }
            : {}),
          ...(context.contextWindowInfo?.source
            ? { contextWindowSource: context.contextWindowInfo.source }
            : {}),
          ...(context.contextWindowInfo?.referenceTokens
            ? { contextWindowReferenceTokens: context.contextWindowInfo.referenceTokens }
            : {}),
          resolvedRef: `${params.provider}/${context.modelId}`,
          assistantTexts,
          ...(lastAssistant ? { lastAssistant } : {}),
          ...(output.usage ? { usage: output.usage } : {}),
        },
        ctx: hookContext,
        hookRunner,
      });
    }
    return {
      output,
      assistantText,
      lastAssistant,
      sourceReplyWasDelivered: sourceReplyMirror.delivered,
      usedHistoryPrompt:
        cliSessionIdToUse === undefined && context.openClawHistoryPrompt !== undefined,
    };
  };

  const executeRun = async (): Promise<EmbeddedAgentRunResult> => {
    if (isolatedCompletion) {
      const { output, usedHistoryPrompt } = await executeCliAttempt();
      return buildCliRunResult({
        context,
        output,
        bindingFlushOk: true,
        assistantTranscriptOwned: false,
        usedHistoryPrompt,
        userTurnHandled,
        sessionBindingDisabled,
        preparedContextAgentMeta,
      });
    }
    if (controlOperation) {
      const reusableCliSessionId = resolveCliSessionId(context.reusableCliSession);
      if (!reusableCliSessionId) {
        throw new Error(
          `CLI backend ${context.backendResolved.id} cannot ${params.controlOperation} without a reusable native session.`,
        );
      }
      const { output, usedHistoryPrompt } = await executeCliAttempt(reusableCliSessionId);
      return buildCliRunResult({
        context,
        output,
        effectiveCliSessionId: reusableCliSessionId,
        bindingFlushOk: true,
        assistantTranscriptOwned: false,
        usedHistoryPrompt,
        userTurnHandled,
        sessionBindingDisabled,
        preparedContextAgentMeta,
      });
    }
    await bootstrapHarnessContextEngine({
      hadSessionFile: context.hadSessionFile,
      contextEngine: context.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      config: context.contextEngineConfig,
      contextEngineHostSupport: buildGenericCliContextEngineHostSupport({
        backendId: context.backendResolved.id,
      }),
      providerId: params.provider,
      modelId: context.modelId,
      warn: (message) => log.warn(message),
    });
    const contextEngineHistoryMessages = context.contextEngine
      ? await loadCliSessionContextEngineMessages({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          config: params.config,
        })
      : [];
    const finishCliAttempt = async (
      result: Awaited<ReturnType<typeof executeCliAttempt>>,
      fallbackCliSessionId?: string,
    ) => {
      const { output, assistantText, lastAssistant, sourceReplyWasDelivered, usedHistoryPrompt } =
        result;
      try {
        await assertCliRuntimeBinding(context);
        const effectiveCliSessionId = output.sessionId ?? fallbackCliSessionId;
        const assistantTranscript = await persistCliAssistantTranscript({
          runParams: params,
          // Dispatch owns source-reply transcript mirrors and their idempotency keys.
          // Persisting them here would duplicate the same visible assistant reply.
          text: sourceReplyWasDelivered ? "" : assistantText,
          modelId: context.modelId,
          usage: output.usage,
        });
        await finalizeCliContextEngineTurn({
          context,
          historyMessages: context.contextEngine ? contextEngineHistoryMessages : historyMessages,
          assistantText,
          terminalAnchor: assistantTranscript.terminalAnchor,
          output,
        });
        // A stateless backend may emit an id, but it never becomes continuity.
        // Managed stdio sessions own continuity in-process and write no native transcript.
        const bindingFlushOk = sessionBindingDisabled
          ? true
          : await isCliBindingFlushed(
              effectiveCliSessionId,
              params.provider,
              context.cwd ?? context.workspaceDir,
              { skipTranscriptProbe: acceptsClaudeLive(context) },
            );
        await runCliAgentEndHook(params, {
          event: {
            messages: buildAgentEndMessages(lastAssistant),
            success: true,
            durationMs: Date.now() - context.started,
          },
          ctx: hookContext,
          hookRunner,
        });
        return buildCliRunResult({
          context,
          output,
          effectiveCliSessionId,
          bindingFlushOk,
          assistantTranscriptOwned: assistantTranscript.owned,
          assistantTranscriptIdempotencyKey: assistantTranscript.idempotencyKey,
          usedHistoryPrompt,
          userTurnHandled,
          sessionBindingDisabled,
          preparedContextAgentMeta,
        });
      } catch (error) {
        throw attachCliMessagingDeliveryEvidence(error, output);
      }
    };

    const finishDeliveredFailure = async (
      error: unknown,
    ): Promise<EmbeddedAgentRunResult | undefined> => {
      const evidence = getCliMessagingDeliveryEvidence(error);
      if (!evidence) {
        return undefined;
      }
      await runCliAgentEndHook(params, {
        event: buildFailedAgentEndEvent(formatErrorMessage(error)),
        ctx: hookContext,
        hookRunner,
      });
      deliveredMessagingSideEffect = true;
      return buildCliDeliveredFailure({
        error,
        evidence,
        context,
        preparedContextAgentMeta,
        sessionBindingDisabled,
        reusableCliSessionId: resolveCliSessionId(context.reusableCliSession),
      });
    };

    if (hasBeforeAgentRunHooks && hookRunner) {
      let beforeRunResult:
        | Awaited<ReturnType<NonNullable<typeof hookRunner>["runBeforeAgentRun"]>>
        | undefined;
      try {
        beforeRunResult = await hookRunner.runBeforeAgentRun(
          {
            prompt: params.prompt,
            systemPrompt: context.systemPrompt,
            messages: buildAgentHookConversationMessages({
              historyMessages,
              currentTurnMessages: [],
            }),
            channelId: hookContext.channelId,
            accountId: params.agentAccountId,
            senderId: params.senderId ?? undefined,
            senderIsOwner: params.senderIsOwner ?? undefined,
          },
          buildAgentHookContext(hookContext),
        );
      } catch {
        const blockMessage = resolveBlockMessage(
          { outcome: "block", reason: "before_agent_run hook failed" },
          { blockedBy: "before_agent_run" },
        );
        await persistCliRunBlock(params, {
          message: blockMessage,
          pluginId: "before_agent_run",
        });
        await runCliAgentEndHook(params, {
          event: buildBlockedAgentEndEvent(blockMessage),
          ctx: hookContext,
          hookRunner,
        });
        return buildBlockedCliRunResult({
          message: blockMessage,
          context,
          preparedContextAgentMeta,
          sessionBindingDisabled,
        });
      }

      const beforeRunDecision = beforeRunResult?.decision;
      if (beforeRunDecision?.outcome === "block") {
        const blockMessage = resolveBlockMessage(beforeRunDecision, {
          blockedBy: beforeRunResult?.pluginId ?? "unknown",
        });
        await persistCliRunBlock(params, {
          message: blockMessage,
          pluginId: beforeRunResult?.pluginId ?? "unknown",
        });
        await runCliAgentEndHook(params, {
          event: buildBlockedAgentEndEvent(blockMessage),
          ctx: hookContext,
          hookRunner,
        });
        return buildBlockedCliRunResult({
          message: blockMessage,
          context,
          preparedContextAgentMeta,
          sessionBindingDisabled,
        });
      }
    }

    userTurnHandled = await persistApprovedCliUserTurnTranscript(params);
    runAgentHarnessLlmInputHook({
      event: llmInputEvent,
      ctx: hookContext,
      hookRunner,
    });
    return await runCliRecovery({
      context,
      executeAttempt: executeCliAttempt,
      finishAttempt: finishCliAttempt,
      finishDeliveredFailure,
      onTerminalFailure: async (error) => {
        await runCliAgentEndHook(params, {
          event: buildFailedAgentEndEvent(formatErrorMessage(error)),
          ctx: hookContext,
          hookRunner,
        });
      },
    });
  };

  let runResult: EmbeddedAgentRunResult | undefined;
  let runError: unknown;
  let runFailed = false;
  try {
    runResult = await executeRun();
  } catch (error) {
    runFailed = true;
    runError = error;
  }
  let cleanupError: Error | undefined;
  try {
    await context.preparedBackend.cleanup?.();
  } catch (error) {
    cleanupError = error as Error;
  }
  return settleCliBackendOutcome({
    runResult,
    runError,
    runFailed,
    cleanupError,
    deliveredMessagingSideEffect,
    diagnosticLifecycle,
    failoverContext: cliFailoverContext,
  });
}
