import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const TYPING_THROTTLE_MS = 1_000;
const TYPING_ACTIVE_TTL_MS = 2_500;
const MAX_TYPING_THROTTLE_KEYS = 2_048;
type PendingTypingBroadcast = { typing: boolean; emit: () => boolean };
type TypingBroadcastState = {
  at: number;
  typing: boolean;
  pending?: PendingTypingBroadcast;
  timer?: ReturnType<typeof setTimeout>;
};

type SessionTypingState = {
  broadcasts: Map<string, TypingBroadcastState>;
  connections: Map<string, Map<string, number>>;
};

function clearSessionTypingStateValue(state: SessionTypingState): void {
  for (const entry of state.broadcasts.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
  }
  state.broadcasts.clear();
  state.connections.clear();
}

const sessionTypingState = resolveGlobalSingleton<SessionTypingState>(
  Symbol.for("openclaw.sessionTypingState"),
  () => ({ broadcasts: new Map(), connections: new Map() }),
  clearSessionTypingStateValue,
);
const typingBroadcastState = sessionTypingState.broadcasts;
const typingConnections = sessionTypingState.connections;

export function clearSessionTypingState(): void {
  clearSessionTypingStateValue(sessionTypingState);
}

export function liveViewerIdentities(sessionKeys: ReadonlySet<string>): Set<string> {
  return new Set(
    listSystemPresence()
      .filter(
        (entry) =>
          entry.user?.id &&
          entry.watchedSessions?.some((sessionKey) => sessionKeys.has(sessionKey)),
      )
      .map((entry) => entry.user?.id)
      .filter((id): id is string => Boolean(id)),
  );
}

function rememberTypingBroadcast(key: string, state: TypingBroadcastState): void {
  typingBroadcastState.delete(key);
  typingBroadcastState.set(key, state);
  if (typingBroadcastState.size <= MAX_TYPING_THROTTLE_KEYS) {
    return;
  }
  const oldestKey = typingBroadcastState.keys().next().value;
  if (!oldestKey) {
    return;
  }
  const oldest = typingBroadcastState.get(oldestKey);
  if (oldest?.timer) {
    clearTimeout(oldest.timer);
  }
  typingBroadcastState.delete(oldestKey);
}

export function broadcastTypingThrottled(params: {
  key: string;
  typing: boolean;
  now: number;
  emit: () => boolean;
}): boolean {
  const previous = typingBroadcastState.get(params.key);
  if (!previous || params.now - previous.at >= TYPING_THROTTLE_MS) {
    if (previous?.timer) {
      clearTimeout(previous.timer);
    }
    const emitted = params.emit();
    if (emitted) {
      rememberTypingBroadcast(params.key, { at: params.now, typing: params.typing });
    } else {
      typingBroadcastState.delete(params.key);
    }
    return emitted;
  }

  if (params.typing === previous.typing && previous.pending?.typing !== params.typing) {
    if (previous.timer) {
      clearTimeout(previous.timer);
    }
    delete previous.pending;
    delete previous.timer;
    if (!params.typing) {
      rememberTypingBroadcast(params.key, previous);
      return false;
    }
  }

  previous.pending = { typing: params.typing, emit: params.emit };
  if (!previous.timer) {
    const timer = setTimeout(
      () => {
        const current = typingBroadcastState.get(params.key);
        if (!current || current.timer !== timer || !current.pending) {
          return;
        }
        const pending = current.pending;
        const next = { at: Date.now(), typing: pending.typing } satisfies TypingBroadcastState;
        if (pending.emit()) {
          rememberTypingBroadcast(params.key, next);
        } else {
          typingBroadcastState.delete(params.key);
        }
      },
      TYPING_THROTTLE_MS - (params.now - previous.at),
    );
    timer.unref?.();
    previous.timer = timer;
  }
  rememberTypingBroadcast(params.key, previous);
  return false;
}

export function updateTypingConnections(params: {
  key: string;
  connectionId: string;
  typing: boolean;
  now: number;
}): boolean {
  for (const [typingKey, activeConnections] of typingConnections) {
    for (const [connectionId, updatedAt] of activeConnections) {
      if (params.now - updatedAt >= TYPING_ACTIVE_TTL_MS) {
        activeConnections.delete(connectionId);
      }
    }
    if (activeConnections.size === 0) {
      typingConnections.delete(typingKey);
    }
  }
  const connections = typingConnections.get(params.key) ?? new Map<string, number>();
  if (params.typing) {
    connections.set(params.connectionId, params.now);
  } else {
    connections.delete(params.connectionId);
  }
  if (connections.size === 0) {
    typingConnections.delete(params.key);
    return false;
  }
  typingConnections.delete(params.key);
  typingConnections.set(params.key, connections);
  pruneMapToMaxSize(typingConnections, MAX_TYPING_THROTTLE_KEYS);
  return true;
}
