import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionSharingRole,
  type SessionVisibility,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import { isSessionMember, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  authorizeGatewaySessionCreation,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicy,
} from "./operator-role-policy.js";
import {
  authenticatedProfileUnavailableError,
  gatewayClientSessionCreator,
  isGatewayClientProfilePending,
} from "./server-methods/gateway-client-identity.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import { loadCachedSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";
import {
  isRequiredSessionTargetMethod,
  isSessionProfileDependentMethod,
  resolveDirectIncognitoTargets,
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import {
  resolveCanonicalSessionStoreMatchFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

type SessionSharingTarget = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  storeKey: string;
  storeKeys: string[];
  storePath: string;
};

type AuthorizedSessionMutationTarget = SessionMutationTarget & {
  resolved: Omit<SessionSharingTarget, "entry" | "storeKeys"> | null;
  sessionId: string | null;
};

const AGENT_RUN_START_METHODS = new Set([
  "agent",
  "chat.send",
  "message.action",
  "send",
  "sessions.dispatch",
  "sessions.send",
  "sessions.steer",
  "talk.client.create",
  "talk.session.create",
  "tools.invoke",
  "wake",
]);

// Documented contract (docs/gateway/protocol.md): these methods authorize by session
// visibility inside their handler, not by mutation participation. The pipeline still
// applies incognito checks and the operator role cap: a view/suggest-capped caller
// must not reassign ownership of a foreign session it can merely see.
const VISIBILITY_AUTHORIZED_METHODS = new Set(["sessions.assignOwner"]);

export class SessionMutationAuthorizationChangedError extends Error {
  readonly error: ErrorShape;

  constructor(error: ErrorShape) {
    super(error.message);
    this.name = "SessionMutationAuthorizationChangedError";
    this.error = error;
  }
}

export { invalidateSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";

export function resolveSessionVisibility(
  entry: Pick<SessionEntry, "visibility">,
): SessionVisibility {
  return entry.visibility ?? "shared";
}

export function isGatewayAdmin(client: Pick<GatewayClient, "connect"> | null): boolean {
  // Internal/plugin-runtime runs reach authorization with a client that has no
  // connect handshake; treat a connect-less client as a non-admin, never a crash.
  return client?.connect?.scopes?.includes("operator.admin") === true;
}

export function allowedSessionVisibilities(cfg: OpenClawConfig): SessionVisibility[] {
  const policy = cfg.session?.sharing;
  return [
    "shared",
    ...(policy?.readOnly === false ? [] : (["read-only"] as const)),
    ...(policy?.suggest === false ? [] : (["suggest"] as const)),
    ...(policy?.drafts === false ? [] : (["draft"] as const)),
  ];
}

export function isSessionVisibilityAllowed(
  cfg: OpenClawConfig,
  visibility: SessionVisibility,
): boolean {
  return allowedSessionVisibilities(cfg).includes(visibility);
}

export function resolveSessionSharingTarget(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  projection?: "full" | "list";
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
}): SessionSharingTarget | null {
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg: params.cfg,
    key: params.sessionKey,
    agentId: params.agentId,
    clone: false,
    ...(params.projection ? { projection: params.projection } : {}),
    ...(params.storeCache ? { storeCache: params.storeCache } : {}),
    ...(params.targetDiscoveryCache ? { targetDiscoveryCache: params.targetDiscoveryCache } : {}),
  });
  const match = resolveCanonicalSessionStoreMatchFromStoreKeys(target.store, target.storeKeys);
  return match
    ? {
        agentId: target.agentId,
        canonicalKey: target.canonicalKey,
        entry: match.entry,
        storeKey: match.key,
        storeKeys: target.storeKeys,
        storePath: target.storePath,
      }
    : null;
}

type SessionSharingRoleParams = {
  cfg?: OpenClawConfig;
  client: GatewayClient | null;
  target: SessionSharingTarget;
  includeMembership?: boolean;
  isMember?: boolean;
};

function sharingIdentity(
  client: GatewayClient | null,
  actor: ReturnType<typeof resolveGatewayOperatorRoleActor>,
) {
  const operator = actor?.kind === "operator" ? { id: actor.profileId } : undefined;
  return gatewayClientSessionCreator(client) ?? operator;
}

