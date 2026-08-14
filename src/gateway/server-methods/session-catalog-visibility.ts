import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { hasMultipleSessionSharingIdentities } from "../../state/user-profiles.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";
import type { GatewayClient } from "./types.js";

type SessionCatalogVisibility = {
  cacheKey: string;
  profileId?: string;
  restricted: boolean;
};

export function resolveSessionCatalogVisibility(
  client: GatewayClient | null,
): SessionCatalogVisibility {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const admin = authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, scopes).allowed;
  const multipleIdentities = hasMultipleSessionSharingIdentities();
  const profileId = client?.authenticatedUserProfile?.profileId;
  return {
    cacheKey: JSON.stringify({ admin, multipleIdentities, profileId: profileId ?? null }),
    ...(profileId ? { profileId } : {}),
    restricted: multipleIdentities && !admin,
  };
}

export function filterSessionCatalogHost(
  host: SessionCatalogHost,
  visibility: SessionCatalogVisibility,
): SessionCatalogHost {
  if (!visibility.restricted) {
    return host;
  }
  return {
    ...host,
    sessions: host.sessions.filter((session) => {
      // No sessionKey means the provider cannot link this host-owned CLI row to an adopted
      // OpenClaw session. Keep it private from non-admin callers on multi-identity Gateways.
      return session.createdActor?.id === visibility.profileId;
    }),
  };
}

export async function isSessionCatalogThreadVisible(params: {
  allowProcessHomeFallback: boolean;
  config: OpenClawConfig;
  fallbackAgentId: string;
  hostId: string;
  list: SessionCatalogProvider["list"];
  listNodes: NonNullable<SessionCatalogListProviderParams["listNodes"]>;
  threadId: string;
  visibility: SessionCatalogVisibility;
}): Promise<boolean> {
  if (!params.visibility.restricted) {
    return true;
  }
  const requestEntries = createSessionCatalogRequestEntrySnapshot({
    cfg: params.config,
    fallbackAgentId: params.fallbackAgentId,
  });
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const hosts = await params.list({
      allowProcessHomeFallback: params.allowProcessHomeFallback,
      hostIds: [params.hostId],
      ...(cursor ? { cursors: { [params.hostId]: cursor } } : {}),
      sessionEntries: requestEntries.sessionEntries,
      listNodes: params.listNodes,
    });
    const host = hosts.find((candidate) => candidate.hostId === params.hostId);
    if (!host) {
      return false;
    }
    const projected = requestEntries.projectHostCreatedActors(host);
    const session = projected.sessions.find((candidate) => candidate.threadId === params.threadId);
    if (session) {
      return session.createdActor?.id === params.visibility.profileId;
    }
    const nextCursor = host.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return false;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}
