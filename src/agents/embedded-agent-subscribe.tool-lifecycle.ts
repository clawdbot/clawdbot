import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { buildToolLifecycleErrorResult } from "./embedded-agent-tool-results.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import {
  consumeTrustedToolNoStartError,
  registerTrustedToolNoStartError,
} from "./tool-result-error.js";

type EmbeddedToolLifecycleParams<T> = {
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  codeModeControl?: { kind: "exec" | "wait"; language?: "javascript" | "typescript" };
  args: unknown;
  replaySafe?: boolean;
  hideFromChannelProgress?: boolean;
  execute: (onImplementationStart: () => void, onUpdate: AgentToolUpdateCallback) => Promise<T>;
};

/** Bridges nested tool-search execution into the canonical embedded tool lifecycle. */
export function createEmbeddedToolLifecycle(ctx: ToolHandlerContext) {
  return async <T>(toolParams: EmbeddedToolLifecycleParams<T>): Promise<T> => {
    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: toolParams.toolName,
      toolCallId: toolParams.toolCallId,
      parentToolCallId: toolParams.parentToolCallId,
      codeModeControl: toolParams.codeModeControl,
      args: toolParams.args,
      replaySafe: toolParams.replaySafe,
      hideFromChannelProgress: toolParams.hideFromChannelProgress,
      lifecycleProvenance: "nested",
    } satisfies Parameters<typeof handleToolExecutionStart>[1]);
    let executionStarted = false;
    const onImplementationStart = () => {
      executionStarted = true;
    };
    const onUpdate: AgentToolUpdateCallback = (partialResult) => {
      handleToolExecutionUpdate(ctx, {
        type: "tool_execution_update",
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        parentToolCallId: toolParams.parentToolCallId,
        args: toolParams.args,
        partialResult,
        hideFromChannelProgress: toolParams.hideFromChannelProgress,
      });
    };
    try {
      const result = await toolParams.execute(onImplementationStart, onUpdate);
      await handleToolExecutionEnd(ctx, {
        type: "tool_execution_end",
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        parentToolCallId: toolParams.parentToolCallId,
        codeModeControl: toolParams.codeModeControl,
        isError: false,
        executionStarted,
        result,
        hideFromChannelProgress: toolParams.hideFromChannelProgress,
      } satisfies Parameters<typeof handleToolExecutionEnd>[1]);
      return result;
    } catch (error) {
      const trustedNoStart = consumeTrustedToolNoStartError(error);
      const terminal = await handleToolExecutionEnd(ctx, {
        type: "tool_execution_end",
        toolName: toolParams.toolName,
        toolCallId: toolParams.toolCallId,
        parentToolCallId: toolParams.parentToolCallId,
        codeModeControl: toolParams.codeModeControl,
        isError: true,
        executionStarted,
        result: buildToolLifecycleErrorResult(error),
        hideFromChannelProgress: toolParams.hideFromChannelProgress,
      } satisfies Parameters<typeof handleToolExecutionEnd>[1]);
      if (trustedNoStart && !terminal.executionStarted) {
        registerTrustedToolNoStartError(error);
      }
      throw error;
    }
  };
}
