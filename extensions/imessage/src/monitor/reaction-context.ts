import type { IMessagePayload } from "./types.js";

export type IMessageReactionContext = {
  action: "added" | "removed";
  emoji: string;
  targetGuid?: string;
  targetGuids?: string[];
  targetText?: string;
};

const TAPBACK_TEXT_PATTERNS: Array<{
  prefix: string;
  action: "added" | "removed";
  emoji: string;
}> = [
  { prefix: "loved", action: "added", emoji: "❤️" },
  { prefix: "liked", action: "added", emoji: "👍" },
  { prefix: "disliked", action: "added", emoji: "👎" },
  { prefix: "laughed at", action: "added", emoji: "😂" },
  { prefix: "emphasized", action: "added", emoji: "‼️" },
  { prefix: "questioned", action: "added", emoji: "❓" },
  { prefix: "removed a heart from", action: "removed", emoji: "❤️" },
  { prefix: "removed a like from", action: "removed", emoji: "👍" },
  { prefix: "removed a dislike from", action: "removed", emoji: "👎" },
  { prefix: "removed a laugh from", action: "removed", emoji: "😂" },
  { prefix: "removed an emphasis from", action: "removed", emoji: "‼️" },
  { prefix: "removed a question from", action: "removed", emoji: "❓" },
];

function normalizeReactionValue(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().replace(/^p:\d+\//iu, "") || undefined
    : undefined;
}

function resolveReactionTargetGuidCandidates(...values: unknown[]): string[] {
  const candidates: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const raw = value.trim();
    if (!raw) {
      continue;
    }
    const normalized = raw.replace(/^p:\d+\//iu, "");
    for (const candidate of [normalized, raw]) {
      if (candidate && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function resolveTapbackTextContext(bodyText: string): IMessageReactionContext | null {
  const lower = bodyText.toLowerCase();
  for (const pattern of TAPBACK_TEXT_PATTERNS) {
    if (!lower.startsWith(pattern.prefix)) {
      continue;
    }
    const afterPrefix = bodyText.slice(pattern.prefix.length).trim();
    if (!/^["“]/u.test(afterPrefix)) {
      continue;
    }
    return {
      action: pattern.action,
      emoji: pattern.emoji,
      targetText: afterPrefix
        .replace(/^["“]/u, "")
        .replace(/["”]$/u, "")
        .trim(),
    };
  }
  return null;
}

export function resolveIMessageReactionContext(
  message: IMessagePayload,
  bodyText: string,
): IMessageReactionContext | null {
  const explicit =
    message.is_reaction === true ||
    message.is_tapback === true ||
    (typeof message.associated_message_type === "number" &&
      Number.isFinite(message.associated_message_type) &&
      message.associated_message_type >= 2000 &&
      message.associated_message_type < 4000);
  if (explicit) {
    const targetGuids = resolveReactionTargetGuidCandidates(
      message.reacted_to_guid,
      message.associated_message_guid,
    );
    return {
      action: message.is_reaction_add === false ? "removed" : "added",
      emoji:
        normalizeReactionValue(message.reaction_emoji) ??
        normalizeReactionValue(message.reaction_type) ??
        "reaction",
      targetGuid: targetGuids[0],
      targetGuids,
    };
  }
  return resolveTapbackTextContext(bodyText);
}
