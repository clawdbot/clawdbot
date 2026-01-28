/**
 * Convert standard Markdown to RingCentral Mini-Markdown format.
 * 
 * RingCentral Mini-Markdown differences:
 * - `_text_` = underline (not italic)
 * - `*text*` = italic
 * - `**text**` = bold
 * - `[text](url)` = link
 * - `> quote` = blockquote
 * - `* item` = bullet list
 * 
 * Not supported: strikethrough (~~), code blocks (```), headings (#), etc.
 */

/**
 * Convert standard markdown to RingCentral mini-markdown
 */
export function toRingCentralMarkdown(text: string): string {
  let result = text;

  // 1. Preserve links - temporarily replace them to avoid modifying URLs
  const linkPlaceholders: string[] = [];
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match) => {
    const idx = linkPlaceholders.length;
    linkPlaceholders.push(match);
    return `\x00LINK_${idx}\x00`;
  });

  // 2. Convert __text__ (some markdown bold) to **text**
  result = result.replace(/__([^_]+)__/g, "**$1**");

  // 3. Convert single _text_ to *text* for italic
  //    Match _text_ but not inside words (e.g., snake_case_name)
  result = result.replace(/(?<=^|[\s\p{P}])_([^_\n]+)_(?=$|[\s\p{P}])/gu, "*$1*");

  // 4. Remove strikethrough ~~text~~ (not supported)
  result = result.replace(/~~([^~]+)~~/g, "$1");

  // 5. Convert code blocks to plain text (not well supported)
  // Remove triple backtick code blocks
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    // Extract content without the backticks and language identifier
    const content = match.replace(/```\w*\n?/, "").replace(/\n?```$/, "");
    return content;
  });

  // Convert inline code `text` to plain text
  result = result.replace(/`([^`]+)`/g, "$1");

  // 6. Convert headings to bold (# Heading -> **Heading**)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

  // 7. Convert horizontal rules (---, ***, ___) to simple separator
  result = result.replace(/^[-*_]{3,}$/gm, "---");

  // 8. Normalize bullet lists (-, +, *) to * for consistency
  result = result.replace(/^(\s*)[-+]\s+/gm, "$1* ");

  // 9. Restore links
  result = result.replace(/\x00LINK_(\d+)\x00/g, (_match, idx) => {
    return linkPlaceholders[Number(idx)];
  });

  // 10. Keep numbered lists as-is (1. item)
  // 11. Keep blockquotes as-is (> quote)

  return result;
}

/**
 * Check if text contains markdown that needs conversion
 */
export function needsMarkdownConversion(text: string): boolean {
  // Check for patterns that need conversion
  return (
    // Single underscore italic
    /(?<![\\*_])_[^_\n]+_(?![_])/.test(text) ||
    // Strikethrough
    /~~[^~]+~~/.test(text) ||
    // Code blocks
    /```[\s\S]*?```/.test(text) ||
    // Inline code
    /`[^`]+`/.test(text) ||
    // Headings
    /^#{1,6}\s+.+$/m.test(text)
  );
}

/**
 * Check if text contains code blocks that would benefit from Adaptive Card formatting
 */
export function hasCodeBlocks(text: string): boolean {
  return /```[\s\S]*?```/.test(text);
}

/**
 * Convert markdown text to an Adaptive Card structure.
 * This preserves code blocks with proper formatting.
 */
export function markdownToAdaptiveCard(text: string): {
  type: "AdaptiveCard";
  $schema: string;
  version: string;
  body: Array<{ type: string; text?: string; wrap?: boolean; fontType?: string; size?: string; weight?: string }>;
} {
  const body: Array<{ type: string; text?: string; wrap?: boolean; fontType?: string; size?: string; weight?: string }> = [];
  
  // Split by code blocks
  const parts = text.split(/(```[\s\S]*?```)/g);
  
  for (const part of parts) {
    if (!part.trim()) continue;
    
    if (part.startsWith("```")) {
      // Extract language and code
      const match = part.match(/```(\w*)\n?([\s\S]*?)\n?```/);
      if (match) {
        const [, , code] = match;
        // Add code block with monospace font
        body.push({
          type: "TextBlock",
          text: code.trim(),
          wrap: true,
          fontType: "Monospace",
        });
      }
    } else {
      // Regular text - convert markdown
      const converted = toRingCentralMarkdown(part.trim());
      if (converted) {
        // Check if it's a heading (starts with **)
        const headingMatch = converted.match(/^\*\*(.+)\*\*$/);
        if (headingMatch && !converted.includes("\n")) {
          body.push({
            type: "TextBlock",
            text: headingMatch[1],
            wrap: true,
            size: "Medium",
            weight: "Bolder",
          });
        } else {
          body.push({
            type: "TextBlock",
            text: converted,
            wrap: true,
          });
        }
      }
    }
  }

  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.3",
    body,
  };
}
