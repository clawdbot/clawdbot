/**
 * Minimal HTML entity decoding helpers.
 *
 * Syntax highlighting and terminal renderers use this to decode the small
 * entity subset emitted by trusted HTML producers without parsing full HTML.
 */
/** Decoded entity text plus the source length consumed from the input. */
export interface DecodedHtmlEntity {
  text: string;
  length: number;
}

function decodeCodePoint(codePoint: number): string | undefined {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return undefined;
  }
  return String.fromCodePoint(codePoint);
}

/** Decodes a named or numeric HTML entity without the surrounding `&`/`;`. */
export function decodeHtmlEntity(entity: string): string | undefined {
  switch (entity) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
  }

  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    return decodeCodePoint(Number.parseInt(entity.slice(2), 16));
  }

  if (entity.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(entity.slice(1), 10));
  }

  return undefined;
}

/** Decodes an entity starting at `index` in an HTML string. */
export function decodeHtmlEntityAt(html: string, index: number): DecodedHtmlEntity | undefined {
  const semicolonIndex = html.indexOf(";", index + 1);
  if (semicolonIndex === -1 || semicolonIndex - index > 16) {
    return undefined;
  }

  const entity = html.slice(index + 1, semicolonIndex);
  const decoded = decodeHtmlEntity(entity);
  if (decoded === undefined) {
    return undefined;
  }

  return { text: decoded, length: semicolonIndex - index + 1 };
}
