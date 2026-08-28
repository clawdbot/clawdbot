import type {
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SessionCatalogEntrySnapshot,
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { hasMultipleSessionSharingIdentities } from "../../state/user-profiles.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { resolveSessionSharingRole, resolveSessionSharingTarget } from "../session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";
import type { GatewayClient } from "./types.js";

type SessionCatalogVisibility =
  | { cacheKey: string; kind: "unrestricted" }
  | { cacheKey: string; kind: "restricted-unprofiled" }
  | { cacheKey: string; kind: "restricted-owner"; ownerProfileId: string }
  | {
      cacheKey: string;
      kind: "restricted-shared";
      others: "view" | "suggest" | "write";
      ownerProfileId: string;
    };

export function resolveSessionCatalogVisibility(
  client: GatewayClient | null,
  config: OpenClawConfig,
): SessionCatalogVisibility {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const admin = authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, scopes).allowed;
  const multipleIdentities = hasMultipleSessionSharingIdentities();
  const profileId = client?.authenticatedUserProfile?.profileId;
  const others = admin ? undefined : operatorSessionCap(client, config);
  const cacheKey = JSON.stringify({
    admin,
    multipleIdentities,
    profileId: profileId ?? null,
    others: others ?? null,
  });
  if (admin || (!multipleIdentities && !others)) {
    return { cacheKey, kind: "unrestricted" };
  }
  if (!profileId) {
    return { cacheKey, kind: "restricted-unprofiled" };
  }
  return others && others !== "none"
    ? { cacheKey, kind: "restricted-shared", others, ownerProfileId: profileId }
    : { cacheKey, kind: "restricted-owner", ownerProfileId: profileId };
}

function isSharedCatalogSessionVisible(params: {
  config: OpenClawConfig;
  fallbackAgentId: string;
  session: SessionCatalogSession;
  sessionEntries: SessionCatalogEntrySnapshot;
  visibility: Extract<SessionCatalogVisibility, { kind: "restricted-shared" }>;
}): boolean {
  if (params.session.createdActor?.id === params.visibility.ownerProfileId) {
    return true;
  }
  const sessionKey = params.session.sessionKey;
  if (!params.session.createdActor?.id || !sessionKey || isIncognitoSessionKey(sessionKey)) {
    return false;
  }
  const agentId = resolveAgentIdFromSessionKey(
    sessionKey,
    tryResolveSessionCompatibilityOwnerAgentId(params.config, sessionKey) ?? params.fallbackAgentId,
  );
  const canonicalKey = resolveStoredSessionKeyForAgentStore({
    cfg: params.config,
    agentId,
    sessionKey,
  });
  const entry = params.sessionEntries
    .entriesForAgent(agentId)
    .find(
      (candidate) => candidate.sessionKey === sessionKey || candidate.sessionKey === canonicalKey,
    )?.entry;
  // Provider rows omit privacy flags; only the request-owned canonical session snapshot can
  // prove a foreign adopted thread is neither a draft nor incognito.
  return entry !== undefined && entry.visibility !== "draft" && entry.incognito !== true;
}

export function filterSessionCatalogHost(
  host: SessionCatalogHost,
  visibility: SessionCatalogVisibility,
  params: {
    config: OpenClawConfig;
    fallbackAgentId: string;
    sessionEntries: SessionCatalogEntrySnapshot;
  },
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
      return visibility.kind === "restricted-shared"
        ? isSharedCatalogSessionVisible({ ...params, session, visibility })
        : session.createdActor?.id === visibility.ownerProfileId;
    }),
  };
}

export async function isSessionCatalogThreadVisible(params: {
  access: "read" | "mutate";
  allowProcessHomeFallback: boolean;
  client: GatewayClient | null;
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
      if (params.visibility.kind === "restricted-owner") {
        return session.createdActor?.id === params.visibility.ownerProfileId;
      }
      if (
        !isSharedCatalogSessionVisible({
          config: params.config,
          fallbackAgentId: params.fallbackAgentId,
          session,
          sessionEntries: requestEntries.sessionEntries,
          visibility: params.visibility,
        })
      ) {
        return false;
      }
      if (
        params.access === "read" ||
        params.visibility.others === "write" ||
        session.createdActor?.id === params.visibility.ownerProfileId
      ) {
        return true;
      }
      const target = session.sessionKey
        ? resolveSessionSharingTarget({ cfg: params.config, sessionKey: session.sessionKey })
        : null;
      return (
        target !== null &&
        resolveSessionSharingRole({ cfg: params.config, client: params.client, target }) ===
          "member"
      );
    }
    const nextCursor = host.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return false;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}
