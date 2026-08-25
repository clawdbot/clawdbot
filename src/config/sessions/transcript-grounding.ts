import type { ManagedMediaGrounding } from "../../media/media-reference.js";

const UNGROUNDED_MEDIA_PLACEHOLDER = "[unverified media reference removed]";

const TOKEN_BOUNDARY = /[\s"'`<>{}()[\]]/u;
const PUNCTUATION = /[.,;:!?\u2012-\u2015\u2026]/u;
const REMOTE_URI = /[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+/iu;

function endsReference(text: string, end: number): boolean {
  let cursor = end;
  let char = text.charAt(cursor);
  if (!char || TOKEN_BOUNDARY.test(char)) {
    return true;
  }
  if (!PUNCTUATION.test(char)) {
    return false;
  }
  while (PUNCTUATION.test((char = text.charAt(++cursor)))) {}
  return !char || TOKEN_BOUNDARY.test(char);
}

export function invalidateUngroundedMediaPrefixes(
  text: string,
  grounding: ManagedMediaGrounding,
): string {
  if (!text || grounding.rootAliases.length === 0) {
    return text;
  }
  let cursor = 0,
    tokenStart = 0;
  const output: string[] = [];
  const comparisonText = grounding.caseInsensitivePaths ? text.toLowerCase() : text;
  const comparable = (alias: string) =>
    grounding.caseInsensitivePaths ? alias.toLowerCase() : alias;
  while (cursor < text.length) {
    const root = grounding.rootAliases.find((alias) =>
      comparisonText.startsWith(comparable(alias), cursor),
    );
    if (
      !root ||
      /[\w/\\]/u.test(text.charAt(cursor - 1)) ||
      REMOTE_URI.test(text.slice(tokenStart, cursor)) ||
      (!["", "/", "\\"].includes(text.charAt(cursor + root.length)) &&
        !endsReference(text, cursor + root.length))
    ) {
      const char = text.charAt(cursor++);
      output.push(char);
      tokenStart = TOKEN_BOUNDARY.test(char) ? cursor : tokenStart;
      continue;
    }
    const allowed = grounding.authorizedAliases.find(
      (alias) =>
        comparisonText.startsWith(comparable(alias), cursor) &&
        endsReference(text, cursor + alias.length),
    );
    if (allowed) {
      output.push(text.slice(cursor, cursor + allowed.length));
      cursor += allowed.length;
    } else {
      output.push(UNGROUNDED_MEDIA_PLACEHOLDER);
      cursor += root.length;
    }
  }
  return output.join("");
}
