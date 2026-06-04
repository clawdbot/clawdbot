/** Detects directive-only turns that should skip the model. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";

/** True when a message only changes directive state and has no agent body. */
export function isDirectiveOnly(params: {
  directives: InlineDirectives;
  cleanedBody: string;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  isGroup: boolean;
}): boolean {
  const { directives, cleanedBody, ctx, cfg, agentId, isGroup } = params;
  if (
    !directives.hasThinkDirective &&
    !directives.hasVerboseDirective &&
    !directives.hasTraceDirective &&
    !directives.hasFastDirective &&
    !directives.hasReasoningDirective &&
    !directives.hasElevatedDirective &&
    !directives.hasExecDirective &&
    !directives.hasModelDirective &&
    !directives.hasQueueDirective
  ) {
    return false;
  }
  const stripped = stripStructuralPrefixes(cleanedBody ?? "");
  // Group mentions are routing syntax, not meaningful agent body text.
  const noMentions = isGroup ? stripMentions(stripped, ctx, cfg, agentId) : stripped;
  return noMentions.length === 0;
}
