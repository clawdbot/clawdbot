// Diagnostic trace helpers for pre-run directive rejections. Kept in a
// dedicated module so the directive resolver stays under its line budget and
// the trace logic is independently testable.
import { emitTrustedDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

/**
 * Derives the rejected directive category and its raw token from the parsed
 * inline directives. The model directive is the most common rejection target
 * (e.g. `/model <ref>` resolving to a disallowed model); other directive
 * categories fall back to their type with no raw token.
 */
function deriveRejectedDirectiveFacts(directives: InlineDirectives): {
  directiveType?: string;
  rawToken?: string;
} {
  if (directives.hasModelDirective) {
    return { directiveType: "model", rawToken: directives.rawModelDirective };
  }
  if (directives.hasElevatedDirective) {
    return { directiveType: "elevated" };
  }
  if (directives.clearThinkLevel || directives.thinkLevel !== undefined) {
    return { directiveType: "think" };
  }
  if (directives.reasoningLevel !== undefined) {
    return { directiveType: "reasoning" };
  }
  if (directives.verboseLevel !== undefined) {
    return { directiveType: "verbose" };
  }
  if (directives.clearFastMode || directives.fastMode !== undefined) {
    return { directiveType: "fast" };
  }
  return {};
}

/**
 * Emits a `directive.rejected` diagnostic trace when an inline directive was
 * rejected before any agent run started, so external diagnostic surfaces can
 * correlate the rejected inbound message with the parser decision. Only error
 * replies (not ack/status replies) are traced.
 */
export function emitPreRunDirectiveRejectionDiagnostic(params: {
  ctx: FinalizedRuntimeMsgContext;
  sessionKey: string;
  directives: InlineDirectives;
  reply: ReplyPayload | ReplyPayload[] | undefined;
}): void {
  const { ctx, sessionKey, directives, reply } = params;
  if (Array.isArray(reply) || !reply || reply.isError !== true) {
    return;
  }
  const { directiveType, rawToken } = deriveRejectedDirectiveFacts(directives);
  emitTrustedDiagnosticEvent({
    type: "directive.rejected",
    stage: "pre_run",
    sessionKey,
    channel: ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface,
    messageId: ctx.MessageSidFull ?? ctx.MessageSid,
    chatId: ctx.ChatId,
    agentId: ctx.AgentId,
    directiveType,
    rawToken,
    errorText: reply.text,
  });
}
