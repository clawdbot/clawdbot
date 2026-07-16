// Covers the SQLite WAL-reset corruption safety floor.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalPrepare = Reflect.get(DatabaseSync.prototype, "prepare") as DatabaseSync["prepare"];

async function loadNodeSqliteWithVersion(version: string) {
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
    function (this: DatabaseSync, sql) {
      if (sql === "SELECT sqlite_version() AS version") {
        return {
          get: () => ({ version }),
        } as unknown as StatementSync;
      }
      return originalPrepare.call(this, sql);
    },
  );
  return await import("./node-sqlite.js");
}

async function withNodeSharedSqliteValue(value: unknown, run: () => Promise<void>): Promise<void> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "config");
  if (!originalDescriptor) {
    throw new Error("process.config descriptor is unavailable");
  }
  try {
    // Node freezes process.config.variables, so replace and then restore its exact descriptor.
    Object.defineProperty(process, "config", {
      value: {
        ...process.config,
        variables: { ...process.config.variables, node_shared_sqlite: value },
      },
      writable: false,
      configurable: true,
    });
    await run();
  } finally {
    Object.defineProperty(process, "config", originalDescriptor);
  }
}

function expectedUnsafeSqliteError(version: string, shared: boolean): string {
  const wording = shared ? "uses shared system" : "embeds";
  const remediation = shared
    ? "Upgrade the system SQLite library to 3.51.3+ (or patched 3.50.7+/3.44.6+), or use a Node build embedding a safe version."
    : "Upgrade to Node 22.22.3+, 24.15.0+, or 25.9.0+ before retrying.";
  return (
    "SQLite support is unavailable or unsafe in this Node runtime. " +
    "OpenClaw requires SQLite 3.51.3+ (or patched 3.50.7+/3.44.6+) for WAL safety; " +
    `Node ${process.versions.node} ${wording} SQLite ${version}, which is affected by the upstream WAL-reset ` +
    `database corruption bug. ${remediation}`
  );
}

describe("node SQLite safety", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["3.51.3", "3.51.4", "3.52.0", "4.0.0", "3.50.7", "3.50.8", "3.44.6"])(
    "accepts patched SQLite %s",
    async (version) => {
      const { requireNodeSqlite } = await loadNodeSqliteWithVersion(version);
      expect(() => requireNodeSqlite()).not.toThrow();
    },
  );

  it.each(["3.51.2", "3.51.0", "3.50.6", "3.49.1", "3.44.5", "invalid", "3.51"])(
    "rejects vulnerable or unknown SQLite %s",
    async (version) => {
      const { requireNodeSqlite } = await loadNodeSqliteWithVersion(version);
      expect(() => requireNodeSqlite()).toThrow(`SQLite ${version}, which is affected`);
    },
  );

  it.each([true, "true"])(
    "rejects vulnerable shared SQLite with system-library remediation (%j)",
    async (nodeSharedSqlite) => {
      await withNodeSharedSqliteValue(nodeSharedSqlite, async () => {
        const { requireNodeSqlite } = await loadNodeSqliteWithVersion("3.51.2");
        expect(() => requireNodeSqlite()).toThrow(expectedUnsafeSqliteError("3.51.2", true));
      });
    },
  );

  it.each([false, "false"])(
    "rejects vulnerable embedded SQLite with Node-upgrade remediation (%j)",
    async (nodeSharedSqlite) => {
      await withNodeSharedSqliteValue(nodeSharedSqlite, async () => {
        const { requireNodeSqlite } = await loadNodeSqliteWithVersion("3.51.2");
        expect(() => requireNodeSqlite()).toThrow(expectedUnsafeSqliteError("3.51.2", false));
      });
    },
  );

  it("accepts the SQLite build embedded in the supported test runtime", () => {
    return import("./node-sqlite.js").then(({ requireNodeSqlite }) => {
      expect(() => requireNodeSqlite()).not.toThrow();
    });
  });
});
