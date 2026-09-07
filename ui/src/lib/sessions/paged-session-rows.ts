import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";

const MAX_SESSION_LIST_PASSES = 4;

export async function fetchPagedSessionRows(params: {
  list: (offset: number) => Promise<SessionsListResult | null>;
  initialResult?: SessionsListResult | null;
  isCurrent?: () => boolean;
  mapPageRows?: (rows: GatewaySessionRow[]) => GatewaySessionRow[];
  missingResultError: string;
  stalledPaginationError?: string;
  incompletePaginationError?: string;
}): Promise<GatewaySessionRow[] | null> {
  if (params.initialResult === null) {
    return [];
  }
  const rowsByKey = new Map<string, GatewaySessionRow>();
  let expectedTotal: number | undefined;
  for (let pass = 0; pass < MAX_SESSION_LIST_PASSES; pass += 1) {
    // Include prefetched rows in first-pass progress so a moving row triggers a retry.
    const rowsBeforePass = rowsByKey.size;
    const seenOffsets = new Set<number>();
    let offset = 0;
    let prefetched = pass === 0 ? params.initialResult : undefined;
    while (!seenOffsets.has(offset)) {
      seenOffsets.add(offset);
      const result = prefetched ?? (await params.list(offset));
      prefetched = undefined;
      if (params.isCurrent && !params.isCurrent()) {
        return null;
      }
      if (!result) {
        throw new Error(params.missingResultError);
      }
      // Optional later-page counts must never erase a known larger roster.
      if (typeof result.totalCount === "number") {
        expectedTotal = Math.max(expectedTotal ?? 0, result.totalCount);
      }
      const rows = params.mapPageRows?.(result.sessions) ?? result.sessions;
      for (const row of rows) {
        rowsByKey.set(row.key, row);
      }
      const hasMore =
        result.hasMore ??
        (typeof result.totalCount === "number" &&
          offset + result.sessions.length < result.totalCount);
      if (!hasMore) {
        break;
      }
      const nextOffset = result.nextOffset ?? (result.offset ?? offset) + result.sessions.length;
      if (nextOffset <= offset) {
        if (params.stalledPaginationError) {
          throw new Error(params.stalledPaginationError);
        }
        break;
      }
      offset = nextOffset;
    }
    if (
      rowsByKey.size === rowsBeforePass ||
      expectedTotal === undefined ||
      rowsByKey.size >= expectedTotal
    ) {
      break;
    }
    // Gateway updatedAt sorting can move rows across offset windows between RPCs.
  }
  if (
    params.incompletePaginationError &&
    expectedTotal !== undefined &&
    rowsByKey.size < expectedTotal
  ) {
    throw new Error(params.incompletePaginationError);
  }
  return [...rowsByKey.values()];
}
