import {
  sessionCreatorProfileId,
  type SessionActor,
} from "../config/sessions/session-entry-provenance.js";
import { readUserProfileAliases } from "../state/user-profile-list.js";

/** Namespace qualification precedes aliases; responsibility and participation never grant access. */
export function isSessionCreatorProfile(
  actor: (SessionActor & { source?: unknown }) | undefined,
  profileId: string | undefined,
): boolean {
  return prepareSessionCreatorProfile(profileId)(actor);
}

/** One read-only synchronous fan-out only; prepare again after awaits or profile/storage changes. */
export function prepareSessionCreatorProfile(
  profileId: string | undefined,
  aliases?: ReadonlySet<string>,
): (actor: Parameters<typeof isSessionCreatorProfile>[0]) => boolean {
  let callerAliases = aliases;
  return (actor) => {
    const creatorId = sessionCreatorProfileId(actor);
    return Boolean(
      creatorId &&
      profileId &&
      (creatorId === profileId ||
        (callerAliases ??= readUserProfileAliases(profileId)).has(creatorId)),
    );
  };
}
