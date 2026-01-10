import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ClawdbotConfig } from "../../config/config.js";
import { getProviderPlugin, listProviderPlugins } from "./index.js";
import type {
  ProviderMessageActionContext,
  ProviderMessageActionName,
} from "./types.js";

export function listProviderMessageActions(
  cfg: ClawdbotConfig,
): ProviderMessageActionName[] {
  const actions = new Set<ProviderMessageActionName>(["send"]);
  for (const plugin of listProviderPlugins()) {
    const list = plugin.actions?.listActions?.({ cfg });
    if (!list) continue;
    for (const action of list) actions.add(action);
  }
  return Array.from(actions);
}

export function supportsProviderMessageButtons(cfg: ClawdbotConfig): boolean {
  for (const plugin of listProviderPlugins()) {
    if (plugin.actions?.supportsButtons?.({ cfg })) return true;
  }
  return false;
}

export async function dispatchProviderMessageAction(
  ctx: ProviderMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  const plugin = getProviderPlugin(ctx.provider);
  if (!plugin?.actions?.handleAction) return null;
  if (
    plugin.actions.supportsAction &&
    !plugin.actions.supportsAction({ action: ctx.action })
  ) {
    return null;
  }
  return await plugin.actions.handleAction(ctx);
}
