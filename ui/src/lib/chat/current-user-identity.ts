import { normalizeSenderIdentity, type SenderIdentity } from "./sender-label.ts";

type HelloWithPresence = {
  snapshot?: unknown;
};

/** Finds this browser connection's authenticated user in the Gateway presence snapshot. */
export function resolveCurrentUserIdentity(
  hello: HelloWithPresence | null | undefined,
  instanceId: string | null | undefined,
): SenderIdentity | null {
  const normalizedInstanceId = instanceId?.trim();
  const snapshot = hello?.snapshot;
  if (!normalizedInstanceId || !snapshot || typeof snapshot !== "object") {
    return null;
  }
  const presence = (snapshot as { presence?: unknown }).presence;
  if (!Array.isArray(presence)) {
    return null;
  }
  const ownPresence = presence.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return (entry as { instanceId?: unknown }).instanceId === normalizedInstanceId;
  });
  if (!ownPresence || typeof ownPresence !== "object" || Array.isArray(ownPresence)) {
    return null;
  }
  const user = (ownPresence as { user?: unknown }).user;
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    return null;
  }
  const record = user as Record<string, unknown>;
  return normalizeSenderIdentity({
    id: record.id ?? record.email,
    name: record.name,
    profileAvatarUrl: record.avatarUrl,
  });
}
