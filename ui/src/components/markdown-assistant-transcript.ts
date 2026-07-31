import type MarkdownIt from "markdown-it";
import {
  ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE,
  markdownItAssistantTranscriptRoles,
  type AssistantTranscriptRoleImageMeta,
} from "../../../packages/markdown-core/src/assistant-transcript.js";

const ROLE_MARKER_OPEN = '<code class="assistant-transcript-role">';
const ROLE_MARKER_CLOSE = "</code>";

function renderAssistantTranscriptRoleMarker(
  text: string,
  escapeHtml: (value: string) => string,
): string {
  return `${ROLE_MARKER_OPEN}${escapeHtml(text)}${ROLE_MARKER_CLOSE}`;
}

const linkedImageIndicesByTokens = new WeakMap<readonly { type: string }[], ReadonlySet<number>>();

function linkedImageIndices(tokens: readonly { type: string }[]): ReadonlySet<number> {
  const cached = linkedImageIndicesByTokens.get(tokens);
  if (cached) {
    return cached;
  }
  const linked = new Set<number>();
  let linkDepth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const tokenType = tokens[index]?.type;
    if (tokenType === "link_open") {
      linkDepth += 1;
    } else if (tokenType === "link_close") {
      linkDepth = Math.max(0, linkDepth - 1);
    } else if (tokenType === "image" && linkDepth > 0) {
      linked.add(index);
    }
  }
  linkedImageIndicesByTokens.set(tokens, linked);
  return linked;
}

function isImageWithinLink(tokens: readonly { type: string }[], index: number): boolean {
  return linkedImageIndices(tokens).has(index);
}

function renderAssistantTranscriptRoleImageLabel(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
  escapeHtml: (value: string) => string,
): string {
  let rendered = "";
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    rendered += escapeHtml(text.slice(cursor, start));
    if (end > start) {
      rendered += renderAssistantTranscriptRoleMarker(text.slice(start, end), escapeHtml);
    }
    cursor = end;
  }
  return rendered + escapeHtml(text.slice(cursor));
}

export function installAssistantTranscriptRoleMarkdown(
  md: MarkdownIt,
  escapeHtml: (value: string) => string,
): void {
  md.use(markdownItAssistantTranscriptRoles, {
    // The task-list plugin injects a trusted checkbox HTML token. It is visible
    // UI structure, not text before the list item's semantic first character.
    isStructuralHtmlInline: (token) => token.meta?.taskListPlugin === true,
  });
  md.renderer.rules[ASSISTANT_TRANSCRIPT_ROLE_NODE_TYPE] = (tokens, index) => {
    const token = tokens[index];
    return token ? renderAssistantTranscriptRoleMarker(token.content, escapeHtml) : "";
  };
}

export function installAssistantTranscriptRoleImageRenderer(
  md: MarkdownIt,
  options: {
    escapeHtml: (value: string) => string;
    isInlineDataImage: (src: string) => boolean;
    normalizeLabel: (value: string) => string;
    assistantLabel: () => string;
    openImageLabel: (alt: string, hasAlt: boolean) => string;
    interactiveImages: (env: unknown) => boolean;
  },
): void {
  md.renderer.rules.image = (tokens, index, _rendererOptions, env) => {
    const token = tokens[index];
    if (!token) {
      return "";
    }
    const src = token.attrGet("src")?.trim() ?? "";
    // token.content preserves raw Markdown formatting in image labels.
    const alt = options.normalizeLabel(token.content);
    const roleMeta = (token.meta as AssistantTranscriptRoleImageMeta | undefined)
      ?.assistantTranscriptRoleImage;
    if (!options.isInlineDataImage(src)) {
      return roleMeta
        ? renderAssistantTranscriptRoleImageLabel(roleMeta.text, roleMeta.spans, options.escapeHtml)
        : options.escapeHtml(alt);
    }
    const image = `<img class="markdown-inline-image" src="${options.escapeHtml(src)}" alt="${options.escapeHtml(alt)}">`;
    const linkedImage = isImageWithinLink(tokens, index);
    const interactiveImage =
      linkedImage || !options.interactiveImages(env)
        ? image
        : `<button class="markdown-inline-image-button" type="button" aria-label="${options.escapeHtml(options.openImageLabel(alt, token.content.trim().length > 0))}">${image}</button>`;
    return roleMeta
      ? `${renderAssistantTranscriptRoleMarker(`${options.assistantLabel()}:`, options.escapeHtml)} ${interactiveImage}`
      : interactiveImage;
  };
}

export function renderAssistantTranscriptPlainTextFallback(
  text: string,
  enabled: boolean,
  assistantLabel: () => string,
  escapeHtml: (value: string) => string,
): string {
  const escaped = escapeHtml(text);
  if (!enabled) {
    return `<div class="markdown-plain-text-fallback">${escaped}</div>`;
  }
  const marker = renderAssistantTranscriptRoleMarker(`${assistantLabel()}:`, escapeHtml);
  return `<div class="markdown-plain-text-fallback">${marker}\n<span class="markdown-plain-text-source">${escaped}</span></div>`;
}
