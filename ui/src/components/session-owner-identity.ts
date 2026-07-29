import {
  readPresenceEntries,
  resolveActorIdentityUsers,
  type ActorIdentityUser,
  type AuthenticatedUser,
} from "../app/user-profile.ts";

export type SessionOwnerIdentityHost = object & {
  readonly sessionDataContext:
    | {
        gateway: { snapshot: { selfUser?: AuthenticatedUser | null } };
      }
    | undefined;
  readonly sessionData: {
    presencePayload?: unknown;
    presenceInstanceId?: string;
  };
};

type SessionOwnerIdentityCache = {
  snapshotUser: AuthenticatedUser | null | undefined;
  presencePayload: unknown;
  presenceInstanceId: string | undefined;
  users: ReadonlyMap<string, ActorIdentityUser>;
};

const cacheByHost = new WeakMap<SessionOwnerIdentityHost, SessionOwnerIdentityCache>();

export function resolveSessionOwnerUser(
  host: SessionOwnerIdentityHost,
  actorId: string | null | undefined,
): ActorIdentityUser | undefined {
  const id = actorId?.trim();
  if (!id) {
    return undefined;
  }
  const snapshotUser = host.sessionDataContext?.gateway.snapshot.selfUser;
  const { presencePayload, presenceInstanceId } = host.sessionData;
  let cached = cacheByHost.get(host);
  if (
    !cached ||
    cached.snapshotUser !== snapshotUser ||
    cached.presencePayload !== presencePayload ||
    cached.presenceInstanceId !== presenceInstanceId
  ) {
    cached = {
      snapshotUser,
      presencePayload,
      presenceInstanceId,
      users: resolveActorIdentityUsers({
        snapshotUser,
        presenceEntries: readPresenceEntries(presencePayload),
        presenceInstanceId,
      }),
    };
    cacheByHost.set(host, cached);
  }
  return cached.users.get(id);
}
