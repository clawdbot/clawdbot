import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import { ensureProfileForEmail, linkEmail, readUserProfileAliases } from "./user-profiles.js";

const roots = createTempDirTracker();
const statePaths: string[] = [];
function stateOptions() {
  const pathname = path.join(roots.make("profile-aliases-"), "state", "openclaw.sqlite");
  statePaths.push(pathname);
  return { path: pathname };
}
afterEach(() => {
  for (const pathname of statePaths.splice(0)) {
    closeOpenClawStateDatabaseByPath(pathname);
  }
  roots.cleanup();
});

describe("profile alias reader lifecycle", () => {
  it("observes committed merges, not nested uncommitted or rolled-back aliases", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@aliases.test", options);
    const target = ensureProfileForEmail("target@aliases.test", options);
    const read = () => readUserProfileAliases(target.id, options);
    expect(read()).toEqual(new Set([target.id]));
    const published = vi.fn(() => expect(read()).toEqual(new Set([source.id, target.id])));
    const stop = onUserProfilesChanged(published);
    try {
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          linkEmail("source@aliases.test", target.id, options);
          expect(read()).toEqual(new Set([target.id]));
          expect(published).not.toHaveBeenCalled();
          throw new Error("rollback");
        }, options),
      ).toThrow("rollback");
      expect(read()).toEqual(new Set([target.id]));
      expect(published).not.toHaveBeenCalled();
      runOpenClawStateWriteTransaction(() => {
        linkEmail("source@aliases.test", target.id, options);
        expect(read()).toEqual(new Set([target.id]));
      }, options);
      expect(published).toHaveBeenCalledOnce();
      expect(read()).toEqual(new Set([source.id, target.id]));
      expect(readUserProfileAliases(source.id, options)).toEqual(new Set([source.id, target.id]));
    } finally {
      stop();
    }
  });

  it("does not merge profiles when moving only one of a source's emails", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@aliases.test", options);
    const target = ensureProfileForEmail("target@aliases.test", options);
    linkEmail("retained@aliases.test", source.id, options);
    expect(readUserProfileAliases(target.id, options)).toEqual(new Set([target.id]));
    linkEmail("source@aliases.test", target.id, options);
    expect(readUserProfileAliases(target.id, options)).toEqual(new Set([target.id]));
    expect(readUserProfileAliases(source.id, options)).toEqual(new Set([source.id]));
  });

  it.each([false, true])(
    "leaves absent storage untouched and observes its later creation (database=%s)",
    (exists) => {
      const options = stateOptions();
      const db = exists ? openOpenClawStateDatabase(options).db : undefined;
      expect(readUserProfileAliases("missing", options)).toEqual(new Set(["missing"]));
      if (db) {
        expect(tableExists(db, "user_profiles")).toBe(false);
      } else {
        expect(fs.existsSync(options.path)).toBe(false);
      }
      const source = ensureProfileForEmail("source@aliases.test", options);
      const target = ensureProfileForEmail("target@aliases.test", options);
      linkEmail("source@aliases.test", target.id, options);
      expect(readUserProfileAliases(target.id, options)).toEqual(new Set([source.id, target.id]));
    },
  );

  it("honors explicit paths and env roots, and drops handle-bound aliases after reopen", () => {
    const options = stateOptions();
    const other = stateOptions();
    const source = ensureProfileForEmail("source@aliases.test", options);
    const target = ensureProfileForEmail("target@aliases.test", options);
    linkEmail("source@aliases.test", target.id, options);
    const env = { OPENCLAW_STATE_DIR: path.dirname(path.dirname(other.path)) };
    expect(readUserProfileAliases(target.id, { ...options, env })).toEqual(
      new Set([source.id, target.id]),
    );
    expect(readUserProfileAliases(target.id, { env })).toEqual(new Set([target.id]));
    expect(fs.existsSync(other.path)).toBe(false);
    closeOpenClawStateDatabaseByPath(options.path);
    // Fixture-only external change while closed; this does not promise external-process polling.
    const reopened = openOpenClawStateDatabase(options).db;
    reopened.prepare("DELETE FROM user_profiles WHERE id = ?").run(source.id);
    expect(readUserProfileAliases(target.id, options)).toEqual(new Set([target.id]));
  });

  it("reselects a newly created default state root instead of retaining legacy-root aliases", () => {
    const home = roots.make("profile-alias-home-");
    const legacyRoot = path.join(home, ".clawdbot");
    const newRoot = path.join(home, ".openclaw");
    const legacyPath = path.join(legacyRoot, "state", "openclaw.sqlite");
    statePaths.push(legacyPath, path.join(newRoot, "state", "openclaw.sqlite"));
    fs.mkdirSync(legacyRoot);
    withPathResolutionEnv(
      home,
      {
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        VITEST_WORKER_ID: undefined,
        NODE_ENV: "production",
      },
      () => {
        const source = ensureProfileForEmail("source@aliases.test");
        const target = ensureProfileForEmail("target@aliases.test");
        linkEmail("source@aliases.test", target.id);
        expect(readUserProfileAliases(target.id)).toEqual(new Set([source.id, target.id]));
        fs.mkdirSync(newRoot);
        expect(readUserProfileAliases(target.id)).toEqual(new Set([target.id]));
        expect(fs.existsSync(path.join(newRoot, "state"))).toBe(false);
        expect(
          readUserProfileAliases(target.id, { env: { OPENCLAW_STATE_DIR: legacyRoot } }),
        ).toEqual(new Set([source.id, target.id]));
      },
    );
  });
});
