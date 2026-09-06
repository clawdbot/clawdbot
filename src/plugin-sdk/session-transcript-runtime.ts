import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { buildSessionsYieldContextMessage } from "../agents/sessions-yield-context.js";
import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessages,
  appendSessionTranscriptReport,
  bindSessionTranscriptStoreScope,
  isSessionTranscriptProjectionUnavailableError,
  loadSessionEntry,
  loadTranscriptEvents,
  publishTranscriptUpdate,
  persistSessionTranscriptTurn,
  readTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDeltaCore as readVisibleMessageDelta,
  readLatestTranscriptAssistantText,
  resolveSessionTranscriptRuntimeTarget,
  withTranscriptWriteLock,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
  type SessionTranscriptRawDeltaLimits,
  type SessionTranscriptRawDeltaResult,
  type SessionTranscriptVisibleMessageDeltaLimits,
} from "../config/sessions/session-accessor.js";
import { resolveMirroredTranscriptText } from "../config/sessions/transcript-mirror.js";
import {
  selectVisibleTranscriptEventEntries,
  selectVisibleTranscriptEvents,
} from "../config/sessions/transcript-visible-events.js";
import type {
  LatestAssistantTranscriptText,
  SessionTranscriptAppendResult,
  SessionTranscriptAssistantMessage,
  SessionTranscriptDeliveryMirror,
  SessionTranscriptUpdateMode,
} from "../config/sessions/transcript.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { extractAssistantPhaseText } from "../shared/chat-message-content.js";
import type { AgentMessage } from "./agent-core.js";
import { withProjectedSessionTranscriptWriteLock } from "./session-transcript-lock-runtime.js";
import {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
  type ResolveSessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptIdentity,
  type SessionTranscriptMemoryHitIdentity,
  type SessionTranscriptMemoryHitKey,
  type SessionTranscriptMemoryHitKeyParams,
  type SessionTranscriptReadParams,
} from "./session-transcript-memory-hit.js";

export type {
  TranscriptEntryAnchor,
  TranscriptTurnAdmission,
} from "../config/sessions/session-accessor.js";
export { hasPromptImageInput } from "../media/prompt-image-input.js";

export {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
};
export type {
  ResolveSessionTranscriptMemoryHitKeyParams,
  SessionTranscriptIdentity,
  SessionTranscriptMemoryHitIdentity,
  SessionTranscriptMemoryHitKey,
  SessionTranscriptMemoryHitKeyParams,
  SessionTranscriptReadParams,
};

export type SessionTranscriptEvent = unknown;

export type SessionTranscriptTargetParams = SessionTranscriptReadParams;

/** Persists a successful yield's private context through the admitted session writer. */
export async function appendSessionYieldContext(
  params: SessionTranscriptTargetParams & {
    config?: OpenClawConfig;
    message: string;
    assertCurrent: () => void;
  },
): Promise<void> {
  const { message, assertCurrent, config, ...scope } = params;
  assertCurrent();
  const result = await appendSessionTranscriptReport(
    bindSessionTranscriptStoreScope(scope, config),
    {
      kind: "custom",
      customTypes: [],
      selectReport: () => {
        assertCurrent();
        return buildSessionsYieldContextMessage(message);
      },
    },
  );
  if (!result.ok) {
    throw new Error(`Could not persist sessions_yield context: ${result.error.code}`);
  }
}

/** Scoped target and bounds for one raw generation-aware transcript page. */
export type SessionTranscriptRawDeltaParams = SessionTranscriptTargetParams &
  SessionTranscriptRawDeltaLimits;
export type { SessionTranscriptRawDeltaResult };

/** Scoped target and bounds for one active-path visible-message page. */
export type SessionTranscriptVisibleMessageDeltaParams = SessionTranscriptTargetParams &
  SessionTranscriptVisibleMessageDeltaLimits;

/** Generation-aware outcome for one bounded visible-message read. */
export type SessionTranscriptVisibleMessageDeltaResult =
  | {
      kind: "page";
      /** Opaque cursor positioned after the last returned visible message. */
      cursor: string;
      /** Ordered active-path message entries selected for this page. */
      entries: SessionTranscriptMessageEntry[];
      /** True when another visible message remains after this page. */
      hasMore: boolean;
      /** First unread event size when it cannot fit under maxBytes. */
      requiredBytes?: number;
      /** Stored JSONL bytes represented by entries. */
      serializedBytes: number;
    }
  | {
      kind: "reset";
      /** Fresh opaque bootstrap cursor for the current visible generation. */
      cursor: string;
      /** Stable discontinuity that invalidated the supplied cursor. */
      reason:
        | "anchor_missing"
        | "anchor_moved"
        | "generation_mismatch"
        | "invalid_cursor"
        | "scope_mismatch";
    }
  | { kind: "unavailable"; reason: "projection_rebuilding" }
  | { kind: "missing" };

