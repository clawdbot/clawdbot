import { controlUiSessionSlug } from "@openclaw/session-url-contract";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SessionPathTarget } from "../../app-session-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { sessionKeyUuid } from "./route-loader-short-cache.ts";

const SESSION_REF_SEARCH_LIMIT = 20;
const SESSION_REF_SEARCH_MAX_PAGES = 5;

export type ShortSessionListFallbackResolution =
  | { kind: "not-found" }
  | { kind: "unique"; session: GatewaySessionRow }
  | { kind: "ambiguous"; sessions: GatewaySessionRow[]; truncated: boolean };

function narrowBySlugHint(
  resolution: ShortSessionListFallbackResolution,
  slugHint: string | undefined,
): ShortSessionListFallbackResolution {
  if (resolution.kind !== "ambiguous" || resolution.truncated || !slugHint) {
    return resolution;
  }
  const matched = resolution.sessions.filter(
    (row) => controlUiSessionSlug(row.displayName) === slugHint,
  );
  return matched.length === 1 && matched[0] ? { kind: "unique", session: matched[0] } : resolution;
}

// Prior-release v4 gateways reject unknown sessions.resolve params.
// Keep this list-based resolver until v4 closed-schema gateways without shortId
// support fall out of support.
export async function resolveShortSessionReferenceWithListFallback(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "short" }>,
  signal: AbortSignal,
): Promise<ShortSessionListFallbackResolution> {
  const matches = new Map<string, GatewaySessionRow>();
  const shortId = target.shortId.toLowerCase().replaceAll("-", "");
  let offset = 0;
  for (let page = 0; ; page += 1) {
    signal.throwIfAborted();
    const result = await context.sessions.list({
      agentId: target.agentId,
      archivedFilter: "all",
      includeDerivedTitles: true,
      limit: SESSION_REF_SEARCH_LIMIT,
      search: shortId.slice(0, 8),
      ...(offset > 0 ? { offset } : {}),
    });
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Session list unavailable while resolving URL.");
    }
    for (const session of result.sessions) {
      if (sessionKeyUuid(session.key)?.startsWith(shortId)) {
        matches.set(session.key, session);
      }
    }
    const sessions = [...matches.values()];
    if (sessions.length > 1) {
      return narrowBySlugHint(
        { kind: "ambiguous", sessions, truncated: result.hasMore === true },
        target.slugHint,
      );
    }
    if (result.hasMore !== true) {
      const session = sessions[0];
      return session ? { kind: "unique", session } : { kind: "not-found" };
    }
    if (page === SESSION_REF_SEARCH_MAX_PAGES - 1) {
      return { kind: "ambiguous", sessions, truncated: true };
    }
    const nextOffset = result.nextOffset ?? offset + result.sessions.length;
    if (nextOffset <= offset) {
      return { kind: "ambiguous", sessions, truncated: true };
    }
    offset = nextOffset;
  }
}
