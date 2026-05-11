import type { ReactionTypeEmoji } from "@grammyjs/types";
import { DEFAULT_EMOJIS, type StatusReactionEmojis } from "openclaw/plugin-sdk/channel-feedback";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TelegramChatDetails, TelegramGetChat } from "./bot/types.js";

type StatusReactionEmojiKey = keyof Required<StatusReactionEmojis>;
export type TelegramReactionEmoji = ReactionTypeEmoji["emoji"];

const TELEGRAM_GENERIC_REACTION_FALLBACKS = ["👍", "👀", "🔥"] as const;

const TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST = [
  "❤",
  "👍",
  "👎",
  "🔥",
  "🥰",
  "👏",
  "😁",
  "🤔",
  "🤯",
  "😱",
  "🤬",
  "😢",
  "🎉",
  "🤩",
  "🤮",
  "💩",
  "🙏",
  "👌",
  "🕊",
  "🤡",
  "🥱",
  "🥴",
  "😍",
  "🐳",
  "❤‍🔥",
  "🌚",
  "🌭",
  "💯",
  "🤣",
  "⚡",
  "🍌",
  "🏆",
  "💔",
  "🤨",
  "😐",
  "🍓",
  "🍾",
  "💋",
  "🖕",
  "😈",
  "😴",
  "😭",
  "🤓",
  "👻",
  "👨‍💻",
  "👀",
  "🎃",
  "🙈",
  "😇",
  "😨",
  "🤝",
  "✍",
  "🤗",
  "🫡",
  "🎅",
  "🎄",
  "☃",
  "💅",
  "🤪",
  "🗿",
  "🆒",
  "💘",
  "🙉",
  "🦄",
  "😘",
  "💊",
  "🙊",
  "😎",
  "👾",
  "🤷‍♂",
  "🤷",
  "🤷‍♀",
  "😡",
] as const satisfies readonly TelegramReactionEmoji[];

const TELEGRAM_SUPPORTED_REACTION_EMOJIS = new Set<TelegramReactionEmoji>(
  TELEGRAM_SUPPORTED_REACTION_EMOJI_LIST,
);

const TELEGRAM_STATUS_REACTION_VARIANTS: Record<StatusReactionEmojiKey, string[]> = {
  queued: ["👀", "👍", "🔥"],
  thinking: ["🤔", "🤓", "👀"],
  tool: ["🔥", "⚡", "👍"],
  coding: ["👨‍💻", "🔥", "⚡"],
  web: ["⚡", "🔥", "👍"],
  done: ["👍", "🎉", "💯"],
  error: ["😱", "😨", "🤯"],
  stallSoft: ["🥱", "😴", "🤔"],
  stallHard: ["😨", "😱", "⚡"],
  compacting: ["✍", "🤔", "🤯"],
};

const STATUS_REACTION_EMOJI_KEYS: StatusReactionEmojiKey[] = [
  "queued",
  "thinking",
  "tool",
  "coding",
  "web",
  "done",
  "error",
  "stallSoft",
  "stallHard",
  "compacting",
];

function toUniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function resolveTelegramStatusReactionEmojis(params: {
  initialEmoji: string;
  overrides?: StatusReactionEmojis;
}): Required<StatusReactionEmojis> {
  const { overrides } = params;
  const queuedFallback = normalizeOptionalString(params.initialEmoji) ?? DEFAULT_EMOJIS.queued;
  return {
    queued: normalizeOptionalString(overrides?.queued) ?? queuedFallback,
    thinking: normalizeOptionalString(overrides?.thinking) ?? DEFAULT_EMOJIS.thinking,
    tool: normalizeOptionalString(overrides?.tool) ?? DEFAULT_EMOJIS.tool,
    coding: normalizeOptionalString(overrides?.coding) ?? DEFAULT_EMOJIS.coding,
    web: normalizeOptionalString(overrides?.web) ?? DEFAULT_EMOJIS.web,
    done: normalizeOptionalString(overrides?.done) ?? DEFAULT_EMOJIS.done,
    error: normalizeOptionalString(overrides?.error) ?? DEFAULT_EMOJIS.error,
    stallSoft: normalizeOptionalString(overrides?.stallSoft) ?? DEFAULT_EMOJIS.stallSoft,
    stallHard: normalizeOptionalString(overrides?.stallHard) ?? DEFAULT_EMOJIS.stallHard,
    compacting: normalizeOptionalString(overrides?.compacting) ?? DEFAULT_EMOJIS.compacting,
  };
}

