// Per-connection viewer presence declarations. Message subscriptions are transport state,
// while this replace-set records only the sessions a client is actually rendering.
import { upsertPresence } from "../infra/system-presence.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { recordClientPresenceActivity } from "./server/client-presence.js";
import type { GatewayClientRegistry } from "./server/client-registry.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";

type SessionViewerPresenceDeclarationsDeps = Parameters<typeof broadcastPresenceSnapshot>[0] & {
  clients: GatewayClientRegistry;
};

type SessionViewerPresenceDeclarations = {
  replace: (connId: string, sessionKeys: readonly string[]) => readonly string[];
  unsubscribe: (connId: string) => void;
  stop: () => void;
};

function normalizedSessionKeys(sessionKeys: readonly string[]): string[] {
  return [...new Set(sessionKeys.map((key) => key.trim()).filter(Boolean))].toSorted();
}

function sameKeys(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((key, index) => key === right[index])
  );
}

/** Owns one replace-set per websocket connection until empty declaration or disconnect. */
export function createSessionViewerPresenceDeclarations(
  deps: SessionViewerPresenceDeclarationsDeps,
): SessionViewerPresenceDeclarations {
  const declarations = new Map<string, readonly string[]>();
  let stopped = false;

  const replace = (connId: string, sessionKeys: readonly string[]): readonly string[] => {
    if (stopped) {
      return [];
    }
    const normalizedConnId = connId.trim();
    const client = deps.clients.getByConnectionId(normalizedConnId);
    if (!client || client.invalidated || client.socket.readyState !== WEBSOCKET_OPEN_READY_STATE) {
      return [];
    }
    const next = normalizedSessionKeys(sessionKeys);
    const previous = declarations.get(normalizedConnId);
    if (sameKeys(previous, next) || (previous === undefined && next.length === 0)) {
      return next;
    }
    if (next.length === 0) {
      declarations.delete(normalizedConnId);
    } else {
      declarations.set(normalizedConnId, next);
    }
    if (client.presenceKey) {
      upsertPresence(client.presenceKey, {
        watchedSessions: next.length > 0 ? [...next] : undefined,
      });
      if (next.length > 0) {
        recordClientPresenceActivity(deps.clients, client);
      }
      broadcastPresenceSnapshot(deps);
    }
    return next;
  };

  const unsubscribe = (connId: string) => {
    const normalizedConnId = connId.trim();
    if (normalizedConnId) {
      // The websocket close boundary publishes reason=disconnect and clears watchedSessions.
      // Delete here first so a recycled connection id can never inherit an old declaration.
      declarations.delete(normalizedConnId);
    }
  };

  const stop = () => {
    stopped = true;
    declarations.clear();
  };

  return { replace, unsubscribe, stop };
}
