import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageEvents,
  resolveConcreteSessionStorePath,
  resolveSessionTranscriptReadTarget,
  waitForSessionTranscriptProjection,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
  type TranscriptEvent,
} from "../config/sessions/session-accessor.js";
import { visitSessionTranscriptMessageEvents } from "../config/sessions/session-accessor.sqlite-active-events.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEventById,
  readSessionTranscriptHistoryEventCount,
  readSessionTranscriptHistoryEventLookup,
  readSessionTranscriptHistoryEventPage,
  readSessionTranscriptHistoryEvents,
} from "../config/sessions/session-accessor.sqlite-history-events.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { readSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import { aggregateSessionTranscriptUsage } from "./session-transcript-derived-readers.js";
import { projectTranscriptEntryMessage } from "./session-transcript-message.js";
import type {
  ReadRecentSessionMessagesOptions,
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptUsageSnapshot,
} from "./session-utils.fs.js";
import {
  ArchivedTranscriptReader,
  buildSessionPreviewItems,
  readLatestSessionUsageFromTranscriptFileAsync,
} from "./session-utils.fs.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

export type { ReadSessionMessagesAsyncOptions };
export { capArrayByJsonBytes } from "./session-utils.fs.js";
export { attachOpenClawTranscriptMeta } from "./session-transcript-message.js";
export { readSessionTranscriptVisibleMessageDeltaCore } from "../config/sessions/session-accessor.js";

export type { SessionTranscriptReadScope };

export type ReadRecentSessionMessagesResult = {
  olderOffset?: number;
  omittedOversized?: boolean;
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  messages: unknown[];
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "active" | "reset-archive";
  totalMessages: number;
};

type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

type ReadSessionMessageByIdResult = {
  message?: unknown;
  seq?: number;
  oversized: boolean;
  found: boolean;
};

export type ResolvedTranscriptReadTarget = {
  agentId?: string;
  sessionFile: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
};

export function resolveTranscriptReadTarget(
  scope: SessionTranscriptReadScope,
): ResolvedTranscriptReadTarget {
  const target = resolveSessionTranscriptReadTarget(scope);
  return {
    agentId: target.agentId,
    sessionFile: target.sessionKey ?? target.sessionId,
    sessionId: target.sessionId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    storePath: target.storePath,
  };
}

export function toTranscriptReadScope(
  target: ResolvedTranscriptReadTarget,
): SessionTranscriptReadScope {
  return {
    ...(target.agentId ? { agentId: target.agentId } : {}),
    sessionId: target.sessionId,
    ...(target.sessionKey ? { sessionKey: target.sessionKey } : {}),
    ...(target.storePath ? { storePath: target.storePath } : {}),
  };
}

function archivedTranscriptReader(target: ResolvedTranscriptReadTarget): ArchivedTranscriptReader {
  return new ArchivedTranscriptReader({
    agentId: target.agentId,
    sessionId: target.sessionId,
    storePath: target.storePath,
  });
}

function extractMessagePayloads(entries: readonly SessionTranscriptMessageEvent[]): unknown[] {
  return entries.map((entry) => asOptionalRecord(entry.event)?.message);
}

function projectSqliteHistoryEvents(entries: readonly SessionTranscriptMessageEvent[]): unknown[] {
  return entries.flatMap((entry) => {
    const message = projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
    return message ? [message] : [];
  });
}

function normalizeRecentSqliteReadOptions(opts?: Partial<ReadRecentSessionMessagesOptions>) {
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  const maxBytes =
    typeof opts?.maxBytes === "number" && Number.isFinite(opts.maxBytes)
      ? Math.max(1024, Math.floor(opts.maxBytes))
      : 8 * 1024 * 1024;
  const defaultMaxLines = maxMessages * 20 + 20;
  const maxLines =
    typeof opts?.maxLines === "number" && Number.isFinite(opts.maxLines)
      ? Math.max(maxMessages, Math.floor(opts.maxLines))
      : defaultMaxLines;
  return { maxMessages, maxBytes, maxLines };
}

async function readRecentSqliteMessageRecords(
  target: ResolvedTranscriptReadTarget,
  opts?: Partial<ReadRecentSessionMessagesOptions>,
): Promise<{
  activeLeafEntryId?: string | null;
  deltaCursor?: string;
  displaySource?: string;
  messages: unknown[];
  transcriptEvents: TranscriptEvent[];
  totalMessages: number;
}> {
  const normalized = normalizeRecentSqliteReadOptions(opts);
  const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), normalized);
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    ...(page.deltaCursor ? { deltaCursor: page.deltaCursor } : {}),
    displaySource: page.displaySource,
    messages: projectSqliteHistoryEvents(page.events),
    transcriptEvents: page.events.map((entry) => entry.event),
    totalMessages: page.totalMessages,
  };
}

