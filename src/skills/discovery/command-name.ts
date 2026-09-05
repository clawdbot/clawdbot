import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export const SKILL_COMMAND_MAX_LENGTH = 32;

export function sanitizeSkillCommandName(raw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(raw)
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, SKILL_COMMAND_MAX_LENGTH) || "skill";
}
