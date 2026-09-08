import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  ensureUserPreferencesSchema,
  getUserPreferences,
  mergeUserPreferences,
  setUserPreferences,
} from "./user-preferences.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-user-prefs-"), "openclaw.sqlite") };
}

function openWithoutFeatureSchemas() {
  const options = stateOptions();
  const { db } = openOpenClawStateDatabase(options);
  db.exec("DROP TABLE IF EXISTS user_preferences; DROP TABLE IF EXISTS agent_provenance;");
  return { db, options };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("user preferences", () => {
  it("initializes each feature independently on each database handle", () => {
    const first = openWithoutFeatureSchemas();
    const second = openWithoutFeatureSchemas();
    ensureUserPreferencesSchema(first.options);
    expect(tableExists(first.db, "user_preferences")).toBe(true);
    expect(tableExists(first.db, "agent_provenance")).toBe(false);
    expect(tableExists(second.db, "user_preferences")).toBe(false);

    ensureAgentProvenanceSchema(first.options);
    ensureUserPreferencesSchema(second.options);
    expect(tableExists(first.db, "agent_provenance")).toBe(true);
    expect(tableExists(second.db, "user_preferences")).toBe(true);
    expect(tableExists(second.db, "agent_provenance")).toBe(false);
  });

  it("retries first-use schema creation after its transaction fails", () => {
    const { db, options } = openWithoutFeatureSchemas();
    const failure = new Error("schema write refused");
    const exec = db.exec.bind(db);
    const write = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE TABLE IF NOT EXISTS user_preferences")) {
        throw failure;
      }
      return exec(sql);
    });
    try {
      expect(() => ensureUserPreferencesSchema(options)).toThrow(failure);
      expect(db.isTransaction).toBe(false);
      expect(tableExists(db, "user_preferences")).toBe(false);
    } finally {
      write.mockRestore();
    }

    ensureUserPreferencesSchema(options);
    expect(tableExists(db, "user_preferences")).toBe(true);
  });

  it("lazily creates the additive table and isolates profile rows", () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    const version = database.prepare("PRAGMA user_version").get()?.user_version;
    database.exec("DROP TABLE user_preferences;");
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(tableExists(reopened, "user_preferences")).toBe(false);

    expect(setUserPreferences("profile-a", { beta: 2, alpha: { enabled: true } }, options)).toEqual(
      {
        ok: true,
        value: undefined,
      },
    );
    expect(getUserPreferences("profile-a", undefined, options)).toEqual({
      alpha: { enabled: true },
      beta: 2,
    });
    expect(getUserPreferences("profile-a", ["beta"], options)).toEqual({ beta: 2 });
    expect(getUserPreferences("profile-b", undefined, options)).toEqual({});
    expect(tableExists(reopened, "user_preferences")).toBe(true);
    expect(reopened.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  });

  it("rejects oversized batches and values before writing any row", () => {
    const options = stateOptions();
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]),
    );
    expect(setUserPreferences("profile-a", tooMany, options)).toMatchObject({
      ok: false,
      error: { code: "invalid-entry-count" },
    });
    expect(
      setUserPreferences("profile-a", { valid: true, oversized: "🦞".repeat(1_025) }, options),
    ).toMatchObject({ ok: false, error: { code: "value-too-large", key: "oversized" } });
    expect(getUserPreferences("profile-a", undefined, options)).toEqual({});
  });

  it("caps each profile at 128 keys while allowing deletions to free capacity", () => {
    const options = stateOptions();
    for (let start = 0; start < 127; start += 32) {
      const count = Math.min(32, 127 - start);
      const entries = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [`key-${start + index}`, true]),
      );
      expect(setUserPreferences("profile-a", entries, options)).toEqual({
        ok: true,
        value: undefined,
      });
    }

    expect(setUserPreferences("profile-a", { "key-127": true }, options)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(setUserPreferences("profile-a", { "key-128": true }, options)).toEqual({
      ok: false,
      error: { code: "profile-key-limit", limit: 128, currentCount: 128 },
    });
    expect(setUserPreferences("profile-a", { "key-0": null }, options)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(setUserPreferences("profile-a", { "key-128": true }, options)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(getUserPreferences("profile-a", ["key-0", "key-128"], options)).toEqual({
      "key-128": true,
    });
  });

  it("keeps merged profiles within the same preference cap", () => {
    const options = stateOptions();
    for (let start = 0; start < 127; start += 32) {
      const count = Math.min(32, 127 - start);
      expect(
        setUserPreferences(
          "target",
          Object.fromEntries(
            Array.from({ length: count }, (_, index) => [`target-${start + index}`, true]),
          ),
          options,
        ),
      ).toMatchObject({ ok: true });
    }
    expect(
      setUserPreferences("source", { "source-a": true, "source-b": true }, options),
    ).toMatchObject({ ok: true });

    mergeUserPreferences(openOpenClawStateDatabase(options).db, "source", "target");

    expect(Object.keys(getUserPreferences("target", undefined, options))).toHaveLength(128);
    expect(getUserPreferences("target", ["source-a", "source-b"], options)).toEqual({
      "source-a": true,
    });
    expect(getUserPreferences("source", undefined, options)).toEqual({});
  });
});
