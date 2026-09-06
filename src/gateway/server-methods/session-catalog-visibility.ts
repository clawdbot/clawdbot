import {
  GATEWAY_OWNER_PROFILE_ID,
  type SessionCatalogHost,
  type SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readUserProfileAliases } from "../../state/user-profile-list.js";
import { hasMultipleSessionSharingIdentities } from "../../state/user-profiles.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { prepareSessionCreatorProfile } from "../session-creator.js";
import { resolveSessionSharingRole, resolveSessionSharingTarget } from "../session-sharing.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";
import type { GatewayClient } from "./types.js";

type SessionCatalogVisibility = { cacheKey: string } & (
  | { kind: "unrestricted" }
  | { kind: "restricted-unprofiled" }
  | { kind: "restricted-owner"; isCreator: ReturnType<typeof prepareSessionCreatorProfile> }
  | {
      kind: "restricted-shared";
      others: "view" | "suggest" | "write";
      isCreator: ReturnType<typeof prepareSessionCreatorProfile>;
    }
);

export function resolveSessionCatalogVisibility(
  client: GatewayClient | null,
  config: OpenClawConfig,
): SessionCatalogVisibility {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const admin = authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, scopes).allowed;
  const multipleIdentities = hasMultipleSessionSharingIdentities();
  const attachedProfileId = client?.authenticatedUserProfile?.profileId;
  const profileId = attachedProfileId === GATEWAY_OWNER_PROFILE_ID ? undefined : attachedProfileId;
  const others = admin ? undefined : operatorSessionCap(client, config);
  const profileAliases = profileId ? readUserProfileAliases(profileId) : undefined;
  const cacheKey = JSON.stringify({
    admin,
    multipleIdentities,
    profileId: profileId ?? null,
    profileAliases: profileAliases ? [...profileAliases].toSorted() : [],
    others: others ?? null,
  });
  if (admin || (!multipleIdentities && !others)) {
    return { cacheKey, kind: "unrestricted" };
  }
  if (!profileId) {
    return { cacheKey, kind: "restricted-unprofiled" };
  }
  // The cache key and this synchronous publication use the same identity facts.
  const isCreator = prepareSessionCreatorProfile(profileId, profileAliases);
  return others && others !== "none"
    ? { cacheKey, kind: "restricted-shared", others, isCreator }
    : { cacheKey, kind: "restricted-owner", isCreator };
}

function visibleCatalogSessionEntry(params: {
  session: SessionCatalogSession;
  requestEntries: ReturnType<typeof createSessionCatalogRequestEntrySnapshot>;
  visibility: Extract<SessionCatalogVisibility, { kind: "restricted-shared" | "restricted-owner" }>;
}): SessionEntry | undefined {
  const sessionKey = params.session.sessionKey;
  if (!params.session.createdActor?.id || !sessionKey || isIncognitoSessionKey(sessionKey)) {
    return undefined;
  }
  const entry = params.requestEntries.entryForSession(sessionKey);
  // Provider rows omit privacy flags; only the request-owned canonical session snapshot can
  // prove a foreign adopted thread is neither a draft nor incognito.
  return entry !== undefined &&
    entry.incognito !== true &&
    (params.visibility.isCreator(entry.createdActor) ||
      (params.visibility.kind === "restricted-shared" && entry.visibility !== "draft"))
    ? entry
    : undefined;
}

export function filterSessionCatalogHost(
  host: SessionCatalogHost,
  visibility: SessionCatalogVisibility,
  params: {
    audience?: SessionCatalogProvider["audience"];
    requestEntries: ReturnType<typeof createSessionCatalogRequestEntrySnapshot>;
  },
): SessionCatalogHost {
  if (visibility.kind === "unrestricted" || params.audience === "gateway-operators") {
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
      return visibleCatalogSessionEntry({ ...params, session, visibility }) !== undefined;
    }),
  };
}

export async function isSessionCatalogThreadVisible(params: {
  access: "read" | "mutate";
  allowProcessHomeFallback: boolean;
  audience?: SessionCatalogProvider["audience"];
  client: GatewayClient | null;
  getConfig: () => OpenClawConfig;
  fallbackAgentId: string;
  hostId: string;
  list: SessionCatalogProvider["list"];
  listNodes: NonNullable<SessionCatalogListProviderParams["listNodes"]>;
  sourceHomeId?: string;
  threadId: string;
}): Promise<boolean> {
  let config = params.getConfig();
  let visibility = resolveSessionCatalogVisibility(params.client, config);
  if (visibility.kind === "unrestricted") {
    return true;
  }
  if (visibility.kind === "restricted-unprofiled" && params.audience !== "gateway-operators") {
    return false;
  }
  const planningEntries = createSessionCatalogRequestEntrySnapshot({
    cfg: config,
    fallbackAgentId: params.fallbackAgentId,
  });
  planningEntries.freeze();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const hosts = await params.list({
      agentId: params.fallbackAgentId,
      allowProcessHomeFallback: params.allowProcessHomeFallback,
      hostIds: [params.hostId],
      ...(cursor ? { cursors: { [params.hostId]: cursor } } : {}),
      sessionEntries: planningEntries.sessionEntries,
      listNodes: params.listNodes,
    });
    const host = hosts.find((candidate) => candidate.hostId === params.hostId);
    if (!host) {
      return false;
    }
    // Providers may populate planning entries before awaiting IO. Re-read privacy and caller
    // policy after enumeration, before granting read or mutation authority.
    config = params.getConfig();
    visibility = resolveSessionCatalogVisibility(params.client, config);
    if (visibility.kind === "unrestricted") {
      return true;
    }
    if (visibility.kind === "restricted-unprofiled" && params.audience !== "gateway-operators") {
      return false;
    }
    const requestEntries = createSessionCatalogRequestEntrySnapshot({
      cfg: config,
      fallbackAgentId: params.fallbackAgentId,
    });
    const instances = new Map();
    planningEntries.captureHostInstances(host, instances);
    const projected = requestEntries.projectHostSessions(host, instances);
    const session = projected.sessions.find(
      (candidate) =>
        candidate.threadId === params.threadId &&
        (!params.sourceHomeId || candidate.sourceHomeId === params.sourceHomeId),
    );
    if (session) {
      // Gateway-hosted catalogs already live inside this Gateway's trust domain.
      // Method scopes and creation policy remain the read/mutation authority.
      if (params.audience === "gateway-operators") {
        return true;
      }
      if (visibility.kind === "restricted-unprofiled") {
        return false;
      }
      const visibleEntry = visibleCatalogSessionEntry({
        session,
        requestEntries,
        visibility,
      });
      if (!visibleEntry) {
        return false;
      }
      if (
        params.access === "read" ||
        visibility.kind === "restricted-owner" ||
        visibility.others === "write" ||
        visibility.isCreator(visibleEntry.createdActor)
      ) {
        return true;
      }
      const target = session.sessionKey
        ? resolveSessionSharingTarget({ cfg: config, sessionKey: session.sessionKey })
        : null;
      return (
        target !== null &&
        resolveSessionSharingRole({ cfg: config, client: params.client, target }) === "member"
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
