import { z } from "zod";
/** SQLite-backed persistence for durable per-agent Talk voice-call records. */
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

export const VOICE_SESSION_CACHE_SCOPE = "talk-client-voice-sessions";
export const VOICE_SESSION_RECORD_VERSION = 1;
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
  /** Bounded hashes of transcript entries that must succeed before close can commit. */
  transcriptFailureKeys: string[];
  /** Declared at create when the client speaks the transcript protocol (sent sessionKey). */
  transcriptCapable?: boolean;
  /** Set once a finalized user utterance persisted; gates spoken confirmation capability. */
  hasUserTranscript?: boolean;
};

export type ClientVoiceRunBinding = Readonly<{
  agentId: string;
  voiceSessionId: string;
  sessionKey: string;
}>;

const TRANSCRIPT_FAILURE_KEY_PATTERN = /^[0-9a-f]{64}$/;

const clientVoiceToolEffectSchema = z.looseObject({
  runId: z.string(),
  toolName: z.string(),
  startedAt: z.number(),
  status: z.enum(["started", "succeeded", "failed", "cancelled", "blocked"]),
});

const clientVoiceSessionRecordSchema = z.looseObject({
  version: z.literal(VOICE_SESSION_RECORD_VERSION),
  voiceSessionId: z.string(),
  agentId: z.string(),
  sessionKey: z.string(),
  provider: z
    .string()
    .refine((value) => value.trim().length > 0)
    .transform((value) => value.trim())
    .optional(),
  origin: z.enum(["client", "relay"]),
  status: z.enum(["open", "closed"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  consultRunIds: z
    .unknown()
    .optional()
    .transform((value) =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [],
    ),
  effects: z
    .unknown()
    .optional()
    .transform((value) =>
      Array.isArray(value)
        ? value.flatMap((entry) => {
            const parsed = clientVoiceToolEffectSchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
          })
        : [],
    ),
  transcriptFailureKeys: z
    .unknown()
    .optional()
    .transform((value) => value ?? [])
    .pipe(
      z
        .array(z.string().regex(TRANSCRIPT_FAILURE_KEY_PATTERN))
        .max(VOICE_TRANSCRIPT_MAX_UNRESOLVED)
        .refine((keys) => new Set(keys).size === keys.length),
    ),
});

function parseVoiceSessionRecord(value: unknown): ClientVoiceSessionRecord | undefined {
  const parsed = clientVoiceSessionRecordSchema.safeParse(value);
  return parsed.success ? (parsed.data as ClientVoiceSessionRecord) : undefined;
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
