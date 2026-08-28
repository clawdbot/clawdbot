/** Durable per-agent voice-call records for Talk continuity and mutation evidence. */
import { createHash, randomUUID } from "node:crypto";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import { mergeSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationUtterance,
  releaseClientVoiceConfirmationRun,
} from "./client-voice-confirmation.js";
import {
  CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  ClientVoiceMutationDigestOwner,
  deliverClientVoiceMutationDigest,
} from "./client-voice-mutation-digest-owner.js";
import {
  assertVoiceSessionOwnership as assertOwnership,
  type ClientVoiceRunBinding,
  type ClientVoiceSessionRecord,
  type ClientVoiceToolEffect,
  operationKey,
  parseStoredVoiceSessionRecord as parseStoredRecord,
  readVoiceSessionRecord as readRecord,
  readVoiceSessionRecordInTransaction as readRecordInTransaction,
  VOICE_SESSION_CACHE_SCOPE as CACHE_SCOPE,
  VOICE_SESSION_RECORD_VERSION as RECORD_VERSION,
  VOICE_SESSION_STALE_AFTER_MS as STALE_AFTER_MS,
  writeVoiceSessionRecordInTransaction as writeRecordInTransaction,
} from "./client-voice-session-store.js";
import {
  createVoiceTranscriptOperationRegistry,
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_MAX_UNRESOLVED,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "./voice-transcript.js";

const voiceSessionByRunId = new Map<string, ClientVoiceRunBinding>();
const voiceSessionOperations = createVoiceTranscriptOperationRegistry(
  VOICE_TRANSCRIPT_QUEUE_POLICY,
);
let unsubscribeToolEffects: (() => void) | undefined;
let unsubscribeRunCompletion: (() => void) | undefined;

function hasLiveConsultRun(record: ClientVoiceSessionRecord): boolean {
  return record.consultRunIds.some((runId) => {
    const binding = voiceSessionByRunId.get(runId);
    return (
      binding?.agentId === record.agentId &&
      binding.voiceSessionId === record.voiceSessionId &&
      binding.sessionKey === record.sessionKey
    );
  });
}

async function runVoiceSessionOperation<T>(
  agentId: string,
  voiceSessionId: string,
  operation: () => Promise<T>,
  options: { weight?: number; waitForCapacity?: boolean } = {},
): Promise<T> {
  return await voiceSessionOperations.run(
    operationKey(agentId, voiceSessionId),
    operation,
    options,
  );
}

async function closeVoiceSessionOperationOwner(
  params: Parameters<typeof closeClientVoiceSessionInternal>[0],
): Promise<void> {
  await voiceSessionOperations.close(
    operationKey(params.agentId, params.voiceSessionId),
    async () => closeClientVoiceSessionInternal(params),
  );
}

function effectStatus(event: TrustedToolExecutionEvent): ClientVoiceToolEffect["status"] {
  if (event.type === "tool.execution.started") {
    return "started";
  }
  if (event.type === "tool.execution.completed") {
    return "succeeded";
  }
  if (event.type === "tool.execution.blocked") {
    return "blocked";
  }
  return event.terminalReason === "cancelled" ? "cancelled" : "failed";
}

function recordClientVoiceToolEffect(event: TrustedToolExecutionEvent): void {
  const runId = event.runId;
  if (!runId) {
    return;
  }
  const binding = voiceSessionByRunId.get(runId);
  if (!binding) {
    return;
  }
  runOpenClawAgentWriteTransaction(
    (database) => {
      const record = readRecordInTransaction(database, binding.voiceSessionId);
      if (!record) {
        return;
      }
      const existing = event.toolCallId
        ? record.effects.find(
            (effect) => effect.runId === runId && effect.toolCallId === event.toolCallId,
          )
        : record.effects.findLast(
            (effect) =>
              effect.runId === runId &&
              effect.toolName === event.toolName &&
              effect.status === "started",
          );
      if (event.type !== "tool.execution.started" && !existing) {
        return;
      }
      if (event.type !== "tool.execution.started" && existing) {
        existing.status = effectStatus(event);
        existing.finishedAt = event.ts;
      } else if (event.mutatingAction === true && (!event.toolCallId || !existing)) {
        record.effects.push({
          runId,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          toolName: event.toolName,
          startedAt: event.ts,
          status: "started",
        });
      }
      record.updatedAt = Date.now();
      writeRecordInTransaction(database, record);
    },
    { agentId: binding.agentId },
  );
}

function ensureToolEffectSubscription(): void {
  unsubscribeToolEffects ??= onTrustedToolExecutionEvent(recordClientVoiceToolEffect);
  unsubscribeRunCompletion ??= onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type !== "run.completed") {
        return;
      }
      const binding = voiceSessionByRunId.get(event.runId);
      if (!binding) {
        return;
      }
      voiceSessionByRunId.delete(event.runId);
      releaseClientVoiceConfirmationRun(binding.agentId, binding.voiceSessionId, event.runId);
      mutationDigestDeliveryOwner.retry(binding);
    },
    { include: ["run.completed"] },
  );
}

