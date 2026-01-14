import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ClawdbotConfig } from "../../config/config.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "./types.js";

export function listChannelMessageActions(
  cfg: ClawdbotConfig,
): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send"]);
  for (const plugin of listChannelPlugins()) {
    const list = plugin.actions?.listActions?.({ cfg });
    if (!list) continue;
    for (const action of list) actions.add(action);
  }
  return Array.from(actions);
}

export function supportsChannelMessageButtons(cfg: ClawdbotConfig): boolean {
  for (const plugin of listChannelPlugins()) {
    if (plugin.actions?.supportsButtons?.({ cfg })) return true;
  }
  return false;
}

export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  const plugin = getChannelPlugin(ctx.channel);
  if (!plugin?.actions?.handleAction) return null;
  if (
    plugin.actions.supportsAction &&
    !plugin.actions.supportsAction({ action: ctx.action })
  ) {
    return null;
  }
  return await plugin.actions.handleAction(ctx);
}
