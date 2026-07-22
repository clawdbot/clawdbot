/** Durable per-agent voice-call records for Talk continuity and mutation evidence. */
import { randomUUID } from "node:crypto";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadSessionEntryReadOnly,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../infra/diagnostic-events.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveSessionDeliveryTarget } from "../infra/outbound/targets-session.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { truncateUtf16Safe } from "../utils.js";
import {
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationUtterance,
  releaseClientVoiceConfirmationRun,
} from "./client-voice-confirmation.js";
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
  VOICE_SESSION_MAX_TRANSCRIPT_CHARS as MAX_TRANSCRIPT_CHARS,
  VOICE_SESSION_RECORD_VERSION as RECORD_VERSION,
  VOICE_SESSION_STALE_AFTER_MS as STALE_AFTER_MS,
  writeVoiceSessionRecordInTransaction as writeRecordInTransaction,
} from "./client-voice-session-store.js";

const voiceSessionByRunId = new Map<string, ClientVoiceRunBinding>();
const voiceSessionOperations = new Map<string, Promise<void>>();
const deferredDigestConfigs = new Map<string, OpenClawConfig>();
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
): Promise<T> {
  const key = operationKey(agentId, voiceSessionId);
  const previous = voiceSessionOperations.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  voiceSessionOperations.set(key, settled);
  void settled.then(() => {
    if (voiceSessionOperations.get(key) === settled) {
      voiceSessionOperations.delete(key);
    }
  });
  return await current;
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
  unsubscribeRunCompletion ??= onTrustedInternalDiagnosticEvent((event) => {
    if (event.type !== "run.completed") {
      return;
    }
    const binding = voiceSessionByRunId.get(event.runId);
    if (!binding) {
      return;
    }
    voiceSessionByRunId.delete(event.runId);
    releaseClientVoiceConfirmationRun(binding.agentId, binding.voiceSessionId, event.runId);
    void finishDeferredMutationDigest(binding).catch((error: unknown) => {
      console.warn(
        `[talk] deferred voice mutation digest failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });
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
      });
    },
    { agentId: params.agentId },
  );
  return voiceSessionId;
}

/** Ensure Talk has the same canonical agent-session row that chat turns append to. */
export async function ensureClientVoiceAgentSessionEntry(params: {
  agentId: string;
  sessionKey: string;
}): Promise<void> {
  const existing = loadSessionEntry(params);
  if (existing?.sessionId) {
    return;
  }
  const created = await upsertSessionEntry(params, {});
  if (!created?.sessionId) {
    throw new Error(`agent session could not be initialized (${params.sessionKey})`);
  }
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
  voiceSessionByRunId.set(params.runId, {
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    sessionKey: params.sessionKey,
  });
  // Bound to a call that already closed: its digest may have been delivered and its
  // retry config cleared, so re-arm it to cover this late run's mutations.
  if (recordClosed && params.config) {
    deferredDigestConfigs.set(operationKey(params.agentId, params.voiceSessionId), params.config);
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

async function appendVoiceTranscript(params: {
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
  await runVoiceSessionOperation(params.agentId, params.voiceSessionId, async () => {
    const text = truncateUtf16Safe(params.text.trim(), MAX_TRANSCRIPT_CHARS);
    if (!text) {
      return;
    }
    const record = readRecord(params.agentId, params.voiceSessionId);
    if (!record) {
      throw new Error("voice session not found");
    }
    assertOwnership(record, params);
    if (record.status !== "open") {
      throw new Error("voice session is closed");
    }
    if (record.origin !== params.origin) {
      throw new Error("voice session origin does not allow this transcript source");
    }
    const sessionEntry = loadSessionEntryReadOnly({
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    if (!sessionEntry?.sessionId) {
      throw new Error(`agent session not found (${params.sessionKey})`);
    }
    const observedAt = Date.now();
    const timestamp = params.timestamp ?? observedAt;
    await appendTranscriptMessage(
      {
        agentId: params.agentId,
        sessionId: sessionEntry.sessionId,
        sessionKey: params.sessionKey,
      },
      {
        ...(params.config ? { config: params.config } : {}),
        eventId: `voice:${params.voiceSessionId}:${params.entryId}`,
        message: buildPersistedVoiceMessage({
          role: params.role,
          text,
          timestamp,
          provider: record.provider ?? "realtime",
        }),
        now: timestamp,
      },
    );
    runOpenClawAgentWriteTransaction(
      (database) => {
        const current = readRecordInTransaction(database, params.voiceSessionId);
        if (!current) {
          throw new Error("voice session disappeared during transcript append");
        }
        assertOwnership(current, params);
        // Reaching here means this exact eventId is durably persisted (fresh append or
        // idempotent dedup of our own prior write). Arm confirmation bookkeeping in both
        // cases so a retry after a partial failure still records the user utterance.
        if (params.role === "user") {
          current.hasUserTranscript = true;
        }
        current.updatedAt = Date.now();
        writeRecordInTransaction(database, current);
      },
      { agentId: params.agentId },
    );
    if (params.role === "user") {
      noteClientVoiceConfirmationUtterance({
        agentId: params.agentId,
        voiceSessionId: params.voiceSessionId,
        text,
        timestamp: observedAt,
      });
    }
  });
}

/** Append one finalized client-owned transcript item idempotently. */
export async function appendClientVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
): Promise<void> {
  await appendVoiceTranscript({ ...params, origin: "client" });
}

/** Append one finalized relay-owned transcript item idempotently. */
export async function appendRelayVoiceTranscript(
  params: Omit<Parameters<typeof appendVoiceTranscript>[0], "origin">,
): Promise<void> {
  await appendVoiceTranscript({ ...params, origin: "relay" });
}

// The mutation digest is a best-effort informational summary, not a durable record:
// the authoritative effects live on the voice record and the canonical transcript is
// persisted independently. Accepted tradeoffs (retry state is process-local like the
// rest of this subsystem): a digest already delivered at close does not reissue for a
// run that binds afterward, and an undelivered digest whose retry map is cleared by a
// gateway restart is not rediscovered. Both lose a summary message, never real data.
function formatMutationDigest(effects: ClientVoiceToolEffect[]): string | undefined {
  if (effects.length === 0) {
    return undefined;
  }
  return [
    "Voice call changes",
    ...effects
      .slice(0, 12)
      .map(
        (effect) =>
          `- ${effect.toolName}: ${effect.status === "started" ? "outcome not confirmed" : effect.status}`,
      ),
  ].join("\n");
}

async function deliverMutationDigest(
  record: ClientVoiceSessionRecord,
  config: OpenClawConfig,
  target: { channel: string; to: string; accountId?: string; threadId?: string | number | null },
  text: string,
): Promise<void> {
  const { sendDurableMessageBatch } = await import("../channels/message/runtime.js");
  const send = await sendDurableMessageBatch({
    cfg: config,
    channel: target.channel,
    to: target.to,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.threadId != null ? { threadId: target.threadId } : {}),
    payloads: [{ text }],
    durability: "required",
    requireUnknownSendReconciliation: true,
    session: buildOutboundSessionContext({
      cfg: config,
      agentId: record.agentId,
      sessionKey: record.sessionKey,
      policySessionKey: record.sessionKey,
    }),
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
}

async function deliverMutationDigestOnce(
  record: ClientVoiceSessionRecord,
  config: OpenClawConfig,
): Promise<void> {
  if (record.digestDeliveredAt) {
    return;
  }
  const text = formatMutationDigest(record.effects);
  if (!text) {
    return;
  }
  const entry = loadSessionEntryReadOnly({
    agentId: record.agentId,
    sessionKey: record.sessionKey,
  });
  const target = resolveSessionDeliveryTarget({ entry, requestedChannel: "last" });
  if (!target.channel || target.channel === "webchat" || !target.to) {
    return;
  }
  // Send first, mark after: a transient send failure (the common case) then leaves
  // the marker unset so close/stale-sweep retries. The rare crash between a durable
  // send and this marker can re-send one informational digest, which is acceptable.
  await deliverMutationDigest(
    record,
    config,
    {
      channel: target.channel,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
    },
    text,
  );
  const deliveredAt = Date.now();
  runOpenClawAgentWriteTransaction(
    (database) => {
      const current = readRecordInTransaction(database, record.voiceSessionId);
      if (!current || current.digestDeliveredAt) {
        return;
      }
      current.digestDeliveredAt = deliveredAt;
      current.updatedAt = deliveredAt;
      writeRecordInTransaction(database, current);
    },
    { agentId: record.agentId },
  );
}

async function finishDeferredMutationDigest(binding: {
  agentId: string;
  voiceSessionId: string;
}): Promise<void> {
  const key = operationKey(binding.agentId, binding.voiceSessionId);
  const config = deferredDigestConfigs.get(key);
  if (!config) {
    return;
  }
  await runVoiceSessionOperation(binding.agentId, binding.voiceSessionId, async () => {
    const record = readRecord(binding.agentId, binding.voiceSessionId);
    if (!record || record.status !== "closed" || hasLiveConsultRun(record)) {
      return;
    }
    // Deliver first; only drop the retry config once the send succeeds, so a
    // transient failure here is retried by the next closeStaleClientVoiceSessions.
    await deliverMutationDigestOnce(record, config);
    deferredDigestConfigs.delete(key);
  });
}

/** Retry deferred digests whose delivery previously failed after the call closed. */
async function retryDeferredMutationDigests(agentId: string): Promise<void> {
  for (const key of Array.from(deferredDigestConfigs.keys())) {
    const [entryAgentId, voiceSessionId] = key.split("\0");
    if (entryAgentId !== agentId || !voiceSessionId) {
      continue;
    }
    try {
      await finishDeferredMutationDigest({ agentId, voiceSessionId });
    } catch {
      // Still undeliverable; a later voice session retries again.
    }
  }
}

async function closeClientVoiceSessionInternal(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
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
  const key = operationKey(params.agentId, params.voiceSessionId);
  // Both the deferred and immediate paths retain the retry config until a send
  // actually succeeds, so a channel outage does not permanently lose the digest.
  deferredDigestConfigs.set(key, params.config);
  if (hasLiveConsultRun(closed)) {
    return;
  }
  await deliverMutationDigestOnce(closed, params.config);
  // Intentionally unconditional: a consult that late-binds during the await above has
  // its mutations omitted from this already-sent point-in-time summary. Re-sending to
  // include them would double-notify the user for one call, which is a worse outcome
  // for an informational digest than omitting a straggler action (still on the record).
  deferredDigestConfigs.delete(key);
}

/** Close a logical voice call and deliver its mutation digest at most once. */
export async function closeClientVoiceSession(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
  config: OpenClawConfig;
  now?: number;
}): Promise<void> {
  await runVoiceSessionOperation(params.agentId, params.voiceSessionId, async () => {
    await closeClientVoiceSessionInternal(params);
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
  // A new voice session is the natural retry point for a digest whose delivery
  // failed after its own call had already closed and its runs completed.
  await retryDeferredMutationDigests(params.agentId);
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
  reset(): void {
    voiceSessionByRunId.clear();
    voiceSessionOperations.clear();
    deferredDigestConfigs.clear();
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
