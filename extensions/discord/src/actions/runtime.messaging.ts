import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ActionGate, DiscordActionConfig, OpenClawConfig } from "../runtime-api.js";
import { handleDiscordMessageManagementAction } from "./runtime.messaging.messages.js";
import { handleDiscordReactionMessagingAction } from "./runtime.messaging.reactions.js";
import { handleDiscordMessageSendAction } from "./runtime.messaging.send.js";
import {
  createDiscordMessagingActionContext,
  type DiscordMessagingActionOptions,
} from "./runtime.messaging.shared.js";
export { discordMessagingActionRuntime } from "./runtime.messaging.runtime.js";

export async function handleDiscordMessagingAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  cfg: OpenClawConfig,
  options?: DiscordMessagingActionOptions,
): Promise<AgentToolResult<unknown>> {
  if (!cfg) {
    throw new Error("Discord messaging actions require a resolved runtime config.");
  }
  const ctx = createDiscordMessagingActionContext({
    action,
    input: params,
    isActionEnabled,
    cfg,
    options,
  });
  return (
    (await handleDiscordReactionMessagingAction(ctx)) ??
    (await handleDiscordMessageSendAction(ctx)) ??
    (await handleDiscordMessageManagementAction(ctx)) ??
    (() => {
      throw new Error(`Unknown action: ${action}`);
    })()
  );
}
