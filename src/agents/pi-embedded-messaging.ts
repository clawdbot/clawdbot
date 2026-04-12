export type { MessagingToolSend } from "./pi-embedded-messaging.types.js";

import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

const CORE_MESSAGING_TOOLS = new Set(["sessions_send", "message"]);

// Provider docking: any plugin with `actions` opts into messaging tool handling.
export function isMessagingTool(toolName: string): boolean {
  if (CORE_MESSAGING_TOOLS.has(toolName)) {
    return true;
  }
  const providerId = normalizeChannelId(toolName);
  return Boolean(providerId && getChannelPlugin(providerId)?.actions);
}

export function isMessagingToolSendAction(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const action = normalizeOptionalString(args.action) ?? "";
  if (toolName === "sessions_send") {
    return true;
  }
  if (toolName === "message") {
    return action === "send" || action === "thread-reply";
  }
  const providerId = normalizeChannelId(toolName);
  if (!providerId) {
    return false;
  }
  const plugin = getChannelPlugin(providerId);
  if (!plugin?.actions?.extractToolSend) {
    return false;
  }
  return Boolean(plugin.actions.extractToolSend({ args })?.to);
}
