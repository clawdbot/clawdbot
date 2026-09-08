import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";

export type SqliteLibrarySelection =
  | { source: "runtime"; ignoredOverride?: string }
  | {
      source: "env" | "discovered";
      path: string;
      version: string;
      extensionLoadingSupported: true;
    };

type SelectionOptions = { explicitPath?: string };
type LibraryProbe = { version: string; extensionLoadingSupported: boolean };
type SelectionDependencies = {
  isBun: boolean;
  platform: string;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  probe: (path: string) => LibraryProbe;
  select: (path: string) => void;
};

// Bun is optional: describe only the FFI symbols used at this native boundary.
type BunFfi = {
  FFIType: { cstring: number; i32: number };
  dlopen: (
    path: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ) => {
    symbols: {
      sqlite3_libversion: () => { toString(): string };
      sqlite3_compileoption_used: (option: Buffer) => number;
    };
    close: () => void;
  };
};

function probeLibrary(path: string): LibraryProbe {
  const require = createRequire(import.meta.url);
  // SAFETY: Called only on Bun; this models its FFI module and the two requested SQLite symbols.
  const { dlopen, FFIType } = require("bun:ffi") as BunFfi;
  const library = dlopen(path, {
    sqlite3_libversion: { args: [], returns: FFIType.cstring },
    sqlite3_compileoption_used: { args: [FFIType.cstring], returns: FFIType.i32 },
  });
  try {
    return {
      version: String(library.symbols.sqlite3_libversion()),
      extensionLoadingSupported:
        library.symbols.sqlite3_compileoption_used(Buffer.from("OMIT_LOAD_EXTENSION\0")) === 0,
    };
  } finally {
    library.close();
  }
}

function selectLibrary(path: string): void {
  const require = createRequire(import.meta.url);
  // SAFETY: Called only on macOS Bun, whose Database exposes the process-wide library selector.
  const { Database } = require("bun:sqlite") as {
    Database: { setCustomSQLite: (path: string) => void };
  };
  Database.setCustomSQLite(path);
}

function createSelector(deps: SelectionDependencies) {
  let selection: SqliteLibrarySelection | undefined;
  let failure: Error | undefined;
  return (options: SelectionOptions = {}): SqliteLibrarySelection => {
    if (failure) {
      throw failure;
    }
    if (selection) {
      return selection;
    }
    const override =
      options.explicitPath ?? (deps.env.OPENCLAW_SQLITE_LIBRARY?.trim() || undefined);
    if (!deps.isBun || deps.platform !== "darwin") {
      selection = override
        ? { source: "runtime", ignoredOverride: "OPENCLAW_SQLITE_LIBRARY requires Bun on macOS" }
        : { source: "runtime" };
      return selection;
    }
    const prefix = deps.env.HOMEBREW_PREFIX?.trim();
    const candidates =
      override !== undefined
        ? [override]
        : [
            ...new Set([
              ...(prefix ? [posix.join(prefix, "opt/sqlite/lib/libsqlite3.dylib")] : []),
              "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
              "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
              "/opt/local/lib/libsqlite3.dylib",
            ]),
          ];
    for (const path of candidates) {
      let probe: LibraryProbe;
      try {
        // dlopen decides loadability: Apple's SQLite lives in the dyld shared cache with no
        // file on disk, so a stat-first check would hide its real defect (OMIT_LOAD_EXTENSION).
        try {
          probe = deps.probe(path);
        } catch (error) {
          throw deps.exists(path) ? error : new Error("missing file", { cause: error });
        }
        if (!isSqliteWalResetSafeVersion(probe.version)) {
          throw new Error(`SQLite version ${probe.version} below the WAL safety floor`);
        }
        if (!probe.extensionLoadingSupported) {
          throw new Error("built with SQLITE_OMIT_LOAD_EXTENSION");
        }
      } catch (error) {
        if (override === undefined) {
          continue;
        }
        failure = selectionError(path, error);
        throw failure;
      }
      try {
        // Never try another candidate after committing: Bun's hook is one-shot, even on failure.
        // Discovery trusts the user-writable prefix like the Homebrew Bun binary itself;
        // an override is operator-specified code, like memory.search.store.vector.extensionPath.
        deps.select(path);
      } catch (error) {
        failure = selectionError(path, error);
        throw failure;
      }
      selection = {
        source: override === undefined ? "discovered" : "env",
        path,
        version: probe.version,
        extensionLoadingSupported: true,
      };
      return selection;
    }
    selection = { source: "runtime" };
    return selection;
  };
}

function selectionError(path: string, error: unknown): Error {
  return new Error(
    `Cannot use SQLite library ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
      "Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.",
    { cause: error },
  );
}

/** Select once, before any SQLite open; shared across CLI and bundled SDK module graphs. */
export function ensureSqliteLibrarySelected(
  options?: SelectionOptions & {
    /** @internal Isolated native dependencies and memoization for boundary tests. */
    internals?: SelectionDependencies & { selector?: ReturnType<typeof createSelector> };
  },
): SqliteLibrarySelection {
  const dependencies = options?.internals;
  const select = dependencies
    ? (dependencies.selector ??= createSelector(dependencies))
    : resolveGlobalSingleton(Symbol.for("openclaw.bunSqliteLibrarySelection"), () =>
        createSelector({
          isBun: Boolean(process.versions.bun),
          platform: process.platform,
          env: process.env,
          exists: existsSync,
          probe: probeLibrary,
          select: selectLibrary,
        }),
      );
  return select(options);
}
