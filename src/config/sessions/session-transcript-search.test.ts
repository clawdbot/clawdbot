/** SQLite-native transcript search: in-transaction indexing, reconcile, and query bounds. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TranscriptEvent } from "./session-accessor.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptMessage,
  deleteSqliteTranscript,
  replaceSqliteTranscriptEvents,
} from "./session-accessor.sqlite.js";
import {
  extractTranscriptIndexEntry,
  listSessionsNeedingTranscriptIndexReconcile,
} from "./session-transcript-index.js";
import {
  resetSessionTranscriptSearchForTest,
  searchSessionTranscripts,
  waitForSessionTranscriptReconcileForTest,
} from "./session-transcript-search.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

type TestPaths = { stateDir: string; tempDir: string };

let paths: TestPaths;

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-"));
  paths = {
    stateDir: path.join(tempDir, "state"),
    tempDir,
  };
});

afterEach(async () => {
  await waitForSessionTranscriptReconcileForTest();
  resetSessionTranscriptSearchForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(paths.tempDir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
}

function transcriptScope(sessionId: string, sessionKey: string) {
  return {
    agentId: "main",
    env: env(),
    sessionId,
    sessionKey,
  };
}

async function appendUserMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

async function appendAssistantMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function search(query: string, options: { limit?: number; sessionKeys?: string[] } = {}) {
  return searchSessionTranscripts({
    agentId: "main",
    env: env(),
    query,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.sessionKeys ? { sessionKeys: options.sessionKeys } : {}),
  });
}

function agentKysely() {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: env() });
  return {
    db: database.db,
    kysely: getNodeSqliteKysely<
      Pick<
        OpenClawAgentKyselyDatabase,
        "session_transcript_fts" | "session_transcript_index_state" | "transcript_events"
      >
    >(database.db),
  };
}

describe("searchSessionTranscripts", () => {
  it("indexes appended messages synchronously and returns bounded hits", async () => {
    await appendUserMessage("session-1", "agent:main:main", "the deployment failed on friday");
    await appendAssistantMessage("session-1", "agent:main:main", "the deployment fix is rolling");

    const result = search("deployment");
    expect(result.indexing).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(2);
    const roles = result.hits.map((hit) => hit.role).toSorted();
    expect(roles).toEqual(["assistant", "user"]);
    for (const hit of result.hits) {
      expect(hit.sessionKey).toBe("agent:main:main");
      expect(hit.sessionId).toBe("session-1");
      expect(hit.snippet).toContain("deployment");
      expect(hit.messageId).toBeTruthy();
    }
  });

  it("ignores non-message events and misses non-matching queries", async () => {
    await appendUserMessage("session-1", "agent:main:main", "alpha topic");
    await appendSqliteTranscriptEvent(transcriptScope("session-1", "agent:main:main"), {
      type: "model_change",
      id: "model-change-1",
      model: "sonnet-4.6",
    } as unknown as TranscriptEvent);

    expect(search("sonnet").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it("filters hits to the requested session keys", async () => {
    await appendUserMessage("session-1", "agent:main:main", "shared keyword payload");
    await appendUserMessage("session-2", "agent:main:other", "shared keyword payload");

    const all = search("keyword");
    expect(all.hits).toHaveLength(2);

    const filtered = search("keyword", { sessionKeys: ["agent:main:other"] });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]?.sessionKey).toBe("agent:main:other");
    expect(filtered.hits[0]?.sessionId).toBe("session-2");
  });

  it("caps hits at the limit and reports truncation", async () => {
    for (let index = 0; index < 4; index += 1) {
      await appendUserMessage("session-1", "agent:main:main", `needle number ${index}`);
    }
    const result = search("needle", { limit: 3 });
    expect(result.hits).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects empty and oversized queries", () => {
    expect(() => search("   ")).toThrow(/query must not be empty/);
    expect(() => search("x".repeat(4097))).toThrow(/must not exceed/);
  });

  it("drops hits when a transcript is deleted", async () => {
    await appendUserMessage("session-1", "agent:main:main", "ephemeral content");
    expect(search("ephemeral").hits).toHaveLength(1);

    await deleteSqliteTranscript({
      agentId: "main",
      env: env(),
      sessionId: "session-1",
    });
    expect(search("ephemeral").hits).toHaveLength(0);
  });

  it("reindexes synchronously when a linear transcript is replaced", async () => {
    await appendUserMessage("session-1", "agent:main:main", "obsolete branch text");
    await replaceSqliteTranscriptEvents(transcriptScope("session-1", "agent:main:main"), [
      {
        type: "message",
        id: "m-new",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "replacement text" }] },
        timestamp: 1720000000000,
      } as unknown as TranscriptEvent,
    ]);

    expect(search("obsolete").hits).toHaveLength(0);
    const result = search("replacement");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.messageId).toBe("m-new");
  });

  it("only surfaces the active branch after a leaf-control rewind", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    await replaceSqliteTranscriptEvents(scope, [
      {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "alpha origin" }] },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", content: [{ type: "text", text: "beta abandoned" }] },
      },
    ] as unknown as TranscriptEvent[]);
    // Rewind to m1: m2 leaves the visible path.
    await appendSqliteTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf-1",
      parentId: "m2",
      targetId: "m1",
    } as unknown as TranscriptEvent);

    // Dirty sessions are hidden from results immediately: stale rows must
    // not surface rewound-away text even before the rebuild commits.
    const dirty = search("beta");
    expect(dirty.indexing).toBe(true);
    expect(dirty.hits).toHaveLength(0);
    await waitForSessionTranscriptReconcileForTest();

    expect(search("beta").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it("backfills transcripts that predate the index via reconcile", async () => {
    await appendUserMessage("session-1", "agent:main:main", "historic knowledge");
    // Simulate a doctor-migrated database that has rows but no index state.
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));
    expect(search("historic").indexing).toBe(true);

    await waitForSessionTranscriptReconcileForTest();
    const result = search("historic");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
  });

  it("detects missing, dirty, and lagging transcript index watermarks", async () => {
    await appendUserMessage("session-1", "agent:main:main", "indexed message");
    const { db, kysely } = agentKysely();
    const pending = () => listSessionsNeedingTranscriptIndexReconcile(db);

    expect(pending()).toEqual([]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ needs_rebuild: 1 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ indexed_seq: -1, needs_rebuild: 0 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("session_transcript_index_state").where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
  });

  it("sweeps orphaned index rows during reconcile", async () => {
    await appendUserMessage("session-1", "agent:main:main", "anchor row");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_fts").values({
        text: "ghost payload",
        session_id: "session-ghost",
        message_id: "m-ghost",
        role: "user",
        timestamp: "1",
      }),
    );
    // The ghost has no transcript rows, so only the dirty scan of a live
    // session triggers reconcile; force one by clearing the live watermark.
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));

    const ghostRows = () =>
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_transcript_fts")
          .select("message_id")
          .where("session_id", "=", "session-ghost"),
      ).rows.length;
    // Ghost rows are already invisible to search (the sessions join drops
    // them); the sweep reclaims their storage.
    expect(ghostRows()).toBe(1);
    expect(search("anchor").indexing).toBe(true);
    await waitForSessionTranscriptReconcileForTest();
    expect(ghostRows()).toBe(0);
    expect(search("anchor").hits).toHaveLength(1);
  });
});

describe("extractTranscriptIndexEntry", () => {
  it("extracts text blocks from user and assistant messages", () => {
    const entry = extractTranscriptIndexEntry(
      {
        type: "message",
        id: "m1",
        timestamp: 1720000000000,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "first" },
            { type: "tool_use", name: "exec", input: { command: "secret" } },
            { type: "text", text: "second" },
          ],
        },
      },
      0,
    );
    expect(entry).toEqual({
      messageId: "m1",
      role: "assistant",
      text: "first\nsecond",
      timestamp: 1720000000000,
    });
  });

  it("returns undefined for tool results, other roles, and empty text", () => {
    expect(
      extractTranscriptIndexEntry({ type: "message", id: "m1", message: { role: "tool" } }, 0),
    ).toBeUndefined();
    expect(
      extractTranscriptIndexEntry({ type: "model_change", id: "e1", message: { role: "user" } }, 0),
    ).toBeUndefined();
    expect(
      extractTranscriptIndexEntry(
        { type: "message", id: "m1", message: { role: "user", content: [] } },
        0,
      ),
    ).toBeUndefined();
  });

  it("falls back to the append timestamp when the event has none", () => {
    const entry = extractTranscriptIndexEntry(
      { type: "message", id: "m1", message: { role: "user", content: "hello" } },
      4242,
    );
    expect(entry?.timestamp).toBe(4242);
  });
});
