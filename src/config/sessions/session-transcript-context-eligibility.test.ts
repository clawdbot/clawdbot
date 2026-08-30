import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceTranscriptEvents } from "./session-accessor.js";
import {
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptActiveStats,
  readSessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import {
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  listSessionsNeedingTranscriptIndexReconcile,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  hasUnclassifiedSessionTranscriptEvents,
  prepareSessionTranscriptProjection,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
} from "./session-transcript-projection-rebuild.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const sessionId = "eligibility";
const entries = [
  { type: "custom", id: "bootstrap", parentId: null, customType: "bootstrap-completed", data: {} },
  {
    type: "message",
    id: "user",
    parentId: "bootstrap",
    message: { role: "user", content: "question" },
  },
  {
    type: "message",
    id: "display",
    parentId: "user",
    message: {
      role: "custom",
      customType: "activity",
      display: true,
      excludeFromContext: true,
      content: "activity",
    },
  },
  {
    type: "message",
    id: "answer",
    parentId: "display",
    message: { role: "assistant", content: "answer", usage: { input: 100, output: 10 } },
  },
] as const;

function projectionRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT active_position, event_seq, message_position, context_eligible FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
    )
    .all(sessionId);
}

function rawRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
    )
    .all(sessionId);
}

it("converges an older current-watermark rebuild and a following append without changing history", async () => {
  await withOpenClawTestState({ label: "transcript-eligibility" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: "agent:main:eligibility",
    };
    runOpenClawAgentWriteTransaction((database) => {
      expect(appendTranscriptEventsInTransaction(database, scope, entries)).toBe(entries.length);
    }, scope);
    const { db } = openOpenClawAgentDatabase(scope);
    const expectedRows = projectionRows(db);
    expect(expectedRows.map((row) => row.context_eligible)).toEqual([1, 1, 0, 1]);
    expect(readRecentSessionTranscriptActiveEvents(scope, 3)).toEqual([
      entries[0],
      entries[1],
      entries[3],
    ]);
    const before = rawRows(db);

    // Older projection writers omit the new column even when they publish a current watermark.
    db.prepare(
      "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
    ).run(sessionId);
    expect(
      db
        .prepare(
          "SELECT needs_rebuild, indexed_seq FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(sessionId),
    ).toEqual({ needs_rebuild: 0, indexed_seq: 3 });
    expect(sessionTranscriptIndexNeedsReconcile(db, sessionId)).toBe(true);
    expect(listSessionsNeedingTranscriptIndexReconcile(db)).toContain(sessionId);
    expect(() => readSessionTranscriptActiveStats(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventsInTransaction(database, scope, [
        entries[3],
        {
          type: "message",
          id: "new",
          parentId: "answer",
          message: { role: "user", content: "next" },
        },
        entries[3],
      ]);
      expect(
        db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ needs_rebuild: 1 });
    }, scope);
    await waitForSessionTranscriptIndexReconcile(scope);

    expect(hasUnclassifiedSessionTranscriptEvents(db, sessionId)).toBe(false);
    expect(sessionTranscriptIndexNeedsReconcile(db, sessionId)).toBe(false);
    expect(rawRows(db).slice(0, before.length)).toEqual(before);
    expect(projectionRows(db).slice(0, expectedRows.length)).toEqual(expectedRows);
    expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(4);
    expect(
      readSessionTranscriptMessageEventPage(scope, { offset: 0, maxMessages: 10 }).totalMessages,
    ).toBe(4);
  });
});

it("reclassifies exact rewrites in both directions and deletes eligibility with the transcript", async () => {
  await withOpenClawTestState({ label: "transcript-eligibility-rewrite" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: "agent:main:eligibility",
    };
    await replaceTranscriptEvents(scope, [...entries]);
    const { db } = openOpenClawAgentDatabase(scope);
    for (const excludeFromContext of [false, true]) {
      const before = rawRows(db);
      const row = before[2];
      if (typeof row?.event_json !== "string") {
        throw new Error("missing activity row");
      }
      const expectedEventJson = row.event_json;
      const event = { ...entries[2], message: { ...entries[2].message, excludeFromContext } };
      runOpenClawAgentWriteTransaction((database) => {
        rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
          { seq: 2, event, expectedEventJson },
        ]);
      }, scope);
      expect(projectionRows(db)[2]?.context_eligible).toBe(excludeFromContext ? 0 : 1);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(excludeFromContext ? 3 : 4);
      expect(
        readSessionTranscriptMessageEventPage(scope, { offset: 0, maxMessages: 10 }).totalMessages,
      ).toBe(3);
      expect(rawRows(db).filter((entry) => entry.seq !== 2)).toEqual(
        before.filter((entry) => entry.seq !== 2),
      );
    }
    await replaceTranscriptEvents(scope, []);
    expect(projectionRows(db)).toEqual([]);
    expect(rawRows(db)).toEqual([]);
    expect(readSessionTranscriptActiveStats(scope)).toEqual({ eventCount: 0, sizeBytes: 0 });
  });
});

