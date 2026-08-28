import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionUpdate } from "./embedded-agent-subscribe.handlers.tools.progress.js";
import {
  cleanupRunToolStartData,
  countActiveToolExecutions,
  handleToolExecutionStart,
} from "./embedded-agent-subscribe.handlers.tools.start.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
/**
 * Handles embedded-agent tool execution events and turns them into channel UI,
 * replay state, hook calls, approval prompts, media queues, and agent-event
 * telemetry.
 */
import { buildToolLifecycleErrorResult } from "./embedded-agent-tool-results.js";
import {
  consumeTrustedToolNoStartError,
  registerTrustedToolNoStartError,
} from "./tool-result-error.js";

export function createEmbeddedToolLifecycle(ctx: ToolHandlerContext) {
  return async <T>(toolParams: {
    toolName: string;
    toolCallId: string;
    args: unknown;
    replaySafe?: boolean;
    hideFromChannelProgress?: boolean;
    execute: (onImplementationStart: () => void) => Promise<T>;
  }): Promise<T> => {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: toolParams.toolName,
      toolCallId: toolParams.toolCallId,
      args: toolParams.args,
      replaySafe: toolParams.replaySafe,
      hideFromChannelProgress: toolParams.hideFromChannelProgress,
      lifecycleProvenance: "nested",
    });
    let executionStarted = false;
    const onImplementationStart = () => {
      executionStarted = true;
    };
    try {
      const result = await toolParams.execute(onImplementationStart);
      await handleToolExecutionEnd(ctx, {
        type: "tool_execution_end",
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        isError: false,
        executionStarted,
        result,
        hideFromChannelProgress: toolParams.hideFromChannelProgress,
      });
      return result;
    } catch (error) {
      const trustedNoStart = consumeTrustedToolNoStartError(error);
      await handleToolExecutionEnd(ctx, {
        type: "tool_execution_end",
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        isError: true,
        executionStarted,
        result: buildToolLifecycleErrorResult(error),
        hideFromChannelProgress: toolParams.hideFromChannelProgress,
      });
      // Operation-owned no-start proof survives generic implementation entry.
      // Only relay the same error after completion succeeds; replacements cannot inherit it.
      if (trustedNoStart) {
        registerTrustedToolNoStartError(error);
      }
      throw error;
    }
  };
}

export {
  cleanupRunToolStartData,
  countActiveToolExecutions,
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
};
