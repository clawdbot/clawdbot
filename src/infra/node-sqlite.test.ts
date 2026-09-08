// Covers the SQLite WAL-reset corruption safety floor.
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";
import {
  openNodeSqliteDatabase,
  resolveImmutableSqliteFileUri,
  resolveNodeSqliteLocation,
} from "./node-sqlite.js";

const originalPrepare = Reflect.get(DatabaseSync.prototype, "prepare") as DatabaseSync["prepare"];

async function loadNodeSqliteWithVersion(version: string, extensionLoadingOmitted?: number) {
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
    function (this: DatabaseSync, sql) {
      if (sql === "SELECT sqlite_version() AS version") {
        return {
          get: () => ({ version }),
        } as unknown as StatementSync;
      }
      if (
        extensionLoadingOmitted !== undefined &&
        sql === "SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted"
      ) {
        return { get: () => ({ omitted: extensionLoadingOmitted }) } as unknown as StatementSync;
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
    : "Upgrade to Node 24.16.0+ or 26.1.0+ before retrying.";
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

  it("opens special locations through the shared connection boundary", () => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      const identity = " a\0🦞 ";
      expect(database.prepare("SELECT CAST(? AS TEXT) AS identity").get(identity)).toEqual({
        identity,
      });
    } finally {
      database.close();
    }
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

  it("keeps UNC and namespaced Windows paths on the Windows VFS path boundary", () => {
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
      expect(resolveNodeSqliteLocation(pathname)).toBe(resolvedPath);
    }
    expect(resolveSpy).toHaveBeenCalledTimes(resolvedPaths.size);
    expect(namespacedSpy).toHaveBeenCalledTimes(resolvedPaths.size);
  });

  it("preserves the Windows long-path namespace in immutable SQLite URIs", () => {
    const pathname = String.raw`C:\deep state\openclaw.sqlite`;
    const namespacedPath = String.raw`\\?\C:\deep state\openclaw.sqlite`;

    expect(resolveImmutableSqliteFileUri(pathname, "win32")).toBe(
      `file:${encodeURIComponent(namespacedPath)}?mode=ro&immutable=1`,
    );
  });
});

describe("node SQLite safety", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0, 1])(
    "detects the loaded library's extension capability (omitted=%s)",
    async (omitted) => {
      const { supportsNodeSqliteExtensionLoading } = await loadNodeSqliteWithVersion(
        "3.51.3",
        omitted,
      );
      expect(supportsNodeSqliteExtensionLoading()).toBe(omitted === 0);
    },
  );

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

const homebrew = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
const intelHomebrew = "/usr/local/opt/sqlite/lib/libsqlite3.dylib";
const safeProbe = { version: "3.53.4", extensionLoadingSupported: true };

function fixture(
  overrides: Partial<
    NonNullable<NonNullable<Parameters<typeof ensureSqliteLibrarySelected>[0]>["internals"]>
  > = {},
) {
  const deps = {
    isBun: true,
    platform: "darwin",
    env: {},
    exists: vi.fn(() => true),
    probe: vi.fn(() => safeProbe),
    select: vi.fn(),
    ...overrides,
  };
  return {
    ...deps,
    ensure: (options?: { explicitPath?: string }) =>
      ensureSqliteLibrarySelected({ ...options, internals: deps }),
  };
}

