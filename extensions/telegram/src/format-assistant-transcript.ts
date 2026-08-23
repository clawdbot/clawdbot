import { markdownToIR, tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import {
  decodeTelegramHtmlEntities,
  findTelegramHtmlEntityEnd,
  isTelegramRichLineBreakStructuralTag,
} from "./format-html.js";

export const TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX = "<code>Assistant:</code> ";

type TelegramHtmlVisibleProjection = {
  text: string;
  excludedRanges: Array<{ start: number; end: number }>;
};

function maskTelegramExcludedText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.trim() ? `x${" ".repeat(Math.max(0, line.length - 1))}` : " ".repeat(line.length),
    )
    .join("\n");
}

function maskTelegramExcludedRanges(projection: TelegramHtmlVisibleProjection): string {
  let masked = "";
  let cursor = 0;
  for (const range of projection.excludedRanges) {
    masked += projection.text.slice(cursor, range.start);
    masked += maskTelegramExcludedText(projection.text.slice(range.start, range.end));
    cursor = range.end;
  }
  return masked + projection.text.slice(cursor);
}

function telegramProjectionHasRoleHeader(projection: TelegramHtmlVisibleProjection): boolean {
  return Boolean(
    markdownToIR(maskTelegramExcludedRanges(projection), {
      assistantTranscriptRoleHeaders: true,
      autolink: false,
      blockquotePrefix: "",
      headingStyle: "none",
      linkify: false,
      tableMode: "off",
    }).annotations?.some((annotation) => annotation.type === "assistant_transcript_role"),
  );
}

function appendTelegramHtmlVisibleValue(
  projection: TelegramHtmlVisibleProjection,
  value: string,
  excluded: boolean,
): void {
  if (!value) {
    return;
  }
  const start = projection.text.length;
  projection.text += value;
  if (!excluded) {
    return;
  }
  const previous = projection.excludedRanges.at(-1);
  if (previous?.end === start) {
    previous.end = projection.text.length;
  } else {
    projection.excludedRanges.push({ start, end: projection.text.length });
  }
}

function appendTelegramHtmlVisibleSegment(
  projection: TelegramHtmlVisibleProjection,
  segment: string,
  excluded: boolean,
): void {
  let index = 0;
  while (index < segment.length) {
    if (segment[index] === "&") {
      const entityEnd = findTelegramHtmlEntityEnd(segment, index);
      if (entityEnd >= 0) {
        const rawEntity = segment.slice(index, entityEnd + 1);
        appendTelegramHtmlVisibleValue(projection, decodeTelegramHtmlEntities(rawEntity), excluded);
        index = entityEnd + 1;
        continue;
      }
    }
    const codePoint = segment.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    appendTelegramHtmlVisibleValue(projection, character, excluded);
    index += character.length;
  }
}

function projectTelegramHtmlVisibleText(html: string): TelegramHtmlVisibleProjection {
  const projection: TelegramHtmlVisibleProjection = { text: "", excludedRanges: [] };
  let codeDepth = 0;
  let preDepth = 0;
  let lastIndex = 0;

  for (const tag of tokenizeHtmlTags(html)) {
    const tagStart = tag.start;
    const tagEnd = tag.end;
    appendTelegramHtmlVisibleSegment(
      projection,
      html.slice(lastIndex, tagStart),
      codeDepth > 0 || preDepth > 0,
    );

    const rawTag = tag.raw;
    const tagName = tag.name;
    const isClosing = tag.closing;
    const isSelfClosing = tag.selfClosing;
    if (
      isTelegramRichLineBreakStructuralTag(rawTag, tagName) &&
      projection.text &&
      !projection.text.endsWith("\n")
    ) {
      appendTelegramHtmlVisibleValue(projection, "\n", codeDepth > 0 || preDepth > 0);
    }
    if (tagName === "br" && !isClosing) {
      appendTelegramHtmlVisibleValue(projection, "\n", codeDepth > 0 || preDepth > 0);
    }
    if (!isSelfClosing && tagName === "code") {
      codeDepth = isClosing ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    } else if (!isSelfClosing && tagName === "pre") {
      preDepth = isClosing ? Math.max(0, preDepth - 1) : preDepth + 1;
    }
    lastIndex = tagEnd;
  }
  appendTelegramHtmlVisibleSegment(
    projection,
    html.slice(lastIndex),
    codeDepth > 0 || preDepth > 0,
  );
  return projection;
}

export function protectTelegramAssistantTranscriptRoleHeaders(html: string): string {
  if (html.startsWith(TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX)) {
    return html;
  }
  if (!telegramProjectionHasRoleHeader(projectTelegramHtmlVisibleText(html))) {
    return html;
  }
  // Supported raw HTML is promoted after Markdown parsing and can reveal hidden text.
  return `${TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX}${html}`;
}
