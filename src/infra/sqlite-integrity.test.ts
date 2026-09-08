import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as nodeSqlite from "./node-sqlite.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as processUrls from "./runtime-process-url.js";
import { assertSqliteIntegrityInWorker } from "./sqlite-integrity-worker.js";
import {
  assertSqliteIntegrity,
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
} from "./sqlite-integrity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("assertSqliteIntegrity", () => {
  it("accepts structurally and referentially consistent databases", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO parents (id) VALUES (1);
        INSERT INTO children (id, parent_id) VALUES (1, 1);
      `);

      expect(assertSqliteIntegrity(database, "test database")).toEqual({
        integrityCheck: "ok",
      });
    } finally {
      database.close();
    }
  });

  it("rejects foreign-key violations that structural checks do not detect", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id) VALUES (1, 99);
      `);
      expect(database.prepare("PRAGMA quick_check;").get()).toEqual({ quick_check: "ok" });
      expect(database.prepare("PRAGMA integrity_check;").get()).toEqual({
        integrity_check: "ok",
      });

      let failure: unknown;
      try {
        assertSqliteIntegrity(database, "test database");
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ name: "SqliteIntegrityError" });
      expect(String(failure)).toMatch(
        /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("names integrity-check failures", () => {
    const database = {
      prepare: () => ({ all: () => [{ integrity_check: "broken index" }] }),
    } as unknown as DatabaseSync;

    let failure: unknown;
    try {
      assertSqliteIntegrity(database, "test database");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "SqliteIntegrityError",
      message: "SQLite integrity_check failed for test database: broken index",
    });
  });

  it("reports violations deterministically without truncating 64-bit rowids", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id)
        VALUES (9007199254740993, 99), (1, 99);
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /children row 1 references parents \(foreign key 0\); children row 9007199254740993 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("bounds foreign-key violation diagnostics", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id)
        VALUES (1, 99), (2, 99), (3, 99), (4, 99), (5, 99), (6, 99);
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /children row 5 references parents \(foreign key 0\); additional violations omitted$/u,
      );
    } finally {
      database.close();
    }
  });

  it("cannot be bypassed by a schema object shadowing the table-valued pragma", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parents(id)
        );
        INSERT INTO children (id, parent_id) VALUES (1, 99);
        CREATE TABLE pragma_foreign_key_check (
          "table" TEXT NOT NULL,
          rowid INTEGER,
          parent TEXT NOT NULL,
          fkid INTEGER NOT NULL
        );
      `);
      expect(
        database.prepare('SELECT "table", rowid, parent, fkid FROM pragma_foreign_key_check').all(),
      ).toEqual([]);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /foreign_key_check failed for test database: children row 1 references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });

  it("identifies violations in WITHOUT ROWID tables", () => {
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(":memory:");
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parents (id TEXT PRIMARY KEY);
        CREATE TABLE children (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parents(id)
        ) WITHOUT ROWID;
        INSERT INTO children (id, parent_id) VALUES ('child-1', 'missing-parent');
      `);

      expect(() => assertSqliteIntegrity(database, "test database")).toThrow(
        /foreign_key_check failed for test database: children row without rowid references parents \(foreign key 0\)/u,
      );
    } finally {
      database.close();
    }
  });
});

describe("isTerminalSqliteIntegrityError", () => {
  it("distinguishes persistent damage from transient pragma failures", () => {
    const corrupt = new Error("integrity check found damage");
    corrupt.name = "SqliteIntegrityError";
    const busy = new Error("integrity check could not run", {
      cause: Object.assign(new Error("database is locked"), { errcode: 5 }),
    });
    busy.name = "SqliteIntegrityError";
    const malformed = new Error("integrity check could not read the database", {
      cause: Object.assign(new Error("database disk image is malformed"), { errcode: 11 }),
    });
    malformed.name = "SqliteIntegrityError";
    const corruptIndex = new Error("integrity check found a corrupt index", {
      cause: Object.assign(new Error("database index is malformed"), { errcode: 779 }),
    });
    corruptIndex.name = "SqliteIntegrityError";

    expect(isTerminalSqliteIntegrityError(corrupt)).toBe(true);
    expect(isTerminalSqliteIntegrityError(busy)).toBe(false);
    expect(isTerminalSqliteIntegrityError(malformed)).toBe(true);
    expect(isTerminalSqliteIntegrityError(corruptIndex)).toBe(true);
  });
});

describe("confirmSqliteFileIntegrity", () => {
  it("leaves SQLite open failures unbound because the failed file identity is unknown", () => {
    const databasePath = path.join(tempDirs.make("sqlite-open-integrity-"), "database.sqlite");
    fs.writeFileSync(databasePath, "not a sqlite database");
    const openError = Object.assign(new Error("file is not a database"), { errcode: 26 });
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementationOnce(() => {
      throw openError;
    });

    try {
      expect(confirmSqliteFileIntegrity(databasePath, "test database")).toEqual({
        status: "failed",
        error: openError,
        terminal: false,
      });
    } finally {
      open.mockRestore();
    }
  });
});

