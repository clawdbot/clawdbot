import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentIdentityResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../api/types.ts";
import type { SessionListOptions } from "../../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

export function sessionAgentIds(result: SessionsListResult | null): string[] {
  return [
    ...new Set(
      (result?.sessions ?? [])
        .map((row) => parseAgentSessionKey(row.key)?.agentId)
        .filter((agentId): agentId is string => Boolean(agentId)),
    ),
  ];
}

export function sessionAgentIdentityById(
  result: SessionsListResult | null,
  getIdentity: (agentId: string) => AgentIdentityResult | undefined,
): Record<string, AgentIdentityResult> {
  return Object.fromEntries(
    sessionAgentIds(result)
      .map((agentId) => [agentId, getIdentity(agentId)] as const)
      .filter((entry): entry is readonly [string, AgentIdentityResult] => Boolean(entry[1])),
  );
}

export async function searchVisibleSessionTranscripts(params: {
  client: GatewayBrowserClient;
  query: string;
  result: SessionsListResult | null;
  listSessions: (options: SessionListOptions) => Promise<SessionsListResult | null>;
  listOptions: SessionListOptions;
  resolveAgentId: (sessionKey: string) => string | undefined;
}): Promise<SessionsSearchResult> {
  const protocolKeyLimit = 200;
  const sessions: GatewaySessionRow[] = [...(params.result?.sessions ?? [])];
  let nextOffset =
    params.result?.hasMore === true
      ? (params.result.nextOffset ?? (params.result.offset ?? 0) + params.result.sessions.length)
      : null;
  while (nextOffset !== null && nextOffset !== undefined) {
    const page = await params.listSessions({
      ...params.listOptions,
      limit: protocolKeyLimit,
      offset: nextOffset,
    });
    if (!page) {
      break;
    }
    sessions.push(...page.sessions);
    const followingOffset =
      page.hasMore === true
        ? (page.nextOffset ?? (page.offset ?? nextOffset) + page.sessions.length)
        : null;
    if (
      followingOffset === null ||
      followingOffset === undefined ||
      followingOffset <= nextOffset
    ) {
      break;
    }
    nextOffset = followingOffset;
  }
  const keysByAgent = new Map<string, string[]>();
  for (const row of sessions) {
    const agentId = params.resolveAgentId(row.key);
    if (!agentId) {
      continue;
    }
    const keys = keysByAgent.get(agentId) ?? [];
    keys.push(row.key);
    keysByAgent.set(agentId, keys);
  }
  const requests: Array<Promise<SessionsSearchResult>> = [];
  for (const [agentId, sessionKeys] of keysByAgent) {
    for (let index = 0; index < sessionKeys.length; index += protocolKeyLimit) {
      requests.push(
        params.client.request<SessionsSearchResult>("sessions.search", {
          agentId,
          sessionKeys: sessionKeys.slice(index, index + protocolKeyLimit),
          query: params.query,
          limit: 25,
        }),
      );
    }
  }
  const pages = await Promise.all(requests);
  const results = pages
    .flatMap((page) => page.results)
    .toSorted((left, right) => right.score - left.score || right.timestamp - left.timestamp)
    .slice(0, 25);
  return {
    results,
    indexing: pages.some((page) => page.indexing === true),
    truncated:
      pages.some((page) => page.truncated === true) ||
      pages.reduce((total, page) => total + page.results.length, 0) > results.length,
  };
}
