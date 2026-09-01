import type { HookExternalContentSource } from "../../security/external-content.js";

/** Kept aligned with SessionStateActorType (src/sessions/session-state-event-kinds.ts); not imported to avoid layering config/sessions onto src/sessions. */
export type SessionActor = {
  type: "human" | "agent" | "system";
  id?: string;
  label?: string;
};

/** Only trusted creation owners may stamp a Gateway profile namespace. */
export type SessionCreatedActor = SessionActor &
  ({ type: "human"; source: "profile" | "channel" | "unknown" } | { type: "agent" | "system" });

export function sessionCreatorProfileId(
  actor: (SessionActor & { source?: unknown }) | undefined,
): string | undefined {
  return actor?.type === "human" && actor.source === "profile" ? actor.id : undefined;
}

export type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
export const MAX_SESSION_PARTICIPANTS = 32;

export type SessionOwnerAssignment = {
  actor: SessionActor;
  assignedBy?: SessionActor;
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

// Return shape mirrors the SessionEntry creation fields as a leaf contract;
// types.ts imports from here, never the reverse (madge cycle guard).
export function buildSessionCreationStamp(params: {
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  now?: number;
  sandbox?: "required";
}): {
  createdVia: SessionCreatedVia;
  createdActor?: SessionCreatedActor;
  createdAt: number;
  sandbox?: "required";
} {
  return {
    createdVia: params.via,
    ...(params.actor ? { createdActor: params.actor } : {}),
    createdAt: params.now ?? Date.now(),
    ...(params.sandbox === "required" ? { sandbox: "required" as const } : {}),
  };
}

/** Logical nodes retain creation attribution and isolation across writes and rollovers. */
export function preserveCreationStamp<
  T extends Partial<ReturnType<typeof buildSessionCreationStamp>>,
>(entry: T, authoritative: Partial<ReturnType<typeof buildSessionCreationStamp>> | undefined): T {
  return authoritative
    ? {
        ...entry,
        createdVia: authoritative.createdVia,
        createdActor: authoritative.createdActor,
        createdAt: authoritative.createdAt,
        ...(authoritative.sandbox === "required" ? { sandbox: authoritative.sandbox } : {}),
      }
    : entry;
}

/** Delegation keeps a required parent's human isolation identity, regardless of current roles. */
export function inheritSessionCreationPolicy(
  source: { createdActor?: SessionCreatedActor; sandbox?: "required" } | undefined,
  actor?: SessionCreatedActor,
): { actor?: SessionCreatedActor; sandbox?: "required" } {
  return source?.sandbox === "required"
    ? { actor: source.createdActor, sandbox: "required" }
    : { actor };
}

export type SessionEntryProvenance = {
  /** Plugin id that owns this session through a trusted runtime creation seam. */
  pluginOwnerId?: string;
  /** External hook source that has contributed content to this transcript. */
  hookExternalContentSource?: HookExternalContentSource;
};
