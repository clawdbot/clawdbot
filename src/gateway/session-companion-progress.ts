type SessionCompanionProgressListener = (payload: { empty: boolean }) => void;

const listeners = new Map<string, SessionCompanionProgressListener>();

function progressKey(connId: string, sessionKey: string): string {
  return `${connId}\0${sessionKey}`;
}

export function registerSessionCompanionProgress(params: {
  connId: string;
  sessionKey: string;
  listener: SessionCompanionProgressListener;
}): () => void {
  const key = progressKey(params.connId, params.sessionKey);
  // A duplicate busy ask must not steal the accepted phase from the request
  // that already owns this connection/session slot.
  if (listeners.has(key)) {
    return () => {};
  }
  listeners.set(key, params.listener);
  return () => {
    if (listeners.get(key) === params.listener) {
      listeners.delete(key);
    }
  };
}

export function notifySessionCompanionPrepared(params: {
  connId: string;
  empty: boolean;
  sessionKey: string;
}): void {
  try {
    listeners.get(progressKey(params.connId, params.sessionKey))?.({ empty: params.empty });
  } catch {
    // Progress presentation is advisory; a callback failure cannot abort the
    // authoritative companion request after context is ready.
  }
}
