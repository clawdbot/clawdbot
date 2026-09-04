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
import { onUserProfilesChanged, readUserProfileVersion } from "./user-profile-events.js";
import {
  ensureProfileForEmail,
  linkEmail,
  listProfiles,
  readUserProfileAliases,
  resolveUserProfileId,
  setDisplayName,
} from "./user-profiles.js";

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
  it("publishes committed merges, not rollbacks or links to the same canonical profile", () => {
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
      expect(linkEmail("source@aliases.test", source.id, options)).toMatchObject({
        id: target.id,
        mergedInto: null,
      });
      expect(ensureProfileForEmail("source@aliases.test", options).id).toBe(target.id);
      expect(published).toHaveBeenCalledOnce();
      expect(read()).toEqual(new Set([source.id, target.id]));
      expect(readUserProfileAliases(source.id, options)).toEqual(new Set([source.id, target.id]));
      expect(listProfiles(options)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: source.id, mergedInto: target.id }),
          expect.objectContaining({ id: target.id, mergedInto: null }),
        ]),
      );
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

  it("moves aliases and leaves an aliasless source profile as a one-hop tombstone", () => {
    const options = stateOptions();
    const source = ensureProfileForEmail("source@example.com", options);
    const target = ensureProfileForEmail("target@example.com", options);

    const version = readUserProfileVersion();
    const linked = linkEmail("source@example.com", target.id, options);
    expect(readUserProfileVersion()).toBe(version + 1);

    expect(ensureProfileForEmail("source@example.com", options).id).toBe(target.id);
    expect(linked).toMatchObject({
      id: target.id,
      emails: ["source@example.com", "target@example.com"],
      hasAvatar: false,
    });
    expect(listProfiles(options)).toContainEqual(
      expect.objectContaining({ id: source.id, mergedInto: target.id, emails: [] }),
    );
  });

  it("compresses tombstones so durable profile references resolve to the merge head", () => {
    const options = stateOptions();
    const a = ensureProfileForEmail("a@example.com", options);
    const b = ensureProfileForEmail("b@example.com", options);
    const c = ensureProfileForEmail("c@example.com", options);

    linkEmail("a@example.com", b.id, options);
    linkEmail("a@example.com", c.id, options);
    linkEmail("b@example.com", c.id, options);

    expect(setDisplayName(a.id, "Durable A", options)).toMatchObject({ id: c.id });
    expect(resolveUserProfileId(a.id, options)).toBe(c.id);
    expect(listProfiles(options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.id, mergedInto: c.id }),
        expect.objectContaining({ id: b.id, mergedInto: c.id }),
      ]),
    );
  });

  it("resolves a tombstoned link target to its head without forming a cycle", () => {
    const options = stateOptions();
    const a = ensureProfileForEmail("a@example.com", options);
    const b = ensureProfileForEmail("b@example.com", options);

    linkEmail("a@example.com", b.id, options);
    const version = readUserProfileVersion();
    linkEmail("a@example.com", a.id, options);
    expect(readUserProfileVersion()).toBe(version);

    expect(ensureProfileForEmail("a@example.com", options).id).toBe(b.id);
    expect(listProfiles(options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: a.id, mergedInto: b.id }),
        expect.objectContaining({ id: b.id, mergedInto: null }),
      ]),
    );
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