/** Create a call record or resume the same open call across transport restarts. */
export function createOrResumeClientVoiceSession(params: {
  agentId: string;
  sessionKey: string;
  provider?: string;
  origin: "client" | "relay";
  transcriptCapable?: boolean;
  voiceSessionId?: string;
  now?: number;
}): string {
  const voiceSessionId = params.voiceSessionId?.trim() || randomUUID();
  const provider = params.provider?.trim() || undefined;
  const now = params.now ?? Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const existing = readRecordInTransaction(database, voiceSessionId);
      if (existing) {
        assertOwnership(existing, params);
        if (existing.origin !== params.origin) {
          throw new Error("voice session origin does not match");
        }
        if (existing.status !== "open") {
          throw new Error("voice session is already closed");
        }
        if (existing.provider && provider && existing.provider !== provider) {
          throw new Error("voice session provider does not match");
        }
        if (!existing.provider && provider) {
          existing.provider = provider;
        }
        if (params.transcriptCapable === true) {
          existing.transcriptCapable = true;
        }
        existing.updatedAt = now;
        writeRecordInTransaction(database, existing);
        return;
      }
      writeRecordInTransaction(database, {
        version: RECORD_VERSION,
        voiceSessionId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(provider ? { provider } : {}),
        origin: params.origin,
        ...(params.transcriptCapable === true ? { transcriptCapable: true } : {}),
        status: "open",
        createdAt: now,
        updatedAt: now,
        consultRunIds: [],
        effects: [],
        transcriptFailureKeys: [],
      });
    },
    { agentId: params.agentId },
  );
  return voiceSessionId;
}

/** Read the canonical agent-session id without creating state during provider startup. */
export function resolveClientVoiceAgentSessionId(params: {
  agentId: string;
  sessionKey: string;
}): string | undefined {
  return loadSessionEntryReadOnly(params)?.sessionId?.trim() || undefined;
}

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  deadlineAt?: number;
  creation?: Pick<Parameters<typeof buildSessionCreationStamp>[0], "actor" | "sandbox">;
}): Promise<string> {
  const created = await patchSessionEntryCore(
    params,
    (_entry, context) => {
      // Browser credentials can be short-lived. Check at the authoritative
      // write boundary so a queued write cannot create an unusable empty chat.
      if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
        throw new Error("Realtime browser session expired during startup; try again");
      }
      if (context.existingEntry?.sessionId) {
        return null;
      }
      if (context.existingEntry) {
        return { sessionId: randomUUID() };
      }
      return buildSessionCreationStamp({
        via: "talk",
        actor: params.creation?.actor ?? { type: "human" },
        sandbox: params.creation?.sandbox,
      });
    },
    { fallbackEntry: mergeSessionEntry(undefined, {}) },
  );
  if (!created?.sessionId) {
    throw new Error(`agent session could not be initialized (${params.sessionKey})`);
  }
  return created.sessionId;
}

/** Correlate a consult run with its open call for confirmation and mutation evidence. */
export function registerClientVoiceConsultRun(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  runId: string;
  config?: OpenClawConfig;
}): void {
  let recordClosed = false;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const record = readRecordInTransaction(database, params.voiceSessionId);
      if (!record) {
        throw new Error("voice session not found");
      }
      assertOwnership(record, params);
      recordClosed = record.status === "closed";
      // A close can race in while chat.send is still acking this run. The run has
      // already started, so bind it anyway (even on a closed record) to keep effect
      // capture; aborting here would drop a just-confirmed high-impact action.
      if (!record.consultRunIds.includes(params.runId)) {
        record.consultRunIds.push(params.runId);
        record.updatedAt = Date.now();
        writeRecordInTransaction(database, record);
      }
    },
    { agentId: params.agentId },
  );
  const previousBinding = voiceSessionByRunId.get(params.runId);
  if (
    previousBinding &&
    (previousBinding.agentId !== params.agentId ||
      previousBinding.voiceSessionId !== params.voiceSessionId)
  ) {
    // A run ID has one authoritative voice scope. Replacing it must retire the
    // prior scope's post-close grant or completion can no longer find that owner.
    releaseClientVoiceConfirmationRun(
      previousBinding.agentId,
      previousBinding.voiceSessionId,
      params.runId,
    );
  }
  voiceSessionByRunId.set(params.runId, {
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    sessionKey: params.sessionKey,
  });
  // Bound to a call that already closed: re-arm the point-in-time summary owner so
  // the run completion becomes a retry point without coupling it to transcript work.
  if (recordClosed && params.config) {
    mutationDigestDeliveryOwner.record({
      agentId: params.agentId,
      voiceSessionId: params.voiceSessionId,
      context: params.config,
    });
  }
  ensureToolEffectSubscription();
}

