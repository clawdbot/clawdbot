import { randomBytes } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateSessionMemberAddParams,
  validateSessionMemberRemoveParams,
  validateSessionMembersListParams,
  validateSessionVisibilitySetParams,
  validateSessionPublicShareSetParams,
  type SessionPublicShare,
  type SessionMember,
  type SessionMemberEvidence,
  type SessionCreatedActor,
  type SessionSharingEvent,
  type SessionSharingEvidenceEvent,
  type SessionSharingIdentity,
  type SessionVisibility,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  addSessionMember,
  listSessionMembers,
  loadCombinedSessionStoreForGatewayCore,
  removeSessionMember,
} from "../../config/sessions.js";
import {
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionPublicShare } from "../../config/sessions/session-public-share.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { listProfiles } from "../../state/user-profiles.js";
import {
  loadPublicSessionShareTokenCodec,
  type PublicSessionShareTokenCodec,
} from "../control-ui-public-session-token.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
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

const UNKNOWN_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unknown";
const UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF = "actor-evidence:unattributed";
const LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS = new Set(["local-operator", "operator.admin"]);

type SharingActorFacts =
  | { state: "present"; actor: SessionSharingIdentity }
  | { state: "unknown" }
  | { state: "absent" };

function actorIdentity(client: GatewayClient | null): SharingActorFacts {
  const principal = gatewayClientSessionCreator(client);
  if (principal) {
    return { state: "present", actor: principal };
  }
  return getGatewayLocalUserIngress(client)?.facts.invoker?.state === "unknown"
    ? { state: "unknown" }
    : { state: "absent" };
}

function sharingActorStorageRef(facts: SharingActorFacts): string {
  return facts.state === "present"
    ? facts.actor.id
    : facts.state === "unknown"
      ? UNKNOWN_SHARING_ACTOR_STORAGE_REF
      : UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF;
}

function projectSessionMemberEvidence(
  member: ReturnType<typeof listSessionMembers>[number],
): SessionMemberEvidence {
  // Sentinel ids satisfy the existing non-null storage contract only. Project
  // actor evidence here so persistence markers never become protocol identities.
  const common = { identityId: member.identityId, addedAt: member.addedAt };
  if (member.addedBy === UNKNOWN_SHARING_ACTOR_STORAGE_REF) {
    return { ...common, addedByState: "unknown" };
  }
  if (
    member.addedBy === UNATTRIBUTED_SHARING_ACTOR_STORAGE_REF ||
    LEGACY_SYNTHETIC_SHARING_ACTOR_STORAGE_REFS.has(member.addedBy)
  ) {
    // Beta builds stored fabricated operator ids before actor evidence became
    // tri-state. Discard those unshipped values instead of presenting principals.
    return common;
  }
  return { ...common, addedBy: member.addedBy };
}

function projectLegacySessionMember(member: SessionMemberEvidence): SessionMember | null {
  if (!member.addedBy) {
    return null;
  }
  return {
    identityId: member.identityId,
    addedBy: member.addedBy,
    addedAt: member.addedAt,
  };
}

function projectPublicSessionShare(params: {
  agentId: string;
  sessionKey: string;
  grant: NonNullable<ReturnType<typeof resolveSessionPublicShare>>;
  codec?: PublicSessionShareTokenCodec;
}): SessionPublicShare {
  const codec = params.codec ?? loadPublicSessionShareTokenCodec();
  return {
    token: codec.mint({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.grant.sessionId,
      shareId: params.grant.id,
    }),
    createdAt: params.grant.createdAt,
  };
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
  const role = resolveSessionSharingRole({ client: params.client, cfg: params.cfg, target });
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
  if (
    !current ||
    current.agentId !== params.authorized.agentId ||
    current.canonicalKey !== params.authorized.canonicalKey ||
    current.storeKey !== params.authorized.storeKey ||
    current.storePath !== params.authorized.storePath ||
    current.entry.sessionId !== params.authorized.entry.sessionId
  ) {
    throw new Error("session changed before sharing mutation");
  }
  const role = resolveSessionSharingRole({
    client: params.client,
    cfg: params.cfg,
    target: current,
  });
  if (!canManageSessionSharing(role)) {
    throw new Error("session ownership changed before sharing mutation");
  }
  return current;
}

