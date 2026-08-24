import {
  ErrorCodes,
  errorShape,
  validateSessionMemberAddParams,
  validateSessionMemberRemoveParams,
  validateSessionMembersListParams,
  validateSessionVisibilitySetParams,
  type SessionSharingEvent,
  type SessionSharingIdentity,
  type SessionCreatedActor,
  type SessionVisibility,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  addSessionMember,
  listSessionMembers,
  loadCombinedSessionStoreForGatewayCore,
  removeSessionMember,
} from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { listProfiles } from "../../state/user-profiles.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  allowedSessionVisibilities,
  canManageSessionSharing,
  invalidateSessionSharingSnapshot,
  isSessionVisibilityAllowed,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function runExclusiveSharingMutation<T>(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  run: () => Promise<T>,
): Promise<T> {
  // Sharing and lifecycle mutations share one exact-row fence so authorization
  // cannot change between archive's stop and commit boundaries.
  return runExclusiveSessionLifecycleMutation({
    scope: target.storePath,
    identities: [target.canonicalKey, target.storeKey, ...target.storeKeys, target.entry.sessionId],
    run,
  });
}

function actorIdentity(client: GatewayClient | null): SessionSharingIdentity {
  return (
    gatewayClientSessionCreator(client) ??
    (client?.connect.scopes?.includes("operator.admin")
      ? { type: "system", id: "operator.admin", label: "Administrator" }
      : { type: "system", id: "local-operator", label: "Local operator" })
  );
}

function requireManageableTarget(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  client: GatewayClient | null;
  sessionKey: string;
  agentId?: string;
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"];
}) {
  const requestedAgent = resolveRequestedSessionAgentId(
    params.cfg,
    params.sessionKey,
    params.agentId,
  );
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return null;
  }
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: requestedAgent.agentId,
  });
  if (!target) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return null;
  }
  const role = resolveSessionSharingRole({ client: params.client, target });
  if (!canManageSessionSharing(role)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "session owner or operator.admin required", {
        details: { code: "SESSION_SHARING_MANAGER_REQUIRED", sessionKey: target.canonicalKey },
      }),
    );
    return null;
  }
  return { target, role };
}

// Manager authorization runs before the lifecycle fence, so a session can be
// reset or recreated under the same key while a mutation waits. Requiring the
// same session instance and a still-valid manager role inside the fence keeps
// a stale owner from mutating the replacement session's sharing state.
function requireCurrentManagedTarget(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  client: GatewayClient | null;
  authorized: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
}): NonNullable<ReturnType<typeof resolveSessionSharingTarget>> {
  const current = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.authorized.canonicalKey,
    agentId: params.authorized.agentId,
  });
  if (!current || current.entry.sessionId !== params.authorized.entry.sessionId) {
    throw new Error("session changed before sharing mutation");
  }
  const role = resolveSessionSharingRole({ client: params.client, target: current });
  if (!canManageSessionSharing(role)) {
    throw new Error("session ownership changed before sharing mutation");
  }
  return current;
}

