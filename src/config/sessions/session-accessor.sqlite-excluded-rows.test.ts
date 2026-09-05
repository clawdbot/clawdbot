import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-lifecycle-state.js";
import { readSessionMaintenanceCapCandidates } from "./session-accessor.sqlite-maintenance-candidates.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function openDatabase(encoding?: "UTF-8" | "UTF-16le" | "UTF-16be") {
  const stateDir = tempDirs.make("openclaw-excluded-rows-");
  const pathname = path.join(stateDir, "agent.sqlite");
  if (encoding) {
    const seed = new DatabaseSync(pathname);
    try {
      seed.exec(
        `PRAGMA encoding='${encoding}'; CREATE TABLE encoding_probe(value TEXT); DROP TABLE encoding_probe;`,
      );
    } finally {
      seed.close();
    }
  }
  return openOpenClawAgentDatabase({
    agentId: "main",
    path: pathname,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function insertEntry(database: OpenClawAgentDatabase, key: string, id: string, json?: string) {
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(key, id, json ?? JSON.stringify({ sessionId: id, updatedAt: 1 }), 1);
}

const readers = [
  {
    name: "references",
    read: (database: OpenClawAgentDatabase, excludedKeys: ReadonlySet<string>) =>
      [...readReferencedSessionIds(database, excludedKeys)].toSorted(),
  },
  {
    name: "cap candidates",
    read: (database: OpenClawAgentDatabase, excludedKeys: ReadonlySet<string>) =>
      Object.values(readSessionMaintenanceCapCandidates({ database, excludedKeys })).map(
        (entry) => entry.sessionId,
      ),
  },
];

describe.each(readers)("SQLite $name exclusions", ({ read }) => {
  it("does not materialize excluded entries before discarding them", () => {
    const database = openDatabase();
    insertEntry(
      database,
      "agent:main:excluded",
      "excluded",
      JSON.stringify({
        sessionId: "excluded",
        updatedAt: 1,
        skillsSnapshot: { prompt: "x".repeat(64 * 1024), skills: [] },
      }),
    );
    insertEntry(database, "agent:main:kept", "kept");
    const materializedKeys: string[] = [];
    const prepare = database.db.prepare.bind(database.db);
    vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
        for (const row of iterate(...args)) {
          if (typeof row.session_key === "string") {
            materializedKeys.push(row.session_key);
          }
          yield row;
        }
        return undefined;
      });
      return statement;
    });

    expect(read(database, new Set(["agent:main:excluded"]))).toEqual(["kept"]);
    expect(materializedKeys).toEqual(["agent:main:kept"]);
  });

  it.each([
    { name: "empty", excluded: [], expected: ["a", "b", "c"] },
    { name: "missing", excluded: ["missing"], expected: ["a", "b", "c"] },
    { name: "all", excluded: ["a", "b", "c"], expected: [] },
    { name: "mixed", excluded: ["b", "missing"], expected: ["a", "c"] },
  ])("preserves $name exclusion results and cap order", ({ excluded, expected }) => {
    const database = openDatabase();
    for (const key of ["c", "a", "b"]) {
      insertEntry(database, key, key);
    }
    expect(read(database, new Set(excluded))).toEqual(expected);
  });

  it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
    "preserves exact exclusions across %s text conversion",
    (encoding) => {
      const database = openDatabase(encoding);
      const keys = ["agent:main:\uFFFD", "agent:main:a\uFFFE", "agent:main:b\uFFFF", "ordinary"];
      for (const [index, key] of keys.entries()) {
        insertEntry(database, key, `id-${index}`);
      }
      expect(database.db.prepare("PRAGMA encoding").get()?.encoding).toBe(encoding);
      const excluded = new Set(["agent:main:\uFFFE", "agent:main:\uFFFF", ...keys.slice(1)]);
      expect(read(database, excluded).toSorted()).toEqual(
        encoding === "UTF-8" ? ["id-0"] : ["id-0", "id-1", "id-2"],
      );
      const storedKeys = database.db.prepare("SELECT session_key FROM session_nodes").all();
      expect(read(database, new Set(storedKeys.map((row) => String(row.session_key))))).toEqual([]);
    },
  );

  it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
    "preserves returned-key membership for NUL text in %s",
    (encoding) => {
      const database = openDatabase(encoding);
      const key = "nul\0tail";
      insertEntry(database, key, "kept");
      const returnedKey = String(
        database.db.prepare("SELECT session_key FROM session_nodes").get()?.session_key,
      );
      // Older supported Node bindings return only the text before NUL.
      expect([key, "nul"]).toContain(returnedKey);
      expect(read(database, new Set([key]))).toEqual(returnedKey === key ? [] : ["kept"]);
      expect(read(database, new Set([returnedKey]))).toEqual([]);
    },
  );

  it("preserves exact UTF-16 membership without replacing unmatched surrogates", () => {
    const database = openDatabase();
    const keys = ["\uFFFD", "\uD83E\uDD9E", "quoted'key", "日本語"];
    for (const [index, key] of keys.entries()) {
      insertEntry(database, key, `id-${index}`);
    }
    const excluded = new Set(["\uD800", "\uDC00", ...keys.slice(1)]);
    expect(read(database, excluded)).toEqual(["id-0"]);
  });
});

describe("SQLite exclusion survivor semantics", () => {
  it.each([
    ["malformed", "{", false],
    ["retained placeholder", "{}", false],
    ["JSON5", '{sessionId:"raw",updatedAt:1}', false],
    ["non-finite timestamp", '{"sessionId":"raw","updatedAt":1e999}', false],
    ["duplicate identity", '{"sessionId":null,"sessionId":"raw","updatedAt":1}', true],
    [
      "duplicate prompts",
      '{"sessionId":"raw","updatedAt":1,"skillsSnapshot":{},"skillsSnapshot":{"prompt":"last","skills":[]}}',
      true,
    ],
    [
      "deep JSON",
      `{"sessionId":"raw","updatedAt":1,"skillsSnapshot":{"prompt":${"[".repeat(1001)}0${"]".repeat(1001)},"skills":[]}}`,
      true,
    ],
  ])("preserves raw IDs and parser behavior for %s", (_name, json, readable) => {
    const database = openDatabase();
    insertEntry(database, "survivor", "raw", json);
    insertEntry(database, "excluded", "excluded");
    const excludedKeys = new Set(["excluded"]);
    expect([...readReferencedSessionIds(database, excludedKeys)]).toEqual(["raw"]);
    expect(readSessionMaintenanceCapCandidates({ database, excludedKeys })).toEqual(
      readable ? { survivor: JSON.parse(json) } : {},
    );
  });

  it("retains surviving historical references, including archived entries", () => {
    const database = openDatabase();
    insertEntry(
      database,
      "archived",
      "current",
      JSON.stringify({
        sessionId: "current",
        updatedAt: 1,
        previousSessionId: " previous ",
        usageFamilySessionIds: ["family", "current"],
        compactionCheckpoints: [
          {
            sessionId: "checkpoint",
            preCompaction: { sessionId: "pre" },
            postCompaction: { sessionId: "post" },
          },
        ],
      }),
    );
    database.db
      .prepare("UPDATE session_nodes SET archived_at = 1 WHERE session_key = ?")
      .run("archived");
    const excludedKeys = new Set(["missing"]);
    expect([...readReferencedSessionIds(database, excludedKeys)].toSorted()).toEqual(
      ["current", "previous", "family", "checkpoint", "pre", "post"].toSorted(),
    );
    expect(readSessionMaintenanceCapCandidates({ database, excludedKeys })).toEqual({});
  });
});