it("rejects a prepared projection after a same-sequence rewrite before its claim", async () => {
  await withOpenClawTestState({ label: "transcript-eligibility-stale" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: "agent:main:eligibility",
    };
    await replaceTranscriptEvents(scope, [...entries]);
    const { db } = openOpenClawAgentDatabase(scope);
    const plan = prepareSessionTranscriptProjection(db, sessionId);
    if (!plan) {
      throw new Error("missing prepared projection");
    }
    runOpenClawAgentWriteTransaction((database) => {
      rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
        {
          seq: 2,
          expectedEventJson: JSON.stringify(entries[2]),
          event: { ...entries[2], message: { ...entries[2].message, excludeFromContext: false } },
        },
      ]);
      db.prepare(
        "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
      ).run(sessionId);
      expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(false);
    }, scope);
    expect(() => readSessionTranscriptActiveStats(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    await waitForSessionTranscriptIndexReconcile(scope);
    expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(4);
  });
});

it.each(["interrupted", "unclassified", "append", "rewrite", "delete"])(
  "fences partial eligibility publication after %s work",
  async (change) => {
    await withOpenClawTestState({ label: "transcript-eligibility-claim" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId,
        sessionKey: "agent:main:eligibility",
      };
      await replaceTranscriptEvents(scope, [...entries]);
      const { db } = openOpenClawAgentDatabase(scope);
      db.prepare(
        "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
      ).run(sessionId);
      const plan = prepareSessionTranscriptProjection(db, sessionId);
      if (!plan) {
        throw new Error("missing prepared projection");
      }
      const claimId = -1;
      runOpenClawAgentWriteTransaction(() => {
        expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, claimId)).toBe(true);
        expect(
          deletePreparedSessionTranscriptProjectionChunkInTransaction(db, {
            sessionId,
            claimId,
            maxRowsPerTable: 512,
          }),
        ).toEqual({ owned: true, hasMore: false });
        expect(
          appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
            sessionId,
            claimId,
            activeRows: plan.activeRows.slice(0, 1),
          }),
        ).toBe(true);
      }, scope);
      // Removing the last NULL is not publication: counts and source identity still need a commit.
      expect(hasUnclassifiedSessionTranscriptEvents(db, sessionId)).toBe(false);
      expect(() => withCurrentProjectionSnapshot(scope, () => "visible")).toThrow(
        SessionTranscriptProjectionUnavailableError,
      );

      if (change !== "interrupted") {
        runOpenClawAgentWriteTransaction((database) => {
          if (change === "unclassified") {
            expect(
              appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
                sessionId,
                claimId,
                activeRows: plan.activeRows.slice(1),
                ftsRows: plan.ftsRows,
              }),
            ).toBe(true);
            db.prepare(
              "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
            ).run(sessionId);
          } else if (change === "append") {
            appendTranscriptEventsInTransaction(database, scope, [
              {
                type: "message",
                id: "new",
                parentId: "answer",
                message: { role: "user", content: "next" },
              },
            ]);
          } else if (change === "rewrite") {
            rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
              {
                seq: 2,
                expectedEventJson: JSON.stringify(entries[2]),
                event: {
                  ...entries[2],
                  message: { ...entries[2].message, excludeFromContext: false },
                },
              },
            ]);
          } else {
            replaceSqliteTranscriptEventsInTransaction(database, scope, []);
          }
          expect(finalizePreparedSessionTranscriptProjectionInTransaction(db, plan, claimId)).toBe(
            false,
          );
        }, scope);
      }
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(sessionTranscriptIndexNeedsReconcile(db, sessionId)).toBe(false);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(
        change === "delete" ? 0 : change === "append" || change === "rewrite" ? 4 : 3,
      );
      expect(projectionRows(db).every((row) => row.context_eligible !== null)).toBe(true);
    });
  },
);
