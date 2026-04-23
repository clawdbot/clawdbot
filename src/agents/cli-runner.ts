import { formatErrorMessage } from "../infra/errors.js";
import { loadCliSessionHistoryMessages } from "./cli-runner/session-history.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { FailoverError, isFailoverError, resolveFailoverStatus } from "./failover-error.js";
import {
  runAgentHarnessAgentEndHook,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
} from "./harness/lifecycle-hook-helpers.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

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
  const { prepareCliRunContext } = await import("./cli-runner/prepare.runtime.js");
  const context = await prepareCliRunContext(params);
  return runPreparedCliAgent(context);
}

export async function runPreparedCliAgent(
  context: PreparedCliRunContext,
): Promise<EmbeddedPiRunResult> {
  const { executePreparedCliRun } = await import("./cli-runner/execute.runtime.js");
  const { params } = context;
  const historyMessages = loadCliSessionHistoryMessages({
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
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
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider,
    trigger: params.trigger,
    channelId: params.messageChannel ?? params.messageProvider,
  } as const;

  const buildAgentEndMessages = (lastAssistant?: unknown): unknown[] => [
    ...historyMessages,
    buildCliHookUserMessage(params.prompt),
    ...(lastAssistant ? [lastAssistant] : []),
  ];

  const buildFailedAgentEndEvent = (error: string) => ({
    messages: buildAgentEndMessages(),
    success: false,
    error,
    durationMs: Date.now() - context.started,
  });

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
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: context.modelId,
        assistantTexts,
        ...(lastAssistant ? { lastAssistant } : {}),
        ...(output.usage ? { usage: output.usage } : {}),
      },
      ctx: hookContext,
    });
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
    runAgentHarnessLlmInputHook({
      event: llmInputEvent,
      ctx: hookContext,
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
            });
            return buildCliRunResult({ output, effectiveCliSessionId });
          } catch (retryErr) {
            const retryMessage = formatErrorMessage(retryErr);
            runAgentHarnessAgentEndHook({
              event: buildFailedAgentEndEvent(retryMessage),
              ctx: hookContext,
            });
            return toCliRunFailure(retryErr);
          }
        }
        runAgentHarnessAgentEndHook({
          event: buildFailedAgentEndEvent(formatErrorMessage(err)),
          ctx: hookContext,
        });
        throw err;
      }
      const message = formatErrorMessage(err);
      runAgentHarnessAgentEndHook({
        event: buildFailedAgentEndEvent(message),
        ctx: hookContext,
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
    extraSystemPrompt: params.extraSystemPrompt,
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
