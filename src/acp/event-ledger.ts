/** Persistent/replayable ACP event ledger implementations for session rehydration. */
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { resolveIntegerOption } from "@openclaw/acp-core/numeric-options";
import { resolveStateDir } from "../config/paths.js";
import { withFileLock } from "../infra/file-lock.js";
import { readJsonFile, writeTextAtomic } from "../infra/json-files.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { isRecord } from "../utils.js";

const LEDGER_VERSION = 1;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_EVENTS_PER_SESSION = 5_000;
const DEFAULT_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;
const FILE_LEDGER_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 5_000,
    randomize: true,
  },
  stale: 15_000,
} as const;

export type AcpEventLedgerEntry = {
  seq: number;
  at: number;
  sessionId: string;
  sessionKey: string;
  runId?: string;
  update: SessionUpdate;
};

export type AcpEventLedgerReplay = {
  complete: boolean;
  sessionId?: string;
  sessionKey?: string;
  events: AcpEventLedgerEntry[];
};

/** Storage interface for recording ACP session prompts/updates and reading replay state. */
export type AcpEventLedger = {
  startSession: (params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  }) => Promise<void>;
  recordUserPrompt: (params: {
    sessionId: string;
    sessionKey: string;
    runId: string;
    prompt: readonly ContentBlock[];
  }) => Promise<void>;
  recordUpdate: (params: {
    sessionId: string;
    sessionKey: string;
    runId?: string;
    update: SessionUpdate;
  }) => Promise<void>;
  markIncomplete: (params: { sessionId: string; sessionKey: string }) => Promise<void>;
  readReplay: (params: { sessionId: string; sessionKey: string }) => Promise<AcpEventLedgerReplay>;
  readReplayBySessionId: (params: { sessionId: string }) => Promise<AcpEventLedgerReplay>;
  readReplayBySessionKey: (params: { sessionKey: string }) => Promise<AcpEventLedgerReplay>;
};

type LedgerSession = {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
  nextSeq: number;
  events: AcpEventLedgerEntry[];
};

type LedgerStore = {
  version: 1;
  sessions: Record<string, LedgerSession>;
};

type LedgerOptions = {
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxSerializedBytes?: number;
  now?: () => number;
};

type MutableLedgerState = {
  store: LedgerStore;
  maxSessions: number;
  maxEventsPerSession: number;
  maxSerializedBytes: number;
  now: () => number;
};

function createEmptyStore(): LedgerStore {
  return {
    version: LEDGER_VERSION,
    sessions: {},
  };
}

function normalizeLedgerOptions(options: LedgerOptions = {}) {
  return {
    maxSessions: resolveIntegerOption(options.maxSessions, DEFAULT_MAX_SESSIONS, { min: 1 }),
    maxEventsPerSession: resolveIntegerOption(
      options.maxEventsPerSession,
      DEFAULT_MAX_EVENTS_PER_SESSION,
      { min: 1 },
    ),
    maxSerializedBytes: resolveIntegerOption(
      options.maxSerializedBytes,
      DEFAULT_MAX_SERIALIZED_BYTES,
      { min: 1_024 },
    ),
    now: options.now ?? Date.now,
  };
}

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

function createUserPromptUpdates(prompt: readonly ContentBlock[]): SessionUpdate[] {
  return prompt.map((content) => ({
    sessionUpdate: "user_message_chunk",
    content: cloneJsonValue(content),
  }));
}

function serializeLedgerStore(store: LedgerStore): string {
  return JSON.stringify(store);
}

function getSerializedLedgerByteLength(store: LedgerStore): number {
  return Buffer.byteLength(serializeLedgerStore(store), "utf8");
}

function normalizeEvent(raw: unknown): AcpEventLedgerEntry | undefined {
  if (!isRecord(raw) || !isRecord(raw.update)) {
    return undefined;
  }
  const seq = raw.seq;
  const at = raw.at;
  const sessionId = raw.sessionId;
  const sessionKey = raw.sessionKey;
  const runId = raw.runId;
  const sessionUpdate = raw.update.sessionUpdate;
  if (
    typeof seq !== "number" ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    typeof at !== "number" ||
    !Number.isFinite(at) ||
    typeof sessionId !== "string" ||
    typeof sessionKey !== "string" ||
    typeof sessionUpdate !== "string"
  ) {
    return undefined;
  }
  return {
    seq,
    at,
    sessionId,
    sessionKey,
    ...(typeof runId === "string" && runId ? { runId } : {}),
    update: cloneJsonValue(raw.update) as SessionUpdate,
  };
}

