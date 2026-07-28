import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { handleApproveCommandFromContext } from "./commands-approve.js";
import { buildCommandContext } from "./commands-context.js";
import { resolveCommandContextText } from "./context-text.js";
import type { ReplyPayload } from "./reply-payload.js";

export type FastApproveResult = { handled: false } | { handled: true; reply?: ReplyPayload };

/** Resolve /approve before session admission so it can release the active run it reviews. */
export async function tryFastApproveFromMessage(params: {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): Promise<FastApproveResult> {
  const triggerBodyNormalized = resolveCommandContextText(params.ctx);
  if (!/^\/approve(?:@[^\s]+)?(?:\s|$)/i.test(triggerBodyNormalized)) {
    return { handled: false };
  }
  const command = buildCommandContext({
    ctx: params.ctx,
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    isGroup: params.ctx.ChatType === "group" || params.ctx.ChatType === "channel",
    triggerBodyNormalized,
    commandAuthorized: params.ctx.CommandAuthorized === true,
  });
  const result = await handleApproveCommandFromContext(
    { cfg: params.cfg, ctx: params.ctx, command },
    shouldHandleTextCommands({
      cfg: params.cfg,
      surface: command.surface,
      commandSource: params.ctx.CommandSource,
    }),
  );
  return result && !result.shouldContinue
    ? { handled: true, ...(result.reply ? { reply: result.reply } : {}) }
    : { handled: false };
}
