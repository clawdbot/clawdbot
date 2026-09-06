import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTranscriptActiveStats } from "./session-accessor.sqlite-active-events.js";
import {
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
  updateSqliteTranscriptEventJsonInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  prepareSessionTranscriptProjection,
  claimPreparedSessionTranscriptProjectionInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
} from "./session-transcript-projection-rebuild.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("SQLite transcript append", () => {
  it("canonicalizes assistant media at the generic transcript append owner", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-append-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const committedJson = runOpenClawAgentWriteTransaction(
      (database) =>
        appendTranscriptEventInTransaction(
          database,
          {
            agentId: "main",
            env,
            sessionId: "append-session",
            sessionKey: "agent:main:append-session",
          },
          {
            type: "message",
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: {
              role: "assistant",
              content: "append",
              MediaPaths: ["/media/a.png"],
              MediaTypes: ["image/png"],
            },
          },
        ),
      { agentId: "main", env },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const row = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
      .get("append-session") as { event_json: string };
    expect(committedJson).toBe(row.event_json);
    const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
    expect(message).toMatchObject({ role: "assistant", content: "append" });
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(message["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: "/media/a.png", contentType: "image/png" })],
    });
  });
});

const rewriteEvents = [
  { type: "custom", id: "root", parentId: null },
  { type: "message", id: "user", parentId: "root", message: { role: "user", content: "question" } },
  {
    type: "message",
    id: "answer",
    parentId: "user",
    message: { role: "assistant", content: "answer" },
  },
] as const;

async function withRewriteFixture(
  run: (f: {
    db: DatabaseSync;
    snapshot: () => {
      raw: Array<Record<string, unknown>>;
      identities: unknown[];
      active: unknown[];
      search: unknown[];
      generation: string | undefined;
      updatedAt: number | null;
    };
    rewrite: (event: unknown, seq?: number) => void;
    scope: { agentId: string; sessionId: string; sessionKey: string; env: NodeJS.ProcessEnv };
  }) => void | Promise<void>,
) {
  await withOpenClawTestState({ label: "exact-rewrite" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "rewrite",
      sessionKey: "agent:main:rewrite",
      env: state.env,
    };
    const owner = openOpenClawAgentDatabase(scope);
    const { db } = owner;
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventsInTransaction(database, scope, rewriteEvents);
    }, scope);
    const snapshot = () => ({
      raw: db
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      active: db
        .prepare(
          "SELECT * FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
      search: db
        .prepare("SELECT * FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id")
        .all(scope.sessionId),
      generation: readTranscriptGenerationInTransaction(owner, scope.sessionId),
      updatedAt: readTranscriptMutationStateInTransaction(owner, scope.sessionId).updatedAt,
    });
    const rewrite = (event: unknown, seq = 1) => {
      const row = db
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = ?")
        .get(scope.sessionId, seq);
      if (typeof row?.event_json !== "string") {
        throw new Error("missing rewrite row");
      }
      const expectedEventJson = row.event_json;
      runOpenClawAgentWriteTransaction((database) => {
        rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
          { seq, event, expectedEventJson },
        ]);
      }, scope);
    };
    await run({ db, snapshot, rewrite, scope });
  });
}

