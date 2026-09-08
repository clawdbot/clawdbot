import { createAgentRunEventHandler } from "../../auto-reply/reply/agent-runner-event-handler.js";
import {
  createShouldEmitToolOutput,
  createShouldEmitToolResult,
} from "../../auto-reply/reply/agent-runner-helpers.js";
import type { VerboseLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sanitizeUserFacingText } from "../embedded-agent-helpers/sanitize-user-facing-text.js";
import type { RunEmbeddedAgentInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import type { AgentCommandOpts } from "./types.js";

export function createCommandChannelReplyCallbacks(params: {
  opts: AgentCommandOpts;
  cfg: OpenClawConfig;
  sessionKey?: string;
  storePath?: string;
  runId: string;
  provider: string;
  model: string;
  resolvedVerboseLevel: VerboseLevel;
  thinkLevel?: import("../../auto-reply/thinking.js").ThinkLevel;
  reasoningLevel?: import("../../auto-reply/thinking.js").ReasoningLevel;
}): Partial<RunEmbeddedAgentInternalParams> {
  const options = params.opts.channelReply?.options;
  if (!options) {
    return {};
  }
  let started = false;
  let compactionCount = 0;
  const toolProgressDetail = params.cfg.agents?.defaults?.toolProgressDetail ?? "explain";
  const eventHandler = createAgentRunEventHandler({
    turn: {
      opts: options,
      sessionKey: params.sessionKey,
      toolProgressDetail,
      replyOperation: options.replyOperation,
      sessionCtx: {},
      typingSignals: {
        signalToolStart: async () => {
          await options.onReplyStart?.();
        },
      },
      applyReplyToMode: (payload) => payload,
    },
    notifyAgentRunStart: () => {
      if (started) {
        return;
      }
      started = true;
      options.onAgentRunStart?.(params.runId);
      options.onModelSelected?.({
        provider: params.provider,
        model: params.model,
        thinkLevel: params.thinkLevel ?? "off",
      });
    },
    sourceRepliesAreToolOnly: params.opts.sourceReplyDeliveryMode === "message_tool_only",
    provider: params.provider,
    model: params.model,
    runId: params.runId,
    notifyUserAboutCompaction: false,
    onCompactionCompleted: () => ++compactionCount,
    messageToolDeliveryState: { toolCallIds: new Set(), completed: false },
  });
  const verbosity = {
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    resolvedVerboseLevel: params.resolvedVerboseLevel,
  };
  options.onRunVerbosityResolved?.({ resolvedVerboseLevel: params.resolvedVerboseLevel });
  return {
    replyOperation: options.replyOperation,
    toolProgressDetail,
    reasoningLevel: params.reasoningLevel,
    toolResultFormat: "markdown",
    shouldEmitToolResult: createShouldEmitToolResult(verbosity),
    shouldEmitToolOutput: createShouldEmitToolOutput(verbosity),
    onAgentEvent: eventHandler,
    onPartialReply: async (payload) =>
      await options.onPartialReply?.({
        ...payload,
        text: payload.text ? sanitizeUserFacingText(payload.text) : payload.text,
      }),
    onAssistantMessageStart: async () => {
      await options.onAssistantMessageStart?.();
    },
    onReasoningStream: async (payload) => {
      await options.onReasoningStream?.(payload);
    },
    onReasoningEnd: async () => {
      await options.onReasoningEnd?.();
    },
    streamReasoningInNonStreamModes: options.streamReasoningInNonStreamModes,
    onBlockReply: async (payload, context) => {
      await options.onBlockReply?.(payload, context);
    },
    onToolResult: async (payload) => {
      await options.onToolResult?.(payload);
    },
  };
}
