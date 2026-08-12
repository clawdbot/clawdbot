// Imessage plugin module implements sanitize outbound behavior.
import {
  findCodeRegions,
  isInsideCode,
  sanitizeAssistantVisibleText,
  stripMarkdown,
  tokenizeHtmlTags,
  type CodeRegion,
} from "openclaw/plugin-sdk/text-chunking";
import { extractMarkdownFormatRuns } from "../markdown-format.js";

/**
 * Patterns that indicate assistant-internal metadata leaked into text.
 * These must never reach a user-facing channel.
 */
const INTERNAL_SEPARATOR_RE = /(?:#\+){2,}#?/g;
const ASSISTANT_ROLE_MARKER_RE = /\bassistant\s+to\s*=\s*\w+/gi;
// Blockquote prefixes are stripped by the iMessage Markdown formatter, so a
// quoted standalone role marker is just as unsafe as an unquoted turn boundary.
const ROLE_TURN_MARKER_RE = /^[ \t]*(?:>[ \t]*)*(?:user|system|assistant)[ \t]*:[ \t]*(?=\r?$)/gim;
const FENCED_ROLE_MARKER_RE = /^[ \t]*(user|system|assistant)[ \t]*:[ \t]*(?=\r?$)/gim;
const FINAL_PRIVATE_MARKER_RE =
  /(?:#\+){2,}#?|\bassistant\s+to\s*=\s*\w+|^[ \t]*(?:user|system|assistant)[ \t]*:[ \t]*(?=\r?$)/gim;
const PRIVATE_USE_START = 0xe000;
const PRIVATE_USE_END = 0xf8ff;
const MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES = 32;
// Mirror the private shared plain-text HTML grammar to inspect every destructive removal stage.
const PLAIN_TEXT_HTML_TAG_RE = /<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi;
const PRIVATE_PROVIDER_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "reasoning",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "antml:reasoning",
  "mm:think",
  "mm:thinking",
  "mm:thought",
  "mm:reasoning",
  "relevant_memories",
  "relevant-memories",
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function_response",
  "function",
  "tool_calls",
  "antml:invoke",
  "antml:parameter",
  "invoke",
  "parameter",
] as const;
const PRIVATE_PROVIDER_TAG_NAME_SET = new Set<string>(PRIVATE_PROVIDER_TAG_NAMES);
// The canonical private runtime context block can erase an inline hidden-tag name fragment.
const OPAQUE_PRIVATE_RUNTIME_CONTEXT_BLOCK_RE =
  /^<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>(?:(?!<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>)[\s\S])*<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/;
const PRIVATE_RUNTIME_CONTEXT_BLOCK_RE =
  /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>(?:(?!<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>)[\s\S])*<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g;
const NESTED_PRIVATE_MARKUP_START_RE =
  /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>|<\s*\/?\s*[A-Za-z][A-Za-z0-9_.:-]*(?=\s|\/?>)/g;
const OUTER_PRIVATE_TAG_FRAGMENT_RE = /^\s*\/?\s*([a-z][a-z0-9_.:-]*)?$/i;
const OPAQUE_PRIVATE_MARKUP_BLOCK_RE =
  /^<\s*(system-reminder|previous_response|details|summary)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/i;
const REMOVABLE_PRIVATE_MARKUP_TAG_RE = /^<\s*\/?\s*[a-z][a-z0-9_.:-]*(?=\s|\/?>)[^>]*>/i;
const PRIVATE_PROVIDER_TAG_FRAGMENT_RE = /^[a-z0-9_.:-]*/i;
// Classify the private producer's names before lexing quoted HTML attributes safely.
const PRIVATE_RUNTIME_SCAFFOLDING_TAG_TOKEN_RE =
  /<\s*(\/?)\s*(system-reminder|previous_response)\b/gi;

function assertSafeIMessageOutboundMarkup(text: string): void {
  for (const nested of text.matchAll(NESTED_PRIVATE_MARKUP_START_RE)) {
    const nestedStart = nested.index ?? 0;
    const outerStart = text.lastIndexOf("<", nestedStart - 1);
    if (outerStart < 0) {
      continue;
    }
    const outer = OUTER_PRIVATE_TAG_FRAGMENT_RE.exec(text.slice(outerStart + 1, nestedStart));
    if (!outer) {
      continue;
    }

    let candidate = (outer[1] ?? "").toLowerCase();
    if (!PRIVATE_PROVIDER_TAG_NAMES.some((name) => name.startsWith(candidate))) {
      continue;
    }

    let cursor = nestedStart;
    for (let depth = 0; depth < MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES; depth += 1) {
      const remaining = text.slice(cursor);
      // Runtime scaffolding erases whole blocks; ordinary HTML erases just its tag.
      const removed =
        OPAQUE_PRIVATE_RUNTIME_CONTEXT_BLOCK_RE.exec(remaining)?.[0] ??
        OPAQUE_PRIVATE_MARKUP_BLOCK_RE.exec(remaining)?.[0] ??
        REMOVABLE_PRIVATE_MARKUP_TAG_RE.exec(remaining)?.[0];
      if (!removed) {
        break;
      }
      cursor += removed.length;

      const suffix = PRIVATE_PROVIDER_TAG_FRAGMENT_RE.exec(text.slice(cursor))?.[0] ?? "";
      candidate += suffix.toLowerCase();
      cursor += suffix.length;
      if (PRIVATE_PROVIDER_TAG_NAME_SET.has(candidate) && /[\s/>]/.test(text.charAt(cursor))) {
        throw new Error("iMessage outbound ambiguous nested HTML is not allowed");
      }
      if (!PRIVATE_PROVIDER_TAG_NAMES.some((name) => name.startsWith(candidate))) {
        break;
      }
      if (
        depth + 1 >= MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES &&
        (OPAQUE_PRIVATE_RUNTIME_CONTEXT_BLOCK_RE.test(text.slice(cursor)) ||
          REMOVABLE_PRIVATE_MARKUP_TAG_RE.test(text.slice(cursor)))
      ) {
        throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
      }
    }
  }
}

function stripIMessageBalancedPrivateRuntimeBlocks(
  text: string,
  verifyProtectedRoles?: (visible: string) => void,
): string {
  type HtmlRegion = { start: number; end: number; terminated: boolean };
  const openBlocks: Array<{
    name: string;
    start: number;
    end: number;
    sawNested: boolean;
    codeRegion?: CodeRegion;
    nestedCodeRegions?: CodeRegion[];
  }> = [];
  const completedBlocks: Array<{ start: number; end: number }> = [];
  const codeRegions = findCodeRegions(text);
  const parsedHtmlTags = [...tokenizeHtmlTags(text)];
  const htmlTags: HtmlRegion[] = parsedHtmlTags.map(({ start, end }) => ({
    start,
    end,
    terminated: true,
  }));
  const rawTextHtml: HtmlRegion[] = [];
  const rawTextTagNames = new Set([
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
  ]);
  for (const [index, opener] of parsedHtmlTags.entries()) {
    if (opener.closing || !rawTextTagNames.has(opener.name)) {
      continue;
    }
    const closing =
      opener.name === "plaintext"
        ? undefined
        : parsedHtmlTags.slice(index + 1).find((candidate) => {
            return candidate.closing && candidate.name === opener.name;
          });
    rawTextHtml.push({
      start: opener.start,
      end: closing?.end ?? text.length,
      terminated: Boolean(closing),
    });
    if (rawTextHtml.length > MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES ** 2) {
      throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
    }
  }
  const opaqueHtml: HtmlRegion[] = [];
  for (let cursor = 0; cursor < text.length;) {
    const start = text.indexOf("<", cursor);
    if (start < 0) {
      break;
    }
    const enclosingTag = htmlTags.find((tag) => tag.start < start && start < tag.end);
    if (enclosingTag) {
      cursor = enclosingTag.end;
      continue;
    }

    let end = -1;
    let delimiterLength = 0;
    if (text.startsWith("<!--", start)) {
      end = text.indexOf("-->", start + 4);
      delimiterLength = 3;
    } else if (/^<!\[CDATA\[/i.test(text.slice(start, start + 9))) {
      end = text.indexOf("]]>", start + 9);
      delimiterLength = 3;
    } else if (text.startsWith("<?", start)) {
      let quote: "'" | '"' | undefined;
      for (let index = start + 2; index < text.length - 1; index += 1) {
        const character = text[index];
        if (quote) {
          if (character === quote) {
            quote = undefined;
          }
        } else if (character === "'" || character === '"') {
          quote = character;
        } else if (character === "?" && text[index + 1] === ">") {
          end = index;
          delimiterLength = 2;
          break;
        }
      }
    } else if (/^<![a-z][a-z0-9_.:-]*\b/i.test(text.slice(start))) {
      let quote: "'" | '"' | undefined;
      let bracketDepth = 0;
      for (let index = start + 2; index < text.length; index += 1) {
        const character = text[index];
        if (quote) {
          if (character === quote) {
            quote = undefined;
          }
        } else if (character === "'" || character === '"') {
          quote = character;
        } else if (character === "[") {
          bracketDepth += 1;
        } else if (character === "]" && bracketDepth > 0) {
          bracketDepth -= 1;
        } else if (character === ">" && bracketDepth === 0) {
          end = index;
          delimiterLength = 1;
          break;
        }
      }
    } else if (
      text.startsWith("<!", start) ||
      (text.startsWith("</", start) &&
        start + 2 < text.length &&
        !/[A-Za-z>]/.test(text[start + 2] ?? ""))
    ) {
      // HTML's bogus-comment state consumes malformed declarations through their first `>`.
      end = text.indexOf(">", start + 2);
      delimiterLength = 1;
    } else {
      cursor = start + 1;
      continue;
    }
    if (opaqueHtml.length >= MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES ** 2) {
      throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
    }
    const terminated = end >= 0;
    const regionEnd = terminated ? end + delimiterLength : text.length;
    opaqueHtml.push({ start, end: regionEnd, terminated });
    cursor = regionEnd;
  }
  htmlTags.push(...opaqueHtml);
  htmlTags.sort((left, right) => left.start - right.start || right.end - left.end);
  let htmlTagIndex = 0;
  let scannedTags = 0;
  let scannedThrough = 0;

  for (const token of text.matchAll(PRIVATE_RUNTIME_SCAFFOLDING_TAG_TOKEN_RE)) {
    const start = token.index ?? 0;
    if (start < scannedThrough) {
      continue;
    }
    while ((htmlTags[htmlTagIndex]?.end ?? 0) <= start && htmlTagIndex < htmlTags.length) {
      htmlTagIndex += 1;
    }
    const enclosingHtmlTag = htmlTags[htmlTagIndex];
    if (enclosingHtmlTag && enclosingHtmlTag.start < start && start < enclosingHtmlTag.end) {
      continue;
    }
    const codeRegion = codeRegions.find((region) => isInsideCode(start, [region]));
    const enclosingBlock = openBlocks.at(-1);
    const enclosingRawText = rawTextHtml.find((region) => {
      return region.start < start && start < region.end;
    });
    if (enclosingBlock && enclosingRawText && enclosingBlock.start < enclosingRawText.start) {
      enclosingBlock.sawNested = true;
      continue;
    }
    if (enclosingBlock && codeRegion && enclosingBlock.codeRegion !== codeRegion) {
      enclosingBlock.sawNested = true;
      continue;
    }
    if (enclosingBlock?.codeRegion && enclosingBlock.codeRegion !== codeRegion) {
      throw new Error("iMessage outbound runtime scaffolding is malformed");
    }
    if (++scannedTags > MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES ** 2) {
      throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
    }

    let quote: "'" | '"' | undefined;
    let end = start + token[0].length;
    for (; end < text.length; end += 1) {
      if (end - start > MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES ** 2) {
        throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
      }
      const character = text[end];
      if (quote) {
        if (character === quote) {
          quote = undefined;
        }
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (character === "<") {
        throw new Error("iMessage outbound runtime scaffolding is malformed");
      } else if (character === ">") {
        break;
      }
    }
    if (end >= text.length || quote) {
      throw new Error("iMessage outbound runtime scaffolding is malformed");
    }
    end += 1;

    if (enclosingBlock?.codeRegion && enclosingBlock.codeRegion === codeRegion) {
      if (!enclosingBlock.nestedCodeRegions) {
        const nestedCodeLength = codeRegion.end - enclosingBlock.end;
        if (nestedCodeLength > MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES ** 3) {
          throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
        }
        enclosingBlock.nestedCodeRegions = findCodeRegions(
          text.slice(enclosingBlock.end, codeRegion.end),
        );
        if (enclosingBlock.nestedCodeRegions.length > MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES ** 2) {
          throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
        }
      }

      // Reparse only the owning wrapper's contents so a nested literal tag cannot close it.
      if (isInsideCode(start - enclosingBlock.end, enclosingBlock.nestedCodeRegions)) {
        enclosingBlock.sawNested = true;
        continue;
      }
    }

    scannedThrough = end;
    const markup = text.slice(start, end);
    const closing = token[1] === "/";
    if (!closing && /\/\s*>$/.test(markup)) {
      const parent = openBlocks.at(-1);
      if (parent) {
        parent.sawNested = true;
      } else {
        completedBlocks.push({ start, end });
      }
      continue;
    }
    const name = (token[2] ?? "").toLowerCase();
    if (!closing) {
      if (openBlocks.length >= MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES) {
        throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
      }
      const parent = openBlocks.at(-1);
      if (parent) {
        parent.sawNested = true;
      }
      openBlocks.push({ name, start, end, sawNested: false, codeRegion });
      continue;
    }

    const opening = openBlocks.at(-1);
    if (!opening) {
      completedBlocks.push({ start, end });
      continue;
    }
    if (opening.name !== name) {
      throw new Error("iMessage outbound runtime scaffolding is malformed");
    }
    openBlocks.pop();
    completedBlocks.push({ start: opening.start, end });
  }
  if (
    openBlocks.length > 1 ||
    openBlocks[0]?.sawNested ||
    (openBlocks[0] &&
      [...opaqueHtml, ...rawTextHtml].some(
        (region) => !region.terminated && openBlocks[0]!.start < region.start,
      ))
  ) {
    throw new Error("iMessage outbound runtime scaffolding is malformed");
  }
  const orphan = openBlocks[0];
  if (orphan) {
    completedBlocks.push({ start: orphan.start, end: orphan.end });
  }

  completedBlocks.sort((left, right) => left.start - right.start || right.end - left.end);
  const outermost: typeof completedBlocks = [];
  for (const block of completedBlocks) {
    const previous = outermost.at(-1);
    if (!previous || block.start >= previous.end) {
      outermost.push(block);
    }
  }
  let current = text;
  for (const block of outermost.toReversed()) {
    verifyProtectedRoles?.(current);
    const stripped = current.slice(0, block.start) + current.slice(block.end);
    assertSafeIMessageOutboundMarkup(stripped);
    verifyProtectedRoles?.(stripped);
    current = stripped;
  }
  return current;
}

function stripIMessagePrivateRuntimeScaffolding(
  text: string,
  verifyProtectedRoles?: (visible: string) => void,
): string {
  assertSafeIMessageOutboundMarkup(text);
  let current = text;
  for (let depth = 0; depth < MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES; depth += 1) {
    let changed = false;
    for (const strip of [
      (value: string) => value.replace(PRIVATE_RUNTIME_CONTEXT_BLOCK_RE, ""),
      (value: string) => stripIMessageBalancedPrivateRuntimeBlocks(value, verifyProtectedRoles),
    ]) {
      verifyProtectedRoles?.(current);
      const stripped = strip(current);
      assertSafeIMessageOutboundMarkup(stripped);
      verifyProtectedRoles?.(stripped);
      if (stripped !== current) {
        current = stripped;
        changed = true;
      }
    }
    if (!changed) {
      return current;
    }
  }
  throw new Error("iMessage outbound runtime scaffolding exceeded its limit");
}

// Delivery owns the complete assistant-scaffolding policy, but its final trim is not a raw
// iMessage wire contract. Restore only the original outer whitespace around surviving prose.
function sanitizeIMessageAssistantVisibleText(
  text: string,
  verifyProtectedRoles?: (visible: string) => void,
): string {
  const cleaned = stripIMessagePrivateRuntimeScaffolding(text, verifyProtectedRoles);
  if (!text.trim()) {
    return text;
  }
  const leadingWhitespace = /^\s*/u.exec(text)?.[0] ?? "";
  const trailingWhitespace = /\s*$/u.exec(text)?.[0] ?? "";
  verifyProtectedRoles?.(cleaned);
  const canonical = cleaned.trim();
  verifyProtectedRoles?.(canonical);
  const visible = sanitizeAssistantVisibleText(canonical);
  verifyProtectedRoles?.(visible);
  return visible ? `${leadingWhitespace}${visible}${trailingWhitespace}` : "";
}

// SDK regions merge fenced, inline, indented, and unterminated code. Only a
// closed fence on its own physical lines may preserve YAML role mapping keys.
function isClosedFencedCodeRegion(text: string, region: CodeRegion): boolean {
  const lineStart = text.lastIndexOf("\n", region.start - 1) + 1;
  if (!/^ {0,3}$/.test(text.slice(lineStart, region.start))) {
    return false;
  }

  const source = text.slice(region.start, region.end);
  const openingFence = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?\n/.exec(source)?.[1];
  if (!openingFence) {
    return false;
  }

  const closingFence = new RegExp(
    `\r?\n {0,3}${openingFence[0]}{${openingFence.length},}[\t ]*(?:\r?\n)?$`,
  );
  const lineEnd = text.indexOf("\n", region.end);
  return (
    closingFence.test(source) &&
    /^[\t ]*\r?$/.test(text.slice(region.end, lineEnd < 0 ? text.length : lineEnd))
  );
}

type OutboundFormattingRange = { start: number; length: number };

type ProtectedOutboundText = {
  text: string;
  verifyProtectedRoles: (visible: string) => void;
  sanitizeFormatted: <T extends OutboundFormattingRange>(formatted: {
    text: string;
    ranges: T[];
  }) => { text: string; ranges: T[] };
};

/** Preserve authenticated fenced role mappings through the final native-render scrub. */
export function protectIMessageFencedRoleMarkers(text: string): ProtectedOutboundText {
  const source = stripIMessagePrivateRuntimeScaffolding(text);
  const closedFencedRegions = findCodeRegions(source).filter((region) =>
    isClosedFencedCodeRegion(source, region),
  );
  const protectedRoles = new Map<string, string>();
  let privateUseCodePoint = PRIVATE_USE_START;

  const protectedText = source.replace(
    FENCED_ROLE_MARKER_RE,
    (marker, role: string, offset: number) => {
      if (!isInsideCode(offset, closedFencedRegions)) {
        return marker;
      }

      while (privateUseCodePoint <= PRIVATE_USE_END) {
        const protectedGlyph = String.fromCharCode(privateUseCodePoint++);
        const token = protectedGlyph.repeat(role.length);
        if (text.includes(protectedGlyph) || protectedRoles.has(token)) {
          continue;
        }
        protectedRoles.set(token, role);
        return marker.replace(role, token);
      }
      throw new Error("iMessage outbound role protection is unavailable");
    },
  );
  const verifyProtectedRoles = (visible: string) => {
    assertSafeIMessageOutboundMarkup(visible);
    let previous = -1;
    for (const token of protectedRoles.keys()) {
      const first = visible.indexOf(token);
      if (first < 0 || first < previous || visible.includes(token, first + token.length)) {
        throw new Error("iMessage outbound role protection failed");
      }
      for (let offset = visible.indexOf(token[0] ?? ""); offset >= 0;) {
        if (offset < first || offset >= first + token.length) {
          throw new Error("iMessage outbound role protection failed");
        }
        offset = visible.indexOf(token[0] ?? "", offset + 1);
      }
      previous = first + token.length;
    }
  };

  return {
    text: protectedText,
    verifyProtectedRoles,
    sanitizeFormatted: <T extends OutboundFormattingRange>(formatted: {
      text: string;
      ranges: T[];
    }): { text: string; ranges: T[] } => {
      verifyProtectedRoles(formatted.text);

      let visible = formatted.text;
      let ranges = formatted.ranges;
      for (let remainingPasses = visible.length; ; remainingPasses--) {
        verifyProtectedRoles(visible);
        const assistantVisible = sanitizeIMessageAssistantVisibleText(
          visible,
          verifyProtectedRoles,
        );
        const assistantTextChanged = assistantVisible !== visible;
        if (assistantTextChanged) {
          // SDK cleanup can insert separators, so stale attributed offsets must never reach imsg.
          visible = assistantVisible;
          ranges = [];
          verifyProtectedRoles(visible);
        }

        const removed: Array<{ start: number; end: number }> = [];
        const cleaned = visible.replace(FINAL_PRIVATE_MARKER_RE, (marker, offset: number) => {
          removed.push({ start: offset, end: offset + marker.length });
          return "";
        });
        if (removed.length > 0) {
          const mapOffset = (offset: number) =>
            offset -
            removed.reduce(
              (total, edit) => total + Math.max(0, Math.min(offset, edit.end) - edit.start),
              0,
            );
          ranges = ranges.flatMap((range) => {
            const start = mapOffset(range.start);
            const length = mapOffset(range.start + range.length) - start;
            return length > 0 ? [{ ...range, start, length }] : [];
          });
          visible = cleaned;
          verifyProtectedRoles(visible);
        }

        if (removed.length === 0) {
          // Nested fences can reveal one protected layer per render. Never mutate the raw wire
          // payload; recursively inspect bounded projections until no hidden layer remains.
          let projection = visible;
          for (let depth = 0; ; depth += 1) {
            verifyProtectedRoles(projection);
            const renderedProjection = extractMarkdownFormatRuns(projection).text;
            verifyProtectedRoles(renderedProjection);
            const unwrappedProjection = stripMarkdown(renderedProjection);
            verifyProtectedRoles(unwrappedProjection);
            let htmlProjection = unwrappedProjection;
            for (let htmlDepth = 0; ; htmlDepth += 1) {
              verifyProtectedRoles(htmlProjection);
              const assistantProjection = sanitizeIMessageAssistantVisibleText(
                htmlProjection,
                verifyProtectedRoles,
              );
              verifyProtectedRoles(assistantProjection);
              if (assistantProjection !== htmlProjection) {
                throw new Error("iMessage outbound hidden assistant content is not allowed");
              }

              const htmlRemoved = htmlProjection.replace(PLAIN_TEXT_HTML_TAG_RE, "");
              verifyProtectedRoles(htmlRemoved);
              if (htmlRemoved === htmlProjection) {
                break;
              }
              if (htmlDepth + 1 >= MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES) {
                throw new Error("iMessage outbound HTML security projection exceeded its limit");
              }
              htmlProjection = htmlRemoved;
            }
            if (unwrappedProjection === projection) {
              break;
            }
            if (depth + 1 >= MAX_PRIVATE_MARKDOWN_UNWRAP_PASSES) {
              throw new Error("iMessage outbound Markdown security projection exceeded its limit");
            }
            projection = unwrappedProjection;
          }
          if (!assistantTextChanged) {
            break;
          }
        }
        if (remainingPasses <= 0) {
          throw new Error("iMessage outbound role sanitization failed");
        }
      }
      verifyProtectedRoles(visible);
      for (const [token, role] of protectedRoles) {
        visible = visible.replace(token, role);
      }

      return {
        text: visible,
        ranges,
      };
    },
  };
}

/** Keep each transport's existing rendered or raw wire contract behind one final security gate. */
export function sanitizeIMessageFinalOutboundText(
  text: string,
  options: { formatMarkdown?: boolean; protection?: ProtectedOutboundText } = {},
) {
  const protection = options.protection ?? protectIMessageFencedRoleMarkers(text);
  const source = options.protection ? text : protection.text;
  protection.verifyProtectedRoles(source);
  const protectedText = sanitizeIMessageAssistantVisibleText(
    source,
    protection.verifyProtectedRoles,
  );
  protection.verifyProtectedRoles(protectedText);
  const formatted =
    options.formatMarkdown && protectedText.trim()
      ? extractMarkdownFormatRuns(protectedText)
      : { text: protectedText, ranges: [] };
  return protection.sanitizeFormatted(formatted);
}

/**
 * Strip all assistant-internal scaffolding from outbound text before delivery.
 * Applies reasoning/thinking tag removal, memory tag removal, and
 * model-specific internal separator stripping.
 */
export function sanitizeOutboundText(text: string): string {
  if (!text) {
    return text;
  }

  let cleaned = sanitizeIMessageAssistantVisibleText(text);

  cleaned = cleaned.replace(INTERNAL_SEPARATOR_RE, "");
  cleaned = cleaned.replace(ASSISTANT_ROLE_MARKER_RE, "");

  const closedFencedRegions = findCodeRegions(cleaned).filter((region) =>
    isClosedFencedCodeRegion(cleaned, region),
  );
  cleaned = cleaned.replace(ROLE_TURN_MARKER_RE, (marker, offset: number) =>
    isInsideCode(offset, closedFencedRegions) ? marker : "",
  );

  // Collapse excessive blank lines left after stripping.
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}
