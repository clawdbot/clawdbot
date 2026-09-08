import type { TranscriptsListParams } from "@openclaw/gateway-protocol";

export const TRANSCRIPT_PAGE_SIZE = 50;
export const TRANSCRIPT_QUERY_LIMIT = 256;
export const TRANSCRIPT_ADVANCED_FILTER_KEYS = [
  "providerId",
  "accountId",
  "agentId",
  "startedAfter",
  "startedBefore",
] as const;
export const TRANSCRIPT_FILTER_KEYS = ["query", ...TRANSCRIPT_ADVANCED_FILTER_KEYS] as const;

export function transcriptListParams(search: string): TranscriptsListParams {
  const query = new URLSearchParams(search);
  return {
    limit: TRANSCRIPT_PAGE_SIZE,
    query: query.get("query")?.slice(0, TRANSCRIPT_QUERY_LIMIT) || undefined,
    providerId: query.get("providerId") || undefined,
    accountId: query.get("accountId") || undefined,
    agentId: query.get("agentId") || undefined,
    startedAfter: transcriptDateFilter(query.get("startedAfter")),
    startedBefore: transcriptDateFilter(query.get("startedBefore")),
    cursor: query.get("cursor") || undefined,
  };
}

function transcriptDateFilter(value: string | null) {
  if (!value) {
    return undefined;
  }
  // Date-only controls describe UTC calendar boundaries; the RPC requires ISO timestamps.
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value;
}

export function transcriptRouteSearch(search: string, patch: Record<string, string | null>) {
  const query = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value) {
      query.set(key, value);
    } else {
      query.delete(key);
    }
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}
