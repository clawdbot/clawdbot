// Imessage tests cover the downtime-recovery cursor.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import { advanceIMessageRecoveryCursor, loadIMessageRecoveryCursor } from "./recovery-cursor.js";

function writeLegacyCatchupCursor(accountId: string, lastSeenRowid: number): void {
  const store = getIMessageRuntime().state.openSyncKeyedStore<{
    lastSeenMs: number;
    lastSeenRowid: number;
  }>({ namespace: "imessage.catchup-cursors", maxEntries: 256 });
  const key = createHash("sha256").update(accountId, "utf8").digest("hex").slice(0, 32);
  store.register(key, { lastSeenMs: Date.now(), lastSeenRowid });
}

describe("iMessage recovery cursor", () => {
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
  });

  it("returns null before anything is recorded", () => {
    expect(loadIMessageRecoveryCursor("default")).toBeNull();
  });

  it("persists the last dispatched rowid", () => {
    advanceIMessageRecoveryCursor("default", 100);
    expect(loadIMessageRecoveryCursor("default")).toBe(100);
  });

  it("advances forward only and never rewinds", () => {
    advanceIMessageRecoveryCursor("default", 100);
    advanceIMessageRecoveryCursor("default", 50);
    expect(loadIMessageRecoveryCursor("default")).toBe(100);
    advanceIMessageRecoveryCursor("default", 150);
    expect(loadIMessageRecoveryCursor("default")).toBe(150);
  });

  it("scopes the cursor per account", () => {
    advanceIMessageRecoveryCursor("work", 10);
    advanceIMessageRecoveryCursor("home", 20);
    expect(loadIMessageRecoveryCursor("work")).toBe(10);
    expect(loadIMessageRecoveryCursor("home")).toBe(20);
  });

  it("ignores non-finite rowids", () => {
    advanceIMessageRecoveryCursor("default", Number.NaN);
    expect(loadIMessageRecoveryCursor("default")).toBeNull();
  });

  it("seeds from the retired catchup cursor once on upgrade, then consumes it", () => {
    writeLegacyCatchupCursor("default", 4321);
    // First load with no recovery cursor seeds from the legacy catchup cursor.
    expect(loadIMessageRecoveryCursor("default")).toBe(4321);
    // The legacy entry is consumed and the value is now the recovery cursor, so
    // a later load still returns it without re-reading the legacy store.
    expect(loadIMessageRecoveryCursor("default")).toBe(4321);
  });

  it("can skip legacy catchup cursor migration when compatibility catchup still owns it", () => {
    writeLegacyCatchupCursor("default", 4321);
    expect(loadIMessageRecoveryCursor("default", { migrateLegacyCatchup: false })).toBeNull();
    expect(loadIMessageRecoveryCursor("default")).toBe(4321);
  });

  it("prefers an existing recovery cursor over the legacy catchup cursor", () => {
    advanceIMessageRecoveryCursor("default", 9000);
    writeLegacyCatchupCursor("default", 10);
    expect(loadIMessageRecoveryCursor("default")).toBe(9000);
  });
});