function normalizeSession(raw: unknown): LedgerSession | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const sessionId = raw.sessionId;
  const sessionKey = raw.sessionKey;
  const cwd = raw.cwd;
  const createdAt = raw.createdAt;
  const updatedAt = raw.updatedAt;
  const nextSeq = raw.nextSeq;
  if (
    typeof sessionId !== "string" ||
    typeof sessionKey !== "string" ||
    typeof cwd !== "string" ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    typeof nextSeq !== "number" ||
    !Number.isInteger(nextSeq) ||
    nextSeq < 1
  ) {
    return undefined;
  }
  const events = Array.isArray(raw.events)
    ? raw.events.map(normalizeEvent).filter((event): event is AcpEventLedgerEntry => Boolean(event))
    : [];
  return {
    sessionId,
    sessionKey,
    cwd,
    complete: raw.complete === true,
    createdAt,
    updatedAt,
    nextSeq,
    events,
  };
}

function normalizeStore(raw: unknown): LedgerStore {
  if (!isRecord(raw) || raw.version !== LEDGER_VERSION || !isRecord(raw.sessions)) {
    return createEmptyStore();
  }
  const sessions: Record<string, LedgerSession> = {};
  for (const [sessionId, value] of Object.entries(raw.sessions)) {
    const session = normalizeSession(value);
    if (!session || session.sessionId !== sessionId) {
      continue;
    }
    sessions[sessionId] = session;
  }
  return { version: LEDGER_VERSION, sessions };
}

function getOrCreateSession(
  state: MutableLedgerState,
  params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  },
): LedgerSession {
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
  const session: LedgerSession = {
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

function trimLedger(state: MutableLedgerState): void {
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
  state: MutableLedgerState,
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
    update: cloneJsonValue(params.update),
  });
  session.nextSeq += 1;
  trimLedger(state);
}