/** Return the open voice-call binding for one executing run. */
export function resolveClientVoiceRunBinding(runId?: string): ClientVoiceRunBinding | undefined {
  return runId ? voiceSessionByRunId.get(runId) : undefined;
}

/**
 * Confirmation applies only when the session can observe spoken approvals:
 * relay sessions (server hears utterances) or clients that report transcripts.
 * Legacy clients without transcript reporting keep pre-gate behavior.
 */
export function isClientVoiceSessionConfirmable(binding: ClientVoiceRunBinding): boolean {
  const record = readRecord(binding.agentId, binding.voiceSessionId);
  return (
    record?.origin === "relay" ||
    record?.transcriptCapable === true ||
    record?.hasUserTranscript === true
  );
}

/** Validate ownership and open state before starting a voice-bound consult. */
export function assertClientVoiceSessionOpen(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
}): "client" | "relay" {
  const record = readRecord(params.agentId, params.voiceSessionId);
  if (!record) {
    throw new Error("voice session not found");
  }
  assertOwnership(record, params);
  if (record.status !== "open") {
    throw new Error("voice session is closed");
  }
  return record.origin;
}

/** Validate durable ownership without rejecting an idempotent close retry. */
export function resolveClientVoiceSessionOrigin(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
}): "client" | "relay" {
  const record = readRecord(params.agentId, params.voiceSessionId);
  if (!record) {
    throw new Error("voice session not found");
  }
  assertOwnership(record, params);
  return record.origin;
}

/** Resolve the newest open client-owned call for legacy tool-call clients. */
export function resolveOpenClientVoiceSessionId(params: {
  agentId: string;
  sessionKey: string;
}): string | undefined {
  const database = openOpenClawAgentDatabase({ agentId: params.agentId });
  const rows = database.db
    .prepare("SELECT value_json FROM cache_entries WHERE scope = ? ORDER BY updated_at DESC")
    .all(CACHE_SCOPE) as Array<{ value_json?: unknown }>;
  let match: string | undefined;
  for (const row of rows) {
    const record = parseStoredRecord(row.value_json);
    if (
      record?.origin === "client" &&
      record.status === "open" &&
      record.agentId === params.agentId &&
      record.sessionKey === params.sessionKey
    ) {
      if (match) {
        return undefined;
      }
      match = record.voiceSessionId;
    }
  }
  return match;
}

function buildPersistedVoiceMessage(params: {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  provider: string;
}): Record<string, unknown> {
  const provenance = { kind: "realtime_voice", sourceChannel: "talk" };
  if (params.role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: params.text }],
      timestamp: params.timestamp,
      provenance,
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "realtime",
    provider: params.provider,
    model: "realtime-voice",
    stopReason: "stop",
    timestamp: params.timestamp,
    provenance,
  };
}

function transcriptFailureKey(entryId: string): string {
  return createHash("sha256").update(entryId, "utf8").digest("hex");
}