function knownSessionIdentities(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  actor: SharingActorFacts;
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
  if (params.actor.state === "present") {
    remember(params.actor.actor);
  }
  const { store } = loadCombinedSessionStoreForGatewayCore(params.cfg, { projection: "list" });
  for (const entry of Object.values(store)) {
    remember(entry.createdActor ?? null);
  }
  for (const profile of listProfiles()) {
    remember({
      type: "human",
      id: profile.id,
      ...(profile.displayName ? { label: profile.displayName } : {}),
    });
  }
  return [...identities.values()];
}

function publishSharingChange(params: {
  context: GatewayRequestContext;
  actor: SharingActorFacts;
  event: Omit<SessionSharingEvidenceEvent, "actorState">;
  agentId: string;
}): void {
  invalidateSessionSharingSnapshot(params.event.sessionKey);
  const eventOptions = {
    sessionKeys: [params.event.sessionKey],
  };
  if (params.actor.state === "present") {
    const event: SessionSharingEvent = { ...params.event, actor: params.actor.actor };
    params.context.broadcast("session.sharing", event, eventOptions);
  } else {
    const event: SessionSharingEvidenceEvent = {
      ...params.event,
      ...(params.actor.state === "unknown" ? { actorState: "unknown" } : {}),
    };
    params.context.broadcast("session.sharing.evidence", event, eventOptions);
  }
  emitSessionsChanged(params.context, {
    reason: "sharing",
    sessionKey: params.event.sessionKey,
    agentId: params.agentId,
  });
  // Draft recipients cannot receive the scoped row, but still need a redacted
  // catalog invalidation so their next canonical list drops a newly hidden session.
  emitSessionsChanged(params.context, { reason: "sharing" });
}

function createSessionMembersListHandler(
  method: "session.members.list" | "session.members.listEvidence",
): GatewayRequestHandlers[string] {
  const evidenceAware = method === "session.members.listEvidence";
  return async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateSessionMembersListParams, method, respond)) {
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
    const evidenceMembers = listSessionMembers({
      agentId: target.agentId,
      sessionKey: target.storeKey,
      storePath: target.storePath,
    }).map(projectSessionMemberEvidence);
    const members = evidenceAware
      ? evidenceMembers
      : evidenceMembers.map(projectLegacySessionMember);
    if (!evidenceAware && members.some((member) => member === null)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "session membership includes actor evidence this client cannot represent",
          {
            details: {
              code: "SESSION_MEMBER_ACTOR_EVIDENCE_UNSUPPORTED",
              recommendedMethod: "session.members.listEvidence",
            },
          },
        ),
      );
      return;
    }
    const projectedMembers = members.filter((member) => member !== null);
    const identities = knownSessionIdentities({ cfg, actor });
    for (const member of projectedMembers) {
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
    const publicShareGrant = resolveSessionPublicShare(
      loadExactSessionEntryReadOnly({
        agentId: target.agentId,
        sessionKey: target.storeKey,
        storePath: target.storePath,
      })?.entry,
    );
    const publicShare =
      publicShareGrant?.sessionId === target.entry.sessionId
        ? projectPublicSessionShare({
            agentId: target.agentId,
            sessionKey: target.canonicalKey,
            grant: publicShareGrant,
          })
        : undefined;
    respond(
      true,
      {
        sessionKey: target.canonicalKey,
        ...(publicShare ? { publicShare } : {}),
        ...(owner ? { owner: { ...owner } } : {}),
        members: projectedMembers,
        identities,
        role: managed.role,
        allowedVisibilities: allowedSessionVisibilities(cfg),
      },
      undefined,
    );
  };
}

