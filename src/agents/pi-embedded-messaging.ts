import { getProviderPlugin, normalizeProviderId } from "../providers/plugins/index.js";

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
  const providerId = normalizeProviderId(toolName);
  return Boolean(providerId && getProviderPlugin(providerId)?.actions);
}

export function isMessagingToolSendAction(
  toolName: string,
  actionRaw: string,
): boolean {
  const action = actionRaw.trim();
  if (toolName === "sessions_send") return true;
  if (toolName === "message") {
    return action === "send" || action === "thread-reply";
  }
  const providerId = normalizeProviderId(toolName);
  if (!providerId || !getProviderPlugin(providerId)?.actions) return false;
  return action === "sendMessage" || action === "threadReply";
}

export function normalizeTargetForProvider(
  provider: string,
  raw?: string,
): string | undefined {
  if (!raw) return undefined;
  const providerId = normalizeProviderId(provider);
  const plugin = providerId ? getProviderPlugin(providerId) : undefined;
  const normalized =
    plugin?.messaging?.normalizeTarget?.(raw) ??
    (raw.trim().toLowerCase() || undefined);
  return normalized || undefined;
}
