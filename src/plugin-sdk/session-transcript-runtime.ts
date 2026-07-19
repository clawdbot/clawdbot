import { redactTranscriptMessage } from "../agents/transcript-redact.js";
import {
  appendTranscriptMessage,
  isSessionTranscriptProjectionUnavailableError,
  loadSessionEntry,
  loadTranscriptEvents,
  publishTranscriptUpdate,
  readTranscriptRawDelta,
  readSessionTranscriptVisibleMessageDelta as readVisibleMessageDelta,
  readLatestTranscriptAssistantText,
  resolveSessionTranscriptRuntimeReadTarget,
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
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import type { AgentMessage } from "./agent-core.js";
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

export type SessionTranscriptAssistantMirrorAppendParams = SessionTranscriptReadParams & {
  config?: OpenClawConfig;
  deliveryMirror?: SessionTranscriptDeliveryMirror;
  idempotencyKey?: string;
  mediaUrls?: string[];
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
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
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
  const target = await resolveSessionTranscriptRuntimeReadTarget(params);
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
  return await loadTranscriptEvents(params);
}

/** Reads one bounded raw page; the opaque cursor survives append and resets after replacement. */
export async function readSessionTranscriptRawDelta(
  params: SessionTranscriptRawDeltaParams,
): Promise<SessionTranscriptRawDeltaResult> {
  const { cursor, maxBytes, maxEvents, ...target } = params;
  return readTranscriptRawDelta(target, {
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
    result = readVisibleMessageDelta(target, {
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
  return selectVisibleTranscriptEventEntries(await loadTranscriptEvents(params)).flatMap(
    projectVisibleMessageEntry,
  );
}

/**
 * Reads the latest visible assistant text by scoped identity.
 */
export async function readLatestAssistantTextByIdentity(
  params: SessionTranscriptTargetParams,
): Promise<LatestAssistantTranscriptText | undefined> {
  return readLatestTranscriptAssistantText(params);
}

/**
 * Appends a delivery-mirror assistant message through the SQLite transcript accessor.
 */
export async function appendAssistantMirrorMessageByIdentity(
  params: SessionTranscriptAssistantMirrorAppendParams,
): Promise<SessionTranscriptMirrorAppendResult> {
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
  return await withTranscriptWriteLock(params, async (locked) => {
    const currentEntry = loadSessionEntry(params);
    if (!currentEntry?.sessionId) {
      return { ok: false, reason: "missing active session", code: "blocked" };
    }
    if (params.sessionId && currentEntry.sessionId !== params.sessionId) {
      return { ok: false, reason: "session changed", code: "session-rebound" };
    }
    const scope = {
      ...params,
      sessionId: currentEntry.sessionId,
    };
    const target = await resolveSessionTranscriptRuntimeReadTarget(scope);
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
    const appendResult = await locked.appendMessage({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.idempotencyKey ? { idempotencyLookup: "scan" as const } : {}),
      message,
    });
    if (!appendResult) {
      return { ok: false, reason: "message skipped", code: "blocked" };
    }
    if (params.updateMode !== "none" && appendResult.appended) {
      await publishTranscriptUpdate(scope, {
        agentId: target.agentId,
        messageId: appendResult.messageId,
        sessionKey: target.sessionKey,
        target: {
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        },
      });
    }
    return {
      ok: true,
      messageId: appendResult.messageId,
    };
  });
}

/**
 * Appends a transcript message by scoped transcript target.
 */
export async function appendSessionTranscriptMessageByIdentity<TMessage>(
  params: SessionTranscriptAppendMessageParams<TMessage>,
): Promise<TranscriptMessageAppendResult<TMessage> | undefined> {
  return await appendTranscriptMessage(params, params);
}

/**
 * Publishes a transcript update by scoped transcript target.
 */
export async function publishSessionTranscriptUpdateByIdentity(
  params: SessionTranscriptTargetParams & { update?: TranscriptUpdatePayload },
): Promise<void> {
  const target = await resolveSessionTranscriptRuntimeTarget(params);
  await publishTranscriptUpdate(
    {
      ...params,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
    },
    {
      ...params.update,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      target: {
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
      },
    },
  );
}

/**
 * Runs transcript work under the write lock for the resolved scoped target.
 */
export async function withSessionTranscriptWriteLock<T>(
  params: SessionTranscriptWriteLockParams,
  run: (context: SessionTranscriptWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const storageTarget = await resolveSessionTranscriptRuntimeTarget(params);
  const target = projectPublicTarget({
    ...storageTarget,
    targetKind: "runtime-session",
  });
  const boundScope = {
    ...params,
    sessionId: storageTarget.sessionId,
    sessionKey: storageTarget.sessionKey,
  };
  // Treat publishUpdate as a post-commit callback: future transactional stores
  // must not expose updates when the scoped write callback fails.
  const queuedUpdates: Array<TranscriptUpdatePayload | undefined> = [];
  const result = await withTranscriptWriteLock(
    boundScope,
    async (locked) =>
      await run({
        target,
        readEvents: locked.readEvents,
        appendMessage: (options) =>
          locked.appendMessage({
            ...options,
            ...(params.config !== undefined ? { config: params.config } : {}),
          }),
        publishUpdate: async (update) => {
          queuedUpdates.push(update ? { ...update } : undefined);
        },
      }),
  );
  for (const update of queuedUpdates) {
    await publishSessionTranscriptUpdateByIdentity({
      ...boundScope,
      update,
    });
  }
  return result;
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
  return extractAssistantVisibleText(redacted)?.trim() || undefined;
}

function isDeliveryMirrorAssistantMessage(message: SessionTranscriptAssistantMessage): boolean {
  return message.provider === "openclaw" && message.model === "delivery-mirror";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