function knownSessionIdentities(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  actor: SessionSharingIdentity;
}): SessionSharingIdentity[] {
  const identities = new Map<string, SessionSharingIdentity>();
  const remember = (identity: SessionCreatedActor | null) => {
    if (!identity?.id) {
      return;
    }
    const current = identities.get(identity.id);
    identities.set(identity.id, {
      type: identity.type,
      id: identity.id,
      ...((identity.label ?? current?.label) ? { label: identity.label ?? current?.label } : {}),
    });
  };
  remember(params.actor);
  for (const entry of Object.values(loadCombinedSessionStoreForGatewayCore(params.cfg).store)) {
    remember(entry.createdActor ?? null);
  }
  for (const profile of listProfiles()) {
    remember({
      type: "human",
      id: profile.id,
      ...(profile.displayName ? { label: profile.displayName } : {}),
    });
  }
  return [...identities.values()].toSorted(
    (left, right) =>
      (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
      left.id.localeCompare(right.id),
  );
}

function publishSharingChange(params: {
  context: GatewayRequestContext;
  event: SessionSharingEvent;
  agentId: string;
}): void {
  invalidateSessionSharingSnapshot(params.event.sessionKey);
  params.context.broadcast("session.sharing", params.event, {
    sessionKeys: [params.event.sessionKey],
  });
  emitSessionsChanged(params.context, {
    reason: "sharing",
    sessionKey: params.event.sessionKey,
    agentId: params.agentId,
  });
  // Draft recipients cannot receive the scoped row, but still need a redacted
  // catalog invalidation so their next canonical list drops a newly hidden session.
  emitSessionsChanged(params.context, { reason: "sharing" });
}

export const sessionSharingHandlers: GatewayRequestHandlers = {
  "session.visibility.set": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionVisibilitySetParams,
        "session.visibility.set",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    const visibility = params.visibility as SessionVisibility;
    if (!isSessionVisibilityAllowed(cfg, visibility)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session visibility is disabled: ${visibility}`, {
          details: { code: "SESSION_VISIBILITY_DISABLED", visibility },
        }),
      );
      return;
    }
    await runExclusiveSharingMutation(managed.target, async () => {
      const current = requireCurrentManagedTarget({ cfg, client, authorized: managed.target });
      const previous = resolveSessionVisibility(current.entry);
      if (previous === visibility) {
        return;
      }
      const scope = {
        agentId: current.agentId,
        sessionKey: current.canonicalKey,
        storePath: current.storePath,
      };
      // The lifecycle fence excludes canonical reset/recreate. Keep the exact
      // session-id check at the storage boundary so an out-of-band row
      // replacement still cannot inherit this visibility change.
      let sessionChanged = false;
      await patchSessionEntryCore(scope, (entry) => {
        if (entry.sessionId !== current.entry.sessionId) {
          sessionChanged = true;
          return null;
        }
        return { visibility };
      });
      if (sessionChanged) {
        throw new Error("session changed before sharing mutation");
      }
      const now = Date.now();
      const actor = actorIdentity(client);
      publishSharingChange({
        context,
        agentId: current.agentId,
        event: {
          action: "visibility",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          actor,
          visibility,
          ts: now,
        },
      });
    });
    respond(true, { ok: true, sessionKey: managed.target.canonicalKey, visibility }, undefined);
  },

  "session.members.list": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateSessionMembersListParams, "session.members.list", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    const target = managed.target;
    const actor = actorIdentity(client);
    const members = listSessionMembers({
      agentId: target.agentId,
      sessionKey: target.storeKey,
      storePath: target.storePath,
    });
    const identities = knownSessionIdentities({
      cfg,
      actor,
    });
    for (const member of members) {
      if (!identities.some((identity) => identity.id === member.identityId)) {
        identities.push({ type: "human", id: member.identityId });
      }
    }
    identities.sort(
      (left, right) =>
        (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
        left.id.localeCompare(right.id),
    );
    const owner = target.entry.createdActor?.id ? target.entry.createdActor : undefined;
    respond(
      true,
      {
        sessionKey: target.canonicalKey,
        ...(owner ? { owner: { ...owner } } : {}),
        members,
        identities,
        role: managed.role,
        allowedVisibilities: allowedSessionVisibilities(cfg),
      },
      undefined,
    );
  },

  "session.members.add": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(params, validateSessionMemberAddParams, "session.members.add", respond)
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    const actor = actorIdentity(client);
    const known = knownSessionIdentities({
      cfg,
      actor,
    });
    if (!known.some((identity) => identity.id === params.identityId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown identity"));
      return;
    }
    await runExclusiveSharingMutation(managed.target, async () => {
      const current = requireCurrentManagedTarget({ cfg, client, authorized: managed.target });
      const scope = {
        agentId: current.agentId,
        sessionKey: current.storeKey,
        storePath: current.storePath,
      };
      const now = Date.now();
      const added = addSessionMember(scope, {
        identityId: params.identityId,
        addedBy: actor.id,
        addedAt: now,
        expectedSessionId: current.entry.sessionId,
      });
      if (!added.inserted) {
        return;
      }
      publishSharingChange({
        context,
        agentId: current.agentId,
        event: {
          action: "member-added",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          actor,
          identityId: params.identityId,
          ts: now,
        },
      });
    });
    respond(
      true,
      { ok: true, sessionKey: managed.target.canonicalKey, identityId: params.identityId },
      undefined,
    );
  },

  "session.members.remove": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionMemberRemoveParams,
        "session.members.remove",
        respond,
      )
    ) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const managed = requireManageableTarget({
      cfg,
      client,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!managed) {
      return;
    }
    await runExclusiveSharingMutation(managed.target, async () => {
      const current = requireCurrentManagedTarget({ cfg, client, authorized: managed.target });
      const scope = {
        agentId: current.agentId,
        sessionKey: current.storeKey,
        storePath: current.storePath,
      };
      const removed = removeSessionMember(
        scope,
        params.identityId,
        undefined,
        current.entry.sessionId,
      );
      if (!removed) {
        return;
      }
      const now = Date.now();
      const actor = actorIdentity(client);
      publishSharingChange({
        context,
        agentId: current.agentId,
        event: {
          action: "member-removed",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          actor,
          identityId: params.identityId,
          ts: now,
        },
      });
    });
    respond(
      true,
      { ok: true, sessionKey: managed.target.canonicalKey, identityId: params.identityId },
      undefined,
    );
  },
};
