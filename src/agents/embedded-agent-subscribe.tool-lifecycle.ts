import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import { buildToolLifecycleErrorResult } from "./embedded-agent-tool-results.js";
import type { ToolEffectReceipt } from "./tool-effect-receipt.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";

type ToolTerminal = {
  result: unknown;
  isError: boolean;
  executedArguments: unknown;
  effectReceipt: ToolEffectReceipt;
};

type EmbeddedToolLifecycleParams<T> = {
  toolName: string;
  toolCallId: string;
  args: unknown;
  replaySafe?: boolean;
  hideFromChannelProgress?: boolean;
  execute: (onImplementationStart: () => void) => Promise<T>;
  onTerminal?: (terminal: ToolTerminal) => void | Promise<void>;
};

type EmbeddedToolLifecycleRunner = <T>(toolParams: EmbeddedToolLifecycleParams<T>) => Promise<T>;

export function createEmbeddedToolLifecycleRunner(
  ctx: EmbeddedAgentSubscribeContext,
): EmbeddedToolLifecycleRunner {
  return async <T>(toolParams: EmbeddedToolLifecycleParams<T>): Promise<T> => {
    ctx.flushAssistantStream();
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: toolParams.toolName,
      toolCallId: toolParams.toolCallId,
      args: toolParams.args,
      replaySafe: toolParams.replaySafe,
      hideFromChannelProgress: toolParams.hideFromChannelProgress,
      lifecycleProvenance: "nested",
    } as never); // SAFETY: internal nested lifecycle event uses the handler's closed shape.
    let executionStarted = false;
    const onImplementationStart = () => {
      executionStarted = true;
    };
    let completedResult: T;
    try {
      completedResult = await toolParams.execute(onImplementationStart);
    } catch (error) {
      const trustedNoStart = consumeTrustedToolNoStartError(error);
      const result = buildToolLifecycleErrorResult(error);
      const terminal = await finishToolLifecycle(ctx, toolParams, {
        executionStarted,
        isError: true,
        result,
      });
      const effectReceipt = trustedNoStart
        ? ({ state: "not_started" } as const)
        : terminal.effectReceipt;
      await toolParams.onTerminal?.({ ...terminal, effectReceipt });
      throw error;
    }
    const terminal = await finishToolLifecycle(ctx, toolParams, {
      executionStarted,
      isError: false,
      result: completedResult,
    });
    await toolParams.onTerminal?.(terminal);
    return completedResult;
  };
}

async function finishToolLifecycle(
  ctx: EmbeddedAgentSubscribeContext,
  toolParams: EmbeddedToolLifecycleParams<unknown>,
  outcome: { executionStarted: boolean; isError: boolean; result: unknown },
): Promise<ToolTerminal> {
  ctx.flushAssistantStream();
  const terminal = await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: toolParams.toolName,
    toolCallId: toolParams.toolCallId,
    isError: outcome.isError,
    executionStarted: outcome.executionStarted,
    result: outcome.result,
    hideFromChannelProgress: toolParams.hideFromChannelProgress,
  } as never); // SAFETY: internal nested lifecycle event uses the handler's closed shape.
  return {
    result: outcome.result,
    isError: terminal.isError,
    executedArguments: terminal.executedArguments ?? toolParams.args,
    effectReceipt: terminal.effectReceipt,
  };
}
