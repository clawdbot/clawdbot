import type { SessionsCatalogListParams } from "../../../packages/gateway-protocol/src/index.js";

export function sessionCatalogListKey(params: {
  agentId: string;
  request: SessionsCatalogListParams;
  search?: string;
}): string {
  const cursors = params.request.cursors
    ? Object.entries(params.request.cursors).toSorted(([left], [right]) =>
        left.localeCompare(right),
      )
    : null;
  const hostIds = params.request.hostIds ? [...new Set(params.request.hostIds)].toSorted() : null;
  return JSON.stringify([
    params.agentId,
    params.request.catalogId ?? null,
    params.search ?? null,
    params.request.limitPerHost ?? null,
    hostIds,
    cursors,
  ]);
}
