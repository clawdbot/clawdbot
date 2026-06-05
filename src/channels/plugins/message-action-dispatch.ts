/**
 * Channel message action dispatcher.
 *
 * Runs plugin-owned message actions from the shared agent tool with sender trust checks.
 */
import type { AgentToolResult } from "../../agents/runtime/index.js";
import { getChannelPlugin } from "./index.js";
import type { ChannelMessageActionContext } from "./types.public.js";

function requiresTrustedRequesterSender(ctx: ChannelMessageActionContext): boolean {
  const plugin = getChannelPlugin(ctx.channel);
  return Boolean(
    plugin?.actions?.requiresTrustedRequesterSender?.({
      action: ctx.action,
      toolContext: ctx.toolContext,
    }),
  );
}

/**
 * Runs a channel message action if the target plugin supports it.
 */
export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  // Some plugin actions depend on the sender identity to enforce channel-local
  // trust. Reject tool-driven calls before invoking the plugin without it.
  if (requiresTrustedRequesterSender(ctx) && !ctx.requesterSenderId?.trim()) {
    throw new Error(
      `Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`,
    );
  }
  const plugin = getChannelPlugin(ctx.channel);
  if (!plugin?.actions?.handleAction) {
    return null;
  }
  // `handleAction` may be broad; `supportsAction` lets plugins cheaply decline
  // action names before the dispatcher enters channel-specific behavior.
  if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) {
    return null;
  }
  return await plugin.actions.handleAction(ctx);
}