describe("SQLite exact transcript rewrite", () => {
  it("preserves healthy derived rows without FTS access or size scans while raw mutation advances", async () => {
    await withRewriteFixture(({ db, snapshot, rewrite, scope }) => {
      const before = snapshot();
      const work = trackSqliteStatementExecutions(db, ["fts", "size"], (sql) =>
        sql.includes("session_transcript_fts")
          ? "fts"
          : sql.includes("octet_length")
            ? "size"
            : null,
      );
      try {
        rewrite({
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, provenance: "new" },
        });
      } finally {
        work.restore();
      }
      const after = snapshot();
      expect(after.generation).not.toBe(before.generation);
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt!);
      expect(after.active).toEqual(before.active);
      expect(after.search).toEqual(before.search);
      expect(after.raw[0]).toEqual(before.raw[0]);
      expect(after.raw[2]).toEqual(before.raw[2]);
      expect(after.raw[1]).toEqual({ ...before.raw[1], event_json: expect.any(String) });
      expect(after.raw[1]?.event_json).not.toBe(before.raw[1]?.event_json);
      expect(after.identities).toEqual(before.identities);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(work.counts).toEqual({ fts: 0, size: 0 });
    });
  });

  it("keeps oversized metadata current but hides changed text until the real worker reconciles", async () => {
    await withRewriteFixture(async ({ db, rewrite, scope }) => {
      const message = {
        ...rewriteEvents[1].message,
        provenance: "x".repeat(SYNC_REBUILD_MAX_BYTES + 1),
      };
      rewrite({ ...rewriteEvents[1], message });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      const before = prepareSessionTranscriptProjection(db, scope.sessionId)!;
      const work = trackSqliteStatementExecutions(db, ["fts"], (sql) =>
        sql.includes("session_transcript_fts") ? "fts" : null,
      );
      try {
        rewrite({ ...rewriteEvents[1], message: { ...message, content: "changed" } });
        expect(work.counts.fts).toBe(0);
      } finally {
        work.restore();
      }
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
      expect(() => readSessionTranscriptActiveStats(scope)).toThrow(
        SessionTranscriptProjectionUnavailableError,
      );
      expect(searchSessionTranscripts({ ...scope, query: "question" }).hits).toEqual([]);
      expect(claimPreparedSessionTranscriptProjectionInTransaction(db, before, -1)).toBe(false);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(searchSessionTranscripts({ ...scope, query: "changed" }).hits).toMatchObject([
        { messageId: "user" },
      ]);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(3);
    });
  });

  it("rolls back all exact writes and mutation state when a later expected row conflicts", async () => {
    await withRewriteFixture(({ snapshot, scope }) => {
      const before = snapshot();
      expect(() =>
        runOpenClawAgentWriteTransaction((database) => {
          rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
            {
              seq: 1,
              expectedEventJson: JSON.stringify(rewriteEvents[1]),
              event: { ...rewriteEvents[1], message: { role: "user", content: "edited" } },
            },
            { seq: 2, expectedEventJson: "stale", event: rewriteEvents[2] },
          ]);
        }, scope),
      ).toThrow("changed before exact rewrite");
      expect(snapshot()).toEqual(before);
    });
  });

  it.each(["dirty", "missing", "lagging", "unclassified", "claimed"] as const)(
    "recovers %s projections on metadata rewrite and fences stale publication",
    async (kind) => {
      await withRewriteFixture(({ db, rewrite, snapshot, scope }) => {
        const before = snapshot();
        const plan = prepareSessionTranscriptProjection(db, scope.sessionId)!;
        if (kind === "missing") {
          db.prepare("DELETE FROM session_transcript_index_state").run();
        } else if (kind === "unclassified") {
          db.prepare("UPDATE session_transcript_active_events SET context_eligible = NULL").run();
        } else if (kind === "lagging") {
          db.prepare("UPDATE session_transcript_index_state SET indexed_seq = -1").run();
        } else {
          db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
        }
        if (kind === "claimed") {
          expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(true);
          db.prepare("DELETE FROM session_transcript_active_events").run();
          db.prepare("DELETE FROM session_transcript_fts").run();
        }
        expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
        rewrite({
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, provenance: "new" },
        });
        expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
        expect(snapshot().active).toEqual(before.active);
        expect(snapshot().search).toEqual(before.search);
        expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -2)).toBe(false);
        expect(
          appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
            sessionId: scope.sessionId,
            claimId: -1,
            ftsRows: plan.ftsRows,
          }),
        ).toBe(false);
        expect(finalizePreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(false);
      });
    },
  );

  it.each([
    {
      name: "content",
      seq: 1,
      event: { ...rewriteEvents[1], message: { role: "user", content: "changed" } },
      texts: ["answer", "changed"],
      messages: 2,
    },
    {
      name: "role",
      seq: 1,
      event: { ...rewriteEvents[1], message: { role: "toolResult", content: "question" } },
      texts: ["answer"],
      messages: 2,
    },
    {
      name: "timestamp",
      seq: 1,
      event: { ...rewriteEvents[1], timestamp: 99 },
      texts: ["answer", "question"],
      messages: 2,
    },
    {
      name: "message presence",
      seq: 1,
      event: { type: "message", id: "user", parentId: "root" },
      texts: ["answer"],
      messages: 1,
    },
    {
      name: "parent",
      seq: 2,
      event: { ...rewriteEvents[2], parentId: "root" },
      texts: ["answer"],
      messages: 1,
    },
    {
      name: "leaf control",
      seq: 2,
      event: { type: "leaf", id: "answer", parentId: "user", targetId: "user" },
      texts: ["question"],
      messages: 1,
    },
  ])(
    "rebuilds changed $name facts without duplicate FTS invalidation",
    async ({ event, seq, texts, messages, name }) => {
      await withRewriteFixture(({ db, rewrite, scope }) => {
        const work = trackSqliteStatementExecutions(db, ["deletes"], (sql) =>
          /^delete from ["`]?session_transcript_fts["`]? /i.test(sql) ? "deletes" : null,
        );
        try {
          rewrite(event, seq);
        } finally {
          work.restore();
        }
        const search = db
          .prepare("SELECT text, timestamp FROM session_transcript_fts ORDER BY message_id")
          .all();
        expect(search.map((row) => row.text)).toEqual(texts);
        if (name === "timestamp") {
          expect(search[1]?.timestamp).toBe(99);
        }
        expect(
          db
            .prepare(
              "SELECT active_message_count FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(scope.sessionId)?.active_message_count,
        ).toBe(messages);
        expect(work.counts.deletes).toBeLessThanOrEqual(1);
      });
    },
  );

  it("avoids duplicate FTS invalidation for maintenance text repair and preserves recency", async () => {
    await withRewriteFixture(({ db, scope, snapshot }) => {
      const before = snapshot();
      const work = trackSqliteStatementExecutions(db, ["deletes"], (sql) =>
        /^delete from ["`]?session_transcript_fts["`]? /i.test(sql) ? "deletes" : null,
      );
      try {
        runOpenClawAgentWriteTransaction(
          (database) =>
            updateSqliteTranscriptEventJsonInTransaction(database, scope.sessionId, [
              {
                seq: 1,
                eventJson: JSON.stringify({
                  ...rewriteEvents[1],
                  message: { role: "user", content: "repaired" },
                }),
              },
            ]),
          scope,
        );
      } finally {
        work.restore();
      }
      expect(snapshot().updatedAt).toBe(before.updatedAt! + 1);
      expect(
        db.prepare("SELECT text FROM session_transcript_fts WHERE message_id = 'user'").get()?.text,
      ).toBe("repaired");
      expect(work.counts.deletes).toBeLessThanOrEqual(1);
    });
  });
});
