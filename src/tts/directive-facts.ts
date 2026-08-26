import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";

type TextRange = {
  start: number;
  end: number;
};

function collectMarkdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const addMatches = (regex: RegExp) => {
    for (const match of text.matchAll(regex)) {
      if (match.index == null) {
        continue;
      }
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  };

  addMatches(/```[\s\S]*?```/g);
  addMatches(/~~~[\s\S]*?~~~/g);
  addMatches(/^(?: {4}|\t).*(?:\n|$)/gm);
  addMatches(/`+[^`\n]*`+/g);

  return ranges.toSorted((left, right) => left.start - right.start);
}

function isInsideRange(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function replaceOutsideMarkdownCode(
  text: string,
  regex: RegExp,
  replace: (match: string, captures: readonly string[]) => string,
): string {
  const codeRanges = collectMarkdownCodeRanges(text);
  return text.replace(regex, (...args: unknown[]) => {
    const match = String(args[0]);
    const offset = args.at(-2);
    if (typeof offset === "number" && isInsideRange(offset, codeRanges)) {
      return match;
    }
    // String.replace passes captures before offset/input; keep the callback
    // typed without depending on the exact regexp arity for each directive.
    const captures = args.slice(1, -2).map((capture) => String(capture));
    return replace(match, captures);
  });
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
  cleanedText = replaceOutsideMarkdownCode(cleanedText, blockRegex, (_match, [inner = ""]) => {
    const next = markTagged();
    if (next.text == null) {
      next.text = inner.trim();
    }
    return "";
  });

  const plainBlockRegex = /\[\[\s*tts\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, plainBlockRegex, (_match, [inner = ""]) => {
    const next = markTagged();
    const visible = inner.trim();
    if (next.text == null) {
      next.text = visible;
    }
    return visible;
  });

  const directiveRegex = /\[\[\s*tts\s*:\s*([^\]]+)\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, directiveRegex, (_match, [body = ""]) => {
    const next = markTagged();
    const tokens = body.split(/\s+/).filter(Boolean);
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
    }
    return "";
  });

  const bareTagRegex = /\[\[\s*tts\s*\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, bareTagRegex, () => {
    markTagged();
    return "";
  });

  const closingTagRegex = /\[\[\s*\/\s*tts(?:\s*:\s*[^\]]*)?\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, closingTagRegex, () => {
    markTagged();
    return "";
  });

  return { cleanedText, ...(facts ? { facts } : {}) };
}
