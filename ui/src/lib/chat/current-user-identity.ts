import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readPresenceEntries, resolveSelfPresenceUser } from "../../app/user-profile.ts";
import { normalizeSenderIdentity, type SenderIdentity } from "./sender-label.ts";

type HelloWithPresence = {
  snapshot?: unknown;
};

/** Finds this browser connection's authenticated user in the Gateway presence snapshot. */
export function resolveCurrentUserIdentity(
  hello: HelloWithPresence | null | undefined,
  instanceId: string | null | undefined,
  snapshotUser?: unknown,
): SenderIdentity | null {
  const user =
    asOptionalRecord(snapshotUser) ??
    resolveSelfPresenceUser(readPresenceEntries(hello?.snapshot) ?? [], instanceId?.trim());
  return user
    ? normalizeSenderIdentity({
        id: user.id ?? user.email,
        name: user.name,
        identity: user.identity,
        profileAvatarUrl: user.avatarUrl,
      })
    : null;
}