function appendVoiceTranscript(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  origin: "client" | "relay";
  entryId: string;
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  config?: OpenClawConfig;
}): Promise<void> {
  // Normalize before admission so the queued task retains only bounded text.
  const normalized = { ...params, text: normalizeVoiceTranscriptText(params.text) };
  if (!normalized.text) {
    return Promise.resolve();
  }
  return runVoiceSessionOperation(
    normalized.agentId,
    normalized.voiceSessionId,
    async () => {
      const record = readRecord(normalized.agentId, normalized.voiceSessionId);
      if (!record) {
        throw new Error("voice session not found");
      }
      assertOwnership(record, normalized);
      if (record.status !== "open") {
        throw new Error("voice session is closed");
      }
      if (record.origin !== normalized.origin) {
        throw new Error("voice session origin does not allow this transcript source");
      }
      const failureKey = transcriptFailureKey(normalized.entryId);
      if (
        record.transcriptFailureKeys.length >= VOICE_TRANSCRIPT_MAX_UNRESOLVED &&
        !record.transcriptFailureKeys.includes(failureKey)
      ) {
        throw new Error("voice transcript persistence has too many unresolved entries");
      }
      const sessionEntry = loadSessionEntryReadOnly({
        agentId: normalized.agentId,
        sessionKey: normalized.sessionKey,
      });
      if (!sessionEntry?.sessionId) {
        throw new Error(`agent session not found (${normalized.sessionKey})`);
      }
      const observedAt = Date.now();
      const timestamp = normalized.timestamp ?? observedAt;
      // Reserve before the fallible append. A crash can leave a conservative
      // retry requirement, but can never let close skip an accepted entry.
      runOpenClawAgentWriteTransaction(
        (database) => {
          const current = readRecordInTransaction(database, normalized.voiceSessionId);
          if (!current) {
            throw new Error("voice session disappeared during transcript reservation");
          }
          assertOwnership(current, normalized);
          if (!current.transcriptFailureKeys.includes(failureKey)) {
            current.transcriptFailureKeys.push(failureKey);
          }
          current.updatedAt = Date.now();
          writeRecordInTransaction(database, current);
        },
        { agentId: normalized.agentId },
      );
      await appendTranscriptMessage(
        {
          agentId: normalized.agentId,
          sessionId: sessionEntry.sessionId,
          sessionKey: normalized.sessionKey,
        },
        {
          ...(normalized.config ? { config: normalized.config } : {}),
          eventId: `voice:${normalized.voiceSessionId}:${normalized.entryId}`,
          message: buildPersistedVoiceMessage({
            role: normalized.role,
            text: normalized.text,
            timestamp,
            provider: record.provider ?? "realtime",
          }),
          now: timestamp,
        },
      );
      runOpenClawAgentWriteTransaction(
        (database) => {
          const current = readRecordInTransaction(database, normalized.voiceSessionId);
          if (!current) {
            throw new Error("voice session disappeared during transcript append");
          }
          assertOwnership(current, normalized);
          // Reaching here means this exact eventId is durably persisted (fresh append or
          // idempotent dedup of our own prior write). Arm confirmation bookkeeping in both
          // cases so a retry after a partial failure still records the user utterance.
          if (normalized.role === "user") {
            current.hasUserTranscript = true;
          }
          current.transcriptFailureKeys = current.transcriptFailureKeys.filter(
            (key) => key !== failureKey,
          );
          current.updatedAt = Date.now();
          writeRecordInTransaction(database, current);
        },
        { agentId: normalized.agentId },
      );
      if (normalized.role === "user") {
        noteClientVoiceConfirmationUtterance({
          agentId: normalized.agentId,
          voiceSessionId: normalized.voiceSessionId,
          text: normalized.text,
          timestamp: observedAt,
        });
      }
    },
    { weight: normalized.text.length },
  );
}

/** Append one finalized client-owned transcript item idempotently. */
export function appendClientVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "client" });
}

/** Wait for the accepted transcript/effect prefix without closing the logical call. */
export async function flushClientVoiceSessionWrites(params: {
  agentId: string;
  voiceSessionId: string;
}): Promise<void> {
  await voiceSessionOperations.flush(operationKey(params.agentId, params.voiceSessionId));
}

/** Append one finalized relay-owned transcript item idempotently. */
export function appendRelayVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
): Promise<void> {
  return appendVoiceTranscript({ ...params, origin: "relay" });
}

const mutationDigestDeliveryOwner = new ClientVoiceMutationDigestOwner<OpenClawConfig>({
  attempt: async ({ agentId, voiceSessionId, context: config, signal }) => {
    const record = readRecord(agentId, voiceSessionId);
    if (!record) {
      return true;
    }
    if (record.status !== "closed" || hasLiveConsultRun(record)) {
      return false;
    }
    await deliverClientVoiceMutationDigest(record, config, signal);
    return true;
  },
  warn: (message) => console.warn(`[talk] deferred voice mutation digest failed: ${message}`),
});

