import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "./index.ts";

const MAX_CHILD_SESSION_LIST_PASSES = 4;

export async function fetchChildSessionRows(params: {
  sessions: SessionCapability;
  parentKey: string;
  isCurrent: () => boolean;
  pageSize?: number;
}): Promise<GatewaySessionRow[] | null> {
  const rowsByKey = new Map<string, GatewaySessionRow>();
  const pageSize = params.pageSize ?? 20;
  for (let pass = 0; pass < MAX_CHILD_SESSION_LIST_PASSES; pass += 1) {
    const seenOffsets = new Set<number>();
    const rowsBeforePass = rowsByKey.size;
    let expectedTotal: number | undefined;
    let offset = 0;
    while (!seenOffsets.has(offset)) {
      seenOffsets.add(offset);
      const result = await params.sessions.list({
        spawnedBy: params.parentKey,
        ...(offset > 0 ? { offset } : {}),
        limit: pageSize,
        includeGlobal: false,
        includeUnknown: false,
        configuredAgentsOnly: true,
      });
      if (!params.isCurrent()) {
        return null;
      }
      if (!result) {
        throw new Error("child session list returned no result");
      }
      expectedTotal = result.totalCount;
      const runtimeSampledAt = Date.now();
      for (const row of result.sessions) {
        // A later pass is a fresher server observation even when the row moved
        // across an updatedAt-sorted offset boundary.
        rowsByKey.set(row.key, { ...row, runtimeSampledAt });
      }
      const hasMore =
        result.hasMore ??
        (typeof result.totalCount === "number" &&
          offset + result.sessions.length < result.totalCount);
      const nextOffset = result.nextOffset ?? offset + result.sessions.length;
      if (!hasMore || nextOffset <= offset) {
        break;
      }
      offset = nextOffset;
    }
    const addedThisPass = rowsByKey.size - rowsBeforePass;
    if (addedThisPass === 0 || expectedTotal === undefined || rowsByKey.size >= expectedTotal) {
      break;
    }
    // updatedAt ordering can move a child across an offset boundary while paging.
    // Repeat from zero until the deduplicated roster reaches the latest total.
  }
  return [...rowsByKey.values()];
}