describe("SQLite integrity child", () => {
  afterEach(() => vi.restoreAllMocks());
  it("kills a stuck scan at its deadline before releasing ownership", async () => {
    const root = tempDirs.make("openclaw-integrity-timeout-");
    const source = path.join(root, "source.sqlite");
    fs.writeFileSync(source, "retained source");
    const worker = path.join(root, "blocked.mjs");
    fs.writeFileSync(
      worker,
      `process.on('message', () => process.send({ type: 'phase', phase: 'checking' })); process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 35000);`,
    );
    vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
      pathToFileURL(worker),
    );
    const started = performance.now();
    await expect(
      assertSqliteIntegrityInWorker(source, 250, new AbortController().signal),
    ).rejects.toThrow(
      /integrity check timed out after 30 seconds.*Stop the Gateway service.*lastObservedPhase=checking/,
    );
    expect(performance.now() - started).toBeLessThan(33_000);
    expect(fs.readFileSync(source, "utf8")).toBe("retained source");
  }, 40_000);

  it.each([
    { messages: [{ type: "phase", phase: "checking" }], completes: false },
    { messages: [{ type: "phase", phase: "checking" }, { ok: true }], completes: true },
    { messages: [{ ok: true }, { type: "phase", phase: "closing" }], completes: true },
  ])(
    "requires a final result independently of progress: $messages",
    async ({ messages, completes }) => {
      const root = tempDirs.make("openclaw-integrity-protocol-");
      const source = path.join(root, "source.sqlite");
      fs.writeFileSync(source, "retained source");
      const worker = path.join(root, "messages.mjs");
      fs.writeFileSync(
        worker,
        `process.once('message', async () => {
        for (const message of ${JSON.stringify(messages)}) {
          await new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
        }
        process.disconnect();
      });`,
      );
      vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
        pathToFileURL(worker),
      );
      const check = assertSqliteIntegrityInWorker(source, 250, new AbortController().signal);
      if (completes) {
        await expect(check).resolves.toBeUndefined();
      } else {
        await expect(check).rejects.toThrow(
          /without a completed check.*lastObservedPhase=checking/,
        );
      }
    },
  );

  it.each([false, true])(
    "preserves native errors and closes the database when closing diagnostics fail=%s",
    async (failClosingPhase) => {
      const root = tempDirs.make("openclaw-integrity-native-");
      const source = path.join(root, "source.sqlite");
      const db = new (requireNodeSqlite().DatabaseSync)(source);
      db.exec(
        "PRAGMA foreign_keys = OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (42);",
      );
      db.close();
      const entry = processUrls.resolveRuntimeProcessEntrypointUrl("sqliteIntegrity");
      const phases = path.join(root, "phases.jsonl");
      const closed = path.join(root, "closed.json");
      const worker = path.join(root, "observed-worker.mts");
      fs.writeFileSync(
        worker,
        `import fs from 'node:fs';
        import { createRequire } from 'node:module';
        const sqlite = createRequire(import.meta.url)('node:sqlite');
        const close = sqlite.DatabaseSync.prototype.close;
        sqlite.DatabaseSync.prototype.close = function (...args) {
          const location = this.prepare('PRAGMA database_list').all().find(row => row.name === 'main').file;
          const result = Reflect.apply(close, this, args);
          if (location === ${JSON.stringify(source)}) fs.writeFileSync(${JSON.stringify(closed)}, JSON.stringify({ isOpen: this.isOpen }));
          return result;
        };
        const send = process.send.bind(process);
        process.send = (message, ...args) => {
          if (message.type === 'phase') {
            fs.appendFileSync(${JSON.stringify(phases)}, JSON.stringify(message.phase) + '\\n');
            if (${failClosingPhase} && message.phase === 'closing') throw new Error('synthetic diagnostic send failure');
          }
          return send(message, ...args);
        };
        await import(${JSON.stringify(entry.href)});`,
      );
      vi.spyOn(processUrls, "resolveRuntimeProcessEntrypointUrl").mockReturnValue(
        pathToFileURL(worker),
      );
      await expect(
        assertSqliteIntegrityInWorker(source, 250, new AbortController().signal),
      ).rejects.toMatchObject({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("foreign_key_check failed"),
      });
      expect(fs.existsSync(phases)).toBe(true);
      expect(
        fs
          .readFileSync(phases, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual(["opening", "checking", "closing"]);
      expect(JSON.parse(fs.readFileSync(closed, "utf8"))).toEqual({ isOpen: false });
    },
  );
});