export type SessionTranscriptMessageEntry = {
  /** Stable transcript event id for this message entry. */
  entryId: string;
  /** Parent id after active-branch normalization; null when this is a visible root. */
  parentId: string | null;
  /** Ordered read metadata for this full transcript read, not a resumable cursor. */
  seq: number;
  /** Redacted agent message payload as persisted by the runtime. */
  message: AgentMessage;
  /** Convenience mirror of message.role. */
  role: AgentMessage["role"];
  /** Entry timestamp recorded by the transcript store, when present. */
  createdAt?: string;
  /** Message idempotency key, when the persisted message has one. */
  idempotencyKey?: string;
};

export type SessionTranscriptTarget = SessionTranscriptIdentity & {
  targetKind: "runtime-session";
};

export type SessionTranscriptAppendMessageParams<TMessage> = SessionTranscriptTargetParams &
  TranscriptMessageAppendOptions<TMessage>;

export type SessionTranscriptAppendMessagesParams<TMessage> = SessionTranscriptTargetParams & {
  config?: TranscriptMessageAppendOptions<TMessage>["config"];
  cwd?: string;
  messages: readonly Omit<
    TranscriptMessageAppendOptions<TMessage>,
    "config" | "cwd" | "parentId" | "prepareMessageAfterIdempotencyCheck" | "useRawWhenLinear"
  >[];
};

export type SessionTranscriptStrictMessageAppendResult<TMessage> =
  | { kind: "result"; result: TranscriptMessageAppendResult<TMessage> }
  | { kind: "suppressed" }
  | { kind: "rejected"; reason: "session-rebound" };

export type SessionTranscriptAssistantMirrorAppendParams = SessionTranscriptReadParams & {
  config?: OpenClawConfig;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
  idempotencyKey?: string;
  mediaUrls?: string[];
  signal?: AbortSignal;
  text?: string;
  updateMode?: SessionTranscriptUpdateMode;
};

export type SessionTranscriptWriteLockParams = SessionTranscriptTargetParams & {
  config?: TranscriptMessageAppendOptions<unknown>["config"];
};

export type SessionTranscriptWriteLockContext = {
  appendMessage: <TMessage>(
    options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
  ) => Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishUpdate: (update?: TranscriptUpdatePayload) => Promise<void>;
  readEvents: () => Promise<SessionTranscriptEvent[]>;
  target: SessionTranscriptTarget;
};

type SessionTranscriptMirrorAppendResult =
  | { ok: true; messageId: string }
  | Extract<SessionTranscriptAppendResult, { ok: false }>;

/**
 * Resolves the public identity for a transcript without returning its file path.
 */
export async function resolveSessionTranscriptIdentity(
  params: SessionTranscriptReadParams,
): Promise<SessionTranscriptIdentity> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
  };
}

/**
 * Resolves the public target for transcript operations without exposing the
 * current storage path as identity.
 */
export async function resolveSessionTranscriptTarget(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptTarget> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  return projectPublicTarget({
    ...target,
    targetKind: "runtime-session",
  });
}

/**
 * Reads transcript events by public session identity instead of file path.
 */
export async function readSessionTranscriptEvents(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptEvent[]> {
  return await loadTranscriptEvents(bindSessionTranscriptStoreScope(params));
}

/** Reads one bounded raw page; the opaque cursor survives append and resets after replacement. */
export async function readSessionTranscriptRawDelta(
  params: SessionTranscriptRawDeltaParams,
): Promise<SessionTranscriptRawDeltaResult> {
  const { cursor, maxBytes, maxEvents, ...target } = params;
  return readTranscriptRawDelta(bindSessionTranscriptStoreScope(target), {
    ...(cursor !== undefined ? { cursor } : {}),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
  });
}

/** Reads one bounded active-path page that resumes appends and resets after discontinuities. */
export async function readSessionTranscriptVisibleMessageDelta(
  params: SessionTranscriptVisibleMessageDeltaParams,
): Promise<SessionTranscriptVisibleMessageDeltaResult> {
  const { cursor, maxBytes, maxMessages, ...target } = params;
  let result: ReturnType<typeof readVisibleMessageDelta>;
  try {
    result = readVisibleMessageDelta(bindSessionTranscriptStoreScope(target), {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(maxMessages !== undefined ? { maxMessages } : {}),
    });
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      return { kind: "unavailable", reason: "projection_rebuilding" };
    }
    throw error;
  }
  if (result.kind !== "page") {
    return result;
  }
  const { events, ...page } = result;
  return {
    ...page,
    entries: events.flatMap((entry) =>
      projectVisibleMessageEntry({
        event: entry.event,
        parentId: entry.parentId,
        seq: entry.seq,
      }),
    ),
  };
}