describe("Bun SQLite library selection", () => {
  it.each([
    { explicitPath: undefined, expected: "/env/sqlite.dylib" },
    { explicitPath: "/parent/sqlite.dylib", expected: "/parent/sqlite.dylib" },
  ])("honors explicit then environment priority ($expected)", ({ explicitPath, expected }) => {
    const f = fixture({ env: { OPENCLAW_SQLITE_LIBRARY: "  /env/sqlite.dylib  " } });
    expect(f.ensure({ explicitPath })).toEqual({ source: "env", path: expected, ...safeProbe });
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(expected);
    expect(f.select).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each(["explicit", "env"])(
    "rejects an invalid %s override without selecting a library",
    (source) => {
      const libraryPath = "/missing/sqlite.dylib";
      const f = fixture({
        exists: vi.fn(() => false),
        env: source === "env" ? { OPENCLAW_SQLITE_LIBRARY: libraryPath } : {},
      });
      expect(() => f.ensure(source === "explicit" ? { explicitPath: libraryPath } : {})).toThrow(
        `Cannot use SQLite library ${libraryPath}: missing file. Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.`,
      );
      expect(f.probe).not.toHaveBeenCalled();
      expect(f.select).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      probe: () => {
        throw new Error("dlopen: incompatible architecture");
      },
      reason: "dlopen: incompatible architecture",
    },
    {
      probe: () => ({ ...safeProbe, version: "3.51.2" }),
      reason: "SQLite version 3.51.2 below the WAL safety floor",
    },
    {
      probe: () => ({ ...safeProbe, extensionLoadingSupported: false }),
      reason: "built with SQLITE_OMIT_LOAD_EXTENSION",
    },
  ])("reports override validation failure: $reason", ({ probe, reason }) => {
    const f = fixture({ env: { OPENCLAW_SQLITE_LIBRARY: "/custom/sqlite.dylib" }, probe });
    expect(() => f.ensure()).toThrow(`Cannot use SQLite library /custom/sqlite.dylib: ${reason}`);
    expect(f.select).not.toHaveBeenCalled();
  });

  it.each([
    { ...safeProbe, version: "3.51.2" },
    { ...safeProbe, extensionLoadingSupported: false },
  ])("skips unusable discovered libraries (%j)", (firstProbe) => {
    const f = fixture({
      probe: vi.fn().mockReturnValueOnce(firstProbe).mockReturnValue(safeProbe),
    });
    expect(f.ensure()).toEqual({ source: "discovered", path: intelHomebrew, ...safeProbe });
    expect(f.select).toHaveBeenCalledExactlyOnceWith(intelHomebrew);
  });

  it("skips missing and unloadable candidates and reaches MacPorts", () => {
    const f = fixture({
      env: { HOMEBREW_PREFIX: "/custom-brew" },
      exists: vi.fn(
        (libraryPath) => libraryPath !== "/custom-brew/opt/sqlite/lib/libsqlite3.dylib",
      ),
      probe: vi.fn((libraryPath) => {
        if (libraryPath !== "/opt/local/lib/libsqlite3.dylib") {
          throw new Error("dlopen failed");
        }
        return safeProbe;
      }),
    });
    expect(f.ensure()).toEqual({
      source: "discovered",
      path: "/opt/local/lib/libsqlite3.dylib",
      ...safeProbe,
    });
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("prefers HOMEBREW_PREFIX and memoizes the selection without probing again", () => {
    const f = fixture({ env: { HOMEBREW_PREFIX: "/custom-brew" } });
    const selected = f.ensure();
    expect(selected).toEqual({
      source: "discovered",
      path: "/custom-brew/opt/sqlite/lib/libsqlite3.dylib",
      ...safeProbe,
    });
    expect(f.ensure({ explicitPath: "/different.dylib" })).toBe(selected);
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("keeps the runtime default when no library exists, including a blank override", () => {
    const f = fixture({ exists: vi.fn(() => false), env: { OPENCLAW_SQLITE_LIBRARY: "  " } });
    const selection = f.ensure();
    expect(selection).toEqual({ source: "runtime" });
    expect(f.ensure()).toBe(selection);
    expect(f.exists).toHaveBeenCalledTimes(3);
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
  });

  it("never retries the one-shot hook after a selection failure", () => {
    const f = fixture({
      select: vi.fn(() => {
        throw new Error("SQLite already loaded");
      }),
    });
    expect(() => f.ensure()).toThrow(
      `Cannot use SQLite library ${homebrew}: SQLite already loaded`,
    );
    expect(() => f.ensure()).toThrow("SQLite already loaded");
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    { isBun: false, platform: "darwin" },
    { isBun: true, platform: "linux" },
    { isBun: true, platform: "win32" },
  ])("leaves unsupported runtimes untouched (%j)", (runtime) => {
    for (const env of [{}, { OPENCLAW_SQLITE_LIBRARY: "/custom/sqlite.dylib" }]) {
      const f = fixture({ ...runtime, env });
      expect(f.ensure()).toEqual(
        env.OPENCLAW_SQLITE_LIBRARY
          ? { source: "runtime", ignoredOverride: "OPENCLAW_SQLITE_LIBRARY requires Bun on macOS" }
          : { source: "runtime" },
      );
      expect(f.exists).not.toHaveBeenCalled();
      expect(f.probe).not.toHaveBeenCalled();
      expect(f.select).not.toHaveBeenCalled();
    }
  });
});
