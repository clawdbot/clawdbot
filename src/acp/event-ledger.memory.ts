/** In-memory replayable ACP event ledger for ephemeral bridge sessions. */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  cloneAcpLedgerValue,
  createAcpPromptUpdates,
  normalizeAcpLedgerOptions,
  type AcpEventLedger,
  type AcpEventLedgerEntry,
  type AcpEventLedgerReplay,
  type AcpLedgerOptions,
  type AcpLedgerSession,
  type AcpMutableLedgerState,
} from "./event-ledger.types.js";

const LEDGER_VERSION = 1;

type LedgerStore = {
  version: 1;
  sessions: Record<string, AcpLedgerSession>;
};

type MemoryLedgerState = AcpMutableLedgerState & {
  store: LedgerStore;
};

function createEmptyStore(): LedgerStore {
  return {
    version: LEDGER_VERSION,
    sessions: {},
  };
}

function serializeLedgerStore(store: LedgerStore): string {
  return JSON.stringify(store);
}

function getSerializedLedgerByteLength(store: LedgerStore): number {
  return Buffer.byteLength(serializeLedgerStore(store), "utf8");
}

function getOrCreateSession(
  state: MemoryLedgerState,
  params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  },
): AcpLedgerSession {
  const now = state.now();
  const existing = state.store.sessions[params.sessionId];
  if (!params.reset && existing) {
    existing.sessionKey = params.sessionKey;
    if (params.cwd) {
      existing.cwd = params.cwd;
    }
    existing.complete = existing.complete || params.complete;
    existing.updatedAt = now;
    return existing;
  }
  const session: AcpLedgerSession = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cwd: params.cwd,
    complete: params.complete,
    createdAt: now,
    updatedAt: now,
    nextSeq: 1,
    events: [],
  };
  state.store.sessions[params.sessionId] = session;
  return session;
}

function trimLedger(state: MemoryLedgerState): void {
  for (const session of Object.values(state.store.sessions)) {
    if (session.events.length <= state.maxEventsPerSession) {
      continue;
    }
    session.events = session.events.slice(-state.maxEventsPerSession);
    session.complete = false;
  }

  const sessions = Object.values(state.store.sessions);
  if (sessions.length > state.maxSessions) {
    for (const session of sessions
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .slice(state.maxSessions)) {
      delete state.store.sessions[session.sessionId];
    }
  }

  let serializedBytes = getSerializedLedgerByteLength(state.store);
  while (serializedBytes > state.maxSerializedBytes) {
    const session = Object.values(state.store.sessions)
      .filter((candidate) => candidate.events.length > 0)
      .toSorted((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!session) {
      break;
    }
    session.events.shift();
    session.complete = false;
    serializedBytes = getSerializedLedgerByteLength(state.store);
  }

  while (serializedBytes > state.maxSerializedBytes) {
    const session = Object.values(state.store.sessions).toSorted(
      (a, b) => a.updatedAt - b.updatedAt,
    )[0];
    if (!session) {
      break;
    }
    delete state.store.sessions[session.sessionId];
    serializedBytes = getSerializedLedgerByteLength(state.store);
  }
}

function appendUpdate(
  state: MemoryLedgerState,
  params: {
    sessionId: string;
    sessionKey: string;
    runId?: string;
    update: SessionUpdate;
  },
): void {
  const session = getOrCreateSession(state, {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cwd: "",
    complete: false,
  });
  const now = state.now();
  session.updatedAt = now;
  session.events.push({
    seq: session.nextSeq,
    at: now,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    ...(params.runId ? { runId: params.runId } : {}),
    update: cloneAcpLedgerValue(params.update),
  });
  session.nextSeq += 1;
  trimLedger(state);
}

function createLedgerApi(params: {
  state: MemoryLedgerState;
  mutate: (fn: () => void) => Promise<void>;
  read: <T>(fn: () => T) => Promise<T>;
}): AcpEventLedger {
  const buildReplay = (session: AcpLedgerSession): AcpEventLedgerReplay => ({
    complete: true,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    events: session.events.map((event: AcpEventLedgerEntry) => cloneAcpLedgerValue(event)),
  });

  return {
    async startSession(sessionParams) {
      await params.mutate(() => {
        getOrCreateSession(params.state, sessionParams);
        trimLedger(params.state);
      });
    },

    async recordUserPrompt(promptParams) {
      await params.mutate(() => {
        for (const update of createAcpPromptUpdates(promptParams.prompt)) {
          appendUpdate(params.state, {
            sessionId: promptParams.sessionId,
            sessionKey: promptParams.sessionKey,
            runId: promptParams.runId,
            update,
          });
        }
      });
    },

    async recordUpdate(updateParams) {
      await params.mutate(() => {
        appendUpdate(params.state, updateParams);
      });
    },

    async markIncomplete(markParams) {
      await params.mutate(() => {
        const session = params.state.store.sessions[markParams.sessionId];
        if (!session || session.sessionKey !== markParams.sessionKey) {
          return;
        }
        session.complete = false;
        session.updatedAt = params.state.now();
      });
    },

    async readReplay(replayParams) {
      return params.read(() => {
        const session = params.state.store.sessions[replayParams.sessionId];
        if (!session || session.sessionKey !== replayParams.sessionKey || !session.complete) {
          return { complete: false, events: [] };
        }
        return buildReplay(session);
      });
    },

    async readReplayBySessionId(replayParams) {
      return params.read(() => {
        const session = params.state.store.sessions[replayParams.sessionId];
        if (!session || !session.complete) {
          return { complete: false, events: [] };
        }
        return buildReplay(session);
      });
    },

    async readReplayBySessionKey(replayParams) {
      return params.read(() => {
        const session = Object.values(params.state.store.sessions)
          .filter(
            (candidate) => candidate.sessionKey === replayParams.sessionKey && candidate.complete,
          )
          .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
        if (!session) {
          return { complete: false, events: [] };
        }
        return buildReplay(session);
      });
    },
  };
}

/** Creates an in-memory ACP event ledger for tests and ephemeral runtimes. */
export function createInMemoryAcpEventLedger(options: AcpLedgerOptions = {}): AcpEventLedger {
  const normalized = normalizeAcpLedgerOptions(options);
  const state: MemoryLedgerState = {
    store: createEmptyStore(),
    ...normalized,
  };
  return createLedgerApi({
    state,
    mutate: async (fn) => {
      fn();
    },
    read: async (fn) => fn(),
  });
}
