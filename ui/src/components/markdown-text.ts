const BLOCK_ART_LINE_RE = /^[\t \u00a0▀▄█]+$/u;
const BLOCK_ART_GLYPH_RE = /[▀▄█]/u;

export function escapeMarkdownHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeMarkdownLineBreaks(value: string): string {
  return value.replace(/\r\n?|[\u2028\u2029]/g, "\n");
}

export function isMarkdownBlockArtText(value: string): boolean {
  const lines = normalizeMarkdownLineBreaks(value).split("\n");
  const artLines = lines.filter((line) => line.trim().length > 0);
  if (artLines.length < 2) {
    return false;
  }

  // QR generators commonly use spaces plus upper/lower/full block glyphs.
  // Require multiple glyph-only lines so ordinary prose with a stray block character stays markdown.
  let glyphCount = 0;
  for (const line of artLines) {
    if (!BLOCK_ART_LINE_RE.test(line) || !BLOCK_ART_GLYPH_RE.test(line)) {
      return false;
    }
    glyphCount += Array.from(line).filter((char) => BLOCK_ART_GLYPH_RE.test(char)).length;
  }
  return glyphCount >= 8;
}
