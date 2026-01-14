import {
  getChannelPlugin,
  normalizeChannelId,
} from "../channels/plugins/index.js";

export type MessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
};

const CORE_MESSAGING_TOOLS = new Set(["sessions_send", "message"]);

// Provider docking: any plugin with `actions` opts into messaging tool handling.
export function isMessagingTool(toolName: string): boolean {
  if (CORE_MESSAGING_TOOLS.has(toolName)) return true;
  const providerId = normalizeChannelId(toolName);
  return Boolean(providerId && getChannelPlugin(providerId)?.actions);
}

export function isMessagingToolSendAction(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (toolName === "sessions_send") return true;
  if (toolName === "message") {
    return action === "send" || action === "thread-reply";
  }
  const providerId = normalizeChannelId(toolName);
  if (!providerId) return false;
  const plugin = getChannelPlugin(providerId);
  if (!plugin?.actions?.extractToolSend) return false;
  return Boolean(plugin.actions.extractToolSend({ args })?.to);
}

export function normalizeTargetForProvider(
  provider: string,
  raw?: string,
): string | undefined {
  if (!raw) return undefined;
  const providerId = normalizeChannelId(provider);
  const plugin = providerId ? getChannelPlugin(providerId) : undefined;
  const normalized =
    plugin?.messaging?.normalizeTarget?.(raw) ??
    (raw.trim().toLowerCase() || undefined);
  return normalized || undefined;
}
