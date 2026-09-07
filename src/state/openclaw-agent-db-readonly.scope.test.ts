import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnlyScope,
  type OpenClawAgentReadOnlyDatabase,
} from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const query = "SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'";
const value = (database: OpenClawAgentReadOnlyDatabase) => database.db.prepare(query).get();

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function fixture(marker = 1, agentId = "main", keepWriter = false) {
  const options = {
    agentId,
    env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-read-scope-") },
  };
  const writer = openOpenClawAgentDatabase(options);
  writer.db.prepare("UPDATE schema_meta SET updated_at = ? WHERE meta_key = 'primary'").run(marker);
  const pathname = writer.path;
  if (!keepWriter) {
    closeOpenClawAgentDatabaseByPath(pathname);
  }
  return { options, pathname, writer };
}

function replaceFile(pathname: string, replacement: string) {
  fs.renameSync(pathname, `${pathname}.replaced`);
  fs.copyFileSync(replacement, pathname);
}

describe("read-only agent database scope", () => {
  it("retains a connection, not a row snapshot, and closes it on return", () => {
    const f = fixture();
    const handles: DatabaseSync[] = [];
    const external = new DatabaseSync(f.pathname);
    try {
      const result = withOpenClawAgentDatabaseReadOnlyScope((read) => {
        const select = (database: OpenClawAgentReadOnlyDatabase) => {
          handles.push(database.db);
          expect(database.db.isTransaction).toBe(false);
          return value(database);
        };
        expect(read(select, f.options)).toEqual({ found: true, value: { updated_at: 1 } });
        external.exec(
          "BEGIN IMMEDIATE; UPDATE schema_meta SET updated_at = 2 WHERE meta_key = 'primary'; COMMIT",
        );
        expect(read(select, f.options)).toEqual({ found: true, value: { updated_at: 2 } });
        expect(handles[1]).toBe(handles[0]);
        expect(handles[0]?.isOpen).toBe(true);
        return "callback value";
      });
      expect(result).toBe("callback value");
      expect(handles[0]?.isOpen).toBe(false);
      expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBeUndefined();
    } finally {
      external.close();
    }
  });

  // SQLite on Windows omits FILE_SHARE_DELETE, so an open database cannot be
  // renamed or unlinked. Keep the actual pathname-mutation cases on POSIX.
  it.skipIf(process.platform === "win32").each(["replacement", "deletion"] as const)(
    "re-admits after pathname %s between reads",
    (change) => {
      const f = fixture();
      const replacement = fixture(2);
      const handles: DatabaseSync[] = [];
      withOpenClawAgentDatabaseReadOnlyScope((read) => {
        const select = (database: OpenClawAgentReadOnlyDatabase) => {
          handles.push(database.db);
          return value(database);
        };
        expect(read(select, f.options)).toEqual({ found: true, value: { updated_at: 1 } });
        if (change === "replacement") {
          replaceFile(f.pathname, replacement.pathname);
        } else {
          fs.unlinkSync(f.pathname);
        }
        expect(read(select, f.options)).toEqual(
          change === "replacement"
            ? { found: true, value: { updated_at: 2 } }
            : { found: false, reason: "database-missing" },
        );
        expect(handles[0]?.isOpen).toBe(false);
        expect(handles).toHaveLength(change === "replacement" ? 2 : 1);
        if (change === "replacement") {
          expect(handles[1] === handles[0]).toBe(false);
        }
      });
      expect(handles.every((handle) => !handle.isOpen)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "serves a changed initial admission once without retaining or replaying it",
    () => {
      const f = fixture();
      const replacement = fixture(2);
      const open = sqlite.openNodeSqliteDatabase;
      let swapped = false;
      vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
        const database = open(pathname, options);
        // Change the real path after SQLite opens its original FD, before ordinary
        // admission returns. The in-flight read still belongs to that original FD.
        if (pathname === f.pathname && options?.readOnly && !swapped) {
          swapped = true;
          replaceFile(f.pathname, replacement.pathname);
        }
        return database;
      });
      const handles: DatabaseSync[] = [];
      withOpenClawAgentDatabaseReadOnlyScope((read) => {
        const select = (database: OpenClawAgentReadOnlyDatabase) => {
          handles.push(database.db);
          return value(database);
        };
        expect(read(select, f.options)).toEqual({ found: true, value: { updated_at: 1 } });
        expect(swapped).toBe(true);
        expect(handles).toHaveLength(1);
        expect(handles[0]?.isOpen).toBe(false);
        expect(read(select, f.options)).toEqual({ found: true, value: { updated_at: 2 } });
        expect(handles).toHaveLength(2);
        expect(handles[1] === handles[0]).toBe(false);
      });
      expect(handles.every((handle) => !handle.isOpen)).toBe(true);
    },
  );

  it("does not retain a missing database result", () => {
    const options = {
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: tempDirs.make("agent-read-missing-") },
    };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    withOpenClawAgentDatabaseReadOnlyScope((read) => {
      expect(read(value, options)).toEqual({ found: false, reason: "database-missing" });
      expect(fs.existsSync(pathname)).toBe(false);
      const writer = openOpenClawAgentDatabase(options);
      writer.db.exec("UPDATE schema_meta SET updated_at = 3 WHERE meta_key = 'primary'");
      closeOpenClawAgentDatabaseByPath(pathname);
      expect(read(value, options)).toEqual({ found: true, value: { updated_at: 3 } });
    });
    expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
  });

  it.each([false, true])(
    "closes an escaped reader after callback completion (throws=%s)",
    (throws) => {
      const f = fixture();
      const failure = new Error("scope callback failed");
      let escaped: typeof withOpenClawAgentDatabaseReadOnly | undefined;
      let handle: DatabaseSync | undefined;
      try {
        withOpenClawAgentDatabaseReadOnlyScope((read) => {
          escaped = read;
          read((database) => {
            handle = database.db;
          }, f.options);
          if (throws) {
            throw failure;
          }
        });
        expect(throws).toBe(false);
      } catch (error) {
        expect(throws).toBe(true);
        expect(error).toBe(failure);
      }
      expect(handle?.isOpen).toBe(false);
      const lateOperation = vi.fn();
      expect(() =>
        expectDefined(escaped, "escaped scoped reader")(lateOperation, f.options),
      ).toThrow("scope has closed");
      expect(lateOperation).not.toHaveBeenCalled();
    },
  );

  it("closes a failed read before admitting the next operation", () => {
    const f = fixture();
    const failure = new Error("read callback failed");
    let failed: DatabaseSync | undefined;
    let next: DatabaseSync | undefined;
    withOpenClawAgentDatabaseReadOnlyScope((read) => {
      expect(() =>
        read((database) => {
          failed = database.db;
          throw failure;
        }, f.options),
      ).toThrow(failure);
      expect(failed?.isOpen).toBe(false);
      expect(
        read((database) => {
          next = database.db;
          return value(database);
        }, f.options),
      ).toEqual({ found: true, value: { updated_at: 1 } });
      expect(next === failed).toBe(false);
    });
    expect(next?.isOpen).toBe(false);
  });

  it("does not retain a callback-owned transaction", () => {
    const f = fixture();
    let transaction: DatabaseSync | undefined;
    let next: DatabaseSync | undefined;
    withOpenClawAgentDatabaseReadOnlyScope((read) => {
      expect(
        read((database) => {
          transaction = database.db;
          database.db.exec("BEGIN");
          return value(database);
        }, f.options),
      ).toEqual({ found: true, value: { updated_at: 1 } });
      expect(transaction?.isOpen).toBe(false);
      expect(
        read((database) => {
          next = database.db;
          expect(database.db.isTransaction).toBe(false);
          return value(database);
        }, f.options),
      ).toEqual({ found: true, value: { updated_at: 1 } });
      expect(next === transaction).toBe(false);
    });
    expect(next?.isOpen).toBe(false);
  });

  it("keeps a writer transaction private and returns ownership after commit", () => {
    const f = fixture(1, "main", true);
    let separate: DatabaseSync | undefined;
    withOpenClawAgentDatabaseReadOnlyScope((read) => {
      f.writer.db.exec(
        "BEGIN IMMEDIATE; UPDATE schema_meta SET updated_at = 4 WHERE meta_key = 'primary'",
      );
      try {
        expect(
          read((database) => {
            separate = database.db;
            return value(database);
          }, f.options),
        ).toEqual({ found: true, value: { updated_at: 1 } });
        expect(separate).not.toBe(f.writer.db);
        expect(separate?.isOpen).toBe(true);
        expect(f.writer.db.isTransaction).toBe(true);
        f.writer.db.exec("COMMIT");
        expect(
          read((database) => {
            expect(database.db).toBe(f.writer.db);
            return value(database);
          }, f.options),
        ).toEqual({ found: true, value: { updated_at: 4 } });
        expect(separate?.isOpen).toBe(false);
        expect(() =>
          read(() => {
            throw new Error("borrowed read failed");
          }, f.options),
        ).toThrow("borrowed read failed");
      } finally {
        if (f.writer.db.isTransaction) {
          f.writer.db.exec("ROLLBACK");
        }
      }
    });
    expect(getOpenClawAgentDatabaseIfOpen(f.options)).toBe(f.writer);
    expect(f.writer.db.isOpen).toBe(true);
    expect(f.writer.db.isTransaction).toBe(false);
  });

  it.each([
    { change: "PRAGMA user_version = 999", error: "newer schema version 999" },
    {
      change: "UPDATE schema_meta SET agent_id = 'other' WHERE meta_key = 'primary'",
      error: "belongs to agent other",
    },
  ])("revalidates a retained handle after $change", ({ change, error }) => {
    const f = fixture();
    let handle: DatabaseSync | undefined;
    withOpenClawAgentDatabaseReadOnlyScope((read) => {
      read((database) => {
        handle = database.db;
      }, f.options);
      const writer = new DatabaseSync(f.pathname);
      try {
        writer.exec(change);
      } finally {
        writer.close();
      }
      const operation = vi.fn();
      expect(() => read(operation, f.options)).toThrow(error);
      expect(operation).not.toHaveBeenCalled();
      expect(handle?.isOpen).toBe(false);
    });
  });

  it.each([false, true])(
    "isolates reentrant ownership and cleanup (outer read throws=%s)",
    (throws) => {
      const first = fixture(1, "first");
      const second = fixture(2, "second");
      const failure = new Error("outer read failed");
      let parent: DatabaseSync | undefined;
      let nested: DatabaseSync | undefined;
      withOpenClawAgentDatabaseReadOnlyScope((read) => {
        const operation = (database: OpenClawAgentReadOnlyDatabase) => {
          parent = database.db;
          expect(
            read((child) => {
              nested = child.db;
              return value(child);
            }, second.options),
          ).toEqual({ found: true, value: { updated_at: 2 } });
          expect(nested).not.toBe(parent);
          expect(nested?.isOpen).toBe(true);
          expect(parent.isOpen).toBe(true);
          if (throws) {
            throw failure;
          }
          return value(database);
        };
        if (throws) {
          expect(() => read(operation, first.options)).toThrow(failure);
          expect(parent?.isOpen).toBe(false);
        } else {
          expect(read(operation, first.options)).toEqual({ found: true, value: { updated_at: 1 } });
          expect(
            read((database) => {
              expect(database.db).toBe(parent);
              return value(database);
            }, first.options),
          ).toEqual({ found: true, value: { updated_at: 1 } });
        }
        expect(nested?.isOpen).toBe(false);
      });
      expect(parent?.isOpen).toBe(false);
    },
  );
});
