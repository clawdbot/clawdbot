/** SQLite-backed persistence for durable per-agent Talk voice-call records. */
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";

export const VOICE_SESSION_CACHE_SCOPE = "talk-client-voice-sessions";
export const VOICE_SESSION_RECORD_VERSION = 1;
export const VOICE_SESSION_MAX_TRANSCRIPT_CHARS = 8_000;
export const VOICE_SESSION_STALE_AFTER_MS = 6 * 60 * 60_000;

export type ClientVoiceToolEffect = {
  runId: string;
  toolCallId?: string;
  toolName: string;
  startedAt: number;
  finishedAt?: number;
  status: "started" | "succeeded" | "failed" | "cancelled" | "blocked";
};

export type ClientVoiceSessionRecord = {
  version: typeof VOICE_SESSION_RECORD_VERSION;
  voiceSessionId: string;
  agentId: string;
  sessionKey: string;
  provider?: string;
  origin: "client" | "relay";
  status: "open" | "closed";
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  consultRunIds: string[];
  effects: ClientVoiceToolEffect[];
  digestDeliveredAt?: number;
  /** Declared at create when the client speaks the transcript protocol (sent sessionKey). */
  transcriptCapable?: boolean;
  /** Set once a finalized user utterance persisted; gates spoken confirmation capability. */
  hasUserTranscript?: boolean;
};

export type ClientVoiceRunBinding = {
  agentId: string;
  voiceSessionId: string;
  sessionKey: string;
};

function parseVoiceSessionRecord(value: unknown): ClientVoiceSessionRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<ClientVoiceSessionRecord>;
  if (
    record.version !== VOICE_SESSION_RECORD_VERSION ||
    typeof record.voiceSessionId !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.sessionKey !== "string" ||
    (record.provider !== undefined &&
      (typeof record.provider !== "string" || !record.provider.trim())) ||
    (record.origin !== "client" && record.origin !== "relay") ||
    (record.status !== "open" && record.status !== "closed") ||
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number"
  ) {
    return undefined;
  }
  const consultRunIds = Array.isArray(record.consultRunIds)
    ? record.consultRunIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const effects = Array.isArray(record.effects)
    ? record.effects.filter((entry): entry is ClientVoiceToolEffect => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        const effect = entry as Partial<ClientVoiceToolEffect>;
        return (
          typeof effect.runId === "string" &&
          typeof effect.toolName === "string" &&
          typeof effect.startedAt === "number" &&
          (effect.status === "started" ||
            effect.status === "succeeded" ||
            effect.status === "failed" ||
            effect.status === "cancelled" ||
            effect.status === "blocked")
        );
      })
    : [];
  const provider = record.provider?.trim();
  return {
    ...record,
    ...(provider ? { provider } : {}),
    consultRunIds,
    effects,
  } as ClientVoiceSessionRecord;
}

export function parseStoredVoiceSessionRecord(
  valueJson: unknown,
): ClientVoiceSessionRecord | undefined {
  if (typeof valueJson !== "string") {
    return undefined;
  }
  try {
    return parseVoiceSessionRecord(JSON.parse(valueJson));
  } catch {
    return undefined;
  }
}

export function readVoiceSessionRecord(
  agentId: string,
  voiceSessionId: string,
): ClientVoiceSessionRecord | undefined {
  const database = openOpenClawAgentDatabase({ agentId });
  const row = database.db
    .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
    .get(VOICE_SESSION_CACHE_SCOPE, voiceSessionId) as { value_json?: unknown } | undefined;
  return parseStoredVoiceSessionRecord(row?.value_json);
}

export function readVoiceSessionRecordInTransaction(
  database: OpenClawAgentDatabase,
  voiceSessionId: string,
): ClientVoiceSessionRecord | undefined {
  const row = database.db
    .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
    .get(VOICE_SESSION_CACHE_SCOPE, voiceSessionId) as { value_json?: unknown } | undefined;
  return parseStoredVoiceSessionRecord(row?.value_json);
}

export function writeVoiceSessionRecordInTransaction(
  database: OpenClawAgentDatabase,
  record: ClientVoiceSessionRecord,
): void {
  database.db
    .prepare(
      `INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(scope, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      VOICE_SESSION_CACHE_SCOPE,
      record.voiceSessionId,
      JSON.stringify(record),
      record.updatedAt,
    );
}

export function assertVoiceSessionOwnership(
  record: ClientVoiceSessionRecord,
  params: { agentId: string; sessionKey: string },
): void {
  if (record.agentId !== params.agentId || record.sessionKey !== params.sessionKey) {
    throw new Error("voice session does not belong to this agent session");
  }
}

export function operationKey(agentId: string, voiceSessionId: string): string {
  return `${agentId}\0${voiceSessionId}`;
}