export const sessionSharingHandlers: GatewayRequestHandlers = {
  "session.publicShare.set": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionPublicShareSetParams,
        "session.publicShare.set",
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
    if (managed.target.entry.incognito || isIncognitoSessionKey(managed.target.canonicalKey)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Incognito sessions cannot be published."),
      );
      return;
    }
    if (managed.target.entry.sessionId !== params.expectedSessionId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Session changed; reopen sharing before publishing.",
        ),
      );
      return;
    }
    let tokenCodec: PublicSessionShareTokenCodec | undefined;
    let publicShareGrant: NonNullable<ReturnType<typeof resolveSessionPublicShare>> | undefined;
    let publicShare: SessionPublicShare | undefined;
    await runExclusiveSharingMutation(managed.target, async () => {
      const current = requireCurrentManagedTarget({
        cfg: context.getRuntimeConfig(),
        client,
        authorized: managed.target,
      });
      tokenCodec = params.enabled ? loadPublicSessionShareTokenCodec() : undefined;
      let changed = false;
      let inspected = false;
      await patchSessionEntryCore(
        {
          agentId: current.agentId,
          sessionKey: current.storeKey,
          storePath: current.storePath,
        },
        (entry) => {
          inspected = true;
          if (entry.sessionId !== params.expectedSessionId) {
            throw new Error("session changed before sharing mutation");
          }
          if (entry.incognito || isIncognitoSessionKey(current.canonicalKey)) {
            throw new Error("Incognito sessions cannot be published.");
          }
          if (
            !canManageSessionSharing(
              resolveSessionSharingRole({
                cfg: context.getRuntimeConfig(),
                client,
                target: { ...current, entry },
              }),
            )
          ) {
            throw new Error("session ownership changed before sharing mutation");
          }
          const previous = resolveSessionPublicShare(entry);
          publicShareGrant = params.enabled
            ? (previous ?? {
                id: randomBytes(24).toString("hex"),
                sessionId: entry.sessionId,
                createdAt: Date.now(),
              })
            : undefined;
          if (publicShareGrant) {
            // Capability URLs may surface in free-form diagnostics where no
            // structured field or query-name policy is available.
            registerSecretValueForRedaction(publicShareGrant.id);
          }
          publicShare =
            publicShareGrant && tokenCodec
              ? projectPublicSessionShare({
                  agentId: current.agentId,
                  sessionKey: current.canonicalKey,
                  grant: publicShareGrant,
                  codec: tokenCodec,
                })
              : undefined;
          changed = publicShareGrant?.id !== previous?.id;
          return changed ? { publicShare: publicShareGrant } : null;
        },
        {
          // Entry patches await preparation before committing. Recheck current
          // sharing authority on the synchronous commit edge, after that await.
          assertCommitAllowed: () => {
            requireCurrentManagedTarget({
              cfg: context.getRuntimeConfig(),
              client,
              authorized: current,
            });
          },
        },
      );
      if (!inspected) {
        throw new Error("session changed before sharing mutation");
      }
      if (changed) {
        emitSessionsChanged(context, {
          reason: "sharing",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
        });
      }
    });
    respond(
      true,
      {
        ok: true,
        sessionKey: managed.target.canonicalKey,
        ...(publicShare ? { publicShare } : {}),
      },
      undefined,
    );
  },
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
        actor,
        event: {
          action: "visibility",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          visibility,
          ts: now,
        },
      });
    });
    respond(true, { ok: true, sessionKey: managed.target.canonicalKey, visibility }, undefined);
  },

  "session.members.list": createSessionMembersListHandler("session.members.list"),
  "session.members.listEvidence": createSessionMembersListHandler("session.members.listEvidence"),

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
        addedBy: sharingActorStorageRef(actor),
        addedAt: now,
        expectedSessionId: current.entry.sessionId,
      });
      if (!added.inserted) {
        return;
      }
      publishSharingChange({
        context,
        agentId: current.agentId,
        actor,
        event: {
          action: "member-added",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
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
        actor,
        event: {
          action: "member-removed",
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
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
