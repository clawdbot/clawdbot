import { html, type TemplateResult } from "lit";

const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCTUATION = /[),.;:!?]+$/;

export type LinkedPlainTextNode = string | TemplateResult;

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function trimBareUrl(value: string): { href: string; trailing: string } {
  const trailing = value.match(TRAILING_PUNCTUATION)?.[0] ?? "";
  return {
    href: trailing ? value.slice(0, -trailing.length) : value,
    trailing,
  };
}

function renderExternalLink(href: string, label: string): TemplateResult {
  return html`<a href=${href} target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export function renderLinkedPlainText(text: string): LinkedPlainTextNode[] {
  if (!text) {
    return [text];
  }
  const nodes: LinkedPlainTextNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      nodes.push(text.slice(cursor, index));
    }
    const markdownLabel = match[1];
    const markdownHref = match[2];
    const bareUrl = match[3];
    if (markdownLabel && markdownHref && isSafeHttpUrl(markdownHref)) {
      nodes.push(renderExternalLink(markdownHref, markdownLabel));
    } else if (bareUrl) {
      const { href, trailing } = trimBareUrl(bareUrl);
      if (isSafeHttpUrl(href)) {
        nodes.push(renderExternalLink(href, href));
        if (trailing) {
          nodes.push(trailing);
        }
      } else {
        nodes.push(match[0]);
      }
    } else {
      nodes.push(match[0]);
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes.length > 0 ? nodes : [text];
}
