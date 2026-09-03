import { upsertPresence } from "../../infra/system-presence.js";
import { presenceUserKey } from "../../shared/presence-user.js";
import { buildAuthenticatedPresenceUser } from "../authenticated-presence-user.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../server-constants.js";
import type { GatewayClient } from "../server-methods/types.js";
import type { GatewayWsClient } from "./ws-types.js";

function isLiveClient(client: GatewayWsClient): boolean {
  return !client.invalidated && client.socket.readyState === WEBSOCKET_OPEN_READY_STATE;
}

function presenceIdentity(client: GatewayWsClient): string | undefined {
  const profileId = client.authenticatedUserProfile?.profileId;
  return profileId
    ? presenceUserKey({ id: profileId, identity: { type: "profile", id: profileId } })
    : client.authenticatedUserId && !client.authenticatedGitHubIdentitySync
      ? presenceUserKey({ id: client.authenticatedUserId })
      : undefined;
}

/** Reconciles canonical identity and timing using only currently registered sockets. */
export function refreshClientPresence(
  clients: ReadonlySet<GatewayWsClient>,
  client: GatewayWsClient,
): boolean {
  if (!clients.has(client) || !isLiveClient(client) || !client.presenceKey) {
    return false;
  }
  const identity = presenceIdentity(client);
  if (!identity) {
    return false;
  }
  const peers = [...clients].filter(
    (peer) =>
      isLiveClient(peer) &&
      peer.presenceKey &&
      presenceIdentity(peer) === identity &&
      (peer === client || (client.personPresence && peer.personPresence)),
  );
  const timing = client.personPresence ? { ...client.personPresence } : undefined;
  for (const peer of peers) {
    if (timing && peer.personPresence) {
      timing.onlineSince = Math.min(timing.onlineSince, peer.personPresence.onlineSince);
      const activity = peer.personPresence.lastActivityAt;
      if (activity !== undefined) {
        timing.lastActivityAt = Math.max(timing.lastActivityAt ?? activity, activity);
      }
    }
  }
  for (const peer of peers) {
    // Copy interval facts so later profile qualification cannot leave raw and
    // profile sockets sharing mutable activity. Nodes retain their device lifecycle.
    if (timing && peer.personPresence) {
      peer.personPresence = { ...timing };
    }
    upsertPresence(peer.presenceKey!, {
      user: buildAuthenticatedPresenceUser(peer),
      ...peer.personPresence,
    });
  }
  return true;
}

/** Records accepted human activity; copies and clients closed during admission cannot write. */
export function recordClientPresenceActivity(
  clients: ReadonlySet<GatewayWsClient>,
  client: GatewayClient | null,
): boolean {
  for (const live of clients) {
    if (
      live !== client ||
      !isLiveClient(live) ||
      !live.presenceKey ||
      !live.personPresence ||
      !presenceIdentity(live)
    ) {
      continue;
    }
    live.personPresence = { ...live.personPresence, lastActivityAt: Date.now() };
    return refreshClientPresence(clients, live);
  }
  return false;
}
