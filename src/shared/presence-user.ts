import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";

/** Presence namespaces come from recorded identity, never display metadata or raw-id shape. */
export function presenceUserKey(
  user: Pick<NonNullable<PresenceEntry["user"]>, "id" | "identity">,
): string {
  return user.identity ? `profile:${user.identity.id}` : `raw:${user.id}`;
}
