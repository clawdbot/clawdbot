import type { ClawdbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

export function buildMentionRegexes(cfg: ClawdbotConfig | undefined): RegExp[] {
  const patterns = cfg?.routing?.groupChat?.mentionPatterns ?? [];
  return patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch {
        return null;
      }
    })
    .filter((value): value is RegExp => Boolean(value));
}

export function normalizeMentionText(text: string): string {
  return (text ?? "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .toLowerCase();
}

export function matchesMentionPatterns(
  text: string,
  mentionRegexes: RegExp[],
): boolean {
  if (mentionRegexes.length === 0) return false;
  const cleaned = normalizeMentionText(text ?? "");
  if (!cleaned) return false;
  return mentionRegexes.some((re) => re.test(cleaned));
}

export function stripStructuralPrefixes(text: string): string {
  // Ignore wrapper labels, timestamps, and sender prefixes so directive-only
  // detection still works in group batches that include history/context.
  const marker = "[Current message - respond to this]";
  const afterMarker = text.includes(marker)
    ? text.slice(text.indexOf(marker) + marker.length)
    : text;
  return afterMarker
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripMentions(
  text: string,
  ctx: MsgContext,
  cfg: ClawdbotConfig | undefined,
): string {
  let result = text;
  const patterns = cfg?.routing?.groupChat?.mentionPatterns ?? [];
  for (const p of patterns) {
    try {
      const re = new RegExp(p, "gi");
      result = result.replace(re, " ");
    } catch {
      // ignore invalid regex
    }
  }
  const selfE164 = (ctx.To ?? "").replace(/^whatsapp:/, "");
  if (selfE164) {
    const esc = selfE164.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result
      .replace(new RegExp(esc, "gi"), " ")
      .replace(new RegExp(`@${esc}`, "gi"), " ");
  }
  // Generic mention patterns like @123456789 or plain digits
  result = result.replace(/@[0-9+]{5,}/g, " ");
  // Discord-style mentions (<@123> or <@!123>)
  result = result.replace(/<@!?\d+>/g, " ");
  return result.replace(/\s+/g, " ").trim();
}
