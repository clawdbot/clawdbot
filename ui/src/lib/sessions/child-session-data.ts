import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionCapability } from "./index.ts";
import { fetchPagedSessionRows } from "./paged-session-rows.ts";

// Matches the Gateway default and covers the default 50-child Swarm roster.
// Custom larger groups keep paging through the bounded retry loop below.
const CHILD_SESSION_LIST_PAGE_SIZE = 100;

export async function fetchChildSessionRows(params: {
  sessions: SessionCapability;
  parentKey: string;
  isCurrent: () => boolean;
  pageSize?: number;
}): Promise<GatewaySessionRow[] | null> {
  const pageSize = params.pageSize ?? CHILD_SESSION_LIST_PAGE_SIZE;
  return fetchPagedSessionRows({
    list: (offset) =>
      params.sessions.list({
        spawnedBy: params.parentKey,
        ...(offset > 0 ? { offset } : {}),
        limit: pageSize,
        includeGlobal: false,
        includeUnknown: false,
        configuredAgentsOnly: true,
      }),
    isCurrent: params.isCurrent,
    missingResultError: "child session list returned no result",
    mapPageRows: (rows) => {
      const runtimeSampledAt = Date.now();
      // Keep each server page's lifecycle sample coherent across sibling rows.
      return rows.map((row) => ({ ...row, runtimeSampledAt }));
    },
  });
}
