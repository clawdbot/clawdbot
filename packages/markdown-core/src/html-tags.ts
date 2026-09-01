// markdown-it 15 keeps its quote-aware HTML grammar private; both parser consumers share its exact grammar here.
const MARKDOWN_HTML_TAG_RE =
  // oxlint-disable-next-line eslint/no-control-regex -- Preserve markdown-it's exact ASCII control-byte exclusion.
  /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\s*=\s*(?:[^"'=<>`\x00-\x20]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)/;

export function matchMarkdownHtmlTag(source: string): string | undefined {
  return MARKDOWN_HTML_TAG_RE.exec(source)?.[0];
}

type HtmlTagToken = {
  raw: string;
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
};

function htmlTagName(rawTag: string, closing: boolean): string {
  let end = closing ? 2 : 1;
  while (end < rawTag.length) {
    const code = rawTag.charCodeAt(end);
    const isAsciiLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    if (!isAsciiLetter && !isDigit && code !== 45) {
      break;
    }
    end += 1;
  }
  return rawTag.slice(closing ? 2 : 1, end).toLowerCase();
}

/** Tokenizes valid open/close HTML tags with Markdown-It's quote-aware grammar. */
export function* tokenizeHtmlTags(html: string): Generator<HtmlTagToken> {
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) {
      return;
    }
    const raw = matchMarkdownHtmlTag(html.slice(start));
    if (!raw) {
      cursor = start + 1;
      continue;
    }
    const closing = raw.startsWith("</");
    const end = start + raw.length;
    const name = htmlTagName(raw, closing);
    // Consume comments, declarations, CDATA, and processing instructions as
    // whole Markdown-It HTML constructs without exposing tag-shaped contents.
    if (!name) {
      cursor = end;
      continue;
    }
    yield {
      raw,
      start,
      end,
      name,
      closing,
      selfClosing: !closing && raw.trimEnd().endsWith("/>"),
    };
    cursor = end;
  }
}
