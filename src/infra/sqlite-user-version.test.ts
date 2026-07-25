// Tests for SQLite user_version pragma helper.
import { describe, expect, it } from "vitest";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "./sqlite-user-version.js";

describe("readSqliteUserVersion", () => {
  it("returns 0 when row is undefined", () => {
    const db = {
      prepare: () => ({ get: () => undefined }),
    };
    expect(readSqliteUserVersion(db)).toBe(0);
  });

  it("returns 0 when user_version is null", () => {
    const db = {
      prepare: () => ({ get: () => ({ user_version: null }) }),
    };
    expect(readSqliteUserVersion(db)).toBe(0);
  });

  it("returns numeric user_version", () => {
    const db = {
      prepare: () => ({ get: () => ({ user_version: 5 }) }),
    };
    expect(readSqliteUserVersion(db)).toBe(5);
  });

  it("returns 0 when user_version is 0", () => {
    const db = {
      prepare: () => ({ get: () => ({ user_version: 0 }) }),
    };
    expect(readSqliteUserVersion(db)).toBe(0);
  });

  it("converts string user_version to number", () => {
    const db = {
      prepare: () => ({ get: () => ({ user_version: "3" }) }),
    };
    expect(readSqliteUserVersion(db)).toBe(3);
  });

  it("returns 0 for empty object", () => {
    const db = {
      prepare: () => ({ get: () => ({}) }),
    };
    expect(readSqliteUserVersion(db)).toBe(0);
  });
});

describe("createNewerSqliteSchemaVersionError", () => {
  it("returns a stable named error with the schema guide", () => {
    const error = createNewerSqliteSchemaVersionError("test database", "/tmp/test.sqlite", 12, 11);

    expect(error.name).toBe("SqliteSchemaVersionError");
    expect(error.message).toContain("https://docs.openclaw.ai/reference/database-schemas");
  });
});