export function sqliteMessageEventWithSeq(
  entry: Pick<SessionTranscriptMessageEvent, "event" | "seq" | "displayPosition">,
): unknown {
  return projectTranscriptEntryMessage(entry.event, entry.seq, entry.displayPosition);
}

function buildSqlitePreviewItems(
  target: ResolvedTranscriptReadTarget,
  maxItems: number,
  maxChars: number,
  view: "display" | "model-context",
): SessionPreviewItem[] {
  // Tool-only and suppressed rows need headroom; cap even the recovery scan so previews
  // never materialize an entire large transcript or monopolize the Gateway thread.
  const initialMaxEvents = Math.min(256, Math.max(64, Math.ceil(maxItems) * 4));
  const readPreviewPage = (maxEvents: number, maxBytes: number) => {
    if (view === "model-context") {
      const { agentId, sessionId, sessionKey, storePath } = target;
      if (!agentId || !sessionKey || !storePath) {
        throw new Error("Model-context preview requires an exact session target");
      }
      let truncated = false;
      const manager = SessionManager.openBounded(
        { agentId, sessionId, sessionKey, storePath },
        {
          maxEvents,
          maxBytes,
          onTruncated: () => {
            truncated = true;
          },
        },
      );
      return {
        items: buildSessionPreviewItems(
          manager.buildSessionContext().messages,
          maxItems,
          maxChars,
          view,
        ),
        hasOlderEvents: truncated,
      };
    }
    const page = readRecentSessionTranscriptHistoryEvents(toTranscriptReadScope(target), {
      maxBytes,
      maxLines: maxEvents,
      maxMessages: maxEvents,
    });
    return {
      items: buildSessionPreviewItems(extractMessagePayloads(page.events), maxItems, maxChars),
      hasOlderEvents: page.totalMessages > page.events.length,
    };
  };
  const preview = readPreviewPage(initialMaxEvents, 1024 * 1024);
  if (preview.items.length >= maxItems || !preview.hasOlderEvents) {
    return preview.items;
  }
  const recoveryMaxEvents = Math.min(
    2048,
    Math.max(1024, initialMaxEvents * 8, Math.ceil(maxItems)),
  );
  return readPreviewPage(recoveryMaxEvents, 8 * 1024 * 1024).items;
}

/** Reads display messages asynchronously through the reader seam. */
export async function readSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
  return (await readSessionMessagesWithSourceAsync(scope, opts)).messages;
}

/** Reads display messages with source metadata through the reader seam. */
export async function readSessionMessagesWithSourceAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<ReadSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const messages =
    opts.mode === "recent"
      ? (await readRecentSqliteMessageRecords(target, opts)).messages
      : projectSqliteHistoryEvents(
          readSessionTranscriptHistoryEvents(toTranscriptReadScope(target)),
        );
  if (messages.length === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).read({ ...opts, resetArchiveOnly: true });
  }
  return {
    messages,
    transcriptPath: target.sessionFile,
  };
}

/** Finds one display message by transcript id through the reader seam. */
export async function readSessionMessageByIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
  opts?: { allowResetArchiveFallback?: boolean },
): Promise<ReadSessionMessageByIdResult> {
  const target = resolveTranscriptReadTarget(scope);
  const foundEvent = readSessionTranscriptHistoryEventById(
    toTranscriptReadScope(target),
    messageId,
  );
  if (foundEvent) {
    return {
      found: true,
      message: projectTranscriptEntryMessage(
        foundEvent.event,
        foundEvent.seq,
        foundEvent.displayPosition,
      ),
      oversized: false,
      seq: foundEvent.seq,
    };
  }
  if (opts?.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readById(messageId, {
      ...opts,
      resetArchiveOnly: true,
    });
  }
  return { found: false, oversized: false };
}

/** Read exact membership while retaining full-history validity and empty-only archive fallback. */
export async function readSessionMessagesMatchingIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
): Promise<unknown[]> {
  const target = resolveTranscriptReadTarget(scope);
  const lookup = readSessionTranscriptHistoryEventLookup(toTranscriptReadScope(target), messageId);
  const messages = lookup.hasDisplayMessages
    ? projectSqliteHistoryEvents(lookup.events)
    : await archivedTranscriptReader(target).readMessageCandidatesById(messageId, {
        allowResetArchiveFallback: true,
        resetArchiveOnly: true,
      });
  return messages.filter(
    (message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id === messageId,
  );
}

/** Visits raw message payloads within the SQLite read snapshot. */
export async function visitSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
): Promise<number> {
  const target = resolveTranscriptReadTarget(scope);
  let count = 0;
  visitSessionTranscriptMessageEvents(toTranscriptReadScope(target), (entry) => {
    const message = asOptionalRecord(entry.event)?.message;
    if (message !== undefined) {
      visit(message, entry.seq);
      count += 1;
    }
  });
  return count;
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const target = resolveTranscriptReadTarget(scope);
  const transcriptScope = toTranscriptReadScope(target);
  try {
    return readSessionTranscriptHistoryEventCount(transcriptScope);
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // The failed read already scheduled the rebuild; wait before assigning
    // a sequence so a concurrent send cannot fail or reuse a stale count.
    await waitForSessionTranscriptProjection(transcriptScope);
    return readSessionTranscriptHistoryEventCount(transcriptScope);
  }
}

