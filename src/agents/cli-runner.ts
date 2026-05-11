import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildAgentHookContextChannelFields } from "../plugins/hook-agent-context.js";
import { resolveBlockMessage } from "../plugins/hook-decision-types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { loadCliSessionHistoryMessages } from "./cli-runner/session-history.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { FailoverError, isFailoverError, resolveFailoverStatus } from "./failover-error.js";
import { buildAgentHookContext } from "./harness/hook-context.js";
import { buildAgentHookConversationMessages } from "./harness/hook-history.js";
import {
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./harness/lifecycle-hook-helpers.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

const log = createSubsystemLogger("agents/cli-runner");

function flushSessionManagerFile(sessionManager: SessionManager): void {
  (sessionManager as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
}

function buildHandledReplyPayloads(reply?: ReplyPayload) {
  const normalized = reply ?? { text: SILENT_REPLY_TOKEN };
  return [
    {
      text: normalized.text,
      mediaUrl: normalized.mediaUrl,
      mediaUrls: normalized.mediaUrls,
      replyToId: normalized.replyToId,
      audioAsVoice: normalized.audioAsVoice,
      isError: normalized.isError,
      isReasoning: normalized.isReasoning,
    },
  ];
}

function buildCliHookUserMessage(prompt: string): unknown {
  return {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  };
}

function buildCliHookAssistantMessage(params: {
  text: string;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "responses",
    provider: params.provider,
    model: params.model,
    ...(params.usage ? { usage: params.usage } : {}),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export async function runCliAgent(params: RunCliAgentParams): Promise<EmbeddedPiRunResult> {
  // Cron gate must fire before prepareCliRunContext — that call allocates
  // backend resources released only by runPreparedCliAgent's try…finally.
  params.onExecutionStarted?.();
  if (params.trigger === "cron") {
    const startedAt = Date.now();
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("before_agent_reply")) {
      const hookContext = {
        runId: params.runId,
        jobId: params.jobId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        trigger: params.trigger,
        ...buildAgentHookContextChannelFields(params),
      } as const;
      const hookResult = await hookRunner.runBeforeAgentReply(
        { cleanedBody: params.prompt },
        hookContext,
      );
      if (hookResult?.handled) {
        return {
          payloads: buildHandledReplyPayloads(hookResult.reply),
          meta: {
            durationMs: Date.now() - startedAt,
            agentMeta: {
              sessionId: params.sessionId,
              provider: params.provider,
              model: params.model ?? "",
            },
            finalAssistantVisibleText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
            finalAssistantRawText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
          },
        };
      }
    }
  }
  const { prepareCliRunContext } = await import("./cli-runner/prepare.runtime.js");
  const context = await prepareCliRunContext(params);
  try {
    return await runPreparedCliAgent(context);
  } finally {
    if (params.cleanupCliLiveSessionOnRunEnd === true) {
      const { closeClaudeLiveSessionForContext } =
        await import("./cli-runner/claude-live-session.js");
      await closeClaudeLiveSessionForContext(context);
    }
    if (params.cleanupBundleMcpOnRunEnd === true) {
      const { closeMcpLoopbackServer } = await import("../gateway/mcp-http.js");
      await closeMcpLoopbackServer();
    }
  }
}

export async function runPreparedCliAgent(
  context: PreparedCliRunContext,
): Promise<EmbeddedPiRunResult> {
  const { executePreparedCliRun } = await import("./cli-runner/execute.runtime.js");
  const { params } = context;
  const hookRunner = getGlobalHookRunner();
  const hasLlmInputHooks = hookRunner?.hasHooks("llm_input") === true;
  const hasLlmOutputHooks = hookRunner?.hasHooks("llm_output") === true;
  const hasAgentEndHooks = hookRunner?.hasHooks("agent_end") === true;
  const hasBeforeAgentRunHooks = hookRunner?.hasHooks("before_agent_run") === true;
  const historyMessages =
    hasLlmInputHooks || hasAgentEndHooks || hasBeforeAgentRunHooks
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
    ...buildAgentHookContextChannelFields(params),
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

  const buildBlockedBeforeAgentRunResult = (message: string): EmbeddedPiRunResult => ({
    payloads: [{ text: message, isError: true }],
    meta: {
      durationMs: Date.now() - context.started,
      finalAssistantVisibleText: message,
      finalAssistantRawText: message,
      livenessState: "blocked",
      error: {
        kind: "hook_block",
        message,
      },
      systemPromptReport: context.systemPromptReport,
      executionTrace: {
        winnerProvider: params.provider,
        winnerModel: context.modelId,
        attempts: [
          {
            provider: params.provider,
            model: context.modelId,
            result: "error",
            reason: "before_agent_run blocked the run",
          },
        ],
        fallbackUsed: false,
        runner: "cli",
      },
      requestShaping: {
        ...(params.thinkLevel ? { thinking: params.thinkLevel } : {}),
        ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
      },
      completion: {
        finishReason: "blocked",
        stopReason: "blocked",
        refusal: true,
      },
      agentMeta: {
        sessionId: params.sessionId ?? "",
        provider: params.provider,
        model: context.modelId,
      },
    },
  });

  const persistBlockedBeforeAgentRun = async (block: {
    message: string;
    pluginId: string;
  }): Promise<void> => {
    try {
      const nowMs = Date.now();
      const sessionManager = SessionManager.open(params.sessionFile);
      sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: block.message }],
        timestamp: nowMs,
        idempotencyKey: `hook-block:before_agent_run:user:${params.runId}`,
        __openclaw: {
          beforeAgentRunBlocked: {
            blockedBy: block.pluginId,
            blockedAt: nowMs,
          },
        },
      } as Parameters<typeof sessionManager.appendMessage>[0]);
      flushSessionManagerFile(sessionManager);
    } catch (err) {
      log.warn(
        `before_agent_run block: failed to persist redacted CLI user message: ${formatErrorMessage(
          err,
        )}`,
      );
    }
  };

  const toCliRunFailure = (error: unknown): never => {
    if (isFailoverError(error)) {
      throw error;
    }
    const message = formatErrorMessage(error);
    if (isFailoverErrorMessage(message, { provider: params.provider })) {
      const reason = classifyFailoverReason(message, { provider: params.provider }) ?? "unknown";
      const status = resolveFailoverStatus(reason);
      throw new FailoverError(message, {
        reason,
        provider: params.provider,
        model: context.modelId,
        sessionId: params.sessionId,
        lane: params.lane,
        status,
      });
    }
    throw error;
  };

  const executeCliAttempt = async (cliSessionIdToUse?: string) => {
    const output = await executePreparedCliRun(context, cliSessionIdToUse);
    const assistantText = output.text.trim();
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
          resolvedRef: `${params.provider}/${context.modelId}`,
          assistantTexts,
          ...(lastAssistant ? { lastAssistant } : {}),
          ...(output.usage ? { usage: output.usage } : {}),
        },
        ctx: hookContext,
        hookRunner,
      });
    }
    return { output, assistantText, lastAssistant };
  };

  const buildCliRunResult = (resultParams: {
    output: Awaited<ReturnType<typeof executePreparedCliRun>>;
    effectiveCliSessionId?: string;
  }): EmbeddedPiRunResult => {
    const text = resultParams.output.text?.trim();
    const rawText = resultParams.output.rawText?.trim();
    const payloads = text ? [{ text }] : undefined;

    return {
      payloads,
      meta: {
        durationMs: Date.now() - context.started,
        ...(resultParams.output.finalPromptText
          ? { finalPromptText: resultParams.output.finalPromptText }
          : {}),
        ...(text || rawText
          ? {
              ...(text ? { finalAssistantVisibleText: text } : {}),
              ...(rawText ? { finalAssistantRawText: rawText } : {}),
            }
          : {}),
        systemPromptReport: context.systemPromptReport,
        executionTrace: {
          winnerProvider: params.provider,
          winnerModel: context.modelId,
          attempts: [
            {
              provider: params.provider,
              model: context.modelId,
              result: "success",
            },
          ],
          fallbackUsed: false,
          runner: "cli",
        },
        requestShaping: {
          ...(params.thinkLevel ? { thinking: params.thinkLevel } : {}),
          ...(context.effectiveAuthProfileId ? { authMode: "auth-profile" } : {}),
        },
        completion: {
          finishReason: "stop",
          stopReason: "completed",
          refusal: false,
        },
        agentMeta: {
          sessionId: resultParams.effectiveCliSessionId ?? params.sessionId ?? "",
          provider: params.provider,
          model: context.modelId,
          usage: resultParams.output.usage,
          ...(resultParams.effectiveCliSessionId
            ? {
                cliSessionBinding: {
                  sessionId: resultParams.effectiveCliSessionId,
                  ...(context.effectiveAuthProfileId
                    ? { authProfileId: context.effectiveAuthProfileId }
                    : {}),
                  ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                  authEpochVersion: context.authEpochVersion,
                  ...(context.extraSystemPromptHash
                    ? { extraSystemPromptHash: context.extraSystemPromptHash }
                    : {}),
                  ...(context.preparedBackend.mcpConfigHash
                    ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
                    : {}),
                  ...(context.preparedBackend.mcpResumeHash
                    ? { mcpResumeHash: context.preparedBackend.mcpResumeHash }
                    : {}),
                },
              }
            : {}),
        },
      },
    };
  };

  // Try with the provided CLI session ID first
  try {
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
            senderIsOwner: params.senderIsOwner,
          },
          buildAgentHookContext(hookContext),
        );
      } catch {
        const blockMessage = resolveBlockMessage(
          { outcome: "block", reason: "before_agent_run hook failed" },
          { blockedBy: "before_agent_run" },
        );
        await persistBlockedBeforeAgentRun({
          message: blockMessage,
          pluginId: "before_agent_run",
        });
        runAgentHarnessAgentEndHook({
          event: buildBlockedAgentEndEvent(blockMessage),
          ctx: hookContext,
          hookRunner,
        });
        return buildBlockedBeforeAgentRunResult(blockMessage);
      }

      const beforeRunDecision = beforeRunResult?.decision;
      if (beforeRunDecision?.outcome === "block") {
        const blockMessage = resolveBlockMessage(beforeRunDecision, {
          blockedBy: beforeRunResult?.pluginId ?? "unknown",
        });
        await persistBlockedBeforeAgentRun({
          message: blockMessage,
          pluginId: beforeRunResult?.pluginId ?? "unknown",
        });
        runAgentHarnessAgentEndHook({
          event: buildBlockedAgentEndEvent(blockMessage),
          ctx: hookContext,
          hookRunner,
        });
        return buildBlockedBeforeAgentRunResult(blockMessage);
      }
    }

    runAgentHarnessLlmInputHook({
      event: llmInputEvent,
      ctx: hookContext,
      hookRunner,
    });
    try {
      const { output, lastAssistant } = await executeCliAttempt(
        context.reusableCliSession.sessionId,
      );
      const effectiveCliSessionId = output.sessionId ?? context.reusableCliSession.sessionId;
      runAgentHarnessAgentEndHook({
        event: {
          messages: buildAgentEndMessages(lastAssistant),
          success: true,
          durationMs: Date.now() - context.started,
        },
        ctx: hookContext,
        hookRunner,
      });
      return buildCliRunResult({ output, effectiveCliSessionId });
    } catch (err) {
      if (isFailoverError(err)) {
        const retryableSessionId = context.reusableCliSession.sessionId ?? params.cliSessionId;
        // Check if this is a session expired error and we have a session to clear
        if (err.reason === "session_expired" && retryableSessionId && params.sessionKey) {
          // Clear the expired session ID from the session entry
          // This requires access to the session store, which we don't have here
          // We'll need to modify the caller to handle this case

          // For now, retry without the session ID to create a new session
          try {
            const { output, lastAssistant } = await executeCliAttempt(undefined);
            const effectiveCliSessionId = output.sessionId;
            runAgentHarnessAgentEndHook({
              event: {
                messages: buildAgentEndMessages(lastAssistant),
                success: true,
                durationMs: Date.now() - context.started,
              },
              ctx: hookContext,
              hookRunner,
            });
            return buildCliRunResult({ output, effectiveCliSessionId });
          } catch (retryErr) {
            const retryMessage = formatErrorMessage(retryErr);
            runAgentHarnessAgentEndHook({
              event: buildFailedAgentEndEvent(retryMessage),
              ctx: hookContext,
              hookRunner,
            });
            return toCliRunFailure(retryErr);
          }
        }
        runAgentHarnessAgentEndHook({
          event: buildFailedAgentEndEvent(formatErrorMessage(err)),
          ctx: hookContext,
          hookRunner,
        });
        throw err;
      }
      const message = formatErrorMessage(err);
      runAgentHarnessAgentEndHook({
        event: buildFailedAgentEndEvent(message),
        ctx: hookContext,
        hookRunner,
      });
      return toCliRunFailure(err);
    }
  } finally {
    await context.preparedBackend.cleanup?.();
  }
}

export type RunClaudeCliAgentParams = Omit<RunCliAgentParams, "provider" | "cliSessionId"> & {
  provider?: string;
  claudeSessionId?: string;
};

export function buildRunClaudeCliAgentParams(params: RunClaudeCliAgentParams): RunCliAgentParams {
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    trigger: params.trigger,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: params.provider ?? "claude-cli",
    model: params.model ?? "opus",
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    runId: params.runId,
    jobId: params.jobId,
    extraSystemPrompt: params.extraSystemPrompt,
    inputProvenance: params.inputProvenance,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    silentReplyPromptMode: params.silentReplyPromptMode,
    extraSystemPromptStatic: params.extraSystemPromptStatic,
    ownerNumbers: params.ownerNumbers,
    // Legacy `claudeSessionId` callers predate the shared CLI session contract.
    // Ignore it here so the compatibility wrapper does not accidentally resume
    // an incompatible Claude session on the generic runner path.
    images: params.images,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    senderIsOwner: params.senderIsOwner,
  };
}

export async function runClaudeCliAgent(
  params: RunClaudeCliAgentParams,
): Promise<EmbeddedPiRunResult> {
  return runCliAgent(buildRunClaudeCliAgentParams(params));
}
