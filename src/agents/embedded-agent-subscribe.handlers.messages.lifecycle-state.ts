import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import type { AssistantMessage } from "../llm/types.js";
import { coerceChatContentText } from "../shared/chat-content.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import {
  createThinkingTagStreamState,
  extractEmbeddedAssistantText,
} from "./embedded-agent-utils.js";
import { hasRawToolValidationOutput } from "./tool-error-summary.js";

/**
 * A tool-validation loop can echo the raw validation error back as assistant text.
 * Suppressing it keeps the retry invisible instead of publishing provider noise.
 */
export function shouldSuppressValidationLoopAssistantOutput(params: {
  message: AssistantMessage;
  assistantRecord?: Record<string, unknown>;
  validationErrorSummary?: string;
  text?: string;
}): boolean {
  if (!params.validationErrorSummary) {
    return false;
  }

  if (params.message.stopReason === "error") {
    return true;
  }

  const candidateText = [
    typeof params.assistantRecord?.delta === "string" ? params.assistantRecord.delta : "",
    typeof params.assistantRecord?.content === "string" ? params.assistantRecord.content : "",
    params.text ?? coerceChatContentText(extractEmbeddedAssistantText(params.message)),
  ]
    .filter(Boolean)
    .join("\n");
  return hasRawToolValidationOutput(candidateText);
}

export function resetMessageEndStreamingState(ctx: EmbeddedAgentSubscribeContext): void {
  ctx.state.deltaBuffer = "";
  ctx.state.streamBlockText = "";
  ctx.state.streamBlockOffset = 0;
  ctx.state.thinkingTagStream = createThinkingTagStreamState();
  ctx.state.deltaBufferIsCommentary = false;
  ctx.state.hasFlushedPartialText = false;
  ctx.blockChunker.reset();
  ctx.state.blockState = { thinking: false, final: false, inlineCode: createInlineCodeState() };
  const { thinking, final, inlineCode } = ctx.state.partialBlockState;
  ctx.state.partialBlockState = { thinking, final, inlineCode };
  ctx.state.assistantStream = undefined;
  ctx.state.reasoningStreamOpen = false;
}
