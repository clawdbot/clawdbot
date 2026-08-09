import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  resolveSessionTranscriptGuardState,
  type SessionTranscriptGuardState,
} from "./session-accessor.sqlite-active-boundary.js";
import {
  getActiveTranscriptKysely,
  withCurrentProjectionSnapshot,
} from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptEventRow as SessionTranscriptMessageEvent,
  SessionTranscriptReadScope,
} from "./session-accessor.sqlite-contract.js";
import {
  readVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";

type GuardedProjection = {
  database: OpenClawAgentDatabase;
  resolved: { sessionId: string };
  state: { leafEventId: string | null };
};

type SessionTranscriptGuardedFields = {
  guardKind: SessionTranscriptGuardState["kind"];
  guardLeafEntryId: string | null;
  hasTranscriptEvents: boolean;
  projectionLeafEntryId: string | null;
};

type SessionTranscriptMessageEventPageWithGuard = SessionTranscriptGuardedFields & {
  events: SessionTranscriptMessageEvent[];
  totalMessages: number;
};

type SessionTranscriptMessageAnchorPageWithGuard = SessionTranscriptMessageEventPageWithGuard & {
  found: boolean;
  hasOverreadContext: boolean;
  offset: number;
};

function resolveGuardedFields(projection: GuardedProjection): SessionTranscriptGuardedFields {
  const guard = resolveSessionTranscriptGuardState(projection);
  return {
    guardKind: guard.kind,
    guardLeafEntryId: guard.guardLeafEntryId,
    hasTranscriptEvents: guard.hasTranscriptEvents,
    projectionLeafEntryId: projection.state.leafEventId,
  };
}

/** Reads every message and its logical guard from one active-path snapshot. */
export function readSessionTranscriptMessageEventSnapshotWithGuard(
  scope: SessionTranscriptReadScope,
): SessionTranscriptMessageEventPageWithGuard {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    return {
      events: readVisibleMessageRange(projection, 0, visible.total),
      ...resolveGuardedFields(projection),
      totalMessages: visible.total,
    };
  });
}

/** Reads a bounded active-path tail and its logical guard from one snapshot. */
export function readRecentSessionTranscriptMessageEventsWithGuard(
  scope: SessionTranscriptReadScope,
  options: { maxBytes: number; maxLines: number; maxMessages: number },
): SessionTranscriptMessageEventPageWithGuard {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    const guardedFields = resolveGuardedFields(projection);
    const maxMessages = Math.min(
      MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
      Math.max(0, Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0)),
    );
    const maxLines = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxLines) ? options.maxLines : 0),
    );
    if (maxMessages === 0 || maxLines === 0) {
      return {
        events: [],
        ...guardedFields,
        totalMessages: visible.total,
      };
    }
    const maxBytes = Math.max(
      1024,
      Math.floor(Number.isFinite(options.maxBytes) ? options.maxBytes : 8 * 1024 * 1024),
    );
    const candidates = readVisibleMessageRange(
      projection,
      Math.max(0, visible.total - maxLines),
      visible.total,
    );
    const selected: SessionTranscriptMessageEvent[] = [];
    let bytes = 0;
    for (const event of candidates.toReversed()) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event.event)) + 1;
      if (
        selected.length >= maxMessages ||
        (selected.length > 0 && bytes + eventBytes > maxBytes)
      ) {
        break;
      }
      selected.push(event);
      bytes += eventBytes;
    }
    return {
      events: selected.toReversed(),
      ...guardedFields,
      totalMessages: visible.total,
    };
  });
}

/** Reads one tail-relative page and its logical guard from one snapshot. */
export function readSessionTranscriptMessageEventPageWithGuard(
  scope: SessionTranscriptReadScope,
  options: { maxMessages: number; offset: number },
): SessionTranscriptMessageEventPageWithGuard {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const visible = resolveVisibleMessagePositions(projection);
    const totalMessages = visible.total;
    const offset = Math.min(
      Math.max(0, Math.floor(Number.isFinite(options.offset) ? options.offset : 0)),
      totalMessages,
    );
    const maxMessages = Math.max(
      0,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 0),
    );
    const endExclusive = Math.max(0, totalMessages - offset);
    const start = Math.max(0, endExclusive - maxMessages);
    return {
      events: readVisibleMessageRange(projection, start, endExclusive),
      ...resolveGuardedFields(projection),
      totalMessages,
    };
  });
}

/** Reads one message-id-anchored page and its logical guard from one snapshot. */
export function readSessionTranscriptMessageAnchorPageWithGuard(
  scope: SessionTranscriptReadScope,
  options: { maxMessages: number; messageId: string },
): SessionTranscriptMessageAnchorPageWithGuard {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const db = getActiveTranscriptKysely(projection.database);
    const guardedFields = resolveGuardedFields(projection);
    const anchor = executeSqliteQueryTakeFirstSync(
      projection.database.db,
      db
        .selectFrom("transcript_event_identities as identity")
        .innerJoin("session_transcript_active_events as active", (join) =>
          join
            .onRef("active.session_id", "=", "identity.session_id")
            .onRef("active.event_seq", "=", "identity.seq"),
        )
        .select("active.message_position")
        .where("identity.session_id", "=", projection.resolved.sessionId)
        .where("identity.event_id", "=", options.messageId)
        .where("active.message_position", "is not", null),
    );
    const visible = resolveVisibleMessagePositions(projection);
    const totalMessages = visible.total;
    if (anchor?.message_position === null || anchor?.message_position === undefined) {
      return {
        events: [],
        found: false,
        ...guardedFields,
        hasOverreadContext: false,
        offset: 0,
        totalMessages,
      };
    }
    const anchorVisiblePosition =
      anchor.message_position >= visible.postStart
        ? visible.kept.length + anchor.message_position - visible.postStart
        : visible.kept.indexOf(anchor.message_position);
    if (anchorVisiblePosition < 0) {
      return {
        events: [],
        found: false,
        ...guardedFields,
        hasOverreadContext: false,
        offset: 0,
        totalMessages,
      };
    }
    const pageSize = Math.max(
      1,
      Math.floor(Number.isFinite(options.maxMessages) ? options.maxMessages : 1),
    );
    const newerMessages = Math.floor(pageSize / 2);
    const olderMessages = pageSize - newerMessages - 1;
    const latestStart = Math.max(0, totalMessages - pageSize);
    const start = Math.min(Math.max(0, anchorVisiblePosition - olderMessages), latestStart);
    const endExclusive = Math.min(totalMessages, start + pageSize);
    const readStart = Math.max(0, start - 1);
    return {
      events: readVisibleMessageRange(projection, readStart, endExclusive),
      found: true,
      ...guardedFields,
      hasOverreadContext: readStart < start,
      offset: totalMessages - endExclusive,
      totalMessages,
    };
  });
}
