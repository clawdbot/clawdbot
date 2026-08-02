/**
 * Tlon Story Format - Rich text converter
 *
 * Converts markdown-like text to Tlon's story format.
 */

import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";

// Inline content types
type StoryInline =
  | string
  | { bold: StoryInline[] }
  | { italics: StoryInline[] }
  | { strike: StoryInline[] }
  | { blockquote: StoryInline[] }
  | { "inline-code": string }
  | { code: string }
  | { ship: string }
  | { link: { href: string; content: string } }
  | { task: { checked: boolean; content: StoryInline[] } }
  | { break: null }
  | { tag: string };

type StoryListType = "ordered" | "unordered" | "tasklist";

// Block content types
type StoryBlock =
  | { header: { tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"; content: StoryInline[] } }
  | { code: { code: string; lang: string } }
  | { image: { src: string; height: number; width: number; alt: string } }
  | { rule: null }
  | { listing: StoryListing };

type StoryListing =
  | {
      list: {
        type: StoryListType;
        items: StoryListing[];
        contents: StoryInline[];
      };
    }
  | { item: StoryInline[] };

// A verse is either a block or inline content
type StoryVerse = { block: StoryBlock } | { inline: StoryInline[] };

// A story is a list of verses
export type Story = StoryVerse[];

/**
 * Parse inline markdown formatting (bold, italic, code, links, mentions)
 */
function parseInlineMarkdown(text: string): StoryInline[] {
  const result: StoryInline[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Ship mentions: ~sampel-palnet
    const shipMatch = remaining.match(/^(~[a-z][-a-z0-9]*)/);
    if (shipMatch) {
      result.push({ ship: expectDefined(shipMatch[1], "ship mention capture") });
      remaining = remaining.slice(shipMatch[0].length);
      continue;
    }

    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*|^__(.+?)__/);
    if (boldMatch) {
      const content = expectDefined(boldMatch[1] ?? boldMatch[2], "bold body capture");
      result.push({ bold: parseInlineMarkdown(content) });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italics: *text* or _text_ (but not inside words for _)
    const italicsMatch = remaining.match(/^\*([^*]+?)\*|^_([^_]+?)_(?![a-zA-Z0-9])/);
    if (italicsMatch) {
      const content = expectDefined(italicsMatch[1] ?? italicsMatch[2], "italic body capture");
      result.push({ italics: parseInlineMarkdown(content) });
      remaining = remaining.slice(italicsMatch[0].length);
      continue;
    }

    // Strikethrough: ~~text~~
    const strikeMatch = remaining.match(/^~~(.+?)~~/);
    if (strikeMatch) {
      result.push({
        strike: parseInlineMarkdown(expectDefined(strikeMatch[1], "strikethrough body capture")),
      });
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      result.push({ "inline-code": expectDefined(codeMatch[1], "inline code capture") });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Links: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      result.push({
        link: {
          href: expectDefined(linkMatch[2], "link URL capture"),
          content: expectDefined(linkMatch[1], "link text capture"),
        },
      });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Markdown images: ![alt](url)
    const imageMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imageMatch) {
      // Return a special marker that will be hoisted to a block
      result.push({
        __image: {
          src: expectDefined(imageMatch[2], "image URL capture"),
          alt: expectDefined(imageMatch[1], "image alt capture"),
        },
      } as unknown as StoryInline);
      remaining = remaining.slice(imageMatch[0].length);
      continue;
    }

    // Plain URL detection
    const urlMatch = remaining.match(/^(https?:\/\/[^\s<>"\]]+)/);
    if (urlMatch) {
      const url = expectDefined(urlMatch[1], "plain URL capture");
      result.push({ link: { href: url, content: url } });
      remaining = remaining.slice(urlMatch[0].length);
      continue;
    }

    // Hashtags: #tag - disabled, chat UI doesn't render them
    // const tagMatch = remaining.match(/^#([a-zA-Z][a-zA-Z0-9_-]*)/);
    // if (tagMatch) {
    //   result.push({ tag: tagMatch[1] });
    //   remaining = remaining.slice(tagMatch[0].length);
    //   continue;
    // }

    // Plain text: consume until next special character or URL start
    // Exclude : and / to allow URL detection to work (stops before https://)
    const plainMatch = remaining.match(/^[^*_`~[#\n:/]+/);
    if (plainMatch) {
      result.push(expectDefined(plainMatch[0], "plain text match"));
      remaining = remaining.slice(plainMatch[0].length);
      continue;
    }

    // Single special char that didn't match a pattern
    result.push(remaining.charAt(0));
    remaining = remaining.slice(1);
  }

  // Merge adjacent strings
  return mergeAdjacentStrings(result);
}

function headingTag(marker: string): "h1" | "h2" | "h3" | "h4" | "h5" | "h6" {
  switch (marker.length) {
    case 1:
      return "h1";
    case 2:
      return "h2";
    case 3:
      return "h3";
    case 4:
      return "h4";
    case 5:
      return "h5";
    default:
      return "h6";
  }
}

/**
 * Merge adjacent string elements in an inline array
 */
function mergeAdjacentStrings(inlines: StoryInline[]): StoryInline[] {
  const result: StoryInline[] = [];
  for (const item of inlines) {
    const last = result.at(-1);
    if (typeof item === "string" && typeof last === "string") {
      result.splice(-1, 1, last + item);
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * Create an image block
 */
export function createImageBlock(src: string, alt = "", height = 0, width = 0): StoryVerse {
  return {
    block: {
      image: { src, height, width, alt },
    },
  };
}

/**
 * Check if URL looks like an image
 */
export function isImageUrl(url: string): boolean {
  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i;
  let path = url.split(/[?#]/, 1)[0] ?? url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep existing non-URL path handling.
  }
  return imageExtensions.test(path);
}

/**
 * Process inlines and extract any image markers into blocks
 */
function processInlinesForImages(inlines: StoryInline[]): {
  inlines: StoryInline[];
  imageBlocks: StoryVerse[];
} {
  const cleanInlines: StoryInline[] = [];
  const imageBlocks: StoryVerse[] = [];

  for (const inline of inlines) {
    if (typeof inline === "object" && "__image" in inline) {
      const img = (inline as unknown as { __image: { src: string; alt: string } })["__image"];
      imageBlocks.push(createImageBlock(img.src, img.alt));
    } else {
      cleanInlines.push(inline);
    }
  }

  return { inlines: cleanInlines, imageBlocks };
}

function parseInlinesWithBreaks(text: string): {
  inlines: StoryInline[];
  imageBlocks: StoryVerse[];
} {
  const withBreaks: StoryInline[] = [];
  for (const inline of parseInlineMarkdown(text)) {
    if (typeof inline !== "string" || !inline.includes("\n")) {
      withBreaks.push(inline);
      continue;
    }
    const parts = inline.split("\n");
    for (const [index, part] of parts.entries()) {
      if (part) {
        withBreaks.push(part);
      }
      if (index < parts.length - 1) {
        withBreaks.push({ break: null });
      }
    }
  }
  return processInlinesForImages(withBreaks);
}

type MarkdownListItem = {
  indent: number;
  contentIndent: number;
  markerType: Exclude<StoryListType, "tasklist">;
  markerKey: string;
  orderedStart?: number;
  hasSourceBody: boolean;
  hasBlockBody: boolean;
  hasImages: boolean;
  content: StoryInline[];
  checked?: boolean;
};

const MARKDOWN_LIST_ITEM_PATTERN = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;

function isMarkdownThematicBreak(text: string): boolean {
  return /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(text);
}

function startsListBlockSyntax(text: string): boolean {
  return (
    /^(`{3,}|~{3,})/.test(text) ||
    text.startsWith(">") ||
    /^#{1,6}(?:\s|$)/.test(text) ||
    isMarkdownThematicBreak(text) ||
    /^(?:[-+*]|\d{1,9}[.)])(?:\s|$)/.test(text)
  );
}

function whitespaceColumns(text: string, startColumn = 0): number {
  let column = startColumn;
  for (const char of text) {
    column += char === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

function parseMarkdownListItem(line: string): MarkdownListItem | undefined {
  const match = line.match(MARKDOWN_LIST_ITEM_PATTERN);
  if (!match || isMarkdownThematicBreak(line.trim())) {
    return undefined;
  }

  const marker = expectDefined(match[2], "list marker capture");
  const markerType = /^\d/.test(marker) ? "ordered" : "unordered";
  const padding = match[3] ?? " ";
  const sourceBody = match[4] ?? "";
  let body = sourceBody;
  const task = body.match(/^\[([\t xX])\](?:\s+(.*))?$/);
  let checked: boolean | undefined;
  if (task) {
    checked = expectDefined(task[1], "task state capture").toLowerCase() === "x";
    body = task[2] ?? "";
  }

  const { inlines, imageBlocks } = parseInlinesWithBreaks(body);
  const indent = whitespaceColumns(expectDefined(match[1], "list indent capture"));
  const markerEnd = indent + marker.length;
  const contentIndent = whitespaceColumns(padding, markerEnd);
  return {
    indent,
    contentIndent,
    markerType,
    markerKey: markerType === "ordered" ? marker.slice(-1) : marker,
    ...(markerType === "ordered" ? { orderedStart: Number.parseInt(marker, 10) } : {}),
    hasSourceBody: sourceBody.length > 0,
    hasBlockBody:
      sourceBody.length > 0 &&
      (contentIndent - markerEnd >= 5 || startsListBlockSyntax(sourceBody)),
    hasImages: imageBlocks.length > 0,
    content: inlines,
    ...(checked === undefined ? {} : { checked }),
  };
}

function lineIndent(line: string): number {
  return whitespaceColumns(line.match(/^[ \t]*/)?.[0] ?? "");
}

function startsTopLevelStoryBlock(line: string): boolean {
  return (
    /^(#{1,6})\s+(.+)$/.test(line) ||
    line.startsWith("```") ||
    line.startsWith("> ") ||
    /^(-{3,}|\*{3,})$/.test(line.trim())
  );
}

function listItemContent(item: MarkdownListItem): StoryInline[] {
  return item.checked === undefined
    ? item.content
    : [{ task: { checked: item.checked, content: item.content } }];
}

function canInterruptWithListItem(item: MarkdownListItem): boolean {
  return item.hasSourceBody && (item.markerType === "unordered" || item.orderedStart === 1);
}

function parseListingBlock(
  lines: string[],
  startIndex: number,
): { verses: StoryVerse[]; nextIndex: number } | undefined {
  const first = parseMarkdownListItem(expectDefined(lines[startIndex], "list start line"));
  if (!first) {
    return undefined;
  }
  if (first.indent >= 4 || (first.markerType === "ordered" && first.orderedStart !== 1)) {
    return undefined;
  }

  function parseLevel(
    index: number,
    minIndent: number,
    markerKey: string,
  ): { type: StoryListType; items: StoryListing[]; nextIndex: number } | undefined {
    const firstItem = parseMarkdownListItem(expectDefined(lines[index], "list level start"));
    if (
      !firstItem ||
      firstItem.indent < minIndent ||
      firstItem.indent > minIndent + 3 ||
      (firstItem.markerType === "ordered" && firstItem.orderedStart !== 1)
    ) {
      return undefined;
    }

    const items: StoryListing[] = [];
    const markerType = firstItem.markerType;
    let allTasks = true;
    let cursor = index;
    while (cursor < lines.length) {
      const item = parseMarkdownListItem(expectDefined(lines[cursor], "list line index"));
      if (
        !item ||
        item.indent < minIndent ||
        item.indent > minIndent + 3 ||
        item.markerKey !== markerKey
      ) {
        break;
      }
      if (item.hasBlockBody || item.hasImages) {
        return undefined;
      }

      allTasks &&= item.checked !== undefined;
      cursor++;

      while (cursor < lines.length) {
        const continuationLine = expectDefined(lines[cursor], "continuation line index");
        if (continuationLine.trim() === "") {
          let nextContentIndex = cursor + 1;
          while (lines[nextContentIndex]?.trim() === "") {
            nextContentIndex++;
          }
          const nextContent = lines.at(nextContentIndex);
          if (nextContent === undefined) {
            break;
          }
          const nextListItem = parseMarkdownListItem(nextContent);
          if (nextListItem) {
            cursor = nextContentIndex;
            continue;
          }
          if (lineIndent(nextContent) > item.indent) {
            return undefined;
          }
          break;
        }

        if (parseMarkdownListItem(continuationLine)) {
          break;
        }
        if (
          lineIndent(continuationLine) <= item.indent &&
          startsTopLevelStoryBlock(continuationLine)
        ) {
          break;
        }
        return undefined;
      }

      const childLine = lines.at(cursor);
      const child = childLine === undefined ? undefined : parseMarkdownListItem(childLine);
      const childIsSibling =
        child !== undefined &&
        child.markerKey === markerKey &&
        child.indent >= minIndent &&
        child.indent <= minIndent + 3 &&
        child.indent < item.contentIndent;
      if (childIsSibling) {
        items.push({ item: listItemContent(item) });
        continue;
      }
      if (child && child.markerKey !== markerKey && !canInterruptWithListItem(child)) {
        return undefined;
      }
      if (child && child.indent >= item.contentIndent && !canInterruptWithListItem(child)) {
        return undefined;
      }
      if (child && child.indent > item.indent) {
        if (child.indent < item.contentIndent || child.indent >= item.contentIndent + 4) {
          return undefined;
        }
        const nested = parseLevel(cursor, item.contentIndent, child.markerKey);
        if (!nested) {
          return undefined;
        }
        // A nested node stores its parent item's contents, while its type controls
        // the child markers. Preserve that type when list styles change by depth.
        items.push({
          list: {
            type: nested.type,
            contents: listItemContent(item),
            items: nested.items,
          },
        });
        cursor = nested.nextIndex;
        const strandedChildLine = lines.at(cursor);
        const strandedChild =
          strandedChildLine === undefined ? undefined : parseMarkdownListItem(strandedChildLine);
        const strandedIsSibling =
          strandedChild !== undefined &&
          strandedChild.markerKey === markerKey &&
          strandedChild.indent >= minIndent &&
          strandedChild.indent <= minIndent + 3 &&
          strandedChild.indent < item.contentIndent;
        if (!strandedIsSibling && strandedChild && strandedChild.indent > item.indent) {
          return undefined;
        }
        let trailingIndex = cursor;
        while (lines[trailingIndex]?.trim() === "") {
          trailingIndex++;
        }
        const trailingLine = lines.at(trailingIndex);
        if (
          trailingLine !== undefined &&
          !parseMarkdownListItem(trailingLine) &&
          lineIndent(trailingLine) > item.indent
        ) {
          return undefined;
        }
      } else {
        items.push({ item: listItemContent(item) });
      }
    }
    return {
      type: markerType === "unordered" && allTasks && items.length > 0 ? "tasklist" : markerType,
      items,
      nextIndex: cursor,
    };
  }

  const parsed = parseLevel(startIndex, 0, first.markerKey);
  if (!parsed) {
    return undefined;
  }
  return {
    verses: [
      {
        block: {
          listing: {
            list: { type: parsed.type, contents: [], items: parsed.items },
          },
        },
      },
    ],
    nextIndex: parsed.nextIndex,
  };
}

/**
 * Convert markdown text to Tlon story format
 */
export function markdownToStory(markdown: string): Story {
  const story: Story = [];
  const lines = markdown.split("\n");
  let i = 0;
  let preservedListMarkerKey: string | undefined;

  while (i < lines.length) {
    const line = expectDefined(lines[i], "Markdown line index is in bounds");
    const lineListItem = parseMarkdownListItem(line);
    if (
      line.trim() !== "" &&
      preservedListMarkerKey !== undefined &&
      (lineListItem !== undefined
        ? lineListItem.markerKey !== preservedListMarkerKey
        : lineIndent(line) === 0)
    ) {
      preservedListMarkerKey = undefined;
    }

    // Code block: ```lang\ncode\n```
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plaintext";
      const codeLines: string[] = [];
      i++;
      while (true) {
        const codeLine = lines.at(i);
        if (codeLine === undefined || codeLine.startsWith("```")) {
          break;
        }
        codeLines.push(codeLine);
        i++;
      }
      story.push({
        block: {
          code: {
            code: codeLines.join("\n"),
            lang,
          },
        },
      });
      i++; // skip closing ```
      continue;
    }

    // Headers: # H1, ## H2, etc.
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const tag = headingTag(expectDefined(headerMatch[1], "header marker capture"));
      story.push({
        block: {
          header: {
            tag,
            content: parseInlineMarkdown(expectDefined(headerMatch[2], "header body capture")),
          },
        },
      });
      i++;
      continue;
    }

    // Horizontal rule: --- or ***
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      story.push({ block: { rule: null } });
      i++;
      continue;
    }

    // Blockquote: > text
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (true) {
        const quoteLine = lines.at(i);
        if (quoteLine === undefined || !quoteLine.startsWith("> ")) {
          break;
        }
        quoteLines.push(quoteLine.slice(2));
        i++;
      }
      const quoteText = quoteLines.join("\n");
      story.push({
        inline: [{ blockquote: parseInlineMarkdown(quoteText) }],
      });
      continue;
    }

    // Empty line - skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    const preservesLooseList =
      preservedListMarkerKey !== undefined && lineListItem?.markerKey === preservedListMarkerKey;
    const listing = preservesLooseList ? undefined : parseListingBlock(lines, i);
    if (listing) {
      story.push(...listing.verses);
      i = listing.nextIndex;
      preservedListMarkerKey = undefined;
      continue;
    }
    if (lineListItem) {
      preservedListMarkerKey = lineListItem.markerKey;
    }

    // If a list-like block cannot be represented without losing Markdown semantics,
    // preserve the whole block in the existing plain paragraph path.
    let preserveListText = preservesLooseList || MARKDOWN_LIST_ITEM_PATTERN.test(line);

    // Regular paragraph - collect consecutive non-empty lines
    const paragraphLines: string[] = [];
    while (true) {
      const paragraphLine = lines.at(i);
      if (
        paragraphLine === undefined ||
        paragraphLine.trim() === "" ||
        paragraphLine.startsWith("#") ||
        paragraphLine.startsWith("```") ||
        paragraphLine.startsWith("> ") ||
        /^(-{3,}|\*{3,})$/.test(paragraphLine.trim())
      ) {
        break;
      }

      if (!preserveListText && MARKDOWN_LIST_ITEM_PATTERN.test(paragraphLine)) {
        const item = parseMarkdownListItem(paragraphLine);
        const candidate = parseListingBlock(lines, i);
        if (item?.hasSourceBody === true && candidate) {
          break;
        }
        // Once one candidate is not safely representable, keep the remaining
        // paragraph byte-compatible instead of repeatedly reparsing its suffixes.
        preserveListText = true;
        if (item) {
          preservedListMarkerKey = item.markerKey;
        }
      }
      paragraphLines.push(paragraphLine);
      i++;
    }

    if (paragraphLines.length > 0) {
      const { inlines, imageBlocks } = parseInlinesWithBreaks(paragraphLines.join("\n"));

      if (inlines.length > 0) {
        story.push({ inline: inlines });
      }
      story.push(...imageBlocks);
    }
  }

  return story;
}
