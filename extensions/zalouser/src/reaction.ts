import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Reactions } from "./zca-constants.js";

const REACTION_ALIAS_MAP = new Map<string, string>([
  ["like", Reactions.LIKE],
  ["👍", Reactions.LIKE],
  [":+1:", Reactions.LIKE],
  ["heart", Reactions.HEART],
  ["❤️", Reactions.HEART],
  ["<3", Reactions.HEART],
  ["haha", Reactions.HAHA],
  ["laugh", Reactions.HAHA],
  ["😂", Reactions.HAHA],
  ["wow", Reactions.WOW],
  ["😮", Reactions.WOW],
  ["cry", Reactions.CRY],
  ["😢", Reactions.CRY],
  ["angry", Reactions.ANGRY],
  ["😡", Reactions.ANGRY],
]);

export function normalizeZaloReactionIcon(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return Reactions.LIKE;
  }
  return (
    REACTION_ALIAS_MAP.get(normalizeLowercaseStringOrEmpty(trimmed)) ??
    REACTION_ALIAS_MAP.get(trimmed) ??
    trimmed
  );
}