function createLedgerApi(params: {
  state: MutableLedgerState;
  mutate: (fn: () => void) => Promise<void>;
  read: <T>(fn: () => T) => Promise<T>;
}): AcpEventLedger {
  const buildReplay = (session: LedgerSession): AcpEventLedgerReplay => ({
    complete: true,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    events: session.events.map((event) => cloneJsonValue(event)),
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
        for (const update of createUserPromptUpdates(promptParams.prompt)) {
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
export function createInMemoryAcpEventLedger(options: LedgerOptions = {}): AcpEventLedger {
  const normalized = normalizeLedgerOptions(options);
  const state: MutableLedgerState = {
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

/** Resolves the legacy file-backed ACP ledger path under the OpenClaw state directory. */
export function resolveDefaultAcpEventLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "acp", "event-ledger.json");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Creates a file-backed ACP event ledger protected by a process/file lock. */
export function createFileAcpEventLedger(
  params: { filePath: string } & LedgerOptions,
): AcpEventLedger {
  const normalized = normalizeLedgerOptions(params);
  const state: MutableLedgerState = {
    store: createEmptyStore(),
    ...normalized,
  };
  let operation = Promise.resolve();

  const load = async () => {
    state.store = normalizeStore(await readJsonFile(params.filePath));
  };
  const ensureParentDir = async () => {
    await fs.mkdir(path.dirname(params.filePath), { recursive: true, mode: 0o700 });
  };

  const enqueue = async <T>(fn: () => Promise<T>): Promise<T> => {
    const task = operation.then(fn, fn);
    operation = task.then(
      () => {},
      () => {},
    );
    return task;
  };

  return createLedgerApi({
    state,
    mutate: async (fn) =>
      enqueue(async () => {
        await ensureParentDir();
        await withFileLock(params.filePath, FILE_LEDGER_LOCK_OPTIONS, async () => {
          await load();
          fn();
          await writeTextAtomic(params.filePath, serializeLedgerStore(state.store), {
            mode: 0o600,
            dirMode: 0o700,
          });
        });
      }),
    read: async (fn) =>
      enqueue(async () => {
        await ensureParentDir();
        return await withFileLock(params.filePath, FILE_LEDGER_LOCK_OPTIONS, async () => {
          await load();
          return fn();
        });
      }),
  });
}

/** Migrates a legacy file ledger into the SQLite state database, preserving replay order. */
export async function migrateFileAcpEventLedgerToSqlite(
  params: { filePath: string; archiveSource?: boolean } & OpenClawStateDatabaseOptions,
): Promise<{ importedSessions: number; importedEvents: number; archived?: boolean }> {
  if (!(await fileExists(params.filePath))) {
    return { importedSessions: 0, importedEvents: 0 };
  }

  const legacy = await withFileLock(params.filePath, FILE_LEDGER_LOCK_OPTIONS, async () =>
    normalizeStore(await readJsonFile(params.filePath)),
  );
  const sessions = Object.values(legacy.sessions);
  if (sessions.length === 0) {
    return { importedSessions: 0, importedEvents: 0 };
  }

  let importedSessions = 0;
  let importedEvents = 0;
  runOpenClawStateWriteTransaction((database) => {
    const sessionExists = database.db.prepare(
      "SELECT 1 FROM acp_replay_sessions WHERE session_id = ?",
    );
    const insertSession = database.db.prepare(
      `INSERT INTO acp_replay_sessions (
         session_id, session_key, cwd, complete, created_at, updated_at, next_seq
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = database.db.prepare(
      `INSERT OR IGNORE INTO acp_replay_events (
         session_id, seq, at, session_key, run_id, update_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const session of sessions) {
      if (sessionExists.get(session.sessionId)) {
        continue;
      }
      insertSession.run(
        session.sessionId,
        session.sessionKey,
        session.cwd,
        session.complete ? 1 : 0,
        session.createdAt,
        session.updatedAt,
        session.nextSeq,
      );
      importedSessions++;
      for (const event of session.events) {
        const result = insertEvent.run(
          event.sessionId,
          event.seq,
          event.at,
          event.sessionKey,
          event.runId ?? null,
          JSON.stringify(event.update),
        );
        importedEvents += Number(result.changes);
      }
    }
  }, params);

  if (params.archiveSource !== true || importedSessions === 0) {
    return { importedSessions, importedEvents };
  }
  const archivePath = `${params.filePath}.migrated`;
  try {
    if (!(await fileExists(archivePath))) {
      await fs.rename(params.filePath, archivePath);
      return { importedSessions, importedEvents, archived: true };
    }
  } catch {
    // The SQLite import succeeded; archiving is a best-effort cleanup.
  }
  return { importedSessions, importedEvents };
}

function normalizeSqliteInteger(value: number | bigint | null): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : 0;
}

type AcpReplaySessionRow = {
  session_id: string;
  session_key: string;
  cwd: string;
  complete: number | bigint;
  created_at: number | bigint;
  updated_at: number | bigint;
  next_seq: number | bigint;
};

type AcpReplayEventRow = {
  session_id: string;
  seq: number | bigint;
  at: number | bigint;
  session_key: string;
  run_id: string | null;
  update_json: string;
};

function sqliteRowToLedgerSession(db: DatabaseSync, row: AcpReplaySessionRow): LedgerSession {
  const events = db
    .prepare(
      `SELECT session_id, seq, at, session_key, run_id, update_json
         FROM acp_replay_events
        WHERE session_id = ?
        ORDER BY seq ASC`,
    )
    .all(row.session_id)
    .flatMap((eventRow) => {
      const normalized = sqliteRowToLedgerEvent(eventRow as AcpReplayEventRow);
      return normalized ? [normalized] : [];
    });
  return {
    sessionId: row.session_id,
    sessionKey: row.session_key,
    cwd: row.cwd,
    complete: normalizeSqliteInteger(row.complete) === 1,
    createdAt: normalizeSqliteInteger(row.created_at),
    updatedAt: normalizeSqliteInteger(row.updated_at),
    nextSeq: normalizeSqliteInteger(row.next_seq),
    events,
  };
}

function sqliteRowToLedgerEvent(row: AcpReplayEventRow): AcpEventLedgerEntry | undefined {
  let update: unknown;
  try {
    update = JSON.parse(row.update_json) as unknown;
  } catch {
    return undefined;
  }
  return normalizeEvent({
    seq: normalizeSqliteInteger(row.seq),
    at: normalizeSqliteInteger(row.at),
    sessionId: row.session_id,
    sessionKey: row.session_key,
    ...(row.run_id ? { runId: row.run_id } : {}),
    update,
  });
}

function readSqliteSessionById(db: DatabaseSync, sessionId: string): LedgerSession | undefined {
  const row = db
    .prepare(
      `SELECT session_id, session_key, cwd, complete, created_at, updated_at, next_seq
         FROM acp_replay_sessions
        WHERE session_id = ?`,
    )
    .get(sessionId) as AcpReplaySessionRow | undefined;
  return row ? sqliteRowToLedgerSession(db, row) : undefined;
}

function readLatestCompleteSqliteSessionByKey(
  db: DatabaseSync,
  sessionKey: string,
): LedgerSession | undefined {
  const row = db
    .prepare(
      `SELECT session_id, session_key, cwd, complete, created_at, updated_at, next_seq
         FROM acp_replay_sessions
        WHERE session_key = ? AND complete = 1
        ORDER BY updated_at DESC, session_id ASC
        LIMIT 1`,
    )
    .get(sessionKey) as AcpReplaySessionRow | undefined;
  return row ? sqliteRowToLedgerSession(db, row) : undefined;
}

function upsertSqliteSession(
  db: DatabaseSync,
  state: Pick<MutableLedgerState, "now">,
  params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  },
): LedgerSession {
  const now = state.now();
  const existing = readSqliteSessionById(db, params.sessionId);
  if (!params.reset && existing) {
    const cwd = params.cwd || existing.cwd;
    const complete = existing.complete || params.complete ? 1 : 0;
    db.prepare(
      `UPDATE acp_replay_sessions
          SET session_key = ?, cwd = ?, complete = ?, updated_at = ?
        WHERE session_id = ?`,
    ).run(params.sessionKey, cwd, complete, now, params.sessionId);
    return {
      ...existing,
      sessionKey: params.sessionKey,
      cwd,
      complete: complete === 1,
      updatedAt: now,
    };
  }

  if (params.reset) {
    db.prepare("DELETE FROM acp_replay_events WHERE session_id = ?").run(params.sessionId);
  }
  db.prepare(
    `INSERT INTO acp_replay_sessions (
       session_id, session_key, cwd, complete, created_at, updated_at, next_seq
     ) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(session_id) DO UPDATE SET
       session_key = excluded.session_key,
       cwd = excluded.cwd,
       complete = excluded.complete,
       updated_at = excluded.updated_at,
       next_seq = excluded.next_seq`,
  ).run(params.sessionId, params.sessionKey, params.cwd, params.complete ? 1 : 0, now, now);
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cwd: params.cwd,
    complete: params.complete,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    nextSeq: 1,
    events: [],
  };
}

function estimateSqliteLedgerBytes(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(length(session_id) + length(session_key) + length(cwd) + 32), 0) AS sessions,
         (SELECT COALESCE(SUM(length(session_id) + length(session_key) + length(update_json) + COALESCE(length(run_id), 0) + 32), 0)
            FROM acp_replay_events) AS events
       FROM acp_replay_sessions`,
    )
    .get() as { sessions?: number | bigint; events?: number | bigint } | undefined;
  return normalizeSqliteInteger(row?.sessions ?? 0) + normalizeSqliteInteger(row?.events ?? 0);
}

function trimSqliteLedger(
  db: DatabaseSync,
  state: Pick<MutableLedgerState, "maxEventsPerSession" | "maxSessions" | "maxSerializedBytes">,
): void {
  const sessionsWithCounts = db
    .prepare(
      `SELECT s.session_id AS session_id, COUNT(e.seq) AS event_count
         FROM acp_replay_sessions s
         LEFT JOIN acp_replay_events e ON e.session_id = s.session_id
        GROUP BY s.session_id`,
    )
    .all() as Array<{ session_id: string; event_count: number | bigint }>;
  for (const row of sessionsWithCounts) {
    const overage = normalizeSqliteInteger(row.event_count) - state.maxEventsPerSession;
    if (overage <= 0) {
      continue;
    }
    const oldEvents = db
      .prepare(
        `SELECT seq
           FROM acp_replay_events
          WHERE session_id = ?
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(row.session_id, overage) as Array<{ seq: number | bigint }>;
    const deleteEvent = db.prepare(
      "DELETE FROM acp_replay_events WHERE session_id = ? AND seq = ?",
    );
    for (const event of oldEvents) {
      deleteEvent.run(row.session_id, normalizeSqliteInteger(event.seq));
    }
    db.prepare("UPDATE acp_replay_sessions SET complete = 0 WHERE session_id = ?").run(
      row.session_id,
    );
  }

  const oldSessions = db
    .prepare(
      `SELECT session_id
         FROM acp_replay_sessions
        ORDER BY updated_at DESC, session_id ASC
        LIMIT -1 OFFSET ?`,
    )
    .all(state.maxSessions) as Array<{ session_id: string }>;
  for (const session of oldSessions) {
    db.prepare("DELETE FROM acp_replay_sessions WHERE session_id = ?").run(session.session_id);
  }

  let serializedBytes = estimateSqliteLedgerBytes(db);
  while (serializedBytes > state.maxSerializedBytes) {
    const event = db
      .prepare(
        `SELECT e.session_id AS session_id, e.seq AS seq
           FROM acp_replay_events e
           JOIN acp_replay_sessions s ON s.session_id = e.session_id
          ORDER BY s.updated_at ASC, e.seq ASC
          LIMIT 1`,
      )
      .get() as { session_id: string; seq: number | bigint } | undefined;
    if (!event) {
      break;
    }
    db.prepare("DELETE FROM acp_replay_events WHERE session_id = ? AND seq = ?").run(
      event.session_id,
      normalizeSqliteInteger(event.seq),
    );
    db.prepare("UPDATE acp_replay_sessions SET complete = 0 WHERE session_id = ?").run(
      event.session_id,
    );
    serializedBytes = estimateSqliteLedgerBytes(db);
  }

  while (serializedBytes > state.maxSerializedBytes) {
    const session = db
      .prepare(
        `SELECT session_id
           FROM acp_replay_sessions
          ORDER BY updated_at ASC, session_id ASC
          LIMIT 1`,
      )
      .get() as { session_id: string } | undefined;
    if (!session) {
      break;
    }
    db.prepare("DELETE FROM acp_replay_sessions WHERE session_id = ?").run(session.session_id);
    serializedBytes = estimateSqliteLedgerBytes(db);
  }
}

function appendSqliteUpdate(
  db: DatabaseSync,
  state: Pick<
    MutableLedgerState,
    "now" | "maxEventsPerSession" | "maxSessions" | "maxSerializedBytes"
  >,
  params: {
    sessionId: string;
    sessionKey: string;
    runId?: string;
    update: SessionUpdate;
  },
): void {
  const session = upsertSqliteSession(db, state, {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    cwd: "",
    complete: false,
  });
  const now = state.now();
  db.prepare(
    `INSERT INTO acp_replay_events (session_id, seq, at, session_key, run_id, update_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.sessionId,
    session.nextSeq,
    now,
    params.sessionKey,
    params.runId ?? null,
    JSON.stringify(cloneJsonValue(params.update)),
  );
  db.prepare(
    `UPDATE acp_replay_sessions
        SET session_key = ?, updated_at = ?, next_seq = ?
      WHERE session_id = ?`,
  ).run(params.sessionKey, now, session.nextSeq + 1, params.sessionId);
  trimSqliteLedger(db, state);
}

function buildSqliteReplay(session: LedgerSession | undefined): AcpEventLedgerReplay {
  if (!session?.complete) {
    return { complete: false, events: [] };
  }
  return {
    complete: true,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    events: session.events.map((event) => cloneJsonValue(event)),
  };
}

/** Creates the SQLite-backed ACP event ledger used by the state database. */
export function createSqliteAcpEventLedger(
  params: OpenClawStateDatabaseOptions & LedgerOptions = {},
): AcpEventLedger {
  const normalized = normalizeLedgerOptions(params);
  const dbOptions = { env: params.env, path: params.path };
  const state = {
    ...normalized,
  };
  const mutate = (fn: (db: DatabaseSync) => void) =>
    runOpenClawStateWriteTransaction((database) => fn(database.db), dbOptions);
  const read = <T>(fn: (db: DatabaseSync) => T): T => fn(openOpenClawStateDatabase(dbOptions).db);

  return {
    async startSession(sessionParams) {
      mutate((db) => {
        upsertSqliteSession(db, state, sessionParams);
        trimSqliteLedger(db, state);
      });
    },

    async recordUserPrompt(promptParams) {
      mutate((db) => {
        for (const update of createUserPromptUpdates(promptParams.prompt)) {
          appendSqliteUpdate(db, state, {
            sessionId: promptParams.sessionId,
            sessionKey: promptParams.sessionKey,
            runId: promptParams.runId,
            update,
          });
        }
      });
    },

    async recordUpdate(updateParams) {
      mutate((db) => {
        appendSqliteUpdate(db, state, updateParams);
      });
    },

    async markIncomplete(markParams) {
      mutate((db) => {
        db.prepare(
          `UPDATE acp_replay_sessions
              SET complete = 0, updated_at = ?
            WHERE session_id = ? AND session_key = ?`,
        ).run(state.now(), markParams.sessionId, markParams.sessionKey);
      });
    },

    async readReplay(replayParams) {
      return read((db) => {
        const session = readSqliteSessionById(db, replayParams.sessionId);
        if (session?.sessionKey !== replayParams.sessionKey) {
          return { complete: false, events: [] };
        }
        return buildSqliteReplay(session);
      });
    },

    async readReplayBySessionId(replayParams) {
      return read((db) => buildSqliteReplay(readSqliteSessionById(db, replayParams.sessionId)));
    },

    async readReplayBySessionKey(replayParams) {
      return read((db) =>
        buildSqliteReplay(readLatestCompleteSqliteSessionByKey(db, replayParams.sessionKey)),
      );
    },
  };
}