/**
 * Reads visible transcript message entries by scoped identity.
 *
 * This is a branch-safe message projection over the current full transcript
 * read. `seq` is ordered read metadata, not a resumable cursor.
 */
export async function readVisibleSessionTranscriptMessageEntries(
  params: SessionTranscriptTargetParams,
): Promise<SessionTranscriptMessageEntry[]> {
  return selectVisibleTranscriptEventEntries(await readSessionTranscriptEvents(params)).flatMap(
    projectVisibleMessageEntry,
  );
}

/**
 * Reads the latest visible assistant text by scoped identity.
 */
export async function readLatestAssistantTextByIdentity(
  params: SessionTranscriptTargetParams,
): Promise<LatestAssistantTranscriptText | undefined> {
  return readLatestTranscriptAssistantText(bindSessionTranscriptStoreScope(params));
}

/**
 * Appends a delivery-mirror assistant message through the SQLite transcript accessor.
 */
export async function appendAssistantMirrorMessageByIdentity(
  params: SessionTranscriptAssistantMirrorAppendParams,
): Promise<SessionTranscriptMirrorAppendResult> {
  params.signal?.throwIfAborted();
  const text = resolveMirroredTranscriptText({
    ...(params.mediaUrls !== undefined ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
  });
  if (!text) {
    return { ok: false, reason: "empty message" };
  }
  const message = createAssistantMirrorMessage({
    ...(params.deliveryMirror !== undefined ? { deliveryMirror: params.deliveryMirror } : {}),
    ...(params.idempotencyKey !== undefined ? { idempotencyKey: params.idempotencyKey } : {}),
    text,
  });
  const scope = bindSessionTranscriptStoreScope(params, params.config);
  return await withTranscriptWriteLock(scope, async (locked) => {
    params.signal?.throwIfAborted();
    const currentEntry = loadSessionEntry(scope);
    if (!currentEntry?.sessionId) {
      return { ok: false, reason: "missing active session", code: "blocked" };
    }
    if (params.sessionId && currentEntry.sessionId !== params.sessionId) {
      return { ok: false, reason: "session changed", code: "session-rebound" };
    }
    const latestEquivalentAssistantId =
      !params.idempotencyKey && isDeliveryMirrorAssistantMessage(message)
        ? findLatestEquivalentAssistantMessageId(
            selectVisibleTranscriptEvents(await locked.readEvents()),
            message,
            params.config,
          )
        : undefined;
    if (latestEquivalentAssistantId) {
      return {
        ok: true,
        messageId: latestEquivalentAssistantId,
      };
    }
    params.signal?.throwIfAborted();
    const appendResult = await locked.appendMessage({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.idempotencyKey ? { idempotencyLookup: "scan" as const } : {}),
      message,
    });
    if (!appendResult) {
      return { ok: false, reason: "message skipped", code: "blocked" };
    }
    if (params.updateMode !== "none" && appendResult.appended) {
      params.signal?.throwIfAborted();
      await publishTranscriptUpdate(scope, {
        messageId: appendResult.messageId,
      });
    }
    return {
      ok: true,
      messageId: appendResult.messageId,
    };
  });
}

/**
 * Appends an already-canonical transcript message by scoped transcript target.
 * Media-bearing user turns use ordered `message.__openclaw.media` facts; this
 * low-level API does not infer deprecated top-level Media* projections.
 */
export async function appendSessionTranscriptMessageByIdentity<TMessage>(
  params: SessionTranscriptAppendMessageParams<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  return await appendTranscriptMessage(
    bindSessionTranscriptStoreScope(params, params.config),
    params,
  );
}

