import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import { replaceOutsideCodeRegions } from "../utils/directive-tags.js";

type TtsDirectiveBody =
  | { kind: "text"; text: string }
  | { kind: "directive"; directive: NonNullable<AssistantDeliveryTtsFacts["directives"]>[number] }
  | { kind: "reserved" };

/** Classify once so persisted facts and streamed text agree on valid directive tokens. */
export function parseTtsDirectiveBody(body: string): TtsDirectiveBody {
  const text = body.trim();
  if (!text || text.toLowerCase() === "text") {
    return { kind: "reserved" };
  }
  let provider: string | undefined;
  const values: Record<string, string> = {};
  for (const token of text.split(/\s+/)) {
    const eqIndex = token.indexOf("=");
    if (eqIndex <= 0 || eqIndex === token.length - 1) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(token.slice(0, eqIndex));
    const value = token.slice(eqIndex + 1);
    if (key === "provider") {
      provider = normalizeLowercaseStringOrEmpty(value);
    } else {
      values[key] = value;
    }
  }
  return provider || Object.keys(values).length > 0
    ? { kind: "directive", directive: { ...(provider ? { provider } : {}), values } }
    : { kind: "text", text };
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

  for (const [tags, hidden] of [
    [/\[\[\s*(\/\s*)?tts\s*:\s*text\s*\]\]/gi, true],
    [/\[\[\s*(\/\s*)?tts\s*\]\]/gi, false],
  ] as const) {
    const regions = findCodeRegions(cleanedText);
    const parts: string[] = [];
    let cursor = 0;
    let opener: { start: number; end: number } | undefined;
    for (const match of cleanedText.matchAll(tags)) {
      if (isInsideCode(match.index, regions)) {
        continue;
      }
      if (!match[1]) {
        opener ??= { start: match.index, end: match.index + match[0].length };
      } else if (opener) {
        const inner = cleanedText.slice(opener.end, match.index).trim();
        const next = markTagged();
        next.text ??= inner;
        parts.push(cleanedText.slice(cursor, opener.start), hidden ? "" : inner);
        cursor = match.index + match[0].length;
        opener = undefined;
      }
    }
    cleanedText = parts.join("") + cleanedText.slice(cursor);
  }

  const directiveRegex = /\[\[\s*tts\s*:\s*([^\]]+)\]\]/gi;
  cleanedText = replaceOutsideCodeRegions(cleanedText, directiveRegex, (_match, [body]) => {
    const next = markTagged();
    const parsed = parseTtsDirectiveBody(String(body));
    if (parsed.kind === "directive") {
      next.directives ??= [];
      next.directives.push(parsed.directive);
    } else if (parsed.kind === "text") {
      // Recovered prose uses the visible-text speech input; it is not a private override.
      return parsed.text;
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
