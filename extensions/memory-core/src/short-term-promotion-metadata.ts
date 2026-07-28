// Memory Core plugin module formats deterministic recall metadata for promoted entries.
import type { PromotionCandidate } from "./short-term-promotion-types.js";

const MAX_PROMOTION_TRIGGER_PHRASE_CHARS = 64;

function normalizePromotionTriggerPhrase(value: string): string {
  const singleLine = value
    .replace(/<!--|-->/gu, " ")
    .replace(/[\r\n,;]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(singleLine).slice(0, MAX_PROMOTION_TRIGGER_PHRASE_CHARS).join("").trimEnd();
}

export function buildPromotionRecallAnnotations(
  candidate: Pick<PromotionCandidate, "conceptTags" | "score">,
): string {
  const triggers = candidate.conceptTags
    .slice(0, 3)
    .map(normalizePromotionTriggerPhrase)
    .filter(Boolean)
    .join(", ");
  const importance = Math.min(10, Math.max(3, Math.round(candidate.score * 10)));
  return `<!-- trigger: ${triggers} --> <!-- importance: ${importance} -->`;
}
