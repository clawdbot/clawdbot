import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "../utils.js";

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_EVENTS_PER_SESSION = 5_000;
const DEFAULT_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;

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

export type AcpLedgerOptions = {
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxSerializedBytes?: number;
  now?: () => number;
};

export type AcpMutableLedgerState = {
  maxSessions: number;
  maxEventsPerSession: number;
  maxSerializedBytes: number;
  now: () => number;
};

export function normalizeAcpLedgerOptions(options: AcpLedgerOptions = {}) {
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

export function cloneAcpLedgerValue<T>(value: T): T {
  return structuredClone(value);
}

export function createAcpPromptUpdates(prompt: readonly ContentBlock[]): SessionUpdate[] {
  return prompt.map((content) => ({
    sessionUpdate: "user_message_chunk",
    content: cloneAcpLedgerValue(content),
  }));
}

export function normalizeAcpLedgerEvent(raw: unknown): AcpEventLedgerEntry | undefined {
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
    update: cloneAcpLedgerValue(raw.update) as SessionUpdate,
  };
}
