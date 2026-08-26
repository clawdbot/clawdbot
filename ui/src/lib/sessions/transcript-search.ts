import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionListOptions } from "./index.ts";
import { fetchPagedSessionRows } from "./paged-session-rows.ts";

type VisibleSessionTranscriptSearchResult = SessionsSearchResult & {
  sessions: GatewaySessionRow[];
};

export async function searchVisibleSessionTranscripts(params: {
  client: GatewayBrowserClient;
  query: string;
  result?: SessionsListResult | null;
  listSessions: (options: SessionListOptions) => Promise<SessionsListResult | null>;
  listOptions: SessionListOptions;
  resolveAgentId: (sessionKey: string) => string | undefined;
  isCurrent?: () => boolean;
  mapPageRows?: (rows: GatewaySessionRow[]) => GatewaySessionRow[];
  maxListPages?: number;
  maxSearchRequests?: number;
  maxSessionKeys?: number;
}): Promise<VisibleSessionTranscriptSearchResult> {
  const protocolKeyLimit = 200;
  const maxSessionKeys = params.maxSessionKeys;
  let rosterTruncated = false;
  const visibleSessions = maxSessionKeys
    ? await (async () => {
        const rowsByKey = new Map<string, GatewaySessionRow>();
        const maxPages = Math.max(1, params.maxListPages ?? 1);
        let offset = 0;
        for (let page = 0; page < maxPages; page += 1) {
          const result = await params.listSessions({
            ...params.listOptions,
            limit: protocolKeyLimit,
            offset,
          });
          if (params.isCurrent && !params.isCurrent()) {
            return [];
          }
          if (!result) {
            throw new Error("Unable to load sessions for transcript search.");
          }
          const rows = params.mapPageRows?.(result.sessions) ?? result.sessions;
          for (const row of rows) {
            if (!rowsByKey.has(row.key) && rowsByKey.size >= maxSessionKeys) {
              rosterTruncated = true;
              return [...rowsByKey.values()];
            }
            rowsByKey.set(row.key, row);
          }
          if (!result.hasMore) {
            return [...rowsByKey.values()];
          }
          if (rowsByKey.size >= maxSessionKeys) {
            rosterTruncated = true;
            return [...rowsByKey.values()];
          }
          const nextOffset = result.nextOffset ?? offset + result.sessions.length;
          if (nextOffset <= offset) {
            throw new Error("Session pagination did not advance during transcript search.");
          }
          offset = nextOffset;
        }
        rosterTruncated = true;
        return [...rowsByKey.values()];
      })()
    : ((await fetchPagedSessionRows({
        initialResult: params.result,
        list: (offset) =>
          params.listSessions({
            ...params.listOptions,
            limit: protocolKeyLimit,
            offset,
          }),
        isCurrent: params.isCurrent,
        mapPageRows: params.mapPageRows,
        missingResultError: "Unable to load all sessions for transcript search.",
        stalledPaginationError: "Session pagination did not advance during transcript search.",
      })) ?? []);
  const keysByAgent = new Map<string, string[]>();
  for (const row of visibleSessions) {
    const agentId = params.resolveAgentId(row.key);
    if (!agentId) {
      continue;
    }
    const keys = keysByAgent.get(agentId) ?? [];
    keys.push(row.key);
    keysByAgent.set(agentId, keys);
  }
  const requests: Array<Promise<SessionsSearchResult>> = [];
  const maxSearchRequests = params.maxSearchRequests ?? Number.POSITIVE_INFINITY;
  let requestsTruncated = false;
  for (const [agentId, sessionKeys] of keysByAgent) {
    for (let index = 0; index < sessionKeys.length; index += protocolKeyLimit) {
      if (requests.length >= maxSearchRequests) {
        requestsTruncated = true;
        break;
      }
      requests.push(
        params.client.request<SessionsSearchResult>("sessions.search", {
          agentId,
          sessionKeys: sessionKeys.slice(index, index + protocolKeyLimit),
          query: params.query,
          limit: 25,
        }),
      );
    }
    if (requestsTruncated) {
      break;
    }
  }
  const pages = await Promise.all(requests);
  const results = pages
    .flatMap((page) => page.results)
    .toSorted((left, right) => right.score - left.score || right.timestamp - left.timestamp)
    .slice(0, 25);
  return {
    sessions: visibleSessions,
    results,
    indexing: pages.some((page) => page.indexing === true),
    truncated:
      rosterTruncated ||
      requestsTruncated ||
      pages.some((page) => page.truncated === true) ||
      pages.reduce((total, page) => total + page.results.length, 0) > results.length,
  };
}
