// Tests for SQLite user_version pragma helper.
import { describe, expect, it, vi } from "vitest";

vi.mock("../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../version.js")>();
  return { ...actual, resolveRuntimeServiceCommit: () => "aaaaaaa" };
});
import { VERSION } from "../version.js";
import {
  createNewerSqliteSchemaVersionError,
  describeRunningOpenClawBuild,
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

  it("names the refusing install and both schema versions", () => {
    const error = createNewerSqliteSchemaVersionError("test database", "/tmp/test.sqlite", 12, 11);

    expect(error.message).toContain("uses newer schema version 12");
    expect(error.message).toContain("this build supports 11");
    expect(error.message).toContain(describeRunningOpenClawBuild());
    expect(error.message).toContain("supports schema 12 or newer");
  });

  it("does not assert a downgrade the operator never performed", () => {
    // Two builds sharing one release version can support different schemas (#115008).
    // Telling the operator to upgrade or stop downgrading is unactionable and often wrong.
    const error = createNewerSqliteSchemaVersionError("test database", "/tmp/test.sqlite", 12, 11);

    expect(error.message).not.toContain("Do not downgrade");
    expect(error.message).not.toContain("Upgrade OpenClaw");
  });
});

describe("describeRunningOpenClawBuild", () => {
  it("reports the version and the install root operators can act on", () => {
    const described = describeRunningOpenClawBuild();

    expect(described).toContain(VERSION);
    expect(described).toContain("installed at ");
  });

  it("reports the loaded build commit", () => {
    expect(describeRunningOpenClawBuild()).toContain("(aaaaaaa)");
  });
});