export function resolveSessionSharingRole(
  params: SessionSharingRoleParams,
  preparedCap?: { value: ReturnType<typeof operatorSessionCap> },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
): SessionSharingRole {
  if (isGatewayAdmin(params.client)) {
    return "admin";
  }
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  // Shared-secret/no-auth solo deployments have no durable person identity.
  if (!identity) {
    return params.client?.authenticatedGitHubIdentitySync ||
      (params.cfg?.gateway?.roles && operatorActor?.kind !== "system")
      ? "viewer"
      : "owner";
  }
  const creatorMatches = isCreator ?? prepareSessionCreatorProfile(identity.id);
  if (creatorMatches(params.target.entry.createdActor)) {
    return "owner";
  }
  const sessionCap = preparedCap
    ? preparedCap.value
    : params.cfg && operatorSessionCap(params.client, params.cfg);
  if (
    sessionCap === "write" &&
    resolveSessionVisibility(params.target.entry) !== "draft" &&
    params.target.entry.incognito !== true &&
    !isIncognitoSessionKey(params.target.canonicalKey)
  ) {
    return "member";
  }
  if (sessionCap === "none") {
    return "viewer";
  }
  const member =
    params.isMember ??
    (params.includeMembership !== false &&
      isSessionMember(
        {
          agentId: params.target.agentId,
          sessionKey: params.target.storeKey,
          storePath: params.target.storePath,
        },
        identity.id,
      ));
  return member ? "member" : "viewer";
}

export function canManageSessionSharing(role: SessionSharingRole): boolean {
  return role === "admin" || role === "owner";
}

function hiddenSessionNotFound(sessionKey: string, incognito = false): ErrorShape {
  const label = incognito ? "Incognito session" : "Session";
  return errorShape(ErrorCodes.INVALID_REQUEST, `${label} "${sessionKey}" was not found.`);
}

function isIncognitoSessionTarget(params: {
  sessionKey: string;
  target: Pick<SessionSharingTarget, "canonicalKey" | "entry"> | null;
}): boolean {
  return params.target
    ? params.target.entry.incognito === true || isIncognitoSessionKey(params.target.canonicalKey)
    : isIncognitoSessionKey(params.sessionKey);
}

export function isResolvedIncognitoSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): boolean {
  return isIncognitoSessionTarget({
    sessionKey: params.sessionKey,
    target: resolveSessionSharingTarget(params),
  });
}

export function authorizeIncognitoSessionTarget(params: {
  client: GatewayClient | null;
  sessionKey: string;
  target: SessionSharingTarget | null;
}): ErrorShape | null {
  if (!isIncognitoSessionTarget(params)) {
    return null;
  }
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  if (isGatewayClientProfilePending(params.client)) {
    return authenticatedProfileUnavailableError();
  }
  const identity = gatewayClientSessionCreator(params.client);
  if (!identity) {
    return null;
  }
  return hiddenSessionNotFound(params.sessionKey, true);
}

export function canAccessIncognitoSession(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): boolean {
  if (isGatewayAdmin(params.client)) {
    return true;
  }
  return (
    authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: params.sessionKey,
      target: resolveSessionSharingTarget(params),
    }) === null
  );
}

export function authorizeResolvedSessionMutation(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
}): ErrorShape | null {
  if (isGatewayAdmin(params.client) && !params.cfg.gateway?.roles) {
    return null;
  }
  if (isGatewayClientProfilePending(params.client)) {
    return authenticatedProfileUnavailableError();
  }
  const target = resolveSessionSharingTarget(params);
  if (target) {
    const agentError = authorizeSessionAgentRun({
      cfg: params.cfg,
      client: params.client,
      target,
    });
    if (agentError) {
      return agentError;
    }
  }
  if (isGatewayAdmin(params.client)) {
    return null;
  }
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target,
  });
  if (incognitoError) {
    return incognitoError;
  }
  if (!target) {
    return null;
  }
  return authorizeSessionSharingTarget({ cfg: params.cfg, client: params.client, target });
}

function authorizeSessionAgentRun(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  target: SessionSharingTarget;
}): ErrorShape | null {
  const agentError = authorizeGatewaySessionCreation({
    cfg: params.cfg,
    client: params.client,
    agentId: params.target.agentId,
  });
  if (agentError) {
    return agentError;
  }
  if (
    params.cfg.gateway?.roles &&
    params.target.entry.sandbox !== "required" &&
    resolveOperatorRolePolicy(params.client, params.cfg)?.sandbox === "required"
  ) {
    return errorShape(
      ErrorCodes.FORBIDDEN,
      `Your operator role requires a sandboxed session; create a new session instead of running in "${params.target.canonicalKey}".`,
    );
  }
  return null;
}

