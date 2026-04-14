import { formatErrorMessage } from "../infra/errors.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./cli-runner/types.js";
import { FailoverError, isFailoverError, resolveFailoverStatus } from "./failover-error.js";
import { classifyFailoverReason, isFailoverErrorMessage } from "./pi-embedded-helpers.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner.js";

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
          ...(params.authProfileId ? { authMode: "auth-profile" } : {}),
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
                  ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
                  ...(context.authEpoch ? { authEpoch: context.authEpoch } : {}),
                  ...(context.extraSystemPromptHash
                    ? { extraSystemPromptHash: context.extraSystemPromptHash }
                    : {}),
                  ...(context.preparedBackend.mcpConfigHash
                    ? { mcpConfigHash: context.preparedBackend.mcpConfigHash }
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
    try {
      const output = await executePreparedCliRun(context, context.reusableCliSession.sessionId);
      const effectiveCliSessionId = output.sessionId ?? context.reusableCliSession.sessionId;
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
          const output = await executePreparedCliRun(context, undefined);
          const effectiveCliSessionId = output.sessionId;
          return buildCliRunResult({ output, effectiveCliSessionId });
        }
        throw err;
      }
      const message = formatErrorMessage(err);
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
      throw err;
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
    ownerNumbers: params.ownerNumbers,
    // Legacy `claudeSessionId` callers predate the shared CLI session contract.
    // Ignore it here so the compatibility wrapper does not accidentally resume
    // an incompatible Claude session on the generic runner path.
    images: params.images,
    senderIsOwner: params.senderIsOwner,
  };
}

export async function runClaudeCliAgent(
  params: RunClaudeCliAgentParams,
): Promise<EmbeddedPiRunResult> {
  return runCliAgent(buildRunClaudeCliAgentParams(params));
}
