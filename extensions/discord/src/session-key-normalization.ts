import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

type DiscordSessionKeyContext = {
  ChatType?: string;
  From?: string;
  SenderId?: string;
};

function normalizeDiscordChatType(raw?: string): "direct" | "group" | "channel" | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "dm") {
    return "direct";
  }
  if (normalized === "group" || normalized === "channel" || normalized === "direct") {
    return normalized;
  }
  return undefined;
}

export function normalizeExplicitDiscordSessionKey(
  sessionKey: string,
  ctx: DiscordSessionKeyContext,
): string {
  let normalized = normalizeLowercaseStringOrEmpty(sessionKey);
  if (normalizeDiscordChatType(ctx.ChatType) !== "direct") {
    return normalized;
  }

  normalized = normalized.replace(/^(discord:)dm:/, "$1direct:");
  normalized = normalized.replace(/^(agent:[^:]+:discord:)dm:/, "$1direct:");
  const match = normalized.match(/^((?:agent:[^:]+:)?)discord:channel:([^:]+)$/);
  if (!match) {
    return normalized;
  }

  const from = normalizeLowercaseStringOrEmpty(ctx.From);
  const senderId = normalizeLowercaseStringOrEmpty(ctx.SenderId);
  const fromDiscordId =
    from.startsWith("discord:") && !from.includes(":channel:") && !from.includes(":group:")
      ? from.slice("discord:".length)
      : "";
  const directId = senderId || fromDiscordId;
  return directId && directId === match[2] ? `${match[1]}discord:direct:${match[2]}` : normalized;
}
