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
  | { break: null }
  | { tag: string };

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
        type: "ordered" | "unordered" | "tasklist";
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

/**
 * Convert markdown text to Tlon story format
 */
export function markdownToStory(markdown: string): Story {
  const story: Story = [];
  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = expectDefined(lines[i], "Markdown line index is in bounds");

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
      paragraphLines.push(paragraphLine);
      i++;
    }

    if (paragraphLines.length > 0) {
      const paragraphText = paragraphLines.join("\n");
      // Convert newlines within paragraph to break elements
      const inlines = parseInlineMarkdown(paragraphText);
      // Replace \n in strings with break elements
      const withBreaks: StoryInline[] = [];
      for (const inline of inlines) {
        if (typeof inline === "string" && inline.includes("\n")) {
          const parts = inline.split("\n");
          for (const [j, part] of parts.entries()) {
            if (part) {
              withBreaks.push(part);
            }
            if (j < parts.length - 1) {
              withBreaks.push({ break: null });
            }
          }
        } else {
          withBreaks.push(inline);
        }
      }

      // Extract any images from inlines and add as separate blocks
      const { inlines: cleanInlines, imageBlocks } = processInlinesForImages(withBreaks);

      if (cleanInlines.length > 0) {
        story.push({ inline: cleanInlines });
      }
      story.push(...imageBlocks);
    }
  }

  return story;
}
