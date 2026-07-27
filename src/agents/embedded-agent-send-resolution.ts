import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { parseSessionThreadInfoFast } from "../config/sessions/thread-info.js";
import { applyCurrentMessageProvider } from "./embedded-agent-subscribe.handlers.tools.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import { extractMessagingToolSend } from "./embedded-agent-subscribe.tools.js";

/**
 * Whether an embedded-runner `message` send resolves to the current source
 * conversation, and so is a source reply rather than an unrelated outbound
 * side effect.
 *
 * `isDeliveredMessageToolOnlySourceReplyResult` learns this from the
 * gateway's trusted `sourceReplyRoute: "current-source"` result tag, which is
 * only applied when a signed message-action turn capability accompanies the
 * call. App-server harnesses (claude-bridge, and any future non-CLI-runner
 * harness) route tool calls through this embedded dispatch path rather than
 * `cli-runner/execute.ts`, but the same gap applies: an explicit-route send
 * (channel/to) is rejected as source-reply evidence even when it delivered to
 * the current source, wrongly tripping the stranded-reply recovery retry
 * (openclaw-p3j — the same defect as openclaw-kg9, just the embedded-path
 * sibling of it; kg9 only patched the CLI runner).
 *
 * This handler is itself the trusted in-process caller, so it verifies the
 * route directly: it resolves the send's destination through the same
 * `extractMessagingToolSend` path used for delivery evidence, and compares it
 * to the destination an implicit (routeless) current-source send would
 * resolve to. Identical normalization (including `applyCurrentMessageProvider`,
 * the same current-provider injection the real send's target already went
 * through) avoids provider-target drift between the two resolutions. When
 * they match, the caller may pass `allowExplicitSourceRoute` so the delivered
 * send counts as source-reply evidence.
 */
export function embeddedSendResolvesToCurrentSource(
  ctx: Pick<ToolHandlerContext, "params">,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (toolName !== "message") {
    return false;
  }
  const messagingArgs = applyCurrentMessageProvider(toolName, args, ctx.params.messageChannel);
  const target = extractMessagingToolSend(toolName, messagingArgs, {
    config: ctx.params.config,
    currentChannelId: ctx.params.currentChannelId,
    currentMessagingTarget: ctx.params.currentMessagingTarget,
    currentThreadId:
      ctx.params.currentThreadId ?? parseSessionThreadInfoFast(ctx.params.sessionKey).threadId,
    currentMessageId: ctx.params.currentMessageId,
  });
  const targetTo = normalizeOptionalString(target?.to);
  if (!targetTo) {
    return false;
  }
  // The same action with no explicit route resolves to the current source.
  const referenceArgs = applyCurrentMessageProvider(
    toolName,
    { action: normalizeOptionalString(args.action) ?? "send" },
    ctx.params.messageChannel,
  );
  const reference = extractMessagingToolSend(toolName, referenceArgs, {
    config: ctx.params.config,
    currentChannelId: ctx.params.currentChannelId,
    currentMessagingTarget: ctx.params.currentMessagingTarget,
    currentThreadId:
      ctx.params.currentThreadId ?? parseSessionThreadInfoFast(ctx.params.sessionKey).threadId,
    currentMessageId: ctx.params.currentMessageId,
  });
  const referenceTo = normalizeOptionalString(reference?.to);
  if (!referenceTo) {
    return false;
  }
  return (
    targetTo === referenceTo &&
    normalizeOptionalLowercaseString(target?.provider) ===
      normalizeOptionalLowercaseString(reference?.provider)
  );
}
