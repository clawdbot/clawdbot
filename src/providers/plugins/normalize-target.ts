import { normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
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

export function normalizeDiscordMessagingTarget(
  raw: string,
): string | undefined {
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

export function normalizeTelegramMessagingTarget(
  raw: string,
): string | undefined {
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

export function normalizeWhatsAppMessagingTarget(
  raw: string,
): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return normalizeWhatsAppTarget(trimmed) ?? undefined;
}
