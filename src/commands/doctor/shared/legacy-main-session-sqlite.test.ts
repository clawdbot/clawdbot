import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maybeMigrateLegacyMainSessionSqlite } from "./legacy-main-session-sqlite.js";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-main-session-sqlite-"));
  roots.push(root);
  const storePath = path.join(root, "sessions.json");
  return {
    env: { HOME: root } as NodeJS.ProcessEnv,
    config: {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    },
    legacyPath: path.join(root, "openclaw-agent.sqlite"),
    rosterPath: path.join(root, "openclaw-agent.main.sqlite"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy main custom session SQLite migration", () => {
  it("moves the complete file set and is idempotent", async () => {
    const test = fixture();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.writeFileSync(`${test.legacyPath}${suffix}`, suffix || "db");
    }

    const first = await maybeMigrateLegacyMainSessionSqlite(test.config, test.env);
    expect(first.changes).toHaveLength(1);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      expect(fs.existsSync(`${test.legacyPath}${suffix}`)).toBe(false);
      expect(fs.readFileSync(`${test.rosterPath}${suffix}`, "utf8")).toBe(suffix || "db");
    }
    expect(await maybeMigrateLegacyMainSessionSqlite(test.config, test.env)).toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("refuses to overwrite an existing roster target", async () => {
    const test = fixture();
    fs.writeFileSync(test.legacyPath, "legacy");
    fs.writeFileSync(`${test.rosterPath}-wal`, "current");

    const result = await maybeMigrateLegacyMainSessionSqlite(test.config, test.env);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(fs.readFileSync(test.legacyPath, "utf8")).toBe("legacy");
    expect(fs.readFileSync(`${test.rosterPath}-wal`, "utf8")).toBe("current");
  });
});
