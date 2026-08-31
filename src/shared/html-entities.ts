import { decodeHTMLStrict } from "entities";

const HTML_ENTITY_RE = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]+));/gi;
const LEGACY_CASE_INSENSITIVE_ENTITY_NAME_RE = /^(?:amp|quot|apos|lt|gt)$/i;

function isUnicodeScalar(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= 0x10ffff &&
    (codePoint < 0xd800 || codePoint > 0xdfff)
  );
}

/** Decodes semicolon-terminated HTML5 named and numeric entities exactly once. */
export function decodeHtmlEntities(html: string): string {
  if (!html.includes("&")) {
    return html;
  }

  // Decode only references present in the original input so decoded ampersands cannot trigger a
  // second pass. Keep OpenClaw's direct numeric scalar mapping and legacy mixed-case XML names.
  return html.replace(
    HTML_ENTITY_RE,
    (entity, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (hex === undefined && decimal === undefined) {
        const decodedEntity = decodeHTMLStrict(entity);
        return decodedEntity === entity && LEGACY_CASE_INSENSITIVE_ENTITY_NAME_RE.test(name ?? "")
          ? decodeHTMLStrict(entity.toLowerCase())
          : decodedEntity;
      }

      const codePoint =
        hex === undefined ? Number.parseInt(decimal ?? "", 10) : Number.parseInt(hex, 16);
      return isUnicodeScalar(codePoint) ? String.fromCodePoint(codePoint) : entity;
    },
  );
}
