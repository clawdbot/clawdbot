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

type SessionCatalogVisibility =
  | { cacheKey: string; kind: "unrestricted" }
  | { cacheKey: string; kind: "restricted-unprofiled" }
  | { cacheKey: string; kind: "restricted-owner"; ownerProfileId: string };

export function resolveSessionCatalogVisibility(
  client: GatewayClient | null,
): SessionCatalogVisibility {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const admin = authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, scopes).allowed;
  const multipleIdentities = hasMultipleSessionSharingIdentities();
  const profileId = client?.authenticatedUserProfile?.profileId;
  const cacheKey = JSON.stringify({ admin, multipleIdentities, profileId: profileId ?? null });
  if (!multipleIdentities || admin) {
    return { cacheKey, kind: "unrestricted" };
  }
  return profileId
    ? { cacheKey, kind: "restricted-owner", ownerProfileId: profileId }
    : { cacheKey, kind: "restricted-unprofiled" };
}

export function filterSessionCatalogHost(
  host: SessionCatalogHost,
  visibility: SessionCatalogVisibility,
): SessionCatalogHost {
  if (visibility.kind === "unrestricted") {
    return host;
  }
  if (visibility.kind === "restricted-unprofiled") {
    return { ...host, sessions: [] };
  }
  return {
    ...host,
    sessions: host.sessions.filter((session) => {
      // No sessionKey means the provider cannot link this host-owned CLI row to an adopted
      // OpenClaw session. Keep it private from non-admin callers on multi-identity Gateways.
      return session.createdActor?.id === visibility.ownerProfileId;
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
  sourceHomeId?: string;
  threadId: string;
  visibility: SessionCatalogVisibility;
}): Promise<boolean> {
  if (params.visibility.kind === "unrestricted") {
    return true;
  }
  if (params.visibility.kind === "restricted-unprofiled") {
    return false;
  }
  const requestEntries = createSessionCatalogRequestEntrySnapshot({
    cfg: params.config,
    fallbackAgentId: params.fallbackAgentId,
  });
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const hosts = await params.list({
      agentId: params.fallbackAgentId,
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
    const session = projected.sessions.find(
      (candidate) =>
        candidate.threadId === params.threadId &&
        (!params.sourceHomeId || candidate.sourceHomeId === params.sourceHomeId),
    );
    if (session) {
      return session.createdActor?.id === params.visibility.ownerProfileId;
    }
    const nextCursor = host.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return false;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}
