import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const CHAT_SELECTION_SNIPPET_MAX_CHARS = 300;

function collapseChatSelectionSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncateUtf16Safe(collapsed, CHAT_SELECTION_SNIPPET_MAX_CHARS);
}

export function buildMoreDetailsCompanionQuestion(selection: string): string | null {
  const snippet = collapseChatSelectionSnippet(selection);
  return snippet ? `Explain "${snippet}" from this conversation in more detail.` : null;
}

export function buildCompanionQuestionPrefill(selection: string): string | null {
  const snippet = collapseChatSelectionSnippet(selection);
  return snippet ? `Regarding "${snippet}": ` : null;
}

export function extractCompanionCommandQuestion(message: string): string {
  return message
    .trim()
    .replace(/^\/(?:btw|side)(?::\s*|\s+|$)/i, "")
    .trim();
}
