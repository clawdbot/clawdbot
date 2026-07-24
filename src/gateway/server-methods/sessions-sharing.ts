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
  loadCombinedSessionStoreForGateway,
  removeSessionMember,
} from "../../config/sessions.js";
import { patchSessionEntry } from "../../config/sessions/session-accessor.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import { listProfiles } from "../../state/user-profiles.js";
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
import { appendSessionAudit } from "./session-audit.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const sharingMutationQueues = new Map<string, StoreWriterQueue>();

function runExclusiveSharingMutation<T>(
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  run: () => Promise<T>,
): Promise<T> {
  return runQueuedStoreWrite({
    queues: sharingMutationQueues,
    storePath: `${target.storePath}\0${target.canonicalKey}`,
    label: "session-sharing-mutation",
    fn: run,
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
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
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

// Manager authorization runs before the exclusive queue, so a session can be
// reset or recreated under the same key while a mutation waits. Requiring the
// same session instance and a still-valid manager role inside the queue keeps
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
  for (const entry of Object.values(loadCombinedSessionStoreForGateway(params.cfg).store)) {
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
      // The entry-store write queue is separate from the sharing queue, so a
      // reset/recreate can replace the row between the check above and this
      // write. Re-check the instance inside the atomic patch and no-op if it
      // changed, so a stale owner cannot stamp the replacement's visibility.
      let sessionChanged = false;
      await patchSessionEntry(scope, (entry) => {
        if (entry.sessionId !== current.entry.sessionId) {
          sessionChanged = true;
          return null;
        }
        return { visibility };
      });
      if (sessionChanged) {
        throw new Error("session changed before sharing mutation");
      }
      invalidateSessionSharingSnapshot(current.canonicalKey);
      const now = Date.now();
      const actor = actorIdentity(client);
      try {
        await appendSessionAudit({
          cfg,
          target: { ...current, sessionKey: current.canonicalKey },
          text: `${actor.label ?? actor.id} changed session visibility from ${previous} to ${visibility}.`,
          now,
        });
      } catch (error) {
        // Roll back only if this is still the same instance we patched; a
        // concurrent reset could otherwise stamp the old restricted value onto
        // a fresh (shared-default) replacement.
        await patchSessionEntry(scope, (entry) =>
          entry.sessionId === current.entry.sessionId &&
          resolveSessionVisibility(entry) === visibility
            ? { visibility: previous }
            : null,
        );
        invalidateSessionSharingSnapshot(current.canonicalKey);
        throw error;
      }
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
      try {
        await appendSessionAudit({
          cfg,
          target: { ...current, sessionKey: current.canonicalKey },
          text: `${actor.label ?? actor.id} added ${params.identityId} as a session member.`,
          now,
        });
      } catch (error) {
        removeSessionMember(scope, params.identityId, added.member, current.entry.sessionId);
        throw error;
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
      try {
        await appendSessionAudit({
          cfg,
          target: { ...current, sessionKey: current.canonicalKey },
          text: `${actor.label ?? actor.id} removed ${params.identityId} from session members.`,
          now,
        });
      } catch (error) {
        addSessionMember(scope, {
          identityId: removed.identityId,
          addedBy: removed.addedBy,
          addedAt: removed.addedAt,
          expectedSessionId: current.entry.sessionId,
        });
        throw error;
      }
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
