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
  },
): void {
  md.renderer.rules.image = (tokens, index) => {
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
    return roleMeta
      ? `${renderAssistantTranscriptRoleMarker(`${options.assistantLabel()}:`, options.escapeHtml)} ${image}`
      : image;
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
