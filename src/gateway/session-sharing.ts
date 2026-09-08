import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import {
  authorizeGatewaySessionCreation,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
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
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import {
  isRequiredSessionTargetMethod,
  isSessionProfileDependentMethod,
} from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionAgentRun,
  authorizeSessionSharingTarget,
  canManageSessionSharing,
  hiddenSessionNotFound,
  isGatewayAdmin,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
  sharingIdentity,
  type SessionSharingRoleParams,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { loadCachedSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";
import {
  resolveDirectIncognitoTargets,
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import { prepareTalkSessionTarget, assertTalkSessionStorageTarget } from "./talk-session-target.js";
import type { PreparedTalkSessionTarget } from "./talk-session-target.types.js";

type AuthorizedSessionMutationTarget = SessionMutationTarget & {
  resolved: Omit<SessionSharingTarget, "entry" | "storeKeys"> | null;
  sessionId: string | null;
  lifecycleRevision?: string;
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
  "talk.client.toolCall",
  "talk.session.create",
  "tools.invoke",
  "wake",
]);

// Documented contract (docs/gateway/protocol.md): these methods authorize by session
// visibility inside their handler, not by mutation participation. The pipeline still
// applies incognito checks and the operator role cap: a view/suggest-capped caller
// must not reassign ownership of a foreign session it can merely see.
const VISIBILITY_AUTHORIZED_METHODS = new Set(["sessions.assignOwner"]);

export { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
export { invalidateSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";

export {
  allowedSessionVisibilities,
  authorizeIncognitoSessionTarget,
  authorizeResolvedSessionMutation,
  authorizeSessionSharing,
  authorizeSessionSharingTarget,
  canAccessIncognitoSession,
  canManageSessionSharing,
  isGatewayAdmin,
  isResolvedIncognitoSession,
  isSessionVisibilityAllowed,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionSharingTargets,
  resolveSessionVisibility,
} from "./session-sharing-policy.js";

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
  // Progress belongs to the current conversation, not merely its stable session ID.
  // Capture this boundary for admins too so delayed writes cannot revive a reset card.
  const bindsProgressLifecycle = params.method === "progressCard.put";
  const adminBypass = isGatewayAdmin(params.client) && !authorizesAgentRun;
  if (adminBypass && !bindsProgressLifecycle) {
    return { error: null };
  }
  if (
    !adminBypass &&
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
    targetCount: number,
  ): { target: SessionSharingTarget | null } | { error: ErrorShape } => {
    try {
      return {
        target: resolveSessionSharingTarget({
          cfg: getCfg(),
          sessionKey: targetRef.sessionKey,
          agentId: targetRef.agentId,
          ...(lookupCaches ??= createLookupCaches()),
          exactRead: targetCount === 1,
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
  let talkInput: ReturnType<typeof resolveTalkSessionTargetInput>;
  let talkSessionTarget: PreparedTalkSessionTarget | undefined;
  try {
    talkInput = resolveTalkSessionTargetInput(
      params.method,
      params.requestParams,
      params.client?.connId,
    );
    if (talkInput?.kind === "relay") {
      assertTalkSessionStorageTarget(getCfg(), talkInput.target);
      talkSessionTarget = talkInput.target;
    } else {
      talkSessionTarget = talkInput && prepareTalkSessionTarget(getCfg(), talkInput.sessionKey);
    }
  } catch (error) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        String(error instanceof Error ? error.message : error),
      ),
    };
  }
  const talkTargets = talkSessionTarget
    ? [{ sessionKey: talkSessionTarget.canonicalKey, agentId: talkSessionTarget.agentId }]
    : undefined;
  const directTargets =
    talkTargets ?? resolveDirectSessionTargets(params.method, params.requestParams);
  const hidesForeignSessions =
    !adminBypass &&
    directTargets.length > 0 &&
    gatewayClientSessionCreator(params.client) &&
    operatorSessionCap(params.client, getCfg()) === "none";
  // Incognito and role-hidden direct reads share the same non-disclosing access boundary.
  const protectedTargets = hidesForeignSessions
    ? directTargets
    : (talkTargets?.filter((target) => isIncognitoSessionKey(target.sessionKey)) ??
      resolveDirectIncognitoTargets(params.method, params.requestParams));
  for (const targetRef of protectedTargets) {
    const resolved = resolveAuthorizedTarget(targetRef, protectedTargets.length);
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
  const targetRefs =
    talkTargets ??
    resolveSessionMutationTargets({
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
  if (talkSessionTarget && authorizesAgentRun) {
    const error = authorizeGatewaySessionCreation({
      cfg: getCfg(),
      client: params.client,
      agentId: talkSessionTarget.agentId,
    });
    if (error) {
      return { error };
    }
  }
  const authorizedTargets: AuthorizedSessionMutationTarget[] = [];
  for (const targetRef of targetRefs) {
    const resolved = resolveAuthorizedTarget(targetRef, targetRefs.length);
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
      ...(bindsProgressLifecycle ? { lifecycleRevision: target?.entry.lifecycleRevision } : {}),
    });
  }
  return {
    error: null,
    authorization: (() => {
      const targetChanged = (sessionKey: string) =>
        new SessionMutationAuthorizationChangedError(
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `session changed before ${params.method}; retry the request`,
            {
              details: {
                code: "SESSION_MUTATION_AUTHORIZATION_CHANGED",
                method: params.method,
                sessionKey,
              },
            },
          ),
        );
      const assertTalkTargetCurrent = (cfg: OpenClawConfig) => {
        if (!talkInput || !talkSessionTarget) {
          return;
        }
        let current: PreparedTalkSessionTarget;
        try {
          if (talkInput.kind === "relay") {
            if (!talkInput.isCurrent()) {
              throw targetChanged(talkSessionTarget.sessionKey);
            }
            assertTalkSessionStorageTarget(cfg, talkSessionTarget);
            current = talkSessionTarget;
          } else {
            current = prepareTalkSessionTarget(cfg, talkInput.sessionKey);
          }
        } catch {
          throw targetChanged(talkSessionTarget.sessionKey);
        }
        if (
          current.agentId !== talkSessionTarget.agentId ||
          current.sessionKey !== talkSessionTarget.sessionKey ||
          current.canonicalKey !== talkSessionTarget.canonicalKey ||
          current.storePath !== talkSessionTarget.storePath
        ) {
          throw targetChanged(talkSessionTarget.sessionKey);
        }
        const error =
          authorizesAgentRun &&
          authorizeGatewaySessionCreation({ cfg, client: params.client, agentId: current.agentId });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      const assertTargetCurrent = (
        targetRef: SessionMutationTarget,
        expected: AuthorizedSessionMutationTarget | undefined,
        currentCfg: OpenClawConfig,
        currentLookupCaches?: ReturnType<typeof createLookupCaches>,
        ensuredSessionId?: string,
      ) => {
        const current = resolveSessionSharingTarget({
          cfg: currentCfg,
          sessionKey: targetRef.sessionKey,
          agentId: targetRef.agentId,
          ...currentLookupCaches,
          exactRead: !currentLookupCaches || authorizedTargets.length === 1,
        });
        // The guarded ensure may mint this row/id. Its result permits only that
        // materialization, never a replacement of an already admitted session.
        const ensuredTarget =
          talkSessionTarget &&
          authorizesAgentRun &&
          expected?.sessionId === null &&
          ensuredSessionId
            ? {
                agentId: talkSessionTarget.agentId,
                canonicalKey: talkSessionTarget.canonicalKey,
                storeKey: talkSessionTarget.canonicalKey,
                storePath: talkSessionTarget.storePath,
              }
            : undefined;
        const expectedResolved = expected?.resolved ?? ensuredTarget;
        const expectedSessionId = expected?.sessionId ?? (ensuredTarget ? ensuredSessionId : null);
        const sameResolvedTarget =
          expected !== undefined &&
          (current === null
            ? expected.resolved === null && !ensuredSessionId
            : expectedResolved !== undefined &&
              expectedResolved !== null &&
              current.agentId === expectedResolved.agentId &&
              current.canonicalKey === expectedResolved.canonicalKey &&
              current.storeKey === expectedResolved.storeKey &&
              current.storePath === expectedResolved.storePath &&
              (current.entry.sessionId?.trim() || null) === expectedSessionId &&
              (!bindsProgressLifecycle ||
                current.entry.lifecycleRevision === expected.lifecycleRevision));
        if (!sameResolvedTarget) {
          throw targetChanged(targetRef.sessionKey);
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
        ...(talkSessionTarget ? { talkSessionTarget } : {}),
        assertCurrent: () => {
          const currentCfg = params.context.getRuntimeConfig();
          assertTalkTargetCurrent(currentCfg);
          const currentLookupCaches = createLookupCaches();
          for (const authorized of authorizedTargets) {
            assertTargetCurrent(authorized, authorized, currentCfg, currentLookupCaches);
          }
        },
        assertTargetCurrent: (targetRef: SessionMutationTarget & { ensuredSessionId?: string }) => {
          // Batch outcomes preserve caller identities, but authorization owns normalized targets.
          // Resolve the same normalized identity so padded aliases cannot escape the snapshot fence.
          const sessionKey = normalizeOptionalString(targetRef.sessionKey);
          const agentId = normalizeOptionalString(targetRef.agentId);
          const normalizedTarget = { sessionKey: sessionKey ?? targetRef.sessionKey, agentId };
          const expected = authorizedTargets.find(
            (target) => target.sessionKey === sessionKey && target.agentId === agentId,
          );
          const currentCfg = params.context.getRuntimeConfig();
          assertTalkTargetCurrent(currentCfg);
          assertTargetCurrent(
            normalizedTarget,
            expected,
            currentCfg,
            undefined,
            targetRef.ensuredSessionId,
          );
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
  client: GatewayClient;
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
    exactRead: sessionKeys.length === 1,
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
):
  | ((
      sessionKey: string | undefined,
      entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">,
    ) => boolean)
  | undefined {
  const operatorActor = resolveGatewayOperatorRoleActor(params.client);
  const identity = sharingIdentity(params.client, operatorActor);
  if (isGatewayAdmin(params.client) || (!identity && operatorActor?.kind === "system")) {
    return undefined;
  }
  if (!identity) {
    return params.cfg?.gateway?.roles ? () => false : undefined;
  }
  const sessionCap = params.cfg ? operatorSessionCap(params.client, params.cfg) : undefined;
  return createProfileSessionEntryFilter({ profileId: identity.id, sessionCap }, isCreator);
}

export function createProfileSessionEntryFilter(
  params: { profileId: string; sessionCap?: ReturnType<typeof operatorSessionCap> },
  isCreator?: ReturnType<typeof prepareSessionCreatorProfile>,
) {
  // Unprepared filters (notably preview) may survive yields and must read current aliases.
  const creatorMatches = isCreator ?? ((actor) => isSessionCreatorProfile(actor, params.profileId));
  return (
    sessionKey: string | undefined,
    entry: Pick<SessionEntry, "createdActor" | "visibility" | "incognito">,
  ) =>
    entry.incognito !== true &&
    !isIncognitoSessionKey(sessionKey) &&
    (creatorMatches(entry.createdActor) ||
      (params.sessionCap !== "none" && resolveSessionVisibility(entry) !== "draft"));
}
