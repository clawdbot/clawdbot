import { html, type TemplateResult } from "lit";

// Display-only linker for Workboard notes and comments.
// Stored card text is never rewritten.
//
// Recognized forms:
// - Markdown: [label](http://…) or [label](https://…)
// - Bare http:// and https:// URLs
//
// Everything else stays literal, including other Markdown, HTML, ftp/mailto/
// javascript/data URLs, and www. hosts without a scheme. Balanced parentheses
// inside a destination are kept. Trailing .,;:!? on a bare URL is kept as
// surrounding text.

const TRAILING_BARE_URL_PUNCTUATION = /[.,;:!?]+$/;

export type LinkedPlainTextNode = string | TemplateResult;

type ParsedLink = {
  href: string;
  label: string;
  end: number;
};

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function httpSchemeLength(text: string, start: number): number {
  if (text.startsWith("https://", start)) {
    return "https://".length;
  }
  if (text.startsWith("http://", start)) {
    return "http://".length;
  }
  return 0;
}

function isUrlStopCharacter(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "<" ||
    char === ">" ||
    char === '"' ||
    char === "'"
  );
}

function readBalancedHttpUrl(text: string, start: number): { href: string; end: number } | null {
  const schemeLength = httpSchemeLength(text, start);
  if (schemeLength === 0) {
    return null;
  }
  let index = start + schemeLength;
  let depth = 0;
  while (index < text.length) {
    const char = text[index];
    if (!char || isUrlStopCharacter(char)) {
      break;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) {
        break;
      }
      depth -= 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  if (index <= start + schemeLength) {
    return null;
  }
  return {
    href: text.slice(start, index),
    end: index,
  };
}

function tryParseMarkdownLink(text: string, start: number): ParsedLink | null {
  if (text[start] !== "[") {
    return null;
  }
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd < 0) {
    return null;
  }
  const label = text.slice(start + 1, labelEnd);
  if (!label || label.includes("[") || label.includes("\n")) {
    return null;
  }
  const urlStart = labelEnd + 2;
  const destination = readBalancedHttpUrl(text, urlStart);
  if (!destination || text[destination.end] !== ")") {
    return null;
  }
  if (!isSafeHttpUrl(destination.href)) {
    return null;
  }
  return {
    href: destination.href,
    label,
    end: destination.end + 1,
  };
}

function tryParseBareUrl(text: string, start: number): ParsedLink | null {
  const destination = readBalancedHttpUrl(text, start);
  if (!destination) {
    return null;
  }
  const trailing = destination.href.match(TRAILING_BARE_URL_PUNCTUATION)?.[0] ?? "";
  const href = trailing ? destination.href.slice(0, -trailing.length) : destination.href;
  if (!isSafeHttpUrl(href)) {
    return null;
  }
  return {
    href,
    label: href,
    end: start + href.length,
  };
}

function stopCardSurfaceActivation(event: Event) {
  event.stopPropagation();
}

function renderExternalLink(href: string, label: string): TemplateResult {
  return html`<a
    href=${href}
    target="_blank"
    rel="noopener noreferrer"
    @click=${stopCardSurfaceActivation}
    @keydown=${stopCardSurfaceActivation}
    >${label}</a
  >`;
}

export function renderLinkedPlainText(text: string): LinkedPlainTextNode[] {
  if (!text) {
    return [text];
  }
  const nodes: LinkedPlainTextNode[] = [];
  let index = 0;
  let literalStart = 0;

  const flushLiteral = (end: number) => {
    if (end > literalStart) {
      nodes.push(text.slice(literalStart, end));
    }
  };

  while (index < text.length) {
    const markdown = tryParseMarkdownLink(text, index);
    if (markdown) {
      flushLiteral(index);
      nodes.push(renderExternalLink(markdown.href, markdown.label));
      index = markdown.end;
      literalStart = index;
      continue;
    }
    const bareUrl = tryParseBareUrl(text, index);
    if (bareUrl) {
      flushLiteral(index);
      nodes.push(renderExternalLink(bareUrl.href, bareUrl.href));
      index = bareUrl.end;
      literalStart = index;
      continue;
    }
    index += 1;
  }
  flushLiteral(text.length);
  return nodes.length > 0 ? nodes : [text];
}