/** Reads recent messages with total-count metadata asynchronously through the reader seam. */
export async function readRecentSessionMessagesWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: ReadRecentSessionMessagesOptions,
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const {
    activeLeafEntryId,
    deltaCursor,
    displaySource,
    messages,
    transcriptEvents,
    totalMessages,
  } = await readRecentSqliteMessageRecords(target, opts);
  if (totalMessages === 0 && messages.length === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readRecentWithStats({
      ...opts,
      resetArchiveOnly: true,
    });
  }
  return {
    ...(activeLeafEntryId !== undefined ? { activeLeafEntryId } : {}),
    ...(deltaCursor ? { deltaCursor } : {}),
    displaySource,
    messages,
    transcriptEvents,
    totalMessages,
    transcriptPath: target.sessionFile,
    transcriptSource: "active",
  };
}

/** Reads one offset page with total-count metadata through the reader seam. */
export async function readSessionMessagesPageWithStatsAsync(
  scope: SessionTranscriptReadScope,
  opts: {
    offset: number;
    maxMessages: number;
    maxBytes?: number;
    allowResetArchiveFallback?: boolean;
  },
): Promise<ReadRecentSessionMessagesResult> {
  const target = resolveTranscriptReadTarget(scope);
  const page = readSessionTranscriptHistoryEventPage(toTranscriptReadScope(target), opts);
  if (page.totalMessages === 0 && opts.allowResetArchiveFallback === true) {
    return await archivedTranscriptReader(target).readPage({ ...opts, resetArchiveOnly: true });
  }
  return {
    ...(Object.hasOwn(page, "activeLeafEntryId")
      ? { activeLeafEntryId: page.activeLeafEntryId }
      : {}),
    ...(page.olderOffset !== undefined ? { olderOffset: page.olderOffset } : {}),
    ...(page.omittedOversized ? { omittedOversized: true } : {}),
    messages: projectSqliteHistoryEvents(page.events),
    transcriptEvents: page.events.map((entry) => entry.event),
    displaySource: page.displaySource,
    totalMessages: page.totalMessages,
    transcriptPath: target.sessionFile,
    transcriptSource: "active",
  };
}

/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
export async function readLatestSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const artifactFile = scope.sessionFile?.trim();
  const concreteStorePath = resolveConcreteSessionStorePath(scope.storePath);
  const targetAgentId = scope.agentId?.trim() || resolveAgentIdFromSessionKey(scope.sessionKey);
  const hasCompleteTarget = Boolean(targetAgentId && scope.sessionKey?.trim() && concreteStorePath);
  if (
    !hasCompleteTarget &&
    artifactFile &&
    path.isAbsolute(artifactFile) &&
    artifactFile.endsWith(".jsonl")
  ) {
    return await readLatestSessionUsageFromTranscriptFileAsync(
      scope.sessionId,
      concreteStorePath,
      artifactFile,
      undefined,
    );
  }
  const target = resolveTranscriptReadTarget(scope);
  return aggregateSessionTranscriptUsage(
    extractMessagePayloads(readSessionTranscriptMessageEvents(toTranscriptReadScope(target))),
  );
}

/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
export function readRecentSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  const target = resolveTranscriptReadTarget(scope);
  const page = readRecentSessionTranscriptMessageEvents(toTranscriptReadScope(target), {
    maxBytes: Math.max(1024, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 8 * 1024 * 1024)),
    maxLines: 1000,
    maxMessages: 1000,
  });
  return aggregateSessionTranscriptUsage(extractMessagePayloads(page.events));
}

/** Reads the answering model only when the latest visible message belongs to this settled run. */
export function readSessionTerminalModelFromTranscript(
  scope: SessionTranscriptReadScope,
  runId: string,
): { modelProvider: string; model: string } | undefined {
  try {
    const page = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxBytes: 256 * 1024,
      maxMessages: 1,
      offset: 0,
    });
    const message = asOptionalRecord(asOptionalRecord(page.events[0]?.event)?.message);
    if (
      (message?.stopReason === "stop" || message?.stopReason === "length") &&
      readSessionTranscriptRunId(message) === runId &&
      projectSessionDisplayMessage(message)?.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      return { modelProvider: message.provider, model: message.model };
    }
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
  }
  return undefined;
}

/** Reads a bounded display or canonical model-context preview before discarding metadata. */
export function readSessionPreviewItemsFromTranscript(
  scope: SessionTranscriptReadScope,
  maxItems: number,
  maxChars: number,
  view: "display" | "model-context" = "display",
): SessionPreviewItem[] {
  const target = resolveTranscriptReadTarget(scope);
  return buildSqlitePreviewItems(target, maxItems, maxChars, view);
}