export function authorizeSessionSharingTarget(params: {
  cfg?: OpenClawConfig;
  client: GatewayClient | null;
  target: SessionSharingTarget;
}): ErrorShape | null {
  const visibility = resolveSessionVisibility(params.target.entry);
  const sessionCap = params.cfg && operatorSessionCap(params.client, params.cfg);
  const role = resolveSessionSharingRole(params, { value: sessionCap });
  if (sessionCap === "none" && role !== "owner" && role !== "admin") {
    return hiddenSessionNotFound(params.target.canonicalKey);
  }
  const capped = sessionCap === "view" || sessionCap === "suggest";
  // Draft membership is inactive, while an explicit role caps even shared visibility.
  const canMutate =
    visibility === "draft"
      ? canManageSessionSharing(role)
      : role !== "viewer" || (visibility === "shared" && !capped);
  return canMutate
    ? null
    : errorShape(ErrorCodes.INVALID_REQUEST, `session is ${visibility} for this connection`, {
        details: {
          code: "SESSION_PARTICIPATION_REQUIRED",
          sessionKey: params.target.canonicalKey,
          visibility,
        },
      });
}

export function authorizeSessionSharing(
  params: Parameters<typeof resolveSessionSharingTarget>[0] & { client: GatewayClient | null },
): ErrorShape | null {
  const target = resolveSessionSharingTarget(params);
  return (
    target && authorizeSessionSharingTarget({ cfg: params.cfg, client: params.client, target })
  );
}