export function buildTelegramStatusReactionVariants(
  emojis: Required<StatusReactionEmojis>,
): Map<string, string[]> {
  const variantsByRequested = new Map<string, string[]>();
  for (const key of STATUS_REACTION_EMOJI_KEYS) {
    const requested = normalizeOptionalString(emojis[key]);
    if (!requested) {
      continue;
    }
    const fallbackVariants = TELEGRAM_STATUS_REACTION_VARIANTS[key] ?? [];
    const candidates = toUniqueNonEmpty([requested, ...fallbackVariants]);
    variantsByRequested.set(requested, candidates);
  }
  return variantsByRequested;
}

export function isTelegramSupportedReactionEmoji(emoji: string): emoji is TelegramReactionEmoji {
  return TELEGRAM_SUPPORTED_REACTION_EMOJIS.has(emoji as TelegramReactionEmoji);
}

export function extractTelegramAllowedEmojiReactions(
  chat: TelegramChatDetails | null | undefined,
): Set<TelegramReactionEmoji> | null | undefined {
  if (!chat) {
    return undefined;
  }
  const availableReactions = chat.available_reactions;
  if (availableReactions === undefined) {
    return undefined;
  }
  if (availableReactions == null) {
    // Explicitly omitted/null => all emoji reactions are allowed in this chat.
    return null;
  }
  if (!Array.isArray(availableReactions)) {
    return new Set<TelegramReactionEmoji>();
  }

  const allowed = new Set<TelegramReactionEmoji>();
  for (const reaction of availableReactions) {
    if (reaction.type !== "emoji") {
      continue;
    }
    const emoji = reaction.emoji.trim();
    if (emoji && isTelegramSupportedReactionEmoji(emoji)) {
      allowed.add(emoji);
    }
  }
  return allowed;
}

export async function resolveTelegramAllowedEmojiReactions(params: {
  chat: TelegramChatDetails | null | undefined;
  chatId: string | number;
  getChat?: TelegramGetChat;
}): Promise<Set<TelegramReactionEmoji> | null> {
  const fromMessage = extractTelegramAllowedEmojiReactions(params.chat);
  if (fromMessage !== undefined) {
    return fromMessage;
  }

  if (params.getChat) {
    try {
      const chatInfo = await params.getChat(params.chatId);
      const fromLookup = extractTelegramAllowedEmojiReactions(chatInfo);
      if (fromLookup !== undefined) {
        return fromLookup;
      }
    } catch {
      return null;
    }
  }

  // If unavailable, assume no explicit restriction.
  return null;
}

export function resolveTelegramReactionVariant(params: {
  requestedEmoji: string;
  variantsByRequestedEmoji: Map<string, string[]>;
  allowedEmojiReactions?: Set<TelegramReactionEmoji> | null;
}): TelegramReactionEmoji | undefined {
  const requestedEmoji = normalizeOptionalString(params.requestedEmoji);
  if (!requestedEmoji) {
    return undefined;
  }

  const configuredVariants = params.variantsByRequestedEmoji.get(requestedEmoji) ?? [
    requestedEmoji,
  ];
  const variants = toUniqueNonEmpty([
    ...configuredVariants,
    ...TELEGRAM_GENERIC_REACTION_FALLBACKS,
  ]);

  for (const candidate of variants) {
    if (!isTelegramSupportedReactionEmoji(candidate)) {
      continue;
    }
    const isAllowedByChat =
      params.allowedEmojiReactions == null || params.allowedEmojiReactions.has(candidate);
    if (isAllowedByChat) {
      return candidate;
    }
  }

  return undefined;
}
