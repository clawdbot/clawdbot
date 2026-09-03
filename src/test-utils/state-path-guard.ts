// Test instrumentation rejects state access outside the shared worker home without redirecting it.
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as statePaths from "../state/openclaw-state-db.paths.js";

/** Fail before host metadata discovery can read state outside the worker's owned home. */
export function useIsolatedStateGuard(): void {
  const resolveStatePath = statePaths.resolveOpenClawStateSqlitePath;
  const openDatabase = nodeSqlite.openNodeSqliteDatabase;
  let restore = () => {};
  beforeEach(() => {
    const testHome = process.env.OPENCLAW_TEST_HOME;
    if (!testHome) {
      throw new Error("State isolation checks require the shared isolated test home.");
    }
    // Physical containment: a symlinked state root inside the home would pass a lexical
    // check while SQLite follows it elsewhere; the home itself may be a tmpdir symlink.
    const ownedRoot = resolveIdentityPathViaExistingAncestorSync(testHome);
    const assertOwnedPath = (pathname: string) => {
      const relative = path.relative(
        ownedRoot,
        resolveIdentityPathViaExistingAncestorSync(pathname),
      );
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`OpenClaw state escaped the isolated test home: ${pathname}`);
      }
    };
    // Check resolution too: a missing foreign DB would otherwise make the leak silently pass.
    const pathSpy = vi
      .spyOn(statePaths, "resolveOpenClawStateSqlitePath")
      .mockImplementation((env) => {
        const pathname = resolveStatePath(env);
        assertOwnedPath(pathname);
        return pathname;
      });
    const openSpy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, options) => {
        if (location !== ":memory:") {
          assertOwnedPath(location);
        }
        return openDatabase(location, options);
      });
    restore = () => {
      openSpy.mockRestore();
      pathSpy.mockRestore();
    };
  });
  afterEach(() => restore());
}