export function resolveSessionMutationAuthorization(params: {
  client: GatewayClient | null;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
}): { authorization?: SessionMutationAuthorization; error: ErrorShape | null } {
  const authorizesAgentRun =
    AGENT_RUN_START_METHODS.has(params.method) ||
    (params.method === "sessions.goal.update" &&
      typeof params.requestParams === "object" &&
      params.requestParams !== null &&
      "action" in params.requestParams &&
      params.requestParams.action === "resume");
  if (isGatewayAdmin(params.client) && !authorizesAgentRun) {
    return { error: null };
  }
  if (
    isGatewayClientProfilePending(params.client) &&
    isSessionProfileDependentMethod(params.method)
  ) {
    return { error: authenticatedProfileUnavailableError() };
  }
  // Resolve runtime config at most once per request and only when a path needs it. The context
  // getter reloads/resolves gateway config, so non-session requests (the vast majority) must not
  // pay it. Group discovery and the authorization loop then share one snapshot, so a mid-request
  // config change cannot split target discovery from authorization.
  let cachedCfg: OpenClawConfig | undefined;
  const getCfg = (): OpenClawConfig => (cachedCfg ??= params.context.getRuntimeConfig());
  // Each cache pair defines one synchronous freshness epoch: initial authorization shares one,
  // while commit-time guards start fresh after handler work.
  const createLookupCaches = (): {
    storeCache: GatewaySessionStoreCache;
    targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
  } => ({ storeCache: new Map(), targetDiscoveryCache: new Map() });
  let lookupCaches: ReturnType<typeof createLookupCaches> | undefined;
  const resolveAuthorizedTarget = (
    targetRef: SessionMutationTarget,
  ): { target: SessionSharingTarget | null } | { error: ErrorShape } => {
    try {
      return {
        target: resolveSessionSharingTarget({
          cfg: getCfg(),
          sessionKey: targetRef.sessionKey,
          agentId: targetRef.agentId,
          ...(lookupCaches ??= createLookupCaches()),
        }),
      };
    } catch (error) {
      if (error instanceof AgentSelectionRequiredError) {
        return {
          error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
        };
      }
      throw error;
    }
  };
  const directTargets = resolveDirectSessionTargets(params.method, params.requestParams);
  const hidesForeignSessions =
    directTargets.length > 0 &&
    gatewayClientSessionCreator(params.client) &&
    operatorSessionCap(params.client, getCfg()) === "none";
  // Incognito and role-hidden direct reads share the same non-disclosing access boundary.
  const protectedTargets = hidesForeignSessions
    ? directTargets
    : resolveDirectIncognitoTargets(params.method, params.requestParams);
  for (const targetRef of protectedTargets) {
    const resolved = resolveAuthorizedTarget(targetRef);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    const error = authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: targetRef.sessionKey,
      target,
    });
    if (error) {
      return { error };
    }
    if (
      hidesForeignSessions &&
      target &&
      !isSessionCreatorProfile(
        target.entry.createdActor,
        params.client?.authenticatedUserProfile?.profileId,
      )
    ) {
      return { error: hiddenSessionNotFound(targetRef.sessionKey) };
    }
  }
  const targetRefs = resolveSessionMutationTargets({
    method: params.method,
    requestParams: params.requestParams,
    context: params.context,
    getCfg,
  });
  if (!targetRefs) {
    if (isRequiredSessionTargetMethod(params.method)) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session mutation target is unavailable", {
          details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: params.method },
        }),
      };
    }
    return { error: null };
  }
  const authorizedTargets: AuthorizedSessionMutationTarget[] = [];
  for (const targetRef of targetRefs) {
    const resolved = resolveAuthorizedTarget(targetRef);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    const error =
      (target && authorizesAgentRun
        ? authorizeSessionAgentRun({
            cfg: getCfg(),
            client: params.client,
            target,
          })
        : null) ??
      authorizeIncognitoSessionTarget({
        client: params.client,
        sessionKey: targetRef.sessionKey,
        target,
      }) ??
      (target &&
      !(
        VISIBILITY_AUTHORIZED_METHODS.has(params.method) &&
        (operatorSessionCap(params.client, getCfg()) ?? "write") === "write"
      )
        ? authorizeSessionSharingTarget({ cfg: getCfg(), client: params.client, target })
        : null);
    if (error) {
      return { error };
    }
    authorizedTargets.push({
      ...targetRef,
      resolved: target
        ? {
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            storeKey: target.storeKey,
            storePath: target.storePath,
          }
        : null,
      sessionId: target?.entry.sessionId?.trim() || null,
    });
  }
  return {
    error: null,
    authorization: (() => {
      const assertTargetCurrent = (
        targetRef: SessionMutationTarget,
        expected: AuthorizedSessionMutationTarget | undefined,
        currentCfg: OpenClawConfig,
        currentLookupCaches?: ReturnType<typeof createLookupCaches>,
      ) => {
        const current = resolveSessionSharingTarget({
          cfg: currentCfg,
          sessionKey: targetRef.sessionKey,
          agentId: targetRef.agentId,
          ...currentLookupCaches,
        });
        const sameResolvedTarget =
          expected !== undefined &&
          (current === null
            ? expected.resolved === null
            : expected.resolved !== null &&
              current.agentId === expected.resolved.agentId &&
              current.canonicalKey === expected.resolved.canonicalKey &&
              current.storeKey === expected.resolved.storeKey &&
              current.storePath === expected.resolved.storePath &&
              (current.entry.sessionId?.trim() || null) === expected.sessionId);
        if (!sameResolvedTarget) {
          throw new SessionMutationAuthorizationChangedError(
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `session changed before ${params.method}; retry the request`,
              {
                details: {
                  code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                  method: params.method,
                  sessionKey: targetRef.sessionKey,
                },
              },
            ),
          );
        }
        if (!current) {
          return;
        }
        const error =
          (authorizesAgentRun
            ? authorizeSessionAgentRun({
                cfg: currentCfg,
                client: params.client,
                target: current,
              })
            : null) ??
          authorizeIncognitoSessionTarget({
            client: params.client,
            sessionKey: targetRef.sessionKey,
            target: current,
          }) ??
          authorizeSessionSharingTarget({
            cfg: currentCfg,
            client: params.client,
            target: current,
          });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      return {
        assertCurrent: () => {
          const currentCfg = params.context.getRuntimeConfig();
          const currentLookupCaches = createLookupCaches();
          for (const authorized of authorizedTargets) {
            assertTargetCurrent(authorized, authorized, currentCfg, currentLookupCaches);
          }
        },
        assertTargetCurrent: (targetRef: SessionMutationTarget) => {
          // Batch outcomes preserve caller identities, but authorization owns normalized targets.
          // Resolve the same normalized identity so padded aliases cannot escape the snapshot fence.
          const sessionKey = normalizeOptionalString(targetRef.sessionKey);
          const agentId = normalizeOptionalString(targetRef.agentId);
          const normalizedTarget = { sessionKey: sessionKey ?? targetRef.sessionKey, agentId };
          const expected = authorizedTargets.find(
            (target) => target.sessionKey === sessionKey && target.agentId === agentId,
          );
          assertTargetCurrent(normalizedTarget, expected, params.context.getRuntimeConfig());
        },
      };
    })(),
  };
}

