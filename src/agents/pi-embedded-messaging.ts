export type MessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
};

const MESSAGING_TOOLS = new Set([
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "sessions_send",
  "message",
]);

export function isMessagingTool(toolName: string): boolean {
  return MESSAGING_TOOLS.has(toolName);
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
  return action === "sendMessage" || action === "threadReply";
}

function normalizeSlackTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mentionMatch) return `user:${mentionMatch[1]}`.toLowerCase();
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("slack:")) {
    const id = trimmed.slice(6).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("#")) {
    const id = trimmed.slice(1).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  return `channel:${trimmed}`.toLowerCase();
}

function normalizeDiscordTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (mentionMatch) return `user:${mentionMatch[1]}`.toLowerCase();
  if (trimmed.startsWith("user:")) {
    const id = trimmed.slice(5).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("channel:")) {
    const id = trimmed.slice(8).trim();
    return id ? `channel:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("discord:")) {
    const id = trimmed.slice(8).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}`.toLowerCase() : undefined;
  }
  return `channel:${trimmed}`.toLowerCase();
}

function normalizeTelegramTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let normalized = trimmed;
  if (normalized.startsWith("telegram:")) {
    normalized = normalized.slice("telegram:".length).trim();
  } else if (normalized.startsWith("tg:")) {
    normalized = normalized.slice("tg:".length).trim();
  } else if (normalized.startsWith("group:")) {
    normalized = normalized.slice("group:".length).trim();
  }
  if (!normalized) return undefined;
  const tmeMatch =
    /^https?:\/\/t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized) ??
    /^t\.me\/([A-Za-z0-9_]+)$/i.exec(normalized);
  if (tmeMatch?.[1]) normalized = `@${tmeMatch[1]}`;
  if (!normalized) return undefined;
  return `telegram:${normalized}`.toLowerCase();
}

export function normalizeTargetForProvider(
  provider: string,
  raw?: string,
): string | undefined {
  if (!raw) return undefined;
  switch (provider.trim().toLowerCase()) {
    case "slack":
      return normalizeSlackTarget(raw);
    case "discord":
      return normalizeDiscordTarget(raw);
    case "telegram":
      return normalizeTelegramTarget(raw);
    default:
      return raw.trim().toLowerCase() || undefined;
  }
}
