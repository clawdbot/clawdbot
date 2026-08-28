import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewaySessionRow } from "../api/types.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";

const SESSION_SEARCH_SNIPPET_MAX_CHARS = 160;

export function sessionMetadataMatchRank(row: GatewaySessionRow, search: string): number {
  const normalizedSearch = normalizeLowercaseStringOrEmpty(search);
  const fields = [
    resolveSessionDisplayName(row.key, row),
    row.key,
    row.label,
    row.subject,
    row.category,
    row.kind,
    row.model,
    row.modelProvider,
    row.owner?.actor.label,
    row.owner?.actor.id,
    row.createdActor?.label,
    row.createdActor?.id,
  ]
    .map((value) => normalizeLowercaseStringOrEmpty(value))
    .filter(Boolean);
  if (fields.some((field) => field === normalizedSearch)) {
    return 3;
  }
  if (fields.some((field) => field.startsWith(normalizedSearch))) {
    return 2;
  }
  return fields.some((field) => field.includes(normalizedSearch)) ? 1 : 0;
}

export function transcriptSearchSnippet(snippet: string): string {
  const compact = snippet.replace(/\s+/gu, " ").trim();
  return compact.length > SESSION_SEARCH_SNIPPET_MAX_CHARS
    ? `${truncateUtf16Safe(compact, SESSION_SEARCH_SNIPPET_MAX_CHARS - 1)}…`
    : compact;
}
