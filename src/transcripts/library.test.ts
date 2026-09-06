import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPTS_EXPORT_MAX_BYTES,
  TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES,
  TRANSCRIPTS_RESULT_MAX_BYTES,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
} from "../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { activeSessions } from "./capture.js";
import { exportTranscriptLibrary, getTranscriptLibrary, listTranscriptLibrary } from "./library.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { readTranscriptLibraryStatus } from "./status.js";
import { meetingTranscriptDb } from "./store-sqlite.js";
import { TranscriptsStore, transcriptSessionSelector } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  activeSessions.clear();
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const stateDir = tempDirs.make("transcript-library-");
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  return {
    stateDir,
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), options),
    database: () => openOpenClawStateDatabase(options).db,
  };
}

function observeArchiveReads(database: DatabaseSync) {
  clearNodeSqliteKyselyCacheForDatabase(database);
  const queries: Array<{
    sql: string;
    rows: number;
    bytes: number;
    maxRowBytes: number;
    closed: boolean;
  }> = [];
  const prepare = database.prepare.bind(database);
  vi.spyOn(database, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!/^select\b/iu.test(sql) || !sql.includes("meeting_transcript_")) {
      return statement;
    }
    const record = { sql, rows: 0, bytes: 0, maxRowBytes: 0, closed: false };
    queries.push(record);
    const iterate = statement.iterate.bind(statement);
    vi.spyOn(statement, "iterate").mockImplementation((...parameters) => {
      const iterator = iterate(...parameters);
      const next = iterator.next.bind(iterator);
      vi.spyOn(iterator, "next").mockImplementation(() => {
        const result = next();
        if (result.done) {
          record.closed = true;
        } else {
          const bytes = Object.values(result.value).reduce<number>(
            (total, value) => total + (typeof value === "string" ? Buffer.byteLength(value) : 0),
            0,
          );
          record.rows++;
          record.bytes += bytes;
          record.maxRowBytes = Math.max(record.maxRowBytes, bytes);
        }
        return result;
      });
      if (iterator.return) {
        const finish = iterator.return.bind(iterator);
        vi.spyOn(iterator, "return").mockImplementation(() => {
          record.closed = true;
          return finish();
        });
      }
      return iterator;
    });
    return statement;
  });
  return queries;
}
function session(
  sessionId: string,
  overrides: Partial<TranscriptSessionDescriptor> = {},
): TranscriptSessionDescriptor {
  return {
    sessionId,
    title: sessionId,
    source: { providerId: "manual-transcript" },
    startedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

describe("transcript library SQLite reads", () => {
  it("orders and filters stored offset dates by instant without rewriting their identities", async () => {
    const { store } = fixture();
    const rows = [
      session("offset-at-1000", { startedAt: "2026-08-20T03:00:00-07:00" }),
      session("utc-at-0930", { startedAt: "2026-08-20T09:30:00.000Z" }),
      session("utc-at-1030", { startedAt: "2026-08-20T10:30:00.000Z" }),
    ];
    for (const row of rows) {
      await store.writeSession(row);
    }
    const result = listTranscriptLibrary(store, { startedAfter: "2026-08-20T09:00:00Z" });
    expect(result.sessions.map(({ sessionId }) => sessionId)).toEqual([
      "utc-at-1030",
      "offset-at-1000",
      "utc-at-0930",
    ]);
    for (const row of rows) {
      expect(await store.readSession(transcriptSessionSelector(row))).toEqual(row);
    }
  });

  it("paginates equal instants and unknown dates using original identity ties and date-string semantics", async () => {
    const { store } = fixture();
    const ordered = [
      session("later", { startedAt: "2026-08-20T06:30:00Z" }),
      session("fraction-tail", { startedAt: "2026-08-20T06:00:00.9999Z" }),
      session("basic", { startedAt: "2026-08-20T06:00:00+0000" }),
      session("fraction", { startedAt: "2026-08-20T06:00:00.0005Z" }),
      session("same", { startedAt: "2026-08-19T23:00:00-07:00" }),
      session("same", { startedAt: "2026-08-20T06:00:00.000Z" }),
      session("earlier", { startedAt: "2026-08-20T05:30:00Z" }),
      session("unknown", { startedAt: "2026-08-21Tbad" }),
      session("unknown", { startedAt: "2026-08-22Tbad" }),
      session("unknown-z", { startedAt: "2026-08-20Tbad" }),
    ];
    for (const row of ordered.toReversed()) {
      await store.writeSession(row);
    }
    const seen: Array<{ sessionId: string; startedAt: string; selector: string }> = [];
    let cursor: string | undefined;
    for (let index = 0; index < ordered.length; index++) {
      const page = listTranscriptLibrary(store, { limit: 1, cursor });
      expect(page.sessions).toHaveLength(1);
      const { sessionId, startedAt, selector } = page.sessions[0]!;
      seen.push({ sessionId, startedAt, selector });
      expect(page.nextCursor).toEqual(index === ordered.length - 1 ? null : expect.any(String));
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toEqual(
      ordered.map((row) => ({
        sessionId: row.sessionId,
        startedAt: row.startedAt,
        selector: transcriptSessionSelector(row),
      })),
    );
    expect(
      listTranscriptLibrary(store, {
        startedAfter: "2026-08-20T06:00:00.0005Z",
        startedBefore: "2026-08-20T06:00:00.001Z",
      }).sessions.map(({ sessionId }) => sessionId),
    ).toEqual(["basic", "fraction", "same", "same"]);
  });

  it(
    "uses the process timezone for unzoned stored dates and range bounds",
    { timeout: 45_000 },
    () => {
      const stateDir = tempDirs.make("transcript-library-timezone-");
      const local = session("local", { startedAt: "2026-08-20T06:00:00" });
      const earlier = session("earlier", { startedAt: "2026-08-20T06:30:00Z" });
      const child = spawnNodeEvalSync(
        `
        import assert from "node:assert/strict";
        import { TranscriptsStore, transcriptSessionSelector } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
        import { listTranscriptLibrary } from ${JSON.stringify(new URL("./library.ts", import.meta.url).href)};
        import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(new URL("../state/openclaw-state-db.ts", import.meta.url).href)};
        const store = new TranscriptsStore(${JSON.stringify(path.join(stateDir, "transcripts"))});
        const local = ${JSON.stringify(local)};
        try {
          await store.writeSession(local);
          await store.writeSession(${JSON.stringify(earlier)});
          const first = listTranscriptLibrary(store, { limit: 1 });
          assert.deepEqual(first.sessions.map(row => row.sessionId), ["local"]);
          assert.equal(typeof first.nextCursor, "string");
          const next = listTranscriptLibrary(store, { limit: 1, cursor: first.nextCursor });
          assert.deepEqual(next.sessions.map(row => row.sessionId), ["earlier"]);
          assert.equal(next.nextCursor, null);
          assert.deepEqual(listTranscriptLibrary(store, {
            startedAfter: "2026-08-20T06:00:00",
            startedBefore: "2026-08-20T13:00:00.001Z",
          }).sessions.map(row => row.sessionId), ["local"]);
          assert.deepEqual(listTranscriptLibrary(store, {
            startedAfter: "2026-08-20T13:00:00.000Z",
            startedBefore: "2026-08-20T13:00:00.001Z",
          }).sessions.map(row => row.sessionId), ["local"]);
          assert.deepEqual(await store.readSession(transcriptSessionSelector(local)), local);
        } finally {
          closeOpenClawStateDatabaseForTest();
        }
      `,
        {
          imports: ["tsx"],
          timeout: 30_000,
          env: {
            ...process.env,
            TZ: "America/Los_Angeles",
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          },
        },
      );
      expect(child.status, child.stderr).toBe(0);
    },
  );

  it.each(["at-cap", "oversized-ascii", "oversized-utf8"] as const)(
    "bounds %s stored date input before the JavaScript parser",
    async (kind) => {
      const { store } = fixture();
      const prefix = "2026-08-20T";
      const remaining = TRANSCRIPTS_RESULT_MAX_BYTES - prefix.length;
      const startedAt =
        prefix +
        (kind === "oversized-utf8"
          ? "é".repeat(Math.floor(remaining / 2) + 1)
          : "x".repeat(remaining + Number(kind === "oversized-ascii")));
      await store.writeSession(session(kind, { startedAt }));
      const parse = vi.spyOn(Date, "parse");
      expect(() => listTranscriptLibrary(store, {})).toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      expect(parse.mock.calls.some(([value]) => value === startedAt)).toBe(kind === "at-cap");
    },
  );

  it("keeps unread notes outside the chronological page and its lookahead", async () => {
    const { store, database } = fixture();
    const old = session("old", { startedAt: "2026-08-18T00:00:00Z" });
    await store.writeSession(old);
    await store.writeSummary(summarizeTranscripts({ session: old, utterances: [] }), old);
    const db = database();
    executeSqliteQuerySync(
      db,
      meetingTranscriptDb(db)
        .updateTable("meeting_transcript_summaries")
        .set({ summary_json: "unreadable old notes" })
        .where("session_id", "=", old.sessionId),
    );
    for (const id of ["b", "a"]) {
      await store.writeSession(session(id));
    }
    const result = listTranscriptLibrary(store, { limit: 1 });
    expect(result.sessions.map(({ sessionId }) => sessionId)).toEqual(["a"]);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("shares date registration across readers and registers a fresh canonical connection after close", async () => {
    const { store, database } = fixture();
    await store.writeSession(session("one"));
    const db = database();
    const schema = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all();
    expect(listTranscriptLibrary(store, {}).sessions).toHaveLength(1);
    const held = db.prepare("SELECT 1 UNION ALL SELECT 2").iterate();
    held.next();
    try {
      expect(listTranscriptLibrary(store, {}).sessions).toHaveLength(1);
    } finally {
      held.return?.();
    }
    expect(db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(
      schema,
    );
    closeOpenClawStateDatabaseForTest();
    expect(database() === db).toBe(false);
    expect(listTranscriptLibrary(store, {}).sessions).toHaveLength(1);
  });

  it("stops active status descriptor reads when the public result budget is consumed", async () => {
    const { store, database } = fixture();
    for (let index = 0; index < 6; index++) {
      const target = session(`active-${index}`, {
        title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2),
      });
      await store.writeSession(target);
      activeSessions.set(target.sessionId, {
        session: target,
        providerId: target.source.providerId,
        provider: {},
        phase: "active",
      });
    }
    const reads = observeArchiveReads(database());
    await expect(readTranscriptLibraryStatus(store, {})).rejects.toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    expect(
      reads.filter((read) => read.sql.includes('from "meeting_transcript_sessions"')).length,
    ).toBeLessThanOrEqual(3);
  });

  it.each(["text", "combined speaker fields"])(
    "bounds %s before SQLite returns an oversized row",
    async (kind) => {
      const { store, database } = fixture();
      const target = session("allocation");
      await store.writeSession(target);
      const payload = "é\0".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2);
      await store.appendUtteranceForSession(
        target,
        kind === "text"
          ? { text: payload }
          : {
              text: "small",
              speaker: { id: "x".repeat(600_000), label: "y".repeat(600_000) },
            },
      );
      const reads = observeArchiveReads(database());
      await expect(
        getTranscriptLibrary(store, {
          selector: transcriptSessionSelector(target),
          includeUtterances: true,
          limit: 1,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          type: "transcript_result_too_large",
          maxBytes: TRANSCRIPTS_RESULT_MAX_BYTES,
        }),
      );
      expect(reads.length).toBeGreaterThan(0);
      expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
        TRANSCRIPTS_RESULT_MAX_BYTES,
      );
      expect(reads.every((read) => read.closed)).toBe(true);
      expect(await store.readUtterancesForSession(target)).toHaveLength(1);
    },
  );

  it("stops a cumulative page before consuming the remaining rows and releases its iterator", async () => {
    const { store, database } = fixture();
    const target = session("cumulative");
    await store.writeSession(target);
    for (let index = 0; index < 6; index++) {
      await store.appendUtteranceForSession(target, {
        text: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2),
      });
    }
    const reads = observeArchiveReads(database());
    expect(() => store.readUtterancePage(target, { limit: 6 })).toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    const page = reads.find((read) => read.sql.includes('"sequence"'))!;
    expect(page.rows).toBeLessThanOrEqual(3);
    expect(page.bytes).toBeLessThanOrEqual(2 * TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(page.closed).toBe(true);
    await store.appendUtteranceForSession(target, { text: "after rejection" });
    expect(store.readUtterancePage(target, { after: 5 }).utterances).toMatchObject([
      { text: "after rejection", sequence: 6 },
    ]);
  });

  it("uses oversized lookahead only for pagination, then rejects that requested row", async () => {
    const { store, database } = fixture();
    const target = session("lookahead");
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, { text: "first" });
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1),
    });
    const reads = observeArchiveReads(database());
    const first = await getTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
      includeUtterances: true,
      limit: 1,
    });
    expect(first.utterances).toEqual([{ sequence: 0, text: "first" }]);
    expect(first.nextCursor).not.toBeNull();
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    await expect(
      getTranscriptLibrary(store, {
        selector: first.session.selector,
        includeUtterances: true,
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
  });

  it.each(["title", "source and metadata", "last timestamp"])(
    "bounds %s in list, selector and latest descriptors without limiting full-store reads",
    async (field) => {
      const { store, database } = fixture();
      const target = session(
        "descriptor",
        field === "title"
          ? { title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) }
          : field === "source and metadata"
            ? {
                source: { providerId: "manual-transcript", private: "x".repeat(600_000) },
                metadata: { private: "y".repeat(600_000) },
              }
            : {},
      );
      await store.writeSession(target);
      await store.appendUtteranceForSession(target, {
        text: "note",
        ...(field === "last timestamp"
          ? { endedAt: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) }
          : {}),
      });
      const reads = observeArchiveReads(database());
      expect(() => listTranscriptLibrary(store, {})).toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      expect(() => store.readLatestEntry()).toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      expect(() => store.readEntry(transcriptSessionSelector(target))).toThrow(
        expect.objectContaining({ type: "transcript_result_too_large" }),
      );
      expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
        TRANSCRIPTS_RESULT_MAX_BYTES,
      );
      expect(store.readEntry(target.sessionId)).toBeUndefined();
      expect(await store.readSession(target.sessionId)).toEqual(target);
    },
  );

  it("streams list projections, preserves oversized lookahead and does not retain private metadata across rows", async () => {
    const { store, database } = fixture();
    const first = session("a");
    const second = session("b", { title: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1) });
    await store.writeSession(first);
    await store.writeSession(second);
    const reads = observeArchiveReads(database());
    const page = listTranscriptLibrary(store, { limit: 1 });
    expect(page.sessions.map((entry) => entry.sessionId)).toEqual(["a"]);
    expect(page.nextCursor).not.toBeNull();
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    expect(() => listTranscriptLibrary(store, { cursor: page.nextCursor! })).toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    for (const id of ["b", "c", "d"]) {
      await store.writeSession(session(id, { title: "x".repeat(600_000) }));
    }
    reads.length = 0;
    expect(() => listTranscriptLibrary(store, { query: "x" })).toThrow(
      expect.objectContaining({ type: "transcript_result_too_large" }),
    );
    expect(reads[0]?.rows).toBe(2);
    expect(reads.every((read) => read.closed)).toBe(true);
    for (const id of ["b", "c", "d"]) {
      await store.writeSession(session(id, { metadata: { private: "x".repeat(600_000) } }));
    }
    expect(listTranscriptLibrary(store, {}).sessions.map((entry) => entry.sessionId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("bounds summary transfer after omitting duplicated history and keeps the larger export budget", async () => {
    const { store, database } = fixture();
    const target = session("summary-bound");
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, { text: "saved note" });
    const summary = {
      ...summarizeTranscripts({ session: target, utterances: [] }),
      transcript: ["x".repeat(TRANSCRIPTS_EXPORT_MAX_BYTES + 1)],
    };
    await store.writeSummary({ ...summary, transcript: [] }, target);
    const db = database();
    executeSqliteQuerySync(
      db,
      meetingTranscriptDb(db)
        .updateTable("meeting_transcript_summaries")
        .set({ summary_json: JSON.stringify(summary) })
        .where("session_id", "=", target.sessionId)
        .where("session_started_at", "=", target.startedAt),
    );
    const reads = observeArchiveReads(database());
    expect(
      (await getTranscriptLibrary(store, { selector: transcriptSessionSelector(target) })).summary
        ?.overview,
    ).toBe(summary.overview);
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    await store.writeSummary(
      { ...summary, transcript: [], overview: "é".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2 + 1) },
      target,
    );
    reads.length = 0;
    await expect(
      getTranscriptLibrary(store, { selector: transcriptSessionSelector(target), limit: 50 }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_RESULT_MAX_BYTES,
    );
    const legacy = await getTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
    });
    expect(Buffer.byteLength(JSON.stringify(legacy))).toBeGreaterThan(TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(legacy.summary?.overview).toBe("é".repeat(TRANSCRIPTS_RESULT_MAX_BYTES / 2 + 1));
    const exported = await exportTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
      format: "markdown",
    });
    expect(exported.sizeBytes).toBeGreaterThan(TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(exported.sizeBytes).toBeLessThan(TRANSCRIPTS_EXPORT_MAX_BYTES);
    expect(Buffer.from(exported.data, "base64").toString("utf8")).toContain("saved note");
  });

  it("clips legacy speech before its transport envelope while retaining modern raw-row bounds", async () => {
    const { store } = fixture();
    const target = session("legacy-clipping");
    const selector = transcriptSessionSelector(target);
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, {
      text: "\u001b[31m" + "x".repeat(TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES + 1),
    });
    const legacy = await getTranscriptLibrary(store, { selector, includeUtterances: true });
    expect(legacy.utterances).toEqual([{ sequence: 0, text: "x".repeat(4000) }]);
    await expect(
      getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 1 }),
    ).rejects.toThrow(
      expect.objectContaining({
        type: "transcript_result_too_large",
        maxBytes: TRANSCRIPTS_RESULT_MAX_BYTES,
      }),
    );
    await store.writeSession({
      ...target,
      title: "x".repeat(TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES + 1),
    });
    await expect(getTranscriptLibrary(store, { selector })).rejects.toThrow(
      expect.objectContaining({
        type: "transcript_result_too_large",
        maxBytes: TRANSCRIPTS_LEGACY_RESULT_MAX_BYTES,
      }),
    );
  });

  it("preserves ID-only stored speakers across legacy reads, pages, and exports", async () => {
    const { store, database } = fixture();
    const target = session("speaker-id-only");
    const selector = transcriptSessionSelector(target);
    await store.writeSession(target);
    await store.appendUtteranceForSession(target, {
      id: "speech-id",
      text: "Saved speech",
      speaker: { id: "speaker-id", label: "Stored label" },
    });
    const db = database();
    executeSqliteQuerySync(
      db,
      meetingTranscriptDb(db)
        .updateTable("meeting_transcript_utterances")
        .set({
          speaker_label: null,
          metadata_json: JSON.stringify({ private: "x".repeat(2 * TRANSCRIPTS_RESULT_MAX_BYTES) }),
        })
        .where("session_id", "=", target.sessionId)
        .where("session_started_at", "=", target.startedAt),
    );
    for (const limit of [undefined, 1]) {
      const read = await getTranscriptLibrary(store, { selector, includeUtterances: true, limit });
      expect(read.utterances?.[0]).toMatchObject({ speakerId: "speaker-id", text: "Saved speech" });
      expect(read.utterances?.[0]?.speakerLabel).toBeUndefined();
      expect(read.utterances?.[0]?.id).toBe(limit === undefined ? undefined : "speech-id");
    }
    const exported = await exportTranscriptLibrary(store, { selector, format: "jsonl" });
    expect(JSON.parse(Buffer.from(exported.data, "base64").toString("utf8"))).toEqual({
      sequence: 0,
      id: "speech-id",
      speakerId: "speaker-id",
      text: "Saved speech",
    });
  });

  it("keeps exact JSON escaping checks and exports valid content above the reader limit", async () => {
    const { store, database } = fixture();
    const target = session("escaping");
    await store.writeSession(target);
    const text = '"'.repeat(600_000) + "é🦞";
    await store.appendUtteranceForSession(target, { text });
    const reads = observeArchiveReads(database());
    await expect(
      getTranscriptLibrary(store, {
        selector: transcriptSessionSelector(target),
        includeUtterances: true,
        limit: 1,
      }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
    const exported = await exportTranscriptLibrary(store, {
      selector: transcriptSessionSelector(target),
      format: "jsonl",
    });
    expect(exported.sizeBytes).toBeGreaterThan(TRANSCRIPTS_RESULT_MAX_BYTES);
    expect(exported.sizeBytes).toBeLessThan(TRANSCRIPTS_EXPORT_MAX_BYTES);
    expect(JSON.parse(Buffer.from(exported.data, "base64").toString("utf8"))).toEqual({
      sequence: 0,
      text,
    });
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(TRANSCRIPTS_EXPORT_MAX_BYTES + 1),
    });
    reads.length = 0;
    await expect(
      exportTranscriptLibrary(store, {
        selector: transcriptSessionSelector(target),
        format: "jsonl",
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        type: "transcript_export_too_large",
        maxBytes: TRANSCRIPTS_EXPORT_MAX_BYTES,
      }),
    );
    expect(Math.max(...reads.map((read) => read.maxRowBytes))).toBeLessThanOrEqual(
      TRANSCRIPTS_EXPORT_MAX_BYTES,
    );
    expect(reads.every((read) => read.closed)).toBe(true);
  });

  it("pages with a stable tie-break, a default of 50, and an explicit upper bound", async () => {
    const { store } = fixture();
    for (let index = 0; index < 103; index++) {
      await store.writeSession(session(`session-${String(index).padStart(3, "0")}`));
    }
    const first = listTranscriptLibrary(store, {});
    expect(first.sessions).toHaveLength(50);
    const second = listTranscriptLibrary(store, { cursor: first.nextCursor! });
    const third = listTranscriptLibrary(store, { cursor: second.nextCursor! });
    expect(second.sessions).toHaveLength(50);
    expect(third.sessions).toHaveLength(3);
    expect(third.nextCursor).toBeNull();
    expect(
      [...first.sessions, ...second.sessions, ...third.sessions].map((entry) => entry.sessionId),
    ).toEqual(
      Array.from({ length: 103 }, (_, index) => `session-${String(index).padStart(3, "0")}`),
    );
    expect(listTranscriptLibrary(store, { limit: 100 }).sessions).toHaveLength(100);
    expect(listTranscriptLibrary(store, { limit: 200 }).sessions).toHaveLength(103);
    for (const limit of [0, 201, 1.5]) {
      expect(() => listTranscriptLibrary(store, { limit })).toThrow("between 1 and 200");
    }
    await store.writeSession(session("newer", { startedAt: "2026-08-21T10:00:00.000Z" }));
    expect(listTranscriptLibrary(store, { cursor: first.nextCursor! }).sessions[0]?.sessionId).toBe(
      "session-050",
    );
  });

  it("combines literal title/source search, exact owner/account/provider filters and inclusive/exclusive dates", async () => {
    const { store } = fixture();
    const source = {
      providerId: "room-provider",
      accountId: "work",
      channelId: "room-a",
      kind: "live-audio" as const,
    };
    await store.writeSession(
      session("one", { title: "100% Launch_review", source, metadata: { agentId: "ops" } }),
    );
    await store.writeSession(
      session("two", {
        source,
        metadata: { agentId: "main" },
        startedAt: "2026-08-21T10:00:00.000Z",
      }),
    );
    await store.writeSession(session("legacy", { source }));
    const filters = {
      providerId: "room-provider",
      accountId: "work",
      agentId: "ops",
      startedAfter: "2026-08-20T03:00:00-07:00",
      startedBefore: "2026-08-21T10:00:00Z",
    };
    expect(
      listTranscriptLibrary(store, { ...filters, query: "% LAUNCH_" }).sessions.map(
        (entry) => entry.sessionId,
      ),
    ).toEqual(["one"]);
    expect(
      listTranscriptLibrary(store, { ...filters, query: "ROOM-A" }).sessions.map(
        (entry) => entry.sessionId,
      ),
    ).toEqual(["one"]);
    expect(listTranscriptLibrary(store, { ...filters, accountId: "personal" }).sessions).toEqual(
      [],
    );
    expect(listTranscriptLibrary(store, { ...filters, providerId: "different" }).sessions).toEqual(
      [],
    );
    expect(
      listTranscriptLibrary(store, { agentId: "main" }).sessions.map((entry) => entry.sessionId),
    ).toEqual(["two"]);
    expect(
      listTranscriptLibrary(store, {}).sessions.find((entry) => entry.sessionId === "legacy")
        ?.agentId,
    ).toBeNull();
    expect(() => listTranscriptLibrary(store, { startedAfter: "bad date" })).toThrow("date filter");
    expect(() =>
      listTranscriptLibrary(store, { startedAfter: "2026-08-22", startedBefore: "2026-08-21" }),
    ).toThrow("range");
  });

  it("preserves full canonical handles and pages/searches durable utterances without reading exports", async () => {
    const { store, stateDir } = fixture();
    const hidden = [
      "fixture-user-amber",
      "fixture-pass-cobalt",
      "fixture-query-violet",
      "fixture-fragment-ochre",
    ];
    const meetingUrl = new URL(`https://example.test/room?invite=${hidden[2]}#${hidden[3]}`);
    meetingUrl.username = hidden[0]!;
    meetingUrl.password = hidden[1]!;
    const target = session("standup:@room?opaque", {
      title: "Public planning",
      source: {
        providerId: "meet",
        accountId: "public-account",
        guildId: "public-guild",
        channelId: "public-channel",
        threadTs: "public-thread",
        fileId: "public-file",
        meetingUrl: meetingUrl.href,
        privateKey: "not-for-ui",
      },
      metadata: { private: "not-for-ui" },
    });
    await store.writeSession(target);
    const utterances = [
      {
        text: "First decision: approved.",
        speaker: { label: "Sam", id: "speaker-1" },
        startedAt: "2026-08-20T10:01:00.000Z",
        final: true,
      },
      { text: "Background." },
      {
        text: "Follow up: FIRST milestone.",
        endedAt: "2026-08-20T10:03:00.000Z",
        metadata: { private: "not-for-ui" },
      },
    ];
    for (const utterance of utterances) {
      await store.appendUtteranceForSession(target, utterance);
    }
    await store.writeSummary(summarizeTranscripts({ session: target, utterances }), target);
    // Reopen a raw legacy-shaped URL row without Doctor or read-time normalization.
    closeOpenClawStateDatabaseForTest();
    const selector = listTranscriptLibrary(store, {}).sessions[0]!.selector;
    for (const query of [
      "PLANNING",
      "opaque",
      "meet",
      "public-account",
      "public-guild",
      "public-channel",
      "public-thread",
      "public-file",
    ]) {
      expect(
        listTranscriptLibrary(store, { query }).sessions.map((entry) => entry.selector),
        query,
      ).toEqual([selector]);
    }
    for (const query of [
      ...hidden.flatMap((part) => [part, part.slice(0, -3).toUpperCase()]),
      "invite",
      "example.test",
    ]) {
      expect(
        [...store.iterateReadEntries({ query })].map((entry) => entry.selector),
        query,
      ).toEqual([]);
      expect(listTranscriptLibrary(store, { query }).sessions, query).toEqual([]);
    }
    const first = await getTranscriptLibrary(store, {
      selector,
      includeUtterances: true,
      limit: 1,
      query: "first",
    });
    expect(first.session).toMatchObject({
      selector: transcriptSessionSelector(target),
      sessionId: target.sessionId,
      utteranceCount: 3,
      lastUtteranceAt: "2026-08-20T10:03:00.000Z",
      activeSubscription: false,
      source: { providerId: "meet", meetingUrl: "https://example.test/room" },
    });
    expect(first.utterances).toEqual([
      {
        sequence: 0,
        text: utterances[0]!.text,
        speakerId: "speaker-1",
        speakerLabel: "Sam",
        startedAt: utterances[0]!.startedAt,
        final: true,
      },
    ]);
    expect(first.summary).toMatchObject({ utteranceCount: 3 });
    expect(first.summary).not.toHaveProperty("transcript");
    const last = await getTranscriptLibrary(store, {
      selector,
      includeUtterances: true,
      limit: 1,
      query: "first",
      cursor: first.nextCursor!,
    });
    expect(last.utterances).toEqual([
      { sequence: 2, text: utterances[2]!.text, endedAt: "2026-08-20T10:03:00.000Z" },
    ]);
    expect(last.nextCursor).toBeNull();
    expect(JSON.stringify(first)).not.toContain("private");
    const publicOutputs = [JSON.stringify(first), JSON.stringify(listTranscriptLibrary(store, {}))];
    for (const format of ["markdown", "jsonl"] as const) {
      const exported = await exportTranscriptLibrary(store, { selector, format });
      const content = Buffer.from(exported.data, "base64").toString("utf8");
      expect(content).toContain("First decision: approved.");
      expect(content).toContain("Follow up: FIRST milestone.");
      publicOutputs.push(content);
    }
    for (const output of publicOutputs) {
      for (const part of hidden) {
        expect(output).not.toContain(part);
      }
    }
    expect((await store.readSession(selector))?.source.meetingUrl).toBe(meetingUrl.href);
    expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    await expect(getTranscriptLibrary(store, { selector: target.sessionId })).rejects.toThrow(
      "not found",
    );
  });

  it("rejects malformed and cross-filter, cross-transcript or cross-method cursors", async () => {
    const { store } = fixture();
    for (const id of ["one", "two"]) {
      const target = session(id);
      await store.writeSession(target);
      await store.appendUtteranceForSession(target, { text: "a" });
      await store.appendUtteranceForSession(target, { text: "b" });
    }
    const listed = listTranscriptLibrary(store, { limit: 1 });
    const selector = listed.sessions[0]!.selector;
    const read = await getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 1 });
    expect(() => listTranscriptLibrary(store, { cursor: "not-a-cursor" })).toThrow("cursor");
    expect(() =>
      listTranscriptLibrary(store, { cursor: listed.nextCursor!, agentId: "other" }),
    ).toThrow("cursor");
    await expect(
      getTranscriptLibrary(store, { selector, cursor: listed.nextCursor! }),
    ).rejects.toThrow("cursor");
    await expect(
      getTranscriptLibrary(store, { selector, cursor: read.nextCursor!, query: "a" }),
    ).rejects.toThrow("cursor");
    await expect(
      getTranscriptLibrary(store, {
        selector: transcriptSessionSelector(session("two")),
        cursor: read.nextCursor!,
      }),
    ).rejects.toThrow("cursor");
  });

  it.each(["structured", "structured-only", "divergent-markdown", "markdown-only"] as const)(
    "exports full canonical content with %s notes even when the stored summary covers only a tail",
    async (notesKind) => {
      const { store, stateDir, database } = fixture();
      const target = session("download");
      await store.writeSession(target);
      await store.appendUtteranceForSession(target, {
        text: "Opening context",
        id: "utterance-1",
        speaker: { label: "Alex", id: "speaker-1" },
        startedAt: "2026-08-20T10:01:00.000Z",
        metadata: { recordingPath: "/private/provider/audio.wav", private: "provider-only" },
      });
      await store.appendUtteranceForSession(target, { text: "Action: verify downloads" });
      await store.writeSummary(
        summarizeTranscripts({
          session: target,
          utterances: [{ text: "Action: verify downloads" }],
        }),
        target,
      );
      const canonicalMarkdown =
        "# Historical notes\r\n\r\nKeep this exact historical decision.\r\n";
      if (notesKind !== "structured") {
        const db = database();
        executeSqliteQuerySync(
          db,
          meetingTranscriptDb(db)
            .updateTable("meeting_transcript_summaries")
            .set({
              markdown: notesKind === "structured-only" ? null : canonicalMarkdown,
              ...(notesKind === "markdown-only" ? { summary_json: null } : {}),
            })
            .where("session_id", "=", target.sessionId)
            .where("session_started_at", "=", target.startedAt),
        );
      }
      const selector = transcriptSessionSelector(target);
      const markdown = await exportTranscriptLibrary(store, { selector, format: "markdown" });
      const text = Buffer.from(markdown.data, "base64").toString("utf8");
      if (notesKind === "divergent-markdown" || notesKind === "markdown-only") {
        const projectedMarkdown =
          "# Historical notes\\r\n\\r\nKeep this exact historical decision.\\r\n";
        expect((await getTranscriptLibrary(store, { selector })).summary?.markdown).toBe(
          projectedMarkdown,
        );
        expect(text).toContain(projectedMarkdown);
      }
      expect(text).toContain("Alex: Opening context");
      expect(text).toContain("Action: verify downloads");
      expect(text).toContain("Transcript utterances: 2");
      if (notesKind !== "markdown-only") {
        expect(text).toContain("Summary covers 1 saved utterances.");
      }
      expect(markdown.filename).toMatch(/^transcript-2026-08-20-[a-f0-9]{12}\.md$/);
      expect(markdown.sizeBytes).toBe(Buffer.byteLength(text));
      const jsonl = await exportTranscriptLibrary(store, { selector, format: "jsonl" });
      expect(
        Buffer.from(jsonl.data, "base64")
          .toString("utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(
        (await getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 50 }))
          .utterances,
      );
      expect(Buffer.from(jsonl.data, "base64").toString("utf8")).not.toContain("provider-only");
      expect((await store.readUtterancesForSession(target))[0]?.metadata).toEqual({
        recordingPath: "/private/provider/audio.wav",
        private: "provider-only",
      });
      expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    },
  );

  it("leaves missing summaries missing and rejects oversized reads/downloads without partial output", async () => {
    const { store, stateDir } = fixture();
    const target = session("large");
    await store.writeSession(target);
    const selector = transcriptSessionSelector(target);
    expect((await getTranscriptLibrary(store, { selector })).summary).toBeUndefined();
    expect(
      Buffer.from(
        (await exportTranscriptLibrary(store, { selector, format: "markdown" })).data,
        "base64",
      ).toString("utf8"),
    ).not.toContain("## Overview");
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(TRANSCRIPTS_RESULT_MAX_BYTES + 1),
    });
    await expect(
      getTranscriptLibrary(store, { selector, includeUtterances: true, limit: 50 }),
    ).rejects.toThrow(expect.objectContaining({ type: "transcript_result_too_large" }));
    for (const format of ["jsonl", "markdown"] as const) {
      const exported = await exportTranscriptLibrary(store, { selector, format });
      expect(exported.sizeBytes).toBeGreaterThan(TRANSCRIPTS_RESULT_MAX_BYTES);
      expect(exported.sizeBytes).toBeLessThan(TRANSCRIPTS_EXPORT_MAX_BYTES);
    }
    await store.appendUtteranceForSession(target, {
      text: "x".repeat(TRANSCRIPTS_EXPORT_MAX_BYTES),
    });
    for (const format of ["jsonl", "markdown"] as const) {
      await expect(exportTranscriptLibrary(store, { selector, format })).rejects.toThrow(
        expect.objectContaining({
          type: "transcript_export_too_large",
          maxBytes: TRANSCRIPTS_EXPORT_MAX_BYTES,
        }),
      );
    }
    expect(fs.existsSync(path.join(stateDir, "transcripts"))).toBe(false);
    expect(store.readNotes(target)).toEqual({});
  });

  it("distinguishes historical unstopped rows from exact live subscriptions and stopping captures", async () => {
    const { store } = fixture();
    const old = session("reused");
    const current = session("reused", { startedAt: "2026-08-21T10:00:00.000Z" });
    await store.writeSession(old);
    await store.writeSession(current);
    activeSessions.set(current.sessionId, {
      session: current,
      phase: "active",
      provider: {},
      providerId: current.source.providerId,
    });
    const first = listTranscriptLibrary(store, {});
    expect(first.sessions.map((entry) => entry.activeSubscription)).toEqual([true, false]);
    activeSessions.get(current.sessionId)!.stopping = true;
    expect(
      (await getTranscriptLibrary(store, { selector: transcriptSessionSelector(current) })).session
        .activeSubscription,
    ).toBe(false);
    const capture = activeSessions.get(current.sessionId)!;
    delete capture.stopping;
    capture.phase = "terminal";
    expect(
      listTranscriptLibrary(store, {}).sessions.every((entry) => !entry.activeSubscription),
    ).toBe(true);
    activeSessions.clear();
    expect(
      listTranscriptLibrary(store, {}).sessions.every(
        (entry) => !entry.activeSubscription && entry.stoppedAt === undefined,
      ),
    ).toBe(true);
  });
});
