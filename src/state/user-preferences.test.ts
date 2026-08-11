import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { getUserPreferences, setUserPreferences } from "./user-preferences.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-user-prefs-"), "openclaw.sqlite") };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("user preferences", () => {
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
});
