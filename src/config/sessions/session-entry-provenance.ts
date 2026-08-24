import type { HookExternalContentSource } from "../../security/external-content.js";

/** Kept aligned with SessionStateActorType (src/sessions/session-state-event-kinds.ts); not imported to avoid layering config/sessions onto src/sessions. */
export type SessionCreatedActor = {
  type: "human" | "agent" | "system";
  id?: string;
  label?: string;
};

export type SessionParticipantSource = "profile" | "channel" | "agent";
export const MAX_SESSION_PARTICIPANTS = 32;

export type SessionParticipant = SessionCreatedActor & {
  /** Identity namespace recorded at the participant producer; absent means unknown legacy data. */
  source?: SessionParticipantSource;
};

export function mergeSessionParticipantSource(
  current: unknown,
  incoming: unknown,
): SessionParticipantSource | null {
  // Canonical profile participation must survive later channel-id collisions.
  if (current === "profile" || incoming === "profile") {
    return "profile";
  }
  const next = incoming === "channel" || incoming === "agent" ? incoming : null;
  if (next) {
    return next;
  }
  return current === "channel" || current === "agent" ? current : null;
}

export type SessionOwnerAssignment = {
  actor: SessionCreatedActor;
  assignedBy?: SessionCreatedActor;
  assignedAt?: number;
};
export type SessionCreatedVia =
  | "operator" // gateway sessions.create (Control UI / operator clients)
  | "spawn" // sessions_spawn native or ACP subagent spawn
  | "channel" // inbound channel conversation materialization
  | "cron"
  | "talk"
  | "run" // create-on-run materialization (agent-session-persist)
  | "plugin" // trusted plugin runtime creation
  | "internal"; // internal/hidden sessions (internal-session-effects, voice bare rows)

export function resolveProfileParticipantIdFromSessionCreation(
  creation:
    | {
        via: SessionCreatedVia;
        actor?: SessionCreatedActor;
      }
    | undefined,
): string | undefined {
  const profileId = creation?.actor?.id?.trim();
  return creation?.actor?.type === "human" &&
    (creation.via === "operator" || creation.via === "run") &&
    profileId
    ? profileId
    : undefined;
}

// Return shape mirrors the SessionEntry creation fields as a leaf contract;
// types.ts imports from here, never the reverse (madge cycle guard).
export function buildSessionCreationStamp(params: {
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  now?: number;
}): { createdVia: SessionCreatedVia; createdActor?: SessionCreatedActor; createdAt: number } {
  return {
    createdVia: params.via,
    ...(params.actor ? { createdActor: params.actor } : {}),
    createdAt: params.now ?? Date.now(),
  };
}

export type SessionEntryProvenance = {
  /** Plugin id that owns this session through a trusted runtime creation seam. */
  pluginOwnerId?: string;
  /** External hook source that has contributed content to this transcript. */
  hookExternalContentSource?: HookExternalContentSource;
};
