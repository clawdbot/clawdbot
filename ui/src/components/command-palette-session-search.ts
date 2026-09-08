import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  SessionsSearchHit,
  SessionsSearchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";

export const SESSION_ACTION_PREFIX = "session:";
export const SESSION_SEARCH_LIMIT = 10;
const SESSION_SEARCH_SNIPPET_MAX_CHARS = 160;

function sessionMetadataMatchRank(
  row: GatewaySessionRow,
  normalizedSearch: string,
  label: string,
): number {
  const fields = [
    label,
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

function transcriptSearchSnippet(snippet: string): string {
  const compact = snippet.replace(/\s+/gu, " ").trim();
  return compact.length > SESSION_SEARCH_SNIPPET_MAX_CHARS
    ? `${truncateUtf16Safe(compact, SESSION_SEARCH_SNIPPET_MAX_CHARS - 1)}…`
    : compact;
}

export function buildCommandPaletteSessionItems(params: {
  visibleRows: readonly GatewaySessionRow[];
  visibleKeys: ReadonlySet<string>;
  transcriptResult: (SessionsSearchResult & { sessions: readonly GatewaySessionRow[] }) | null;
  search: string;
}): CommandPaletteItem[] {
  const { visibleRows, visibleKeys, transcriptResult } = params;
  const normalizedSearch = normalizeLowercaseStringOrEmpty(params.search);
  const transcriptHitByKey = new Map<string, SessionsSearchHit>();
  for (const hit of transcriptResult?.results ?? []) {
    if (!transcriptHitByKey.has(hit.sessionKey)) {
      transcriptHitByKey.set(hit.sessionKey, hit);
    }
  }
  const rowsByKey = new Map(visibleRows.map((row) => [row.key, row] as const));
  for (const row of transcriptResult?.sessions ?? []) {
    if (!rowsByKey.has(row.key)) {
      rowsByKey.set(row.key, row);
    }
  }
  return [...rowsByKey.values()]
    .map((row) => {
      const label = resolveSessionDisplayName(row.key, row);
      const rawMetadataRank = sessionMetadataMatchRank(row, normalizedSearch, label);
      return {
        row,
        label,
        rawMetadataRank,
        metadataRank: Math.max(visibleKeys.has(row.key) ? 1 : 0, rawMetadataRank),
        transcriptHit: transcriptHitByKey.get(row.key),
      };
    })
    .filter(({ metadataRank, transcriptHit }) => metadataRank > 0 || transcriptHit)
    .toSorted((left, right) => {
      const metadataDiff = right.metadataRank - left.metadataRank;
      if (metadataDiff !== 0) {
        return metadataDiff;
      }
      const transcriptDiff =
        (right.transcriptHit?.score ?? Number.NEGATIVE_INFINITY) -
        (left.transcriptHit?.score ?? Number.NEGATIVE_INFINITY);
      return transcriptDiff || (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0);
    })
    .slice(0, SESSION_SEARCH_LIMIT)
    .map<CommandPaletteItem>(({ row, label, rawMetadataRank, transcriptHit }) => ({
      id: `session-${row.key}`,
      label,
      icon: "messageSquare",
      category: "chats",
      action: `${SESSION_ACTION_PREFIX}${row.key}`,
      // The server match floor affects ordering, not whether the local metadata matched.
      description:
        transcriptHit && rawMetadataRank === 0
          ? transcriptSearchSnippet(transcriptHit.snippet)
          : formatRelativeTimestamp(row.updatedAt, { fallback: "" }),
    }));
}
