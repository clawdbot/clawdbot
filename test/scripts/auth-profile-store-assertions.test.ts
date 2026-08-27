import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoLegacyPrimaryAuthRows,
  readSharedAuthProfileStoreText,
} from "../../scripts/e2e/lib/auth-profile-store-assertions.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStateDir(): string {
  const root = tempDirs.make("openclaw-auth-profile-assertions-");
  return path.join(root, ".openclaw");
}

function writeSharedDatabase(
  stateDir: string,
  options: { asView?: boolean; storeJson?: string } = {},
): string {
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    if (options.asView) {
      db.exec(`
        CREATE VIEW auth_profile_stores AS
          SELECT 'shared' AS store_key, '{}' AS store_json, 1 AS updated_at;
      `);
    } else {
      db.exec(`
        CREATE TABLE auth_profile_stores (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      db.prepare("INSERT INTO auth_profile_stores VALUES (?, ?, ?)").run(
        "shared",
        options.storeJson ?? "{}",
        Date.now(),
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

function writeAgentDatabase(
  stateDir: string,
  options: {
    stateKeys?: string[];
    storeKeys?: string[];
    storeAsView?: boolean;
  } = {},
): string {
  const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    if (options.storeAsView) {
      db.exec(`
        CREATE VIEW auth_profile_store AS
          SELECT 'primary' AS store_key, '{}' AS store_json, 1 AS updated_at;
      `);
    } else {
      db.exec(`
        CREATE TABLE auth_profile_store (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      for (const key of options.storeKeys ?? []) {
        db.prepare("INSERT INTO auth_profile_store VALUES (?, '{}', ?)").run(key, Date.now());
      }
    }
    db.exec(`
      CREATE TABLE auth_profile_state (
        state_key TEXT NOT NULL PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    for (const key of options.stateKeys ?? []) {
      db.prepare("INSERT INTO auth_profile_state VALUES (?, '{}', ?)").run(key, Date.now());
    }
  } finally {
    db.close();
  }
  return dbPath;
}

describe("auth profile store E2E assertions", () => {
  it("reads the canonical shared row", () => {
    const stateDir = makeStateDir();
    writeSharedDatabase(stateDir, { storeJson: '{"version":1}' });

    expect(readSharedAuthProfileStoreText(stateDir)).toBe('{"version":1}');
  });

  it("returns empty when the shared database or table is absent", () => {
    const stateDir = makeStateDir();

    expect(readSharedAuthProfileStoreText(stateDir)).toBe("");
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    new DatabaseSync(dbPath).close();
    expect(readSharedAuthProfileStoreText(stateDir)).toBe("");
  });

  it("fails closed for a corrupt shared database", () => {
    const stateDir = makeStateDir();
    const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "not sqlite");

    expect(() => readSharedAuthProfileStoreText(stateDir)).toThrow(
      "could not read the shared auth profile store",
    );
  });

  it("fails closed when the shared auth table is replaced by a view", () => {
    const stateDir = makeStateDir();
    writeSharedDatabase(stateDir, { asView: true });

    expect(() => readSharedAuthProfileStoreText(stateDir)).toThrow(
      "auth_profile_stores is view, not a table",
    );
  });

  it("permits unrelated main-agent auth rows", () => {
    const stateDir = makeStateDir();
    writeAgentDatabase(stateDir, {
      stateKeys: ["last-good"],
      storeKeys: ["workspace"],
    });

    expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).not.toThrow();
  });

  it.each(["auth_profile_store", "auth_profile_state"] as const)(
    "rejects a retired primary row in %s",
    (table) => {
      const stateDir = makeStateDir();
      writeAgentDatabase(stateDir, {
        stateKeys: table === "auth_profile_state" ? ["primary"] : [],
        storeKeys: table === "auth_profile_store" ? ["primary"] : [],
      });

      expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
        `onboard preserved a retired primary row in ${table}`,
      );
    },
  );

  it("fails closed for a corrupt main-agent database", () => {
    const stateDir = makeStateDir();
    const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "not sqlite");

    expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
      "could not validate the main-agent auth database",
    );
  });

  it("fails closed when a retired auth table is replaced by a view", () => {
    const stateDir = makeStateDir();
    writeAgentDatabase(stateDir, { storeAsView: true });

    expect(() => assertNoLegacyPrimaryAuthRows(stateDir)).toThrow(
      "auth_profile_store is view, not a table",
    );
  });
});