async function closeClientVoiceSessionInternal(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  transcriptFailurePolicy: "require-success" | "retain-and-close";
  now?: number;
}): Promise<void> {
  const existing = readRecord(params.agentId, params.voiceSessionId);
  if (!existing) {
    throw new Error("voice session not found");
  }
  assertOwnership(existing, params);
  const now = params.now ?? Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const current = readRecordInTransaction(database, params.voiceSessionId);
      if (!current) {
        throw new Error("voice session disappeared during close");
      }
      assertOwnership(current, params);
      if (
        current.transcriptFailureKeys.length > 0 &&
        params.transcriptFailurePolicy === "require-success"
      ) {
        throw new Error("voice transcript persistence must be retried before close");
      }
      if (params.transcriptFailurePolicy === "retain-and-close" && current.origin !== "relay") {
        throw new Error("only relay voice sessions may close with unresolved transcripts");
      }
      if (current.status === "open") {
        current.status = "closed";
        current.closedAt = now;
        current.updatedAt = now;
        writeRecordInTransaction(database, current);
      }
    },
    { agentId: params.agentId },
  );
  const closed = readRecord(params.agentId, params.voiceSessionId);
  if (!closed) {
    throw new Error("voice session disappeared after close");
  }
  // Transport close does not end consult runs: live bindings keep effect capture active,
  // approved grants stay valid for those runs, and the digest waits for the last run.completed.
  const liveRunIds = closed.consultRunIds.filter((runId) => {
    const binding = voiceSessionByRunId.get(runId);
    return binding?.voiceSessionId === params.voiceSessionId && binding.agentId === params.agentId;
  });
  deactivateClientVoiceConfirmationSession(params.agentId, params.voiceSessionId, liveRunIds);
  // Record retry ownership only after canonical close and confirmation cleanup.
  // Channel delivery is best-effort and must never delay this durable boundary.
  mutationDigestDeliveryOwner.record({
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    context: params.config,
  });
}

/** Close a logical voice call after its accepted transcript prefix is durable. */
export async function closeClientVoiceSession(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  now?: number;
}): Promise<void> {
  await closeVoiceSessionOperationOwner({
    ...params,
    transcriptFailurePolicy: "require-success",
  });
}

/**
 * Terminally close a relay call after its bounded append retries settle.
 * Relays have no payload replay owner after teardown, so unresolved hashes remain as audit state.
 */
export async function closeRelayVoiceSessionRecord(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  now?: number;
}): Promise<void> {
  await closeVoiceSessionOperationOwner({
    ...params,
    transcriptFailurePolicy: "retain-and-close",
  });
}

/** Close abandoned open calls idle for the fixed six-hour recovery window. */
export async function closeStaleClientVoiceSessions(params: {
  agentId: string;
  config: OpenClawConfig;
  excludeVoiceSessionId?: string;
  now?: number;
  warn?: (message: string) => void;
}): Promise<number> {
  const now = params.now ?? Date.now();
  // A new voice session remains a retry point, but channel I/O is detached so a
  // stalled adapter cannot block stale-session recovery.
  mutationDigestDeliveryOwner.retryAgent(params.agentId, params.config);
  const database = openOpenClawAgentDatabase({ agentId: params.agentId });
  const rows = database.db
    .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND updated_at <= ?")
    .all(CACHE_SCOPE, now - STALE_AFTER_MS) as Array<{ value_json?: unknown }>;
  const stale = rows.flatMap((row) => {
    const record = parseStoredRecord(row.value_json);
    return record &&
      record.status === "open" &&
      record.voiceSessionId !== params.excludeVoiceSessionId
      ? [record]
      : [];
  });
  let closed = 0;
  for (const record of stale) {
    try {
      await closeClientVoiceSession({
        agentId: params.agentId,
        sessionKey: record.sessionKey,
        voiceSessionId: record.voiceSessionId,
        config: params.config,
        now,
      });
      closed += 1;
    } catch (error) {
      params.warn?.(
        `failed to close stale voice session ${record.voiceSessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return closed;
}

const clientVoiceSessionTesting = {
  readRecord,
  digestDeliveryPolicy: CLIENT_VOICE_MUTATION_DIGEST_POLICY,
  digestDeliverySnapshot: () => mutationDigestDeliveryOwner.snapshot(),
  reset(): void {
    voiceSessionByRunId.clear();
    voiceSessionOperations.clear();
    mutationDigestDeliveryOwner.clear();
    unsubscribeToolEffects?.();
    unsubscribeToolEffects = undefined;
    unsubscribeRunCompletion?.();
    unsubscribeRunCompletion = undefined;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.clientVoiceSessionTestApi")] =
    clientVoiceSessionTesting;
}
