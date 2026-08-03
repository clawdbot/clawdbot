/**
 * Reaction action message-id resolver.
 *
 * Reads explicit reaction targets or falls back to the current tool message context.
 */
import { readStringOrNumberParam } from "../../../agents/tools/common.js";

type ReactionToolContext = {
  currentMessageId?: string | number;
};

/**
 * Resolves the message id for reaction tools from explicit args or current tool context.
 */
export function resolveReactionMessageId(params: {
  args: Record<string, unknown>;
  toolContext?: ReactionToolContext;
}): string | number | undefined {
  return readStringOrNumberParam(params.args, "messageId") ?? params.toolContext?.currentMessageId;
}