function loadSharingSnapshot(params: Parameters<typeof resolveSessionSharingTarget>[0]) {
  const { sessionKey, agentId } = params;
  return loadCachedSessionSharingSnapshot({
    agentId,
    sessionKey,
    resolve: () => {
      const target = resolveSessionSharingTarget(params);
      return {
        canonicalKey: target?.canonicalKey ?? sessionKey,
        canonicalAgentId: target?.agentId ?? agentId,
        snapshot: {
          // Missing rows occur after deletion. Fail closed here; the delete path also
          // emits an unscoped catalog invalidation so identified readers still refresh.
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          ...(target ? { createdActor: target.entry.createdActor } : {}),
        },
      };
    },
  });
}

export function canReceiveSessionEvent(params: {
  cfg: OpenClawConfig;
  client: GatewayWsClient;
  sessionKeys: readonly string[];
  agentId?: string;
  event?: string;
  payload?: unknown;
}): boolean {
  const { cfg, client, sessionKeys, event } = params;
  if (isGatewayAdmin(client)) {
    return true;
  }
  const operatorActor = resolveGatewayOperatorRoleActor(client);
  const identity = sharingIdentity(client, operatorActor);
  if (!identity) {
    return (
      (!cfg.gateway?.roles || operatorActor?.kind === "system") &&
      event !== "session.suggestion" &&
      event !== "session.typing"
    );
  }
  const hidesForeignSessions = operatorSessionCap(client, cfg) === "none";
  const sharing = prepareSessionSharing({ cfg, client });
  // Discovery remains lazy; these facts belong only to this recipient check, never a socket send.
  const lookup: Omit<Parameters<typeof resolveSessionSharingTarget>[0], "sessionKey"> = {
    cfg,
    agentId: params.agentId,
    storeCache: new Map(),
    targetDiscoveryCache: new Map(),
  };
  const visible = sessionKeys.every((sessionKey) => {
    const snapshot = loadSharingSnapshot({ ...lookup, sessionKey });
    const isCreator = sharing.isCreator(snapshot.createdActor);
    if (snapshot.incognito || (hidesForeignSessions && !isCreator)) {
      return false;
    }
    if (snapshot.visibility !== "draft" || isCreator) {
      return true;
    }
    if (event !== "session.typing") {
      return false;
    }
    const target = resolveSessionSharingTarget({ ...lookup, sessionKey });
    return target !== null && canManageSessionSharing(sharing.roleForTarget(target));
  });
  if (!visible || event !== "session.suggestion") {
    return visible;
  }
  const authorId =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { suggestion?: { author?: { id?: unknown } } }).suggestion?.author?.id
      : undefined;
  if (authorId === identity.id) {
    return true;
  }
  return sessionKeys.every((sessionKey) => {
    const target = resolveSessionSharingTarget({ ...lookup, sessionKey });
    return target !== null && sharing.roleForTarget(target) !== "viewer";
  });
}

/** Share caller facts across synchronous selection/role projection, never across an await. */
export function prepareSessionSharing(params: Pick<SessionSharingRoleParams, "cfg" | "client">) {
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  const isCreator = prepareSessionCreatorProfile(identity?.id);
  return {
    isCreator,
    entryFilter: createSessionListEntryFilter(params, isCreator),
    roleForTarget: (target: SessionSharingTarget, isMember?: boolean) =>
      resolveSessionSharingRole({ ...params, target, isMember }, undefined, isCreator),
  };
}

export function createSessionListEntryFilter(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
): ((sessionKey: string, entry: SessionEntry) => boolean) | undefined {
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  if (isGatewayAdmin(params.client) || (!identity && operatorActor?.kind === "system")) {
    return undefined;
  }
  if (!identity) {
    return params.cfg?.gateway?.roles ? () => false : undefined;
  }
  const hidesForeignSessions =
    params.cfg && operatorSessionCap(params.client, params.cfg) === "none";
  // Unprepared filters (notably preview) may survive yields and must read current aliases.
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, identity.id));
  return (sessionKey, entry) =>
    entry.incognito !== true &&
    !isIncognitoSessionKey(sessionKey) &&
    (creatorMatches(entry.createdActor) ||
      (!hidesForeignSessions && resolveSessionVisibility(entry) !== "draft"));
}