/** Appends one message while preserving distinct suppression and session-rebind outcomes. */
export async function appendSessionTranscriptMessageByIdentityStrict<TMessage>(
  params: SessionTranscriptAppendMessageParams<TMessage>,
): Promise<SessionTranscriptStrictMessageAppendResult<TMessage>> {
  const expectedSessionId = params.sessionId?.trim();
  if (!expectedSessionId) {
    throw new Error("Cannot strictly append a transcript message without an exact session id");
  }
  const turn = await persistSessionTranscriptTurn(params, {
    ...(params.config ? { config: params.config } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    expectedSessionId,
    messages: [
      {
        ...(params.eventId !== undefined ? { eventId: params.eventId } : {}),
        ...(params.idempotencyLookup !== undefined
          ? { idempotencyLookup: params.idempotencyLookup }
          : {}),
        message: params.message,
        ...(params.now !== undefined ? { now: params.now } : {}),
        ...(params.parentId !== undefined ? { parentId: params.parentId } : {}),
        ...(params.prepareMessageAfterIdempotencyCheck
          ? {
              prepareMessageAfterIdempotencyCheck: (message: unknown) =>
                params.prepareMessageAfterIdempotencyCheck?.(message as TMessage),
            }
          : {}),
        ...(params.useRawWhenLinear !== undefined
          ? { useRawWhenLinear: params.useRawWhenLinear }
          : {}),
      },
    ],
    updateMode: "none",
  });
  if (turn.rejectedReason) {
    return { kind: "rejected", reason: turn.rejectedReason };
  }
  const result = turn.messages[0] as TranscriptMessageAppendResult<TMessage> | undefined;
  return result ? { kind: "result", result } : { kind: "suppressed" };
}

/**
 * Atomically appends one ordered, already-hooked message group. Preparation and
 * redaction finish before SQLite begins; this is the canonical future harness seam.
 */
export async function appendSessionTranscriptMessagesByIdentity<TMessage>(
  params: SessionTranscriptAppendMessagesParams<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage>[]> {
  return await appendTranscriptMessages(params, params);
}

/**
 * Publishes a transcript update by scoped transcript target.
 */
export async function publishSessionTranscriptUpdateByIdentity(
  params: SessionTranscriptTargetParams & { update?: TranscriptUpdatePayload },
): Promise<void> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  await publishTranscriptUpdate({ ...params, ...target }, params.update);
}

/**
 * Runs transcript work under the write lock for the resolved scoped target.
 */
export async function withSessionTranscriptWriteLock<T>(
  params: SessionTranscriptWriteLockParams,
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  return await withProjectedSessionTranscriptWriteLock(params, run, (context) => context);
}

function createAssistantMirrorMessage(params: {
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  idempotencyKey?: string;
  text: string;
}): SessionTranscriptAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...(params.deliveryMirror ? { openclawDeliveryMirror: params.deliveryMirror } : {}),
  };
}

function findLatestEquivalentAssistantMessageId(
  events: readonly SessionTranscriptEvent[],
  message: SessionTranscriptAssistantMessage,
  config: OpenClawConfig | undefined,
): string | undefined {
  const expectedText = extractAssistantMirrorComparableText(message, config);
  if (!expectedText) {
    return undefined;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as { id?: unknown; message?: unknown };
    const candidate = record.message as SessionTranscriptAssistantMessage | undefined;
    if (!candidate) {
      continue;
    }
    if (candidate.role !== "assistant") {
      return undefined;
    }
    return extractAssistantMirrorComparableText(candidate, config) === expectedText &&
      typeof record.id === "string" &&
      record.id
      ? record.id
      : undefined;
  }
  return undefined;
}

function extractAssistantMirrorComparableText(
  message: SessionTranscriptAssistantMessage,
  config: OpenClawConfig | undefined,
): string | undefined {
  const redacted = redactTranscriptMessage(
    message as Parameters<typeof redactTranscriptMessage>[0],
    config,
  ) as SessionTranscriptAssistantMessage;
  return extractAssistantPhaseText(redacted)?.trim() || undefined;
}

function isDeliveryMirrorAssistantMessage(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && readNonEmptyString(value.role) !== undefined;
}

function projectVisibleMessageEntry(entry: {
  event: SessionTranscriptEvent;
  parentId: string | null;
  seq: number;
}): SessionTranscriptMessageEntry[] {
  const event = entry.event;
  if (!isRecord(event) || event.type !== "message") {
    return [];
  }
  const entryId = readNonEmptyString(event.id);
  const message = event.message;
  if (!entryId || !isAgentMessageRecord(message)) {
    return [];
  }
  const createdAt = readNonEmptyString(event.timestamp);
  const idempotencyKey = readNonEmptyString(message.idempotencyKey);
  return [
    {
      entryId,
      parentId: entry.parentId,
      seq: entry.seq,
      message,
      role: message.role,
      ...(createdAt ? { createdAt } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  ];
}

function projectPublicTarget(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  targetKind: SessionTranscriptTarget["targetKind"];
}): SessionTranscriptTarget {
  const agentId = normalizeAgentId(target.agentId);
  return {
    agentId,
    memoryKey: formatSessionTranscriptMemoryHitKey({ agentId, sessionId: target.sessionId }),
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    targetKind: target.targetKind,
  };
}
