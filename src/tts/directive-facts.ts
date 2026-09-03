import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import { replaceOutsideCodeRegions } from "../utils/directive-tags.js";

/**
 * A directive tag body declares speech overrides only when it carries a
 * whitespace token shaped `key=value`. A colon-form tag whose body has none is
 * free prose the model wrapped in the tag by mistake; both parsed and streamed
 * cleaners preserve it as reply text instead of discarding it.
 */
export function bodyHasTtsDirectiveKeyValue(body: string): boolean {
  return body
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => token.includes("="));
}

/** Extract final-text TTS syntax into persisted facts, leaving markdown code spans unchanged. */
export function extractTtsDirectiveFacts(text: string): {
  cleanedText: string;
  facts?: AssistantDeliveryTtsFacts;
} {
  if (!/\[\[\s*\/?\s*tts(?:\s*:|\s*\]\])/iu.test(text)) {
    return { cleanedText: text };
  }
  let cleanedText = text;
  let facts: AssistantDeliveryTtsFacts | undefined;
  const markTagged = () => {
    facts ??= { tagged: true };
    return facts;
  };

  const blockRegex = /\[\[\s*tts\s*:\s*text\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*:\s*text\s*\]\]/gi;
  cleanedText = replaceOutsideCodeRegions(cleanedText, blockRegex, (_match, [inner]) => {
    const next = markTagged();
    if (next.text == null) {
      next.text = String(inner).trim();
    }
    return "";
  });

  const plainBlockRegex = /\[\[\s*tts\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*\]\]/gi;
  cleanedText = replaceOutsideCodeRegions(cleanedText, plainBlockRegex, (_match, [inner]) => {
    const next = markTagged();
    const visible = String(inner).trim();
    if (next.text == null) {
      next.text = visible;
    }
    return visible;
  });

  const directiveRegex = /\[\[\s*tts\s*:\s*([^\]]+)\]\]/gi;
  cleanedText = replaceOutsideCodeRegions(cleanedText, directiveRegex, (_match, [body]) => {
    const next = markTagged();
    const tokens = String(body).split(/\s+/).filter(Boolean);
    let provider: string | undefined;
    const values: Record<string, string> = {};
    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      const rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = normalizeLowercaseStringOrEmpty(rawKey);
      if (key === "provider") {
        provider = normalizeLowercaseStringOrEmpty(rawValue) || undefined;
        continue;
      }
      values[key] = rawValue;
    }
    if (provider || Object.keys(values).length > 0) {
      next.directives ??= [];
      next.directives.push({ ...(provider ? { provider } : {}), values });
    } else if (
      !bodyHasTtsDirectiveKeyValue(body) &&
      normalizeLowercaseStringOrEmpty(body.trim()) !== "text"
    ) {
      // No parseable directive and no key=value shaped token means the model
      // wrapped its spoken reply in [[tts:<free text>]] by mistake. Keep that
      // prose as visible reply text so delivery does not collapse to the
      // empty-reply fallback. Mixed values deliberately keep existing
      // behavior, and the reserved [[tts:text]] marker stays audio-only (never
      // surfaced as literal speech) to match the streaming/caption cleaner.
      const spoken = body.trim();
      if (spoken) {
        next.text ??= spoken;
        return spoken;
      }
    }
    return "";
  });

  const bareTagRegex = /\[\[\s*tts\s*\]\]/gi;
  cleanedText = replaceOutsideCodeRegions(cleanedText, bareTagRegex, () => {
    markTagged();
    return "";
  });

  const closingTagRegex = /\[\[\s*\/\s*tts(?:\s*:\s*[^\]]*)?\]\]/gi;
  cleanedText = replaceOutsideCodeRegions(cleanedText, closingTagRegex, () => {
    markTagged();
    return "";
  });

  return { cleanedText, ...(facts ? { facts } : {}) };
}
