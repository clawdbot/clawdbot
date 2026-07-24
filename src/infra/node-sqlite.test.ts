// Covers the SQLite WAL-reset corruption safety floor.
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNodeSqliteLocation, resolveNodeSqliteReadOnlyLocation } from "./node-sqlite.js";

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
    ? "Upgrade the system SQLite library to one of those safe versions, or use a Node build embedding a safe version."
    : "Upgrade to Node 22.22.3+, 24.15.0+, or 25.9.0+ before retrying.";
  return (
    "SQLite support is unavailable or unsafe in this Node runtime. " +
    "OpenClaw requires SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x for WAL safety; " +
    `Node ${process.versions.node} ${wording} SQLite ${version}, which is affected by the upstream WAL-reset ` +
    `database corruption bug. ${remediation}`
  );
}

describe("node SQLite locations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["", ":memory:", "file:///tmp/openclaw.sqlite?mode=ro&immutable=1"])(
    "preserves special location %j",
    (location) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      expect(resolveNodeSqliteLocation(location)).toBe(location);
    },
  );

  it("keeps ordinary filesystem paths unchanged outside Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(resolveNodeSqliteLocation("relative/openclaw.sqlite")).toBe("relative/openclaw.sqlite");
  });

  it("normalizes ordinary filesystem paths through the Windows VFS boundary", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolveSpy = vi.spyOn(path, "resolve").mockReturnValue("resolved-openclaw.sqlite");
    const namespacedSpy = vi
      .spyOn(path, "toNamespacedPath")
      .mockReturnValue(String.raw`\\?\C:\resolved-openclaw.sqlite`);

    expect(resolveNodeSqliteLocation("relative/openclaw.sqlite")).toBe(
      String.raw`\\?\C:\resolved-openclaw.sqlite`,
    );
    expect(resolveSpy).toHaveBeenCalledWith("relative/openclaw.sqlite");
    expect(namespacedSpy).toHaveBeenCalledWith("resolved-openclaw.sqlite");
  });

  it("uses immutable URIs for local databases without WAL sidecars", () => {
    const pathname =
      process.platform === "win32"
        ? String.raw`C:\Users\OpenClaw\.openclaw\state\openclaw.sqlite`
        : "/var/lib/openclaw/state/openclaw.sqlite";

    expect(resolveNodeSqliteReadOnlyLocation(pathname, false)).toBe(
      `${pathToFileURL(pathname).href}?mode=ro&immutable=1`,
    );
    expect(resolveNodeSqliteReadOnlyLocation(pathname, true)).toBe(
      resolveNodeSqliteLocation(pathname),
    );
  });

  it("keeps UNC and namespaced Windows paths out of SQLite URI authority parsing", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolvedPaths = new Map([
      [
        String.raw`\\server\share\state\openclaw.sqlite`,
        String.raw`\\server\share\state\openclaw.sqlite`,
      ],
      ["//server/share/state/openclaw.sqlite", String.raw`\\server\share\state\openclaw.sqlite`],
      ["relative/openclaw.sqlite", String.raw`\\server\share\workdir\relative\openclaw.sqlite`],
      [
        String.raw`\\?\C:\deep\state\openclaw.sqlite`,
        String.raw`\\?\C:\deep\state\openclaw.sqlite`,
      ],
      [
        String.raw`\\?\UNC\server\share\state\openclaw.sqlite`,
        String.raw`\\?\UNC\server\share\state\openclaw.sqlite`,
      ],
    ]);
    const resolveSpy = vi.spyOn(path, "resolve").mockImplementation((pathname) => {
      return resolvedPaths.get(pathname) ?? pathname;
    });
    const namespacedSpy = vi
      .spyOn(path, "toNamespacedPath")
      .mockImplementation((pathname) => pathname);

    for (const [pathname, resolvedPath] of resolvedPaths) {
      expect(resolveNodeSqliteReadOnlyLocation(pathname, false)).toBe(resolvedPath);
    }
    expect(resolveSpy).toHaveBeenCalledTimes(resolvedPaths.size);
    expect(namespacedSpy).toHaveBeenCalledTimes(resolvedPaths.size);
  });
});

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

  it.each(["3.51.2", "3.51.0", "3.50.6", "3.49.1", "3.46.1", "3.44.5", "invalid", "3.51"])(
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
