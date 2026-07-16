// Imessage tests cover the downtime-recovery cursor.
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import {
  advanceIMessageRecoveryCursor,
  loadIMessageRecoveryCursor,
  resolveIMessageRecoveryCursorDbIdentity,
} from "./recovery-cursor.js";

// Default database identity used by tests that are not exercising the db-scoping
// behavior directly.
const DB = "local:/db-a";
const DB_B = "local:/db-b";

function writeLegacyCatchupCursor(accountId: string, lastSeenRowid: number): void {
  const store = getIMessageRuntime().state.openSyncKeyedStore<{
    lastSeenMs: number;
    lastSeenRowid: number;
  }>({ namespace: "imessage.catchup-cursors", maxEntries: 256 });
  const key = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 32);
  store.register(key, { lastSeenMs: Date.now(), lastSeenRowid });
}

// Writes a pre-database-scoping recovery cursor: keyed by accountId alone, with
// no database identity, as older builds persisted it.
function writeLegacyRecoveryCursor(accountId: string, lastRowid: number): void {
  getIMessageRuntime()
    .state.openSyncKeyedStore<{ lastRowid: number }>({
      namespace: "imessage.recovery-cursor",
      maxEntries: 64,
    })
    .register(accountId, { lastRowid });
}

describe("iMessage recovery cursor", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  it("returns null before anything is recorded", () => {
    expect(loadIMessageRecoveryCursor("default", DB)).toBeNull();
  });

  it("persists the last dispatched rowid", () => {
    advanceIMessageRecoveryCursor("default", DB, 100);
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(100);
  });

  it("advances forward only and never rewinds", () => {
    advanceIMessageRecoveryCursor("default", DB, 100);
    advanceIMessageRecoveryCursor("default", DB, 50);
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(100);
    advanceIMessageRecoveryCursor("default", DB, 150);
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(150);
  });

  it("scopes the cursor per account", () => {
    advanceIMessageRecoveryCursor("work", DB, 10);
    advanceIMessageRecoveryCursor("home", DB, 20);
    expect(loadIMessageRecoveryCursor("work", DB)).toBe(10);
    expect(loadIMessageRecoveryCursor("home", DB)).toBe(20);
  });

  it("ignores a cursor recorded against a different database (#99638)", () => {
    // A high-water from db-a must not seed since_rowid after repointing to db-b,
    // or every lower rowid in db-b is silently suppressed forever.
    advanceIMessageRecoveryCursor("default", DB, 12396);
    expect(loadIMessageRecoveryCursor("default", DB_B, { migrateLegacyCatchup: false })).toBeNull();
    // The original database still reports its cursor.
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(12396);
  });

  it("re-scopes the cursor to the new database on advance", () => {
    advanceIMessageRecoveryCursor("default", DB, 12396);
    // Advancing on db-b starts fresh (not blocked by db-a's higher monotonic value).
    advanceIMessageRecoveryCursor("default", DB_B, 15);
    expect(loadIMessageRecoveryCursor("default", DB_B)).toBe(15);
    // db-a keeps its own high-water; switching back does not lose it.
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(12396);
  });

  it("adopts a pre-database-scoping cursor once for the active database (#99638)", () => {
    writeLegacyRecoveryCursor("default", 12396);
    // Upgrade restart: the identity-less cursor is adopted for the active
    // database so downtime replay still works (not dropped to the watermark).
    expect(loadIMessageRecoveryCursor("default", DB, { migrateLegacyCatchup: false })).toBe(12396);
    // It is consumed and re-scoped, so a different database does not inherit it.
    expect(loadIMessageRecoveryCursor("default", DB_B, { migrateLegacyCatchup: false })).toBeNull();
    // The adopted database keeps it across reloads.
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(12396);
  });

  it("ignores non-finite rowids", () => {
    advanceIMessageRecoveryCursor("default", DB, Number.NaN);
    expect(loadIMessageRecoveryCursor("default", DB)).toBeNull();
  });

  it("seeds from the retired catchup cursor once on upgrade, then consumes it", () => {
    writeLegacyCatchupCursor("default", 4321);
    // First load with no recovery cursor seeds from the legacy catchup cursor.
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(4321);
    // The legacy entry is consumed and the value is now the recovery cursor, so
    // a later load still returns it without re-reading the legacy store.
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(4321);
  });

  it("can skip legacy catchup cursor migration when compatibility catchup still owns it", () => {
    writeLegacyCatchupCursor("default", 4321);
    expect(loadIMessageRecoveryCursor("default", DB, { migrateLegacyCatchup: false })).toBeNull();
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(4321);
  });

  it("prefers an existing recovery cursor over the legacy catchup cursor", () => {
    advanceIMessageRecoveryCursor("default", DB, 9000);
    writeLegacyCatchupCursor("default", 10);
    expect(loadIMessageRecoveryCursor("default", DB)).toBe(9000);
  });

  it("unifies the implicit default with explicit spellings of the same chat.db (#99638)", () => {
    const home = (process.env.HOME || os.homedir()).trim();
    const defaultIdentity = `local:${path.resolve(path.join(home, "Library", "Messages", "chat.db"))}`;

    // Implicit default (imsg binary, no dbPath) and any explicit spelling of the
    // same file resolve to one identity, so switching between them does not drop
    // the cursor and skip downtime messages.
    expect(resolveIMessageRecoveryCursorDbIdentity({ cliPath: "imsg" })).toBe(defaultIdentity);
    expect(resolveIMessageRecoveryCursorDbIdentity({ cliPath: "/opt/homebrew/bin/imsg" })).toBe(
      defaultIdentity,
    );
    expect(
      resolveIMessageRecoveryCursorDbIdentity({
        dbPath: path.join(home, "Library/Messages/chat.db"),
      }),
    ).toBe(defaultIdentity);
    expect(resolveIMessageRecoveryCursorDbIdentity({ dbPath: "~/Library/Messages/chat.db" })).toBe(
      defaultIdentity,
    );
  });

  it("keeps distinct databases, wrappers, and remotes on separate identities", () => {
    const defaultId = resolveIMessageRecoveryCursorDbIdentity({ cliPath: "imsg" });
    const otherDb = resolveIMessageRecoveryCursorDbIdentity({ dbPath: "/Users/other/chat.db" });
    // Distinct wrappers with no dbPath/remoteHost must not collapse together.
    const wrapperA = resolveIMessageRecoveryCursorDbIdentity({
      cliPath: "/usr/local/bin/imsg-a.sh",
    });
    const wrapperB = resolveIMessageRecoveryCursorDbIdentity({
      cliPath: "/usr/local/bin/imsg-b.sh",
    });
    const remote = resolveIMessageRecoveryCursorDbIdentity({
      remoteHost: "bot@host",
      dbPath: "/Users/b/chat.db",
    });
    expect(new Set([defaultId, otherDb, wrapperA, wrapperB, remote]).size).toBe(5);
    // Stable for the same inputs.
    expect(otherDb).toBe(
      resolveIMessageRecoveryCursorDbIdentity({ dbPath: "/Users/other/chat.db" }),
    );
  });
});
