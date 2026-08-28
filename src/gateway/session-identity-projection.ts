import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionCreatedActor,
  SessionOwner,
  SessionPerson,
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { looksLikeAvatarPath } from "../shared/avatar-policy.js";
import { SESSIONS_LIST_OWNER_LIMIT } from "../shared/session-list-limits.js";
import type { SessionOwnerFacetIdentity } from "../shared/session-types.js";
import { buildControlUiResourcePath } from "./control-ui-contract.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import type { SessionActorProfileIdentity } from "./session-utils-contracts.js";

function projectParticipant(
  identity: SessionParticipantIdentity,
  profiles: Map<string, SessionActorProfileIdentity | undefined>,
  cfg?: OpenClawConfig,
): SessionParticipant {
  if (identity.type === "agent" && cfg) {
    const agent = resolveAgentIdentity(cfg, identity.id);
    const label = normalizeOptionalString(agent?.name);
    const avatar = normalizeOptionalString(agent?.avatar);
    return {
      identity,
      ...(label ? { label } : {}),
      ...(avatar && looksLikeAvatarPath(avatar)
        ? {
            avatarUrl: buildControlUiResourcePath(
              "agentAvatar",
              normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath),
              identity.id,
            ),
          }
        : {}),
    };
  }
  if (identity.type !== "profile") {
    return { identity };
  }
  if (!profiles.has(identity.id)) {
    const display = resolveCurrentUserProfileDisplay(identity.id);
    profiles.set(identity.id, display.kind === "resolved" ? display : undefined);
  }
  const profile = profiles.get(identity.id);
  return {
    identity: { type: "profile", id: profile?.profileId ?? identity.id },
    ...(profile?.label ? { label: profile.label } : {}),
    ...(profile?.hasUploadedAvatar ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

/** Required delegation preserves the profile creator, not evidence of their input. */
export function hasSessionCreatorProfileProvenance(entry: SessionEntry | undefined): boolean {
  switch (entry?.createdVia) {
    case "operator":
    case "run":
      return true;
    case "spawn":
    case "talk":
    case "cron":
      return entry.sandbox === "required";
    default:
      return false;
  }
}

export function projectSessionActor(
  actor: SessionEntry["createdActor"],
  profiles: Map<string, SessionActorProfileIdentity | undefined> = new Map(),
  cfg?: OpenClawConfig,
  profileProvenance = true,
): SessionCreatedActor | undefined {
  if (!actor) {
    return undefined;
  }
  const id = normalizeOptionalString(actor.id);
  if (!id) {
    return { type: actor.type };
  }
  const identity: SessionParticipantIdentity =
    actor.type === "agent"
      ? { type: "agent", id }
      : actor.type === "human" && profileProvenance
        ? { type: "profile", id }
        : { type: "legacy", actorType: actor.type, source: null, id };
  // Original actor fields remain authorization inputs; only display identity canonicalizes aliases.
  return { type: actor.type, id, ...projectParticipant(identity, profiles, cfg) };
}

/** Projects an identity only when it can own a session durably. */
export function projectAssignableSessionOwner(
  actor: SessionEntry["createdActor"],
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>,
  cfg: OpenClawConfig,
  configuredAgentIds?: ReadonlySet<string>,
  profileProvenance = true,
): SessionOwnerFacetIdentity | undefined {
  if (!actor || (actor.type !== "human" && actor.type !== "agent")) {
    return undefined;
  }
  const rawId = normalizeOptionalString(actor.id);
  if (!rawId) {
    return undefined;
  }
  const id = actor.type === "agent" ? normalizeAgentId(rawId) : rawId;
  if (actor.type === "agent" && !(configuredAgentIds ?? new Set(listAgentIds(cfg))).has(id)) {
    return undefined;
  }
  if (actor.type === "human" && !profileProvenance) {
    return undefined;
  }
  const projected = projectSessionActor({ type: actor.type, id }, userProfileIdentityById, cfg);
  if (!projected?.id || (actor.type === "human" && userProfileIdentityById.get(id) === undefined)) {
    return undefined;
  }
  return { ...projected, type: actor.type, id };
}

export function projectSessionOwner(
  entry: SessionEntry | undefined,
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined> | undefined,
  cfg: OpenClawConfig,
  configuredAgentIds?: ReadonlySet<string>,
): (SessionOwner & { actor: SessionOwnerFacetIdentity }) | undefined {
  const persisted = entry?.owner;
  const identities = userProfileIdentityById ?? new Map();
  const actor = projectAssignableSessionOwner(
    persisted?.actor ?? entry?.createdActor,
    identities,
    cfg,
    configuredAgentIds,
    Boolean(persisted?.actor || hasSessionCreatorProfileProvenance(entry)),
  );
  if (!actor) {
    return undefined;
  }
  const assignedBy = projectSessionActor(persisted?.assignedBy, identities, cfg);
  return {
    actor,
    ...(assignedBy ? { assignedBy } : {}),
    ...(persisted?.assignedAt !== undefined ? { assignedAt: persisted.assignedAt } : {}),
  };
}

export function projectSessionParticipants(
  entry: SessionEntry | undefined,
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined> | undefined,
  cfg: OpenClawConfig,
): NonNullable<SessionEntry["participants"]> {
  const identities = userProfileIdentityById ?? new Map();
  const participants = entry?.participants?.map(({ identity }) =>
    projectParticipant(identity, identities, cfg),
  );
  return [
    ...new Map(
      (participants ?? []).map((participant) => [
        JSON.stringify(participant.identity),
        participant,
      ]),
    ).values(),
  ];
}

/** Participation, creation, and responsibility are associations, never access grants. */
export function projectSessionPeople(
  entry: SessionEntry,
  identities: Map<string, SessionActorProfileIdentity | undefined>,
  cfg: OpenClawConfig,
  owner?: SessionOwnerFacetIdentity,
): SessionPerson[] {
  const participants = projectSessionParticipants(entry, identities, cfg);
  const actors = [
    owner,
    projectSessionActor(
      entry.createdActor,
      identities,
      cfg,
      hasSessionCreatorProfileProvenance(entry),
    ),
  ];
  const people = new Map<string, SessionPerson>();
  for (const participant of [...participants, ...actors]) {
    const identity = participant?.identity;
    if (identity?.type === "profile") {
      people.set(identity.id, {
        identity,
        label: participant?.label,
        avatarUrl: participant?.avatarUrl,
        sessionCount: 1,
      });
    }
  }
  return [...people.values()];
}

export function projectSessionPeopleFacet(
  people: Iterable<SessionPerson>,
  selectedProfileId?: string,
) {
  const sortedPeople = [...people].toSorted(
    (a, b) =>
      b.sessionCount - a.sessionCount ||
      (a.label ?? a.identity.id).localeCompare(b.label ?? b.identity.id) ||
      a.identity.id.localeCompare(b.identity.id),
  );
  const visiblePeople = sortedPeople.slice(0, SESSIONS_LIST_OWNER_LIMIT);
  const selected = selectedProfileId
    ? sortedPeople.find((person) => person.identity.id === selectedProfileId)
    : undefined;
  if (selected && !visiblePeople.includes(selected)) {
    visiblePeople.splice(-1, 1, selected);
  }
  return { people: visiblePeople, selected, overflow: sortedPeople.length > visiblePeople.length };
}

export function addSessionOwnerFacetIdentity(
  ownerFacet: Map<string, SessionOwnerFacetIdentity>,
  actor: SessionOwnerFacetIdentity,
): void {
  const existing = ownerFacet.get(actor.id);
  // The wire filter is id-only; a configured agent wins an authoritative namespace collision.
  if (!existing || (existing.type === "human" && actor.type === "agent")) {
    ownerFacet.set(actor.id, actor);
  }
}

export function sortSessionOwnerFacet(
  ownerFacet: Map<string, SessionOwnerFacetIdentity>,
): SessionOwnerFacetIdentity[] {
  return [...ownerFacet.values()].toSorted((a, b) => {
    const byLabel = (a.label ?? a.id).localeCompare(b.label ?? b.id);
    return byLabel || a.id.localeCompare(b.id);
  });
}
