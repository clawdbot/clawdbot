import { upsertPresence } from "../../infra/system-presence.js";
import { buildAuthenticatedPresenceUser } from "../authenticated-presence-user.js";
import { WEBSOCKET_OPEN_READY_STATE } from "../server-constants.js";
import type { GatewayClient } from "../server-methods/types.js";
import type { GatewayWsClient } from "./ws-types.js";

function isLiveClient(client: GatewayWsClient): boolean {
  return !client.invalidated && client.socket.readyState === WEBSOCKET_OPEN_READY_STATE;
}

function presenceIdentity(client: GatewayWsClient): string | undefined {
  return (
    client.authenticatedUserProfile?.profileId ??
    (client.authenticatedGitHubIdentitySync ? undefined : client.authenticatedUserId)
  );
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
  if (!identity || !client.authenticatedUserId) {
    return false;
  }
  const peers = [...clients].filter(
    (peer) =>
      isLiveClient(peer) &&
      peer.presenceKey &&
      presenceIdentity(peer) === identity &&
      (peer === client || (client.personPresence && peer.personPresence)),
  );
  const timing = client.personPresence;
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
    // Nodes retain their device lifecycle. Only person sockets share the interval,
    // including its original start after the oldest socket closes or a profile merges.
    if (timing && peer.personPresence) {
      peer.personPresence = timing;
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
    live.personPresence.lastActivityAt = Date.now();
    return refreshClientPresence(clients, live);
  }
  return false;
}
